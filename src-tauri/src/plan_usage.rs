//! The account's plan usage, read live from the `claude` CLI.
//!
//! The statusLine bridge only learns the 5-hour and 7-day windows while an
//! interactive Claude Code session is drawing its status line, and Lever's own
//! chats never draw one — so someone who works in Lever's chats would watch the
//! meter's reset times go stale for days. Claude Code answers a `get_usage`
//! control request with the same figures its `/usage` command shows: no model
//! call, no tokens, and its own sign-in, so Lever never touches a credential.
//!
//! A fetch spawns `claude` for about a second and a half, so it runs on its
//! own thread and at most every few minutes; the poll only ever reads the last
//! answer.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::agent_usage::{RateLimitWindow, RateLimits};

/// How long a background read waits for `claude` before giving up on it.
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);

struct State {
    latest: Option<RateLimits>,
    last_attempt: Option<Instant>,
}

static STATE: Mutex<State> = Mutex::new(State { latest: None, last_attempt: None });
static IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// The last reading `claude` gave, if any.
pub fn latest() -> Option<RateLimits> {
    STATE.lock().ok()?.latest
}

/// Starts a background read unless one is running or the last attempt is
/// younger than `max_age`. Never blocks: the poll calls this every cycle.
pub fn refresh_if_stale(max_age: Duration) {
    {
        let Ok(state) = STATE.lock() else { return };
        if state.last_attempt.is_some_and(|t| t.elapsed() < max_age) {
            return;
        }
    }
    if IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Ok(mut state) = STATE.lock() {
        state.last_attempt = Some(Instant::now());
    }
    std::thread::spawn(|| {
        let got = fetch();
        if let (Some(limits), Ok(mut state)) = (got, STATE.lock()) {
            state.latest = Some(limits);
        }
        IN_FLIGHT.store(false, Ordering::SeqCst);
    });
}

/// One `get_usage` round trip. `None` when `claude` is missing, signed out,
/// on an API key (no plan windows), or slow to answer.
fn fetch() -> Option<RateLimits> {
    let mut child = Command::new("claude")
        .args([
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            // Nothing to remember, and no MCP servers — Lever's own among
            // them — started just to be torn down a second later.
            "--no-session-persistence",
            "--strict-mcp-config",
        ])
        .current_dir(std::env::temp_dir())
        // Lever started from the Dock has launchd's PATH, which has no claude.
        .env("PATH", crate::get_shell_path())
        // Set when Lever itself was launched from inside a Claude Code session.
        .env_remove("CLAUDECODE")
        .env_remove("CLAUDE_CODE_ENTRYPOINT")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let mut stdin = child.stdin.take()?;
    let stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            let resp = &v["response"];
            if v["type"] == "control_response" && resp["request_id"] == "usage" {
                let _ = tx.send(resp.clone());
                break;
            }
        }
    });

    let requests = concat!(
        r#"{"type":"control_request","request_id":"init","request":{"subtype":"initialize"}}"#,
        "\n",
        r#"{"type":"control_request","request_id":"usage","request":{"subtype":"get_usage","skip_behaviors":true}}"#,
        "\n",
    );
    let sent = stdin.write_all(requests.as_bytes()).and_then(|_| stdin.flush()).is_ok();
    let answer = if sent { rx.recv_timeout(FETCH_TIMEOUT).ok() } else { None };

    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();

    let answer = answer?;
    if answer["subtype"] != "success" {
        return None;
    }
    parse_usage(&answer["response"], now_secs())
}

/// The plan windows out of a `get_usage` response. Utilization arrives as a
/// 0–100 percentage and the reset as an ISO-8601 timestamp.
fn parse_usage(v: &serde_json::Value, now: u64) -> Option<RateLimits> {
    if v["rate_limits_available"] != true {
        return None;
    }
    let window = |key: &str| -> Option<RateLimitWindow> {
        let w = &v["rate_limits"][key];
        Some(RateLimitWindow {
            used_percentage: w["utilization"].as_f64()?.clamp(0.0, 100.0),
            resets_at: parse_iso8601(w["resets_at"].as_str()?)?,
            reported_at: now,
        })
    };
    let limits = RateLimits { five_hour: window("five_hour"), seven_day: window("seven_day") };
    if limits.five_hour.is_none() && limits.seven_day.is_none() { None } else { Some(limits) }
}

/// Unix seconds from an RFC 3339 timestamp such as
/// `2026-10-19T01:10:00.214309+00:00` or `...Z`, rounded to the nearest
/// second — the API sometimes says `01:09:59.98` for a 01:10 reset.
fn parse_iso8601(s: &str) -> Option<u64> {
    let (date, rest) = s.split_once('T')?;
    let mut d = date.splitn(3, '-').map(|p| p.parse::<i64>());
    let (year, month, day) = (d.next()?.ok()?, d.next()?.ok()?, d.next()?.ok()?);

    let tz_at = rest.find(|c| c == 'Z' || c == '+' || c == '-').unwrap_or(rest.len());
    let (clock, tz) = rest.split_at(tz_at);
    let (clock, fraction) = clock.split_once('.').unwrap_or((clock, ""));
    let round_up = fraction.chars().next().is_some_and(|d| d >= '5');
    let mut t = clock.splitn(3, ':').map(|p| p.parse::<i64>());
    let (hour, minute, second) = (t.next()?.ok()?, t.next()?.ok()?, t.next().unwrap_or(Ok(0)).ok()?);

    let offset = match tz.chars().next() {
        None | Some('Z') => 0,
        Some(sign) => {
            let (h, m) = tz[1..].split_once(':').unwrap_or((&tz[1..], "0"));
            let secs = h.parse::<i64>().ok()? * 3600 + m.parse::<i64>().ok()? * 60;
            if sign == '-' { -secs } else { secs }
        }
    };

    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;

    let secs = days * 86_400 + hour * 3600 + minute * 60 + second - offset + i64::from(round_up);
    u64::try_from(secs).ok()
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_parse_with_fractions_and_offsets() {
        assert_eq!(parse_iso8601("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso8601("2026-10-19T01:10:00.214309+00:00"), Some(1_792_372_200));
        assert_eq!(parse_iso8601("2026-10-19T14:10:00+13:00"), Some(1_792_372_200));
        assert_eq!(parse_iso8601("2026-10-18T20:10:00-05:00"), Some(1_792_372_200));
        assert_eq!(parse_iso8601("2026-10-19T01:09:59.98+00:00"), Some(1_792_372_200));
        assert_eq!(parse_iso8601("not a date"), None);
    }

    #[test]
    fn a_usage_response_becomes_both_windows() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"rate_limits_available":true,"rate_limits":{
                "five_hour":{"utilization":39,"resets_at":"2026-10-19T01:10:00.214309+00:00"},
                "seven_day":{"utilization":9,"resets_at":"2026-10-22T17:00:00+00:00"}}}"#,
        )
        .unwrap();
        let l = parse_usage(&v, 42).unwrap();
        let five = l.five_hour.unwrap();
        assert_eq!((five.used_percentage, five.resets_at, five.reported_at), (39.0, 1_792_372_200, 42));
        assert_eq!(l.seven_day.unwrap().used_percentage, 9.0);
    }

    #[test]
    fn no_plan_windows_means_no_reading() {
        let v: serde_json::Value =
            serde_json::from_str(r#"{"rate_limits_available":false,"rate_limits":null}"#).unwrap();
        assert!(parse_usage(&v, 0).is_none());
    }

    /// Talks to the real `claude`; run with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn reads_live_usage_from_claude() {
        let l = fetch().expect("claude answered get_usage");
        assert!(l.five_hour.is_some() || l.seven_day.is_some());
        eprintln!("{:?}", l);
    }
}

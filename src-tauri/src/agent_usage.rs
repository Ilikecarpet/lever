//! Token usage for AI agent CLIs running inside Lever's terminals.
//!
//! Claude Code leaves everything we need on disk, so none of this attaches to
//! the process or scrapes its TUI:
//!
//!   ~/.claude/sessions/<pid>.json      pid -> session id + cwd + version
//!   ~/.claude/projects/<slug>/<id>.jsonl   one JSON object per turn, appended
//!
//! `detect_agents` already hands us the agent's pid for each PTY, which is the
//! key into the first file; the second gives the per-turn `usage` blocks the
//! API returned. Transcripts run to megabytes, so each one is read once and
//! then only from wherever the last read stopped.
//!
//! Plan usage — how much of the account's 5-hour and 7-day allowance has gone —
//! is not on disk anywhere Claude Code writes by default. It arrives only via
//! the statusLine bridge (`agent_status_bridge`), whose payloads this also
//! reads; see `read_rate_limits`.

use crate::agent_status_bridge;
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

/// Context window assumed for a Claude model. Every current model is 200k
/// except the 1M-context variants, which the transcript does not distinguish —
/// so we start here and let `context_limit` grow if a turn overshoots it.
const BASE_CONTEXT_LIMIT: u64 = 200_000;
const LARGE_CONTEXT_LIMIT: u64 = 1_000_000;

/// A transcript line only ever appends, so a refresh reads the new tail. The
/// cap bounds the very first read of a long-running session's transcript,
/// which can run to tens of megabytes — it catches up over the next few polls
/// instead of stalling one of them.
const MAX_READ_PER_REFRESH: u64 = 8 * 1024 * 1024;

/// How many request ids to remember for de-duplication. One API response is
/// written as one line per content block, all sharing a requestId, and they
/// all carry the same `usage` — counting each would multiply the totals.
const SEEN_REQUEST_HISTORY: usize = 256;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    pub session_id: String,
    /// The label Claude Code derives for the session, e.g. "lever-4f".
    pub session_name: Option<String>,
    pub model: Option<String>,
    pub cli_version: Option<String>,

    /// Conversation size after the last turn: that request's input plus the
    /// reply that got appended to it. A floor, not an exact figure — tool
    /// results added since the last API call are not counted anywhere yet.
    pub context_tokens: u64,
    pub context_limit: u64,
    /// "reported" when Claude Code handed us the real window through the
    /// statusLine bridge, "inferred" when it is the 200k-until-proven-larger
    /// guess. The meter says which, so a wrong number is explainable.
    pub context_limit_source: &'static str,
    /// The four parts of `context_tokens`, in the order they read on the meter.
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub fresh_input_tokens: u64,
    pub reply_tokens: u64,

    /// Billed totals for the whole session, subagents included.
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cache_read_tokens: u64,
    pub total_cache_write_tokens: u64,
    /// Output spent by subagents, which never lands in this context window.
    pub sidechain_output_tokens: u64,
    /// API responses on the main thread.
    pub turns: u64,
    /// "busy" or "idle", as Claude Code itself records it. Authoritative —
    /// Lever's own guess from PTY output cannot tell a spinner redraw from
    /// real work. `None` for an agent that keeps no such record.
    pub session_status: Option<String>,
    /// True while the reader is still working through a transcript's backlog.
    /// A long session's file runs to tens of megabytes and is read a chunk per
    /// poll, so the totals climb toward the real figure over a few seconds —
    /// the UI says so rather than presenting a number that is still moving.
    pub catching_up: bool,
    /// What Claude Code itself says about the session, via the statusLine
    /// bridge: none of it is recoverable from the transcript. Absent with the
    /// bridge off.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reported: Option<ReportedDetails>,
}

/// The per-session extras in a statusLine payload worth surfacing. Every field
/// is optional because the payload has grown release by release and an older
/// CLI sends a subset.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportedDetails {
    /// The conversation's title — what `/rename` sets, or Claude Code's own
    /// summary of it. Distinct from the derived label in the sessions file.
    pub title: Option<String>,
    /// "Fable 5.1" rather than `claude-fable-5-1`.
    pub model_name: Option<String>,
    pub effort: Option<String>,
    pub fast_mode: Option<bool>,
    pub thinking: Option<bool>,
    /// Running cost at API list price. Nominal on a subscription plan.
    pub cost_usd: Option<f64>,
    pub duration_ms: Option<u64>,
    pub api_duration_ms: Option<u64>,
    pub lines_added: Option<u64>,
    pub lines_removed: Option<u64>,
    /// Prompt cache: whether the conversation is still cached server-side,
    /// how long entries live, when the current one lapses, and what a cold
    /// resume would have to re-read.
    pub cache_warm: Option<bool>,
    pub cache_ttl: Option<String>,
    pub cache_expires_at: Option<u64>,
    pub cache_hit_ratio: Option<f64>,
    pub cache_recache_tokens: Option<u64>,
    /// Unix seconds the payload was written. It refreshes only while the
    /// session is drawing, so the figures above can lag an idle session.
    pub reported_at: u64,
}

/// The bits of ~/.claude/sessions/<pid>.json we use.
struct SessionMeta {
    session_id: String,
    cwd: String,
    name: Option<String>,
    version: Option<String>,
    /// "busy" while a turn is in flight, "idle" at the prompt.
    status: Option<String>,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn read_session_meta(pid: u32) -> Option<SessionMeta> {
    let path = home_dir()?.join(".claude/sessions").join(format!("{}.json", pid));
    let raw = fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    Some(SessionMeta {
        session_id: v.get("sessionId")?.as_str()?.to_string(),
        cwd: v.get("cwd").and_then(|c| c.as_str()).unwrap_or("").to_string(),
        name: v.get("name").and_then(|c| c.as_str()).map(str::to_string),
        version: v.get("version").and_then(|c| c.as_str()).map(str::to_string),
        status: v.get("status").and_then(|c| c.as_str()).map(str::to_string),
    })
}

/// Claude Code names a project directory after its cwd with every character
/// outside [A-Za-z0-9] replaced by a dash.
fn project_slug(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// The transcript for a session. Tries the slug the cwd implies, then falls
/// back to a scan — a session resumed under a different cwd keeps writing to
/// the directory it started in.
fn transcript_path(cwd: &str, session_id: &str) -> Option<PathBuf> {
    let projects = home_dir()?.join(".claude/projects");
    let file = format!("{}.jsonl", session_id);

    let direct = projects.join(project_slug(cwd)).join(&file);
    if direct.is_file() {
        return Some(direct);
    }
    for entry in fs::read_dir(&projects).ok()? {
        let candidate = entry.ok()?.path().join(&file);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[derive(Default)]
struct Totals {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
}

/// One turn's context breakdown, kept from the most recent main-thread reply.
#[derive(Default, Clone, Copy)]
struct ContextSnapshot {
    fresh_input: u64,
    cache_write: u64,
    cache_read: u64,
    reply: u64,
}

impl ContextSnapshot {
    fn total(&self) -> u64 {
        self.fresh_input + self.cache_write + self.cache_read + self.reply
    }
}

/// Incremental tail-reader over one session transcript.
struct TranscriptReader {
    path: PathBuf,
    /// Bytes consumed so far. Everything before this has been folded into the
    /// counters below and is never re-read.
    offset: u64,
    /// Bytes after `offset` that did not end in a newline — a turn caught
    /// mid-write, completed by the next refresh.
    partial: String,
    seen_requests: HashSet<String>,
    seen_order: VecDeque<String>,
    totals: Totals,
    context: ContextSnapshot,
    model: Option<String>,
    turns: u64,
    sidechain_output: u64,
    /// Sticky: a session that once held more than 200k tokens is on a 1M model
    /// and stays scaled that way, even after a compaction drops it back down.
    context_limit: u64,
    /// Bytes of transcript still unread as of the last refresh.
    pending_bytes: u64,
}

impl TranscriptReader {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            offset: 0,
            partial: String::new(),
            seen_requests: HashSet::new(),
            seen_order: VecDeque::new(),
            totals: Totals::default(),
            context: ContextSnapshot::default(),
            model: None,
            turns: 0,
            sidechain_output: 0,
            context_limit: BASE_CONTEXT_LIMIT,
            pending_bytes: 0,
        }
    }

    fn reset(&mut self) {
        let path = self.path.clone();
        *self = Self::new(path);
    }

    /// True the first time this request id is seen.
    fn claim_request(&mut self, id: &str) -> bool {
        if !self.seen_requests.insert(id.to_string()) {
            return false;
        }
        self.seen_order.push_back(id.to_string());
        if self.seen_order.len() > SEEN_REQUEST_HISTORY {
            if let Some(old) = self.seen_order.pop_front() {
                self.seen_requests.remove(&old);
            }
        }
        true
    }

    fn refresh(&mut self) {
        let len = match fs::metadata(&self.path) {
            Ok(m) => m.len(),
            Err(_) => return,
        };
        // Shorter than what we already consumed means the file was replaced
        // (a --resume rewrite, a cleared session); start over rather than
        // splice unrelated bytes onto our partial line.
        if len < self.offset {
            self.reset();
        }
        self.pending_bytes = len - self.offset;
        if len == self.offset {
            return;
        }

        let mut file = match fs::File::open(&self.path) {
            Ok(f) => f,
            Err(_) => return,
        };
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return;
        }
        let want = (len - self.offset).min(MAX_READ_PER_REFRESH);
        let mut buf = vec![0u8; want as usize];
        let read = match file.read(&mut buf) {
            Ok(n) => n,
            Err(_) => return,
        };
        buf.truncate(read);
        self.offset += read as u64;
        self.pending_bytes = len.saturating_sub(self.offset);

        let mut chunk = std::mem::take(&mut self.partial);
        chunk.push_str(&String::from_utf8_lossy(&buf));
        // Everything after the final newline is an unfinished line; hold it
        // back so it is parsed once, whole, on the next refresh.
        let split = match chunk.rfind('\n') {
            Some(i) => i + 1,
            None => {
                self.partial = chunk;
                return;
            }
        };
        self.partial = chunk[split..].to_string();
        for line in chunk[..split].lines() {
            self.ingest(line);
        }
    }

    fn ingest(&mut self, line: &str) {
        if line.is_empty() {
            return;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return,
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            return;
        }
        let message = match v.get("message") {
            Some(m) => m,
            None => return,
        };
        let usage = match message.get("usage") {
            Some(u) => u,
            None => return,
        };
        if let Some(id) = v.get("requestId").and_then(|r| r.as_str()) {
            if !self.claim_request(id) {
                return;
            }
        }

        let tok = |key: &str| usage.get(key).and_then(|n| n.as_u64()).unwrap_or(0);
        let fresh_input = tok("input_tokens");
        let cache_write = tok("cache_creation_input_tokens");
        let cache_read = tok("cache_read_input_tokens");
        let reply = tok("output_tokens");

        self.totals.input += fresh_input;
        self.totals.output += reply;
        self.totals.cache_read += cache_read;
        self.totals.cache_write += cache_write;

        // Subagents run against their own context window; their turns are
        // billed to the session but never occupy the main conversation.
        if v.get("isSidechain").and_then(|s| s.as_bool()).unwrap_or(false) {
            self.sidechain_output += reply;
            return;
        }

        self.turns += 1;
        if let Some(m) = message.get("model").and_then(|m| m.as_str()) {
            self.model = Some(m.to_string());
        }
        self.context = ContextSnapshot { fresh_input, cache_write, cache_read, reply };
        if self.context.total() > self.context_limit {
            self.context_limit = LARGE_CONTEXT_LIMIT;
        }
    }

    fn snapshot(&self, meta: &SessionMeta, reported: Option<&ReportedStatus>) -> AgentUsage {
        AgentUsage {
            session_id: meta.session_id.clone(),
            session_name: meta.name.clone(),
            // The bridge carries the id unabridged, `[1m]` suffix and all;
            // the transcript has it stripped.
            model: reported
                .and_then(|r| r.model.clone())
                .or_else(|| self.model.clone()),
            cli_version: meta.version.clone(),
            context_tokens: self.context.total(),
            context_limit: reported
                .and_then(|r| r.context_window_size)
                .filter(|n| *n > 0)
                .unwrap_or(self.context_limit),
            context_limit_source: match reported.and_then(|r| r.context_window_size) {
                Some(n) if n > 0 => "reported",
                _ => "inferred",
            },
            cache_read_tokens: self.context.cache_read,
            cache_write_tokens: self.context.cache_write,
            fresh_input_tokens: self.context.fresh_input,
            reply_tokens: self.context.reply,
            total_input_tokens: self.totals.input,
            total_output_tokens: self.totals.output,
            total_cache_read_tokens: self.totals.cache_read,
            total_cache_write_tokens: self.totals.cache_write,
            sidechain_output_tokens: self.sidechain_output,
            turns: self.turns,
            session_status: meta.status.clone(),
            catching_up: self.pending_bytes > 0,
            reported: reported.map(|r| r.details.clone()),
        }
    }
}

/// One of the account's rolling usage windows, as Claude Code last reported it.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitWindow {
    /// 0–100. Claude Code rounds this; a fraction is not a precision claim.
    pub used_percentage: f64,
    /// Unix seconds at which the window rolls over and usage drops to zero.
    pub resets_at: u64,
    /// Unix seconds when Claude Code last wrote this figure. Payloads only
    /// refresh while a session is rendering, so the UI can say how old it is.
    pub reported_at: u64,
}

/// The account's plan usage. Account-wide, so it is one figure for the whole
/// app rather than one per session. Either window may be absent — Claude Code
/// omits one it has no data for, and older CLIs send only the weekly one.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimits {
    pub five_hour: Option<RateLimitWindow>,
    pub seven_day: Option<RateLimitWindow>,
}

impl RateLimits {
    fn is_empty(&self) -> bool {
        self.five_hour.is_none() && self.seven_day.is_none()
    }
}

/// The freshest plan usage across every payload the bridge has stashed.
///
/// Each window is taken from whichever payload wrote it most recently, not the
/// focused session's: the limit is per account, so a busy session in another
/// pane has the newer number. `None` when the bridge is off or nothing has
/// reported yet.
pub fn read_rate_limits() -> Option<RateLimits> {
    read_rate_limits_in(&agent_status_bridge::sessions_dir().ok()?)
}

fn read_rate_limits_in(dir: &std::path::Path) -> Option<RateLimits> {
    let mut out = RateLimits::default();
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        // Skip the bridge script's in-flight temp files and anything else
        // that is not a stashed payload.
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || !name.ends_with(".json") {
            continue;
        }
        let reported_at = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        let reported_at = match reported_at {
            Some(t) => t,
            None => continue,
        };
        let raw = match fs::read_to_string(&path) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let v: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let limits = match v.get("rate_limits") {
            Some(l) if l.is_object() => l,
            _ => continue,
        };
        let window = |key: &str| -> Option<RateLimitWindow> {
            let w = limits.get(key)?;
            Some(RateLimitWindow {
                used_percentage: w.get("used_percentage")?.as_f64()?.clamp(0.0, 100.0),
                resets_at: w.get("resets_at")?.as_u64()?,
                reported_at,
            })
        };
        let newer = |cur: Option<RateLimitWindow>, cand: Option<RateLimitWindow>| match (cur, cand) {
            (Some(c), Some(n)) if n.reported_at >= c.reported_at => Some(n),
            (None, Some(n)) => Some(n),
            (c, _) => c,
        };
        out.five_hour = newer(out.five_hour, window("five_hour"));
        out.seven_day = newer(out.seven_day, window("seven_day"));
    }
    if out.is_empty() { None } else { Some(out) }
}

/// What the statusLine bridge stashed for a session, when it is installed.
struct ReportedStatus {
    context_window_size: Option<u64>,
    model: Option<String>,
    details: ReportedDetails,
}

/// Reads ~/.lever/agent-status/sessions/<id>.json, which the bridge script
/// rewrites on every Claude Code render. Absent whenever the bridge is off.
fn read_reported(session_id: &str) -> Option<ReportedStatus> {
    read_reported_in(&agent_status_bridge::sessions_dir().ok()?, session_id)
}

fn read_reported_in(dir: &std::path::Path, session_id: &str) -> Option<ReportedStatus> {
    let path = dir.join(format!("{}.json", session_id));
    let reported_at = fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let raw = fs::read_to_string(&path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;

    let at = |path: &[&str]| -> Option<&serde_json::Value> {
        path.iter().try_fold(&v, |cur, key| cur.get(key))
    };
    let string = |path: &[&str]| at(path).and_then(|x| x.as_str()).map(str::to_string);
    let u64_ = |path: &[&str]| at(path).and_then(|x| x.as_u64());
    let f64_ = |path: &[&str]| at(path).and_then(|x| x.as_f64());
    let bool_ = |path: &[&str]| at(path).and_then(|x| x.as_bool());

    Some(ReportedStatus {
        context_window_size: u64_(&["context_window", "context_window_size"]),
        model: string(&["model", "id"]),
        details: ReportedDetails {
            title: string(&["session_name"]).filter(|t| !t.trim().is_empty()),
            model_name: string(&["model", "display_name"]),
            effort: string(&["effort", "level"]),
            fast_mode: bool_(&["fast_mode"]),
            thinking: bool_(&["thinking", "enabled"]),
            cost_usd: f64_(&["cost", "total_cost_usd"]),
            duration_ms: u64_(&["cost", "total_duration_ms"]),
            api_duration_ms: u64_(&["cost", "total_api_duration_ms"]),
            lines_added: u64_(&["cost", "total_lines_added"]),
            lines_removed: u64_(&["cost", "total_lines_removed"]),
            cache_warm: bool_(&["prompt_cache", "warm"]),
            cache_ttl: string(&["prompt_cache", "ttl"]),
            cache_expires_at: u64_(&["prompt_cache", "expires_at"]),
            cache_hit_ratio: f64_(&["prompt_cache", "hit_ratio"]),
            cache_recache_tokens: u64_(&["prompt_cache", "recache_tokens_if_cold"]),
            reported_at,
        },
    })
}

#[cfg(test)]
impl AgentUsage {
    /// A usage record carrying nothing but a status, for exercising the
    /// busy/idle bookkeeping that hangs off it.
    pub fn with_status(status: Option<&str>) -> Self {
        Self {
            session_id: String::new(),
            session_name: None,
            model: None,
            cli_version: None,
            context_tokens: 0,
            context_limit: BASE_CONTEXT_LIMIT,
            context_limit_source: "inferred",
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            fresh_input_tokens: 0,
            reply_tokens: 0,
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_cache_read_tokens: 0,
            total_cache_write_tokens: 0,
            sidechain_output_tokens: 0,
            turns: 0,
            session_status: status.map(str::to_string),
            catching_up: false,
            reported: None,
        }
    }
}

/// Keeps one reader per session across polls so transcripts are parsed once.
#[derive(Default)]
pub struct UsageTracker {
    readers: HashMap<String, TranscriptReader>,
}

impl UsageTracker {
    /// Usage for each of `agents` (pty_id -> agent pid) that turns out to be a
    /// Claude Code session. PTYs running something else are simply absent.
    pub fn collect(&mut self, agents: &[(String, u32)]) -> HashMap<String, AgentUsage> {
        let mut out = HashMap::new();
        let mut live: HashSet<String> = HashSet::new();

        for (pty_id, pid) in agents {
            let meta = match read_session_meta(*pid) {
                Some(m) => m,
                None => continue,
            };
            live.insert(meta.session_id.clone());

            let reader = match self.readers.entry(meta.session_id.clone()) {
                std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
                std::collections::hash_map::Entry::Vacant(e) => {
                    let path = match transcript_path(&meta.cwd, &meta.session_id) {
                        Some(p) => p,
                        None => continue,
                    };
                    e.insert(TranscriptReader::new(path))
                }
            };
            // A transcript that vanished (session deleted) leaves the reader
            // serving its last good numbers rather than blanking the meter.
            if reader.path.exists() {
                reader.refresh();
            }
            out.insert(pty_id.clone(), reader.snapshot(&meta, read_reported(&meta.session_id).as_ref()));
        }

        self.readers.retain(|session_id, _| live.contains(session_id));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn turn(req: &str, sidechain: bool, input: u64, cw: u64, cr: u64, out: u64) -> String {
        format!(
            r#"{{"type":"assistant","requestId":"{}","isSidechain":{},"message":{{"model":"claude-opus-5","usage":{{"input_tokens":{},"cache_creation_input_tokens":{},"cache_read_input_tokens":{},"output_tokens":{}}}}}}}"#,
            req, sidechain, input, cw, cr, out
        )
    }

    fn reader_over(lines: &[String]) -> (TranscriptReader, tempfile_path::Temp) {
        let temp = tempfile_path::Temp::new();
        let mut f = fs::File::create(&temp.0).unwrap();
        for l in lines {
            writeln!(f, "{}", l).unwrap();
        }
        let mut r = TranscriptReader::new(temp.0.clone());
        r.refresh();
        (r, temp)
    }

    /// Minimal scratch-file helper; the crate has no dev-dependencies. The
    /// name comes off a counter, not the clock — macOS timestamps are coarse
    /// enough that two tests starting together would land on one file.
    mod tempfile_path {
        use std::path::PathBuf;
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        pub struct Temp(pub PathBuf);
        impl Temp {
            pub fn new() -> Self {
                let n = SEQ.fetch_add(1, Ordering::Relaxed);
                Temp(std::env::temp_dir()
                    .join(format!("lever-usage-{}-{}.jsonl", std::process::id(), n)))
            }
        }
        impl Drop for Temp {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
    }

    #[test]
    fn context_comes_from_the_last_main_thread_turn() {
        let (r, _t) = reader_over(&[
            turn("req_a", false, 5, 100, 1_000, 50),
            turn("req_b", false, 2, 200, 1_500, 80),
        ]);
        assert_eq!(r.context.total(), 2 + 200 + 1_500 + 80);
        assert_eq!(r.turns, 2);
        assert_eq!(r.model.as_deref(), Some("claude-opus-5"));
    }

    #[test]
    fn repeated_request_ids_are_counted_once() {
        // One API response is written as one line per content block, each
        // carrying an identical usage object.
        let (r, _t) = reader_over(&[
            turn("req_a", false, 5, 100, 1_000, 50),
            turn("req_a", false, 5, 100, 1_000, 50),
            turn("req_a", false, 5, 100, 1_000, 50),
        ]);
        assert_eq!(r.turns, 1);
        assert_eq!(r.totals.output, 50);
        assert_eq!(r.totals.cache_read, 1_000);
    }

    #[test]
    fn subagent_turns_bill_but_do_not_enter_the_context() {
        let (r, _t) = reader_over(&[
            turn("req_a", false, 5, 100, 1_000, 50),
            turn("req_sub", true, 9, 900, 90_000, 400),
        ]);
        assert_eq!(r.context.total(), 5 + 100 + 1_000 + 50);
        assert_eq!(r.turns, 1);
        assert_eq!(r.sidechain_output, 400);
        assert_eq!(r.totals.output, 450);
    }

    #[test]
    fn a_turn_past_the_base_window_scales_the_limit_and_stays_scaled() {
        let (mut r, _t) = reader_over(&[turn("req_a", false, 10, 0, 400_000, 100)]);
        assert_eq!(r.context_limit, LARGE_CONTEXT_LIMIT);
        // A compaction drops the conversation back under 200k; the window it
        // is being measured against has not changed.
        r.ingest(&turn("req_b", false, 10, 0, 20_000, 100));
        assert_eq!(r.context_limit, LARGE_CONTEXT_LIMIT);
    }

    #[test]
    fn a_half_written_line_is_parsed_once_it_completes() {
        let temp = tempfile_path::Temp::new();
        let complete = turn("req_a", false, 5, 100, 1_000, 50);
        let next = turn("req_b", false, 2, 200, 1_500, 80);
        fs::write(&temp.0, format!("{}\n{}", complete, &next[..40])).unwrap();

        let mut r = TranscriptReader::new(temp.0.clone());
        r.refresh();
        assert_eq!(r.turns, 1);

        // The rest of the turn lands; nothing is dropped or double-counted.
        let mut f = fs::OpenOptions::new().append(true).open(&temp.0).unwrap();
        writeln!(f, "{}", &next[40..]).unwrap();
        r.refresh();
        assert_eq!(r.turns, 2);
        assert_eq!(r.context.total(), 2 + 200 + 1_500 + 80);
    }

    #[test]
    fn a_replaced_transcript_starts_over_instead_of_splicing() {
        let (mut r, t) = reader_over(&[
            turn("req_a", false, 5, 100, 1_000, 50),
            turn("req_b", false, 2, 200, 1_500, 80),
        ]);
        assert_eq!(r.turns, 2);
        fs::write(&t.0, format!("{}\n", turn("req_c", false, 1, 10, 20, 30))).unwrap();
        r.refresh();
        assert_eq!(r.turns, 1);
        assert_eq!(r.context.total(), 1 + 10 + 20 + 30);
    }

    fn scratch_dir(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "lever-reported-{}-{}-{}", tag, std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_reported_window_overrides_the_inferred_one() {
        let dir = scratch_dir("override");
        fs::write(
            dir.join("s1.json"),
            r#"{"session_id":"s1","model":{"id":"claude-opus-5[1m]"},"context_window":{"context_window_size":1000000}}"#,
        ).unwrap();

        let reported = read_reported_in(&dir, "s1").unwrap();
        assert_eq!(reported.context_window_size, Some(1_000_000));
        // The suffix the transcript strips is the whole point of the bridge.
        assert_eq!(reported.model.as_deref(), Some("claude-opus-5[1m]"));

        let (r, _t) = reader_over(&[turn("req_a", false, 5, 100, 1_000, 50)]);
        let meta = SessionMeta {
            session_id: "s1".into(), cwd: String::new(),
            name: None, version: None, status: None,
        };
        let with = r.snapshot(&meta, Some(&reported));
        assert_eq!(with.context_limit, 1_000_000);
        assert_eq!(with.context_limit_source, "reported");
        assert_eq!(with.model.as_deref(), Some("claude-opus-5[1m]"));

        // Without the bridge the same reader falls back to its own guess.
        let without = r.snapshot(&meta, None);
        assert_eq!(without.context_limit, BASE_CONTEXT_LIMIT);
        assert_eq!(without.context_limit_source, "inferred");
        assert_eq!(without.model.as_deref(), Some("claude-opus-5"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_or_junk_payload_falls_back_instead_of_erroring() {
        let dir = scratch_dir("junk");
        assert!(read_reported_in(&dir, "nope").is_none());
        fs::write(dir.join("bad.json"), "{ half written").unwrap();
        assert!(read_reported_in(&dir, "bad").is_none());
        // Present but without the field: no window, so the guess stands.
        fs::write(dir.join("thin.json"), r#"{"session_id":"thin"}"#).unwrap();
        let thin = read_reported_in(&dir, "thin").unwrap();
        assert_eq!(thin.context_window_size, None);

        let (r, _t) = reader_over(&[turn("req_a", false, 5, 100, 1_000, 50)]);
        let meta = SessionMeta {
            session_id: "thin".into(), cwd: String::new(), name: None,
            version: None, status: None,
        };
        let snap = r.snapshot(&meta, Some(&thin));
        assert_eq!(snap.context_limit, BASE_CONTEXT_LIMIT);
        assert_eq!(snap.context_limit_source, "inferred");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_backlog_is_flagged_until_the_reader_catches_up() {
        // One turn per line, more than a single refresh can swallow.
        let temp = tempfile_path::Temp::new();
        let lines: Vec<String> = (0..40_000)
            .map(|i| turn(&format!("req_{i}"), false, 2, 10, 1_000, 50))
            .collect();
        fs::write(&temp.0, lines.join("\n") + "\n").unwrap();
        assert!(fs::metadata(&temp.0).unwrap().len() > MAX_READ_PER_REFRESH);

        let mut r = TranscriptReader::new(temp.0.clone());
        r.refresh();
        assert!(r.pending_bytes > 0, "a backlog this size cannot be one read");
        assert!(r.turns < 40_000, "should not have finished yet");

        while r.pending_bytes > 0 {
            r.refresh();
        }
        assert_eq!(r.turns, 40_000);
        assert_eq!(r.totals.output, 40_000 * 50);
    }

    #[test]
    fn slug_matches_claude_codes_project_directory_naming() {
        assert_eq!(project_slug("/Users/onil/Repos/Personal/lever"), "-Users-onil-Repos-Personal-lever");
        assert_eq!(project_slug("/a/b.c_d"), "-a-b-c-d");
    }

    /// A scratch payload directory, one per test.
    struct PayloadDir(PathBuf);
    impl PayloadDir {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir()
                .join(format!("lever-limits-{}-{}", tag, std::process::id()));
            let _ = fs::remove_dir_all(&p);
            fs::create_dir_all(&p).unwrap();
            PayloadDir(p)
        }
        fn write(&self, name: &str, body: &str, mtime_offset_secs: i64) {
            let path = self.0.join(name);
            fs::write(&path, body).unwrap();
            // Ordering is by mtime, so each file is stamped explicitly — two
            // writes in one test would otherwise land on the same second.
            let t = std::time::SystemTime::now()
                .checked_sub(std::time::Duration::from_secs((-mtime_offset_secs).max(0) as u64))
                .unwrap();
            fs::File::open(&path).unwrap().set_modified(t).unwrap();
        }
    }
    impl Drop for PayloadDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn each_window_comes_from_the_freshest_payload_that_has_it() {
        let d = PayloadDir::new("freshest");
        // An old session that saw both windows...
        d.write(
            "old.json",
            r#"{"session_id":"old","rate_limits":{"five_hour":{"used_percentage":40,"resets_at":100},"seven_day":{"used_percentage":9,"resets_at":900}}}"#,
            -600,
        );
        // ...and a newer one that only reported the weekly window.
        d.write(
            "new.json",
            r#"{"session_id":"new","rate_limits":{"seven_day":{"used_percentage":12,"resets_at":900}}}"#,
            -5,
        );
        let l = read_rate_limits_in(&d.0).unwrap();
        assert_eq!(l.five_hour.unwrap().used_percentage, 40.0);
        assert_eq!(l.seven_day.unwrap().used_percentage, 12.0);
        assert!(l.seven_day.unwrap().reported_at > l.five_hour.unwrap().reported_at);
    }

    #[test]
    fn payloads_without_limits_and_stray_files_are_ignored() {
        let d = PayloadDir::new("ignore");
        d.write("a.json", r#"{"session_id":"a","rate_limits":null}"#, -1);
        d.write("b.json", r#"{"session_id":"b"}"#, -1);
        d.write("c.json", "{ not json", -1);
        d.write(".sid.123.tmp", r#"{"rate_limits":{"five_hour":{"used_percentage":99,"resets_at":1}}}"#, 0);
        assert!(read_rate_limits_in(&d.0).is_none());
    }

    #[test]
    fn a_full_payload_yields_every_reported_detail() {
        let d = PayloadDir::new("reported");
        d.write(
            "sid-1.json",
            r#"{"session_id":"sid-1","session_name":"Usage display","effort":{"level":"high"},
                "model":{"id":"claude-fable-5-1[1m]","display_name":"Fable 5.1"},
                "cost":{"total_cost_usd":0.4377,"total_duration_ms":118239,"total_api_duration_ms":38721,"total_lines_added":12,"total_lines_removed":3},
                "context_window":{"context_window_size":1000000},
                "prompt_cache":{"warm":true,"ttl":"1h","expires_at":1788735617,"hit_ratio":0.91,"recache_tokens_if_cold":42474},
                "fast_mode":false,"thinking":{"enabled":true}}"#,
            -2,
        );
        let r = read_reported_in(&d.0, "sid-1").unwrap();
        assert_eq!(r.context_window_size, Some(1_000_000));
        assert_eq!(r.model.as_deref(), Some("claude-fable-5-1[1m]"));
        let x = r.details;
        assert_eq!(x.title.as_deref(), Some("Usage display"));
        assert_eq!(x.model_name.as_deref(), Some("Fable 5.1"));
        assert_eq!(x.effort.as_deref(), Some("high"));
        assert_eq!(x.fast_mode, Some(false));
        assert_eq!(x.thinking, Some(true));
        assert_eq!(x.cost_usd, Some(0.4377));
        assert_eq!(x.lines_added, Some(12));
        assert_eq!(x.lines_removed, Some(3));
        assert_eq!(x.cache_warm, Some(true));
        assert_eq!(x.cache_ttl.as_deref(), Some("1h"));
        assert_eq!(x.cache_expires_at, Some(1_788_735_617));
        assert_eq!(x.cache_recache_tokens, Some(42_474));
        assert!(x.reported_at > 0);
    }

    #[test]
    fn a_sparse_payload_leaves_the_rest_none() {
        let d = PayloadDir::new("sparse");
        d.write("sid-2.json", r#"{"session_id":"sid-2","session_name":"  ","model":{"id":"claude-opus-5"}}"#, -1);
        let r = read_reported_in(&d.0, "sid-2").unwrap();
        assert!(r.context_window_size.is_none());
        // A blank title is no title.
        assert!(r.details.title.is_none());
        assert!(r.details.cost_usd.is_none());
        assert!(read_reported_in(&d.0, "sid-missing").is_none());
    }

    #[test]
    fn a_missing_directory_yields_nothing() {
        assert!(read_rate_limits_in(std::path::Path::new("/nonexistent/lever-limits")).is_none());
    }
}

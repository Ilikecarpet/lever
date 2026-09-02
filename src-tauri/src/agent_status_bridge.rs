//! Bridges Claude Code's statusLine hook into Lever.
//!
//! The transcript records a model as `claude-opus-5` whether or not the session
//! is on the 1M-context variant, so the window a session is measured against
//! cannot be read from it. Claude Code will hand over the real figure, but only
//! through `statusLine`: a command named in settings that it pipes a JSON blob
//! to on every render, carrying `context_window.context_window_size` along with
//! the model, session id, and rate limits.
//!
//! So this installs a shell script into that slot which stashes each payload
//! under ~/.lever/agent-status/sessions/<session id>.json for `agent_usage` to
//! read. It is opt-in, because the slot lives in the user's *global* Claude
//! Code settings and affects every session on the machine, not just Lever's.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// Where payloads land, and where the script and the chained command live.
const BRIDGE_SUBDIR: &str = ".lever/agent-status";
const SCRIPT_NAME: &str = "statusline.sh";
/// Holds whatever occupied the statusLine slot before Lever took it, so the
/// script can keep calling it and uninstall can hand the slot back.
const CHAIN_FILE: &str = "chained-command";

/// A payload older than this belongs to a session that has long since ended.
const STALE_PAYLOAD_SECS: u64 = 7 * 24 * 60 * 60;

fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not set".to_string())
}

// Everything below is written against an explicit home so the tests can point
// it at a scratch directory. Mutating $HOME in-process would race every other
// thread's getenv.

fn bridge_dir_in(home: &Path) -> PathBuf {
    home.join(BRIDGE_SUBDIR)
}

fn sessions_dir_in(home: &Path) -> PathBuf {
    bridge_dir_in(home).join("sessions")
}

fn script_path_in(home: &Path) -> PathBuf {
    bridge_dir_in(home).join(SCRIPT_NAME)
}

fn chain_path_in(home: &Path) -> PathBuf {
    bridge_dir_in(home).join(CHAIN_FILE)
}

fn settings_path_in(home: &Path) -> PathBuf {
    home.join(".claude/settings.json")
}

pub fn sessions_dir() -> Result<PathBuf, String> {
    Ok(sessions_dir_in(&home()?))
}

/// POSIX sh, and no `jq` — Claude Code's own examples reach for it, but it is
/// not on a stock macOS and a missing binary here would break the status line
/// for every session on the machine. Whitespace is stripped before the match so
/// the session id is found whether the payload is compact or pretty-printed.
fn script_body(home: &Path) -> String {
    format!(
        r#"#!/bin/sh
# Installed by Lever, and removed when you turn the bridge off in Settings.
# Claude Code pipes its statusLine payload here on every render; this stashes it
# where Lever can read the session's real context window, then hands the same
# payload to whatever statusLine command was configured before Lever took the
# slot (so its output, not this script's, is what you see).

payload=$(cat)
dir="{sessions}"

sid=$(printf '%s' "$payload" | tr -d '\n\r\t ' \
  | sed -n 's/.*"session_id":"\([^"]*\)".*/\1/p')

if [ -n "$sid" ]; then
  mkdir -p "$dir"
  tmp="$dir/.$sid.$$.tmp"
  # Written aside and moved into place so Lever never reads a half-written file.
  if printf '%s' "$payload" > "$tmp" 2>/dev/null; then
    mv -f "$tmp" "$dir/$sid.json" 2>/dev/null || rm -f "$tmp"
  fi
fi

chain="{chain}"
if [ -s "$chain" ]; then
  printf '%s' "$payload" | sh -c "$(cat "$chain")"
fi
# With nothing chained this prints nothing, and Claude Code shows no status
# line — exactly as it did before the bridge was installed.
"#,
        sessions = sessions_dir_in(home).display(),
        chain = chain_path_in(home).display(),
    )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeState {
    /// Lever's script currently occupies the statusLine slot.
    pub installed: bool,
    /// Another statusLine command is installed that is not ours. Turning the
    /// bridge on will chain to it rather than replace it.
    pub foreign_command: Option<String>,
}

fn read_settings(home: &Path) -> Result<serde_json::Value, String> {
    let path = settings_path_in(home);
    match fs::read_to_string(&path) {
        Ok(raw) if raw.trim().is_empty() => Ok(serde_json::json!({})),
        Ok(raw) => serde_json::from_str(&raw)
            .map_err(|e| format!("~/.claude/settings.json is not valid JSON: {}", e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
        Err(e) => Err(format!("could not read ~/.claude/settings.json: {}", e)),
    }
}

/// Rewrites settings.json through a temp file in the same directory, so a
/// crash mid-write cannot leave the user without a Claude Code config.
fn write_settings(home: &Path, value: &serde_json::Value) -> Result<(), String> {
    let path = settings_path_in(home);
    let parent = path.parent().ok_or("settings.json has no parent directory")?;
    fs::create_dir_all(parent).map_err(|e| format!("could not create ~/.claude: {}", e))?;
    let body = serde_json::to_string_pretty(value)
        .map_err(|e| format!("could not serialize settings: {}", e))?;
    let tmp = path.with_extension("json.lever-tmp");
    fs::write(&tmp, format!("{}\n", body))
        .map_err(|e| format!("could not write settings: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| format!("could not replace settings: {}", e))
}

fn command_of(settings: &serde_json::Value) -> Option<String> {
    settings
        .get("statusLine")?
        .get("command")?
        .as_str()
        .map(str::to_string)
}

fn is_ours(command: &str) -> bool {
    command.contains(&format!("{}/{}", BRIDGE_SUBDIR, SCRIPT_NAME))
}

pub fn state() -> Result<BridgeState, String> {
    state_in(&home()?)
}

fn state_in(home: &Path) -> Result<BridgeState, String> {
    let settings = read_settings(home)?;
    let command = command_of(&settings);
    let installed = command.as_deref().map(is_ours).unwrap_or(false);
    // A script left behind with the slot pointing elsewhere is not installed.
    let installed = installed && script_path_in(home).is_file();
    Ok(BridgeState {
        foreign_command: match &command {
            Some(c) if !is_ours(c) => Some(c.clone()),
            _ => None,
        },
        installed,
    })
}

pub fn install() -> Result<BridgeState, String> {
    install_in(&home()?)
}

fn install_in(home: &Path) -> Result<BridgeState, String> {
    let dir = bridge_dir_in(home);
    fs::create_dir_all(sessions_dir_in(home))
        .map_err(|e| format!("could not create {}: {}", dir.display(), e))?;

    let script = script_path_in(home);
    fs::write(&script, script_body(home))
        .map_err(|e| format!("could not write the bridge script: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("could not make the bridge script executable: {}", e))?;
    }

    let mut settings = read_settings(home)?;
    // Remember an existing command before overwriting the slot — the script
    // calls it, and uninstall puts it back.
    match command_of(&settings) {
        Some(existing) if !is_ours(&existing) => {
            fs::write(chain_path_in(home), &existing)
                .map_err(|e| format!("could not record the existing statusLine: {}", e))?;
        }
        None => {
            let _ = fs::remove_file(chain_path_in(home));
        }
        _ => {}
    }

    let obj = settings
        .as_object_mut()
        .ok_or("~/.claude/settings.json is not a JSON object")?;
    // Preserve any other keys on statusLine (padding, type) the user had set.
    let entry = obj
        .entry("statusLine")
        .or_insert_with(|| serde_json::json!({}));
    if !entry.is_object() {
        *entry = serde_json::json!({});
    }
    let entry = entry.as_object_mut().unwrap();
    entry.insert("type".into(), serde_json::json!("command"));
    entry.insert(
        "command".into(),
        serde_json::json!(script.to_string_lossy()),
    );

    write_settings(home, &settings)?;
    prune_stale_payloads_in(home);
    state_in(home)
}

pub fn uninstall() -> Result<BridgeState, String> {
    uninstall_in(&home()?)
}

fn uninstall_in(home: &Path) -> Result<BridgeState, String> {
    let mut settings = read_settings(home)?;
    let ours = command_of(&settings).map(|c| is_ours(&c)).unwrap_or(false);

    if ours {
        let chained = fs::read_to_string(chain_path_in(home)).ok().filter(|c| !c.trim().is_empty());
        let obj = settings
            .as_object_mut()
            .ok_or("~/.claude/settings.json is not a JSON object")?;
        match chained {
            // Hand the slot back to whatever held it before.
            Some(cmd) => {
                let entry = obj
                    .entry("statusLine")
                    .or_insert_with(|| serde_json::json!({}));
                if let Some(e) = entry.as_object_mut() {
                    e.insert("command".into(), serde_json::json!(cmd.trim()));
                }
            }
            None => {
                obj.remove("statusLine");
            }
        }
        write_settings(home, &settings)?;
    }

    let _ = fs::remove_file(script_path_in(home));
    let _ = fs::remove_file(chain_path_in(home));
    state_in(home)
}

/// Payloads outlive the sessions that wrote them; a session whose id no longer
/// matches a live process is never read again.
fn prune_stale_payloads_in(home: &Path) {
    let dir = sessions_dir_in(home);
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let cutoff = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(STALE_PAYLOAD_SECS));
    let cutoff = match cutoff {
        Some(c) => c,
        None => return,
    };
    for entry in entries.flatten() {
        let modified = entry.metadata().and_then(|m| m.modified());
        if let Ok(modified) = modified {
            if modified < cutoff {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::io::Write;

    pub struct FakeHome(pub PathBuf);
    impl FakeHome {
        pub fn new(tag: &str) -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static SEQ: AtomicU64 = AtomicU64::new(0);
            let n = SEQ.fetch_add(1, Ordering::Relaxed);
            let p = std::env::temp_dir()
                .join(format!("lever-bridge-{}-{}-{}", tag, std::process::id(), n));
            fs::create_dir_all(p.join(BRIDGE_SUBDIR)).unwrap();
            FakeHome(p)
        }
    }

    impl Drop for FakeHome {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    /// Runs the installed script the way Claude Code does: payload on stdin.
    fn run_script(home: &PathBuf, payload: &str) -> String {
        let script = home.join(BRIDGE_SUBDIR).join(SCRIPT_NAME);
        let mut child = Command::new("/bin/sh")
            .arg(&script)
            .env("HOME", home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.as_mut().unwrap().write_all(payload.as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    fn write_script(home: &PathBuf) {
        let dir = home.join(BRIDGE_SUBDIR);
        fs::create_dir_all(dir.join("sessions")).unwrap();
        fs::write(dir.join(SCRIPT_NAME), script_body(home)).unwrap();
    }

    const PAYLOAD: &str = r#"{"session_id":"abc-123","model":{"id":"claude-opus-5[1m]","display_name":"Opus 5"},"context_window":{"context_window_size":1000000,"used_percentage":9.2}}"#;

    #[test]
    fn the_script_stashes_the_payload_under_its_session_id() {
        let home = FakeHome::new("stash");
        write_script(&home.0);
        let printed = run_script(&home.0, PAYLOAD);

        let stashed = home.0.join(BRIDGE_SUBDIR).join("sessions/abc-123.json");
        assert_eq!(fs::read_to_string(&stashed).unwrap(), PAYLOAD);
        // Nothing chained, so nothing is printed and no status line appears.
        assert_eq!(printed, "");
    }

    #[test]
    fn a_pretty_printed_payload_still_yields_the_session_id() {
        let home = FakeHome::new("pretty");
        write_script(&home.0);
        let pretty = serde_json::to_string_pretty(
            &serde_json::from_str::<serde_json::Value>(PAYLOAD).unwrap(),
        ).unwrap();
        run_script(&home.0, &pretty);
        assert!(home.0.join(BRIDGE_SUBDIR).join("sessions/abc-123.json").is_file());
    }

    #[test]
    fn a_chained_command_gets_the_payload_and_owns_the_output() {
        let home = FakeHome::new("chain");
        write_script(&home.0);
        fs::write(
            home.0.join(BRIDGE_SUBDIR).join(CHAIN_FILE),
            "sed -n 's/.*\"display_name\":\"\\([^\"]*\\)\".*/\\1/p'",
        ).unwrap();

        let printed = run_script(&home.0, PAYLOAD);
        assert_eq!(printed.trim(), "Opus 5");
        // Stashing still happened alongside the passthrough.
        assert!(home.0.join(BRIDGE_SUBDIR).join("sessions/abc-123.json").is_file());
    }

    #[test]
    fn a_payload_with_no_session_id_is_dropped_without_erroring() {
        let home = FakeHome::new("nosid");
        write_script(&home.0);
        let printed = run_script(&home.0, r#"{"model":{"id":"x"}}"#);
        assert_eq!(printed, "");
        let dir = home.0.join(BRIDGE_SUBDIR).join("sessions");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
    }
}

#[cfg(test)]
mod install_tests {
    use super::*;
    use super::tests::FakeHome;

    /// A scratch home per test. Nothing here touches the process environment,
    /// so these run in parallel with everything else.
    fn with_home<T>(tag: &str, f: impl FnOnce(&PathBuf) -> T) -> T {
        let home = FakeHome::new(tag);
        f(&home.0)
    }

    fn settings_of(home: &PathBuf) -> serde_json::Value {
        serde_json::from_str(
            &fs::read_to_string(home.join(".claude/settings.json")).unwrap(),
        ).unwrap()
    }

    #[test]
    fn install_claims_the_slot_and_uninstall_gives_it_back_empty() {
        with_home("roundtrip", |home| {
            fs::create_dir_all(home.join(".claude")).unwrap();
            fs::write(
                home.join(".claude/settings.json"),
                r#"{"effortLevel":"high","permissions":{"defaultMode":"auto"}}"#,
            ).unwrap();

            let st = install_in(home).unwrap();
            assert!(st.installed);
            assert!(st.foreign_command.is_none());
            let s = settings_of(home);
            assert!(s["statusLine"]["command"].as_str().unwrap().contains(SCRIPT_NAME));
            assert_eq!(s["statusLine"]["type"], "command");
            // Unrelated settings survive the rewrite.
            assert_eq!(s["effortLevel"], "high");
            assert_eq!(s["permissions"]["defaultMode"], "auto");

            let st = uninstall_in(home).unwrap();
            assert!(!st.installed);
            let s = settings_of(home);
            assert!(s.get("statusLine").is_none());
            assert_eq!(s["effortLevel"], "high");
            assert!(!home.join(BRIDGE_SUBDIR).join(SCRIPT_NAME).exists());
        });
    }

    #[test]
    fn an_existing_statusline_is_chained_and_then_handed_back() {
        with_home("chainback", |home| {
            fs::create_dir_all(home.join(".claude")).unwrap();
            fs::write(
                home.join(".claude/settings.json"),
                r#"{"statusLine":{"type":"command","command":"my-own-line --fancy","padding":0}}"#,
            ).unwrap();

            let st = install_in(home).unwrap();
            assert!(st.installed);
            // The script now calls it...
            assert_eq!(
                fs::read_to_string(home.join(BRIDGE_SUBDIR).join(CHAIN_FILE)).unwrap(),
                "my-own-line --fancy"
            );
            // ...and unrelated keys on the entry are left alone.
            assert_eq!(settings_of(home)["statusLine"]["padding"], 0);

            uninstall_in(home).unwrap();
            let s = settings_of(home);
            assert_eq!(s["statusLine"]["command"], "my-own-line --fancy");
            assert_eq!(s["statusLine"]["padding"], 0);
        });
    }

    #[test]
    fn installing_with_no_settings_file_at_all_works() {
        with_home("nosettings", |home| {
            let st = install_in(home).unwrap();
            assert!(st.installed);
            assert!(settings_of(home)["statusLine"]["command"].is_string());
            uninstall_in(home).unwrap();
            assert!(settings_of(home).get("statusLine").is_none());
        });
    }

    #[test]
    fn malformed_settings_are_reported_rather_than_overwritten() {
        with_home("malformed", |home| {
            fs::create_dir_all(home.join(".claude")).unwrap();
            fs::write(home.join(".claude/settings.json"), "{ not json").unwrap();
            let err = install_in(home).unwrap_err();
            assert!(err.contains("not valid JSON"), "{}", err);
            // The user's file is untouched.
            assert_eq!(
                fs::read_to_string(home.join(".claude/settings.json")).unwrap(),
                "{ not json"
            );
        });
    }
}

//! Chat panes: a coding agent spoken to over the Agent Client Protocol.
//!
//! ACP is JSON-RPC over stdio, one message per line. The backend is only the
//! pipe: it starts the agent's ACP adapter in the pane's checkout, hands every
//! line the agent prints to the window that owns the chat, and writes back
//! whatever the window sends. The protocol itself — the handshake, prompts,
//! permission requests, the transcript — lives in the UI, which is the only
//! thing that has a use for it.
//!
//! A chat belongs to its window the way a shell does: it is stopped when its
//! pane closes, when its window closes, and when Lever quits.

use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::process::CommandExt;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::Emitter;

/// The agents a chat can talk to, by the id the UI uses, and the ACP adapter
/// package each runs through. Pinned so an update to an adapter cannot change
/// the protocol under a released Lever; npx fetches and caches each on first use.
const AGENTS: &[(&str, &str)] = &[
    ("claude", "@agentclientprotocol/claude-agent-acp@0.90.0"),
    ("codex", "@agentclientprotocol/codex-acp@2.2.2"),
];

/// Most files a mention list is built from; past this a repo is vendoring
/// something, and the first slice is as useful as the rest.
const MAX_LISTED_FILES: usize = 50_000;

/// How much of the adapter's stderr to keep for explaining why it exited.
const STDERR_TAIL_LINES: usize = 20;

struct Session {
    stdin: ChildStdin,
    pid: u32,
    window: String,
}

impl Drop for Session {
    /// npx runs the adapter as its own child, so the whole group goes.
    fn drop(&mut self) {
        unsafe {
            libc::kill(-(self.pid as i32), libc::SIGTERM);
        }
    }
}

fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone, Serialize)]
struct AcpLine {
    line: String,
}

#[derive(Clone, Serialize)]
struct AcpExit {
    code: Option<i32>,
    /// The last few lines the adapter wrote to stderr — why it could not start
    /// (no Node, not signed in) is there, not on the protocol.
    stderr: String,
}

/// Start an agent for the chat `chat_id`. The window subscribes to
/// `acp-msg-{chat_id}` and `acp-exit-{chat_id}` before calling this, so it
/// cannot miss the agent's first lines.
#[tauri::command(async)]
pub fn acp_start(chat_id: String, cwd: String, agent: String, window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    if sessions().lock().unwrap().contains_key(&chat_id) {
        return Err(format!("Chat {} is already running", chat_id));
    }
    let adapter = AGENTS
        .iter()
        .find(|(id, _)| *id == agent)
        .map(|(_, pkg)| *pkg)
        .ok_or_else(|| format!("Unknown agent {}", agent))?;

    let mut cmd = Command::new("npx");
    cmd.args(["-y", adapter])
        .current_dir(&cwd)
        // Lever started from the Dock has launchd's PATH, which has no Node.
        .env("PATH", crate::get_shell_path())
        // Set when Lever itself was launched from inside a Claude Code session;
        // the agent would take it to mean it is nested in one.
        .env_remove("CLAUDECODE")
        .env_remove("CLAUDE_CODE_ENTRYPOINT")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut child = cmd.spawn().map_err(|e| format!("Failed to start the agent (npx {}): {}", adapter, e))?;
    let pid = child.id();
    let stdin = child.stdin.take().ok_or("Agent has no stdin")?;
    let stdout = child.stdout.take().ok_or("Agent has no stdout")?;
    let stderr = child.stderr.take().ok_or("Agent has no stderr")?;

    let window_label = window.label().to_string();
    sessions().lock().unwrap().insert(chat_id.clone(), Session { stdin, pid, window: window_label.clone() });
    crate::debug_action("chat", &format!("start {} in {} ({})", agent, cwd, chat_id));

    let tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    let tail_writer = tail.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let mut t = tail_writer.lock().unwrap();
            if t.len() == STDERR_TAIL_LINES {
                t.pop_front();
            }
            t.push_back(line);
        }
    });

    std::thread::spawn(move || {
        let msg_event = format!("acp-msg-{}", chat_id);
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            let _ = app.emit_to(window_label.as_str(), &msg_event, AcpLine { line });
        }
        let code = child.wait().ok().and_then(|s| s.code());
        // A chat that ended on its own is gone; one stopped by Lever already is.
        sessions().lock().unwrap().remove(&chat_id);
        let stderr = tail.lock().unwrap().iter().cloned().collect::<Vec<_>>().join("\n");
        let _ = app.emit_to(window_label.as_str(), &format!("acp-exit-{}", chat_id), AcpExit { code, stderr });
    });

    Ok(())
}

/// Write one JSON-RPC message to the chat's agent.
#[tauri::command]
pub fn acp_send(chat_id: String, line: String) -> Result<(), String> {
    let mut sessions = sessions().lock().unwrap();
    let session = sessions.get_mut(&chat_id).ok_or("The agent is not running")?;
    session.stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    session.stdin.write_all(b"\n").map_err(|e| e.to_string())?;
    session.stdin.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn acp_stop(chat_id: String) {
    sessions().lock().unwrap().remove(&chat_id);
}

/// Largest image a chat sends to its agent inline.
const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageFile {
    mime_type: String,
    /// base64, as ACP image blocks carry it
    data: String,
}

/// An image file from disk, ready to attach to a prompt. The web view gets
/// only a path from a native file picker or drop, not the bytes.
#[tauri::command(async)]
pub fn acp_read_image(path: String) -> Result<ImageFile, String> {
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return Err(format!("{} is not an image the agent can see", path)),
    };
    let len = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if len > MAX_IMAGE_BYTES {
        return Err(format!(
            "{} is {:.1} MB; images can be at most {} MB",
            path.rsplit('/').next().unwrap_or(&path),
            len as f64 / 1_048_576.0,
            MAX_IMAGE_BYTES / 1_048_576
        ));
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(ImageFile { mime_type: mime.to_string(), data: base64(&bytes) })
}

fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn base64_matches_the_standard_alphabet_and_padding() {
        assert_eq!(super::base64(b""), "");
        assert_eq!(super::base64(b"f"), "Zg==");
        assert_eq!(super::base64(b"fo"), "Zm8=");
        assert_eq!(super::base64(b"foo"), "Zm9v");
        assert_eq!(super::base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(super::base64(&[0xff, 0xfe, 0x00]), "//4A");
    }
}

/// Largest text file whose contents go into a prompt, the way `@file` does in
/// Claude Code. Past this the agent gets a link and reads what it needs.
const MAX_EMBED_BYTES: u64 = 200 * 1024;

/// A file's contents, when they are small enough and are text, for embedding
/// in a prompt. None for anything else — the caller sends a link instead.
#[tauri::command(async)]
pub fn acp_read_text(path: String) -> Option<String> {
    let meta = std::fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_EMBED_BYTES {
        return None;
    }
    embeddable_text(std::fs::read(&path).ok()?)
}

/// Text is valid UTF-8 with no NUL bytes; PDFs, images and archives fail one
/// or the other.
fn embeddable_text(bytes: Vec<u8>) -> Option<String> {
    if bytes.contains(&0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

#[cfg(test)]
mod embed_tests {
    use super::embeddable_text;

    #[test]
    fn text_is_embedded_and_binary_is_not() {
        assert_eq!(embeddable_text(b"fn main() {}\n".to_vec()).as_deref(), Some("fn main() {}\n"));
        assert_eq!(embeddable_text("héllo".as_bytes().to_vec()).as_deref(), Some("héllo"));
        assert_eq!(embeddable_text(b"%PDF-1.7\x00\x01".to_vec()), None);
        assert_eq!(embeddable_text(vec![0xff, 0xfe, 0x41]), None);
    }
}

/// The checkout's files, relative to it, for @-mentioning in a chat: tracked
/// ones and untracked ones git does not ignore. Empty outside a repo.
#[tauri::command(async)]
pub fn acp_list_files(cwd: String) -> Vec<String> {
    let out = Command::new("git")
        .args(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
        .current_dir(&cwd)
        .output();
    match out {
        Ok(o) if o.status.success() => o
            .stdout
            .split(|b| *b == 0)
            .filter(|p| !p.is_empty())
            .take(MAX_LISTED_FILES)
            .map(|p| String::from_utf8_lossy(p).into_owned())
            .collect(),
        _ => Vec::new(),
    }
}

/// The branch each of these Claude sessions was last on, by session id. A
/// checkout's history spans every branch it has had checked out; this is what
/// lets a chat show only the current one's. Sessions with no recorded branch
/// (other agents, detached HEADs) are left out.
#[tauri::command(async)]
pub fn acp_session_branches(cwd: String, session_ids: Vec<String>) -> HashMap<String, String> {
    session_ids
        .into_iter()
        .filter_map(|id| crate::agent_usage::session_branch(&cwd, &id).map(|b| (id, b)))
        .collect()
}

/// A closing window takes its chats with it, as it does its shells.
pub fn stop_for_window(label: &str) {
    sessions().lock().unwrap().retain(|_, s| s.window != label);
}

pub fn stop_all() {
    sessions().lock().unwrap().clear();
}

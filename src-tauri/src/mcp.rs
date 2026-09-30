//! An MCP server, so an agent can see and drive the services Lever runs.
//!
//! Served over MCP's Streamable HTTP transport on 127.0.0.1, answering each
//! POST with a plain JSON body (the transport allows that in place of an SSE
//! stream, and nothing here pushes unprompted). Every request must carry the
//! bearer token kept in ~/.lever/mcp.json, which is created 0600 — the port is
//! reachable by anything on the machine, the token is not.
//!
//! Only projects loaded in Lever are in reach: ones open in a window, or ones
//! the `lever` CLI has worked in since Lever started. Logs are the output Lever
//! keeps for each service run (see output.rs) — the same bytes the window's log
//! panel shows — so they can be read whether or not a window is open.
//!
//! Off by default. Turning it on starts the server and registers it with
//! Claude Code through its own CLI (`claude mcp add`, user scope), which, like
//! the statusLine bridge, reaches every Claude Code session on the machine.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{Emitter, Manager};

use super::{
    output,
    all_services, debug_action, get_shell_path, is_pid_alive, load_project_index, now_unix,
    service_shell_line, start_service_in, stop_service_in, wait_for_exit, AppState, ServiceDef,
    now_millis, AppConfig, LastExit, ServiceGroup, SvcExitEvent, WorktreeDef,
};

const CONFIG_SUBPATH: &str = ".lever/mcp.json";
const DEFAULT_PORT: u16 = 7438;
/// The name the server is registered under in Claude Code.
const SERVER_NAME: &str = "lever";
const PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY_BYTES: u64 = 1 << 20;
const DEFAULT_LOG_LINES: usize = 200;
const MAX_LOG_LINES: usize = 2000;
/// However many lines are asked for, one reply stays under this — a noisy dev
/// server's 2000 lines would otherwise take a large bite of the agent's context.
const MAX_LOG_CHARS: usize = 40_000;
/// Lines of output returned with the result of a start.
const START_OUTPUT_LINES: usize = 20;
/// How long a start waits to see the service come up.
const READY_TIMEOUT: Duration = Duration::from_secs(10);
/// Output this quiet means a service has settled.
const QUIET_MS: u64 = 1500;
/// Not called settled before this: the port scan runs every 2s, and a server
/// that has printed its banner may not be listening yet.
const MIN_READY_WAIT: Duration = Duration::from_secs(3);
const MAX_WAIT_SECS: u64 = 600;

// ---------------------------------------------------------------------------
// Config and lifecycle
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
struct McpConfig {
    enabled: bool,
    port: u16,
    token: String,
}

fn config_path() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join(CONFIG_SUBPATH))
        .ok_or_else(|| "HOME is not set".to_string())
}

fn load_config() -> Option<McpConfig> {
    let raw = fs::read_to_string(config_path().ok()?).ok()?;
    serde_json::from_str(&raw).ok()
}

fn save_config(cfg: &McpConfig) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    use std::io::Write;
    let path = config_path()?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {}", dir.display(), e))?;
    }
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    let mut f = fs::OpenOptions::new()
        .write(true).create(true).truncate(true).mode(0o600)
        .open(&path)
        .map_err(|e| format!("could not write {}: {}", path.display(), e))?;
    f.write_all(json.as_bytes()).map_err(|e| e.to_string())
}

fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 24];
    fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| format!("could not read /dev/urandom: {}", e))?;
    Ok(bytes.iter().map(|b| format!("{:02x}", b)).collect())
}

fn url_for(port: u16) -> String {
    format!("http://127.0.0.1:{}/mcp", port)
}

fn register_command(cfg: &McpConfig) -> String {
    format!(
        "claude mcp add --transport http --scope user {} {} --header \"Authorization: Bearer {}\"",
        SERVER_NAME, url_for(cfg.port), cfg.token
    )
}

struct Running {
    server: Arc<tiny_http::Server>,
    port: u16,
}

static RUNNING: Mutex<Option<Running>> = Mutex::new(None);
/// Why the server is enabled but not running — at launch nobody is looking,
/// so the reason is kept for Settings to show.
static START_ERROR: Mutex<Option<String>> = Mutex::new(None);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpState {
    enabled: bool,
    running: bool,
    url: Option<String>,
    /// What registers the server with Claude Code by hand, for when the CLI
    /// could not be run for you.
    register_command: Option<String>,
    error: Option<String>,
}

fn state_with(error: Option<String>) -> McpState {
    let cfg = load_config();
    let running = RUNNING.lock().unwrap().as_ref().map(|r| r.port);
    let enabled = cfg.as_ref().map_or(false, |c| c.enabled);
    // On but not serving: agents get "connection refused" and nothing else,
    // so this is the one place the reason can surface.
    let error = error.or_else(|| (enabled && running.is_none()).then(|| format!(
        "The server is not running{}. Turn this off and on again to retry.",
        START_ERROR.lock().unwrap().as_ref().map(|e| format!(": {}", e)).unwrap_or_default()
    )));
    McpState {
        enabled,
        running: running.is_some(),
        url: cfg.as_ref().map(|c| url_for(c.port)),
        register_command: cfg.as_ref().filter(|c| c.enabled).map(register_command),
        error,
    }
}

fn start_server(app: tauri::AppHandle, cfg: &McpConfig) -> Result<(), String> {
    let mut running = RUNNING.lock().unwrap();
    if running.is_some() {
        return Ok(());
    }
    let server = tiny_http::Server::http(("127.0.0.1", cfg.port))
        .map_err(|e| {
            let e = format!("could not listen on 127.0.0.1:{} ({})", cfg.port, e);
            *START_ERROR.lock().unwrap() = Some(e.clone());
            e
        })?;
    *START_ERROR.lock().unwrap() = None;
    let server = Arc::new(server);
    let token = cfg.token.clone();
    let port = cfg.port;
    let accept = server.clone();
    std::thread::spawn(move || {
        // `incoming_requests` ends once `unblock` is called on stop.
        for request in accept.incoming_requests() {
            let app = app.clone();
            let token = token.clone();
            // Own thread each: a task start can wait minutes for the task.
            std::thread::spawn(move || serve(&token, request,
                &|name, args, peer| {
                    let cwd = peer.and_then(|p| caller_cwd(p, port));
                    call_tool(&app, name, args, cwd.as_deref())
                },
                &|peer| {
                    let cwd = peer.and_then(|p| caller_cwd(p, port));
                    instructions_for(&app.state::<AppState>(), cwd.as_deref())
                },
            ));
        }
    });
    *running = Some(Running { server, port: cfg.port });
    Ok(())
}

fn stop_server() {
    if let Some(r) = RUNNING.lock().unwrap().take() {
        r.server.unblock();
    }
}

/// Called once at startup.
pub fn start_if_enabled(app: tauri::AppHandle) {
    if let Some(cfg) = load_config().filter(|c| c.enabled) {
        if let Err(e) = start_server(app, &cfg) {
            super::debug_log("mcp", "error", &e);
        }
    }
}

// Codex CLI has no command that adds an HTTP server, so its config.toml is
// edited directly — only when Codex is installed (~/.codex exists), and only
// Lever's own table, which is replaced whole and removed whole.

const CODEX_MARKER: &str = "# Added by Lever; removed when you turn off its MCP server in Settings.";

fn codex_config_path() -> Option<PathBuf> {
    let dir = PathBuf::from(std::env::var_os("HOME")?).join(".codex");
    dir.is_dir().then(|| dir.join("config.toml"))
}

/// `toml` with Lever's `[mcp_servers.lever]` table (and any subtables, and the
/// marker comment above it) taken out, and everything else as it was.
fn without_codex_table(toml: &str) -> String {
    let ours = format!("[mcp_servers.{}]", SERVER_NAME);
    let ours_sub = format!("[mcp_servers.{}.", SERVER_NAME);
    let mut out: Vec<&str> = Vec::new();
    let mut inside = false;
    for line in toml.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            inside = t == ours || t.starts_with(&ours_sub);
        }
        if !inside && t != CODEX_MARKER {
            out.push(line);
        }
    }
    while out.last().map_or(false, |l| l.trim().is_empty()) {
        out.pop();
    }
    let mut s = out.join("\n");
    if !s.is_empty() {
        s.push('\n');
    }
    s
}

fn with_codex_table(toml: &str, cfg: &McpConfig) -> String {
    let mut s = without_codex_table(toml);
    if !s.is_empty() {
        s.push('\n');
    }
    s.push_str(&format!(
        "{}\n[mcp_servers.{}]\nurl = \"{}\"\nhttp_headers = {{ \"Authorization\" = \"Bearer {}\" }}\n",
        CODEX_MARKER, SERVER_NAME, url_for(cfg.port), cfg.token
    ));
    s
}

/// Adds (`Some`) or removes (`None`) Lever in Codex's config. Ok(false) when
/// Codex is not installed and nothing was touched.
fn register_codex(cfg: Option<&McpConfig>) -> Result<bool, String> {
    let path = match codex_config_path() {
        Some(p) => p,
        None => return Ok(false),
    };
    let current = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("could not read ~/.codex/config.toml: {}", e)),
    };
    let next = match cfg {
        Some(cfg) => with_codex_table(&current, cfg),
        None => without_codex_table(&current),
    };
    if next == current {
        return Ok(true);
    }
    // Written aside and moved into place, so Codex never reads half a file.
    let tmp = path.with_extension("toml.lever-tmp");
    fs::write(&tmp, next)
        .and_then(|_| fs::rename(&tmp, &path))
        .map_err(|e| {
            let _ = fs::remove_file(&tmp);
            format!("could not write ~/.codex/config.toml: {}", e)
        })?;
    Ok(true)
}

fn run_claude(args: &[&str]) -> Result<(), String> {
    let out = std::process::Command::new("claude")
        .args(args)
        .env("PATH", get_shell_path())
        .output()
        .map_err(|e| format!("could not run the claude CLI ({})", e))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[tauri::command(async)]
pub fn mcp_state() -> McpState {
    state_with(None)
}

#[tauri::command(async)]
pub fn enable_mcp(app: tauri::AppHandle) -> Result<McpState, String> {
    let mut cfg = match load_config() {
        Some(c) if !c.token.is_empty() => c,
        _ => McpConfig { enabled: false, port: DEFAULT_PORT, token: new_token()? },
    };
    start_server(app, &cfg)?;
    cfg.enabled = true;
    save_config(&cfg)?;
    debug_action("mcp", &format!("MCP server on {}", url_for(cfg.port)));

    // Replaces any earlier registration, which may carry an old port or token.
    let _ = run_claude(&["mcp", "remove", "--scope", "user", SERVER_NAME]);
    let url = url_for(cfg.port);
    let header = format!("Authorization: Bearer {}", cfg.token);
    let mut problems = Vec::new();
    if let Err(e) = run_claude(&[
        "mcp", "add", "--transport", "http", "--scope", "user", SERVER_NAME, &url, "--header", &header,
    ]) {
        problems.push(format!("registering it with Claude Code failed: {}. Run the command below yourself", e));
    }
    if let Err(e) = register_codex(Some(&cfg)) {
        problems.push(format!("adding it to Codex failed: {}", e));
    }
    Ok(state_with((!problems.is_empty()).then(|| {
        format!("The server is running, but {}.", problems.join("; "))
    })))
}

#[tauri::command(async)]
pub fn disable_mcp() -> Result<McpState, String> {
    stop_server();
    if let Some(mut cfg) = load_config() {
        cfg.enabled = false;
        save_config(&cfg)?;
    }
    debug_action("mcp", "MCP server stopped");
    let mut problems = Vec::new();
    if let Err(e) = run_claude(&["mcp", "remove", "--scope", "user", SERVER_NAME]) {
        problems.push(format!("removing it from Claude Code failed: {}", e));
    }
    if let Err(e) = register_codex(None) {
        problems.push(format!("removing it from Codex failed: {}", e));
    }
    Ok(state_with((!problems.is_empty()).then(|| {
        format!("The server is stopped, but {}.", problems.join("; "))
    })))
}

// ---------------------------------------------------------------------------
// Reading a service's output
// ---------------------------------------------------------------------------

type LogReply = Result<Vec<String>, String>;

/// The run a service's output belongs to: the one going now, else the last.
pub(crate) fn service_run(state: &AppState, project_id: &str, service_id: &str) -> Option<String> {
    let projects = state.projects.lock().unwrap();
    let ps = projects.get(project_id)?;
    ps.tracked.get(service_id).and_then(|t| t.pty_id.clone())
        .or_else(|| ps.last_exit.get(service_id).map(|e| e.pty_id.clone()))
}

/// What `service_id`'s latest run has printed, as lines of text.
fn read_output(state: &AppState, project_id: &str, service_id: &str) -> LogReply {
    service_run(state, project_id, service_id)
        .and_then(|pty| output::hub().lines(&pty))
        .ok_or_else(|| "No output: this service has not run since Lever started.".into())
}

/// The last `n` lines.
fn tail(lines: Vec<String>, n: usize) -> Vec<String> {
    let skip = lines.len().saturating_sub(n);
    lines.into_iter().skip(skip).collect()
}

/// What part of a service's output a get_logs call wants. Lines are numbered
/// from 1 over the whole output, so a range means the same thing on every
/// call as long as the run is the same.
struct LogQuery<'a> {
    from: Option<usize>,
    to: Option<usize>,
    lines: usize,
    contains: Option<&'a str>,
}

/// The reply to a get_logs call: a header saying which lines these are, then
/// the lines. Reading forward (`from` given) keeps the start of the range;
/// otherwise the newest lines are kept. Either way the reply is cut to
/// MAX_LOG_CHARS, and the header says where to pick up.
fn select_logs(name: &str, all: &[String], q: &LogQuery) -> String {
    let total = all.len();
    if total == 0 {
        return format!("{} has printed nothing yet.", name);
    }
    let needle = q.contains.map(str::to_lowercase);
    let mut picked: Vec<(usize, &str)> = all.iter().enumerate()
        .map(|(i, l)| (i + 1, l.as_str()))
        .filter(|(n, _)| q.from.map_or(true, |f| *n >= f) && q.to.map_or(true, |t| *n <= t))
        .filter(|(_, l)| needle.as_ref().map_or(true, |f| l.to_lowercase().contains(f)))
        .collect();
    let forward = q.from.is_some();
    let n = q.lines.clamp(1, MAX_LOG_LINES);
    if picked.len() > n {
        if forward {
            picked.truncate(n);
        } else {
            picked.drain(..picked.len() - n);
        }
    }
    if picked.is_empty() {
        return match q.contains {
            Some(f) => format!("No line of {} contains \"{}\" (its output has {} lines).", name, f, total),
            None => format!("{} has no lines there; its output has {} lines.", name, total),
        };
    }

    // Matching lines carry their number, so the agent can ask for the lines
    // around one with from/to.
    let render = |(n, l): &(usize, &str)| match needle {
        Some(_) => format!("{}: {}", n, l),
        None => l.to_string(),
    };
    let mut kept: Vec<(usize, String)> = Vec::new();
    let mut used = 0;
    let order: Box<dyn Iterator<Item = &(usize, &str)>> =
        if forward { Box::new(picked.iter()) } else { Box::new(picked.iter().rev()) };
    for line in order {
        let mut text = render(line);
        if kept.is_empty() && text.len() > MAX_LOG_CHARS {
            // One line longer than the whole budget still comes back, cut.
            let cut = (0..=MAX_LOG_CHARS).rev().find(|i| text.is_char_boundary(*i)).unwrap_or(0);
            text.truncate(cut);
            text.push('…');
        } else if used + text.len() + 1 > MAX_LOG_CHARS {
            break;
        }
        used += text.len() + 1;
        kept.push((line.0, text));
    }
    if !forward {
        kept.reverse();
    }
    let (first, last) = (kept[0].0, kept[kept.len() - 1].0);

    let mut header = match q.contains {
        Some(f) => format!("{}: {} lines containing \"{}\", between lines {} and {} of {}",
            name, kept.len(), f, first, last, total),
        None => format!("{}: lines {}–{} of {}", name, first, last, total),
    };
    if kept.len() < picked.len() {
        header.push_str(&if forward {
            format!(" (cut to fit {} characters; pass from={} for the rest)", MAX_LOG_CHARS, last + 1)
        } else {
            format!(" (cut to fit {} characters; pass to={} for earlier lines)", MAX_LOG_CHARS, first - 1)
        });
    }
    let body: Vec<String> = kept.into_iter().map(|(_, t)| t).collect();
    format!("{}\n{}", header, body.join("\n"))
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

fn header<'a>(req: &'a tiny_http::Request, name: &str) -> Option<&'a str> {
    req.headers().iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str())
}

/// A browser page can reach 127.0.0.1 too. It cannot know the token, but a
/// request that carries a foreign Origin is turned away before it is looked at.
fn origin_allowed(origin: Option<&str>) -> bool {
    let origin = match origin {
        None => return true,
        Some(o) => o,
    };
    let rest = match origin.split_once("://") {
        Some((_, rest)) => rest,
        None => return false,
    };
    let host = match rest.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or(""),
        None => rest.split([':', '/']).next().unwrap_or(""),
    };
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}

fn token_matches(auth: Option<&str>, token: &str) -> bool {
    let given = match auth.and_then(|a| a.strip_prefix("Bearer ")) {
        Some(g) => g.trim().as_bytes(),
        None => return false,
    };
    // Constant time, so the token cannot be guessed a byte at a time.
    given.len() == token.len()
        && given.iter().zip(token.as_bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

fn respond(req: tiny_http::Request, status: u16, body: Option<Value>) {
    let mut resp = tiny_http::Response::from_string(body.map(|b| b.to_string()).unwrap_or_default())
        .with_status_code(status);
    if let Ok(h) = tiny_http::Header::from_bytes("Content-Type", "application/json") {
        resp.add_header(h);
    }
    let _ = req.respond(resp);
}

/// Runs a tool, given the address the request came from — which is how the
/// caller's checkout is found.
type ToolCall<'a> = &'a dyn Fn(&str, &Value, Option<std::net::SocketAddr>) -> Result<String, String>;

/// The instructions sent on `initialize`, given the same address.
type Briefing<'a> = &'a dyn Fn(Option<std::net::SocketAddr>) -> String;

fn serve(token: &str, mut req: tiny_http::Request, call: ToolCall, brief: Briefing) {
    let path = req.url().split('?').next().unwrap_or("").to_string();
    if path != "/mcp" {
        return respond(req, 404, None);
    }
    if !origin_allowed(header(&req, "Origin")) {
        return respond(req, 403, None);
    }
    if !token_matches(header(&req, "Authorization"), token) {
        return respond(req, 401, Some(json!({ "error": "missing or wrong bearer token" })));
    }
    // No server-initiated stream (GET) and no sessions to end (DELETE).
    if *req.method() != tiny_http::Method::Post {
        return respond(req, 405, None);
    }
    let peer = req.remote_addr().copied();
    let mut body = String::new();
    if req.as_reader().take(MAX_BODY_BYTES).read_to_string(&mut body).is_err() {
        return respond(req, 400, None);
    }
    let msg: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => return respond(req, 400, Some(rpc_error(Value::Null, -32700, &format!("parse error: {}", e)))),
    };
    match handle_rpc(&msg, |name, args| call(name, args, peer), || brief(peer)) {
        Some(reply) => respond(req, 200, Some(reply)),
        // A notification, or a response to something we never asked.
        None => respond(req, 202, None),
    }
}

// ---------------------------------------------------------------------------
// JSON-RPC / MCP
// ---------------------------------------------------------------------------

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Answers one JSON-RPC message; `None` when it wants no answer. Tool calls
/// go to `call`, which is what keeps this testable without a running app.
fn handle_rpc(
    msg: &Value,
    call: impl Fn(&str, &Value) -> Result<String, String>,
    instructions: impl Fn() -> String,
) -> Option<Value> {
    let id = msg.get("id").cloned()?;
    let method = match msg.get("method").and_then(Value::as_str) {
        Some(m) => m,
        None => return None,
    };
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
            let version = if PROTOCOL_VERSIONS.contains(&asked) { asked } else { PROTOCOL_VERSIONS[0] };
            json!({
                "protocolVersion": version,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
                "instructions": instructions(),
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tool_definitions() }),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            if !tool_definitions().iter().any(|t| t["name"] == name) {
                return Some(rpc_error(id, -32602, &format!("unknown tool: {}", name)));
            }
            // A failed action is a tool result the agent can read and react
            // to, not a protocol error.
            let (text, is_error) = match call(name, &args) {
                Ok(t) => (t, false),
                Err(e) => (e, true),
            };
            json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
        }
        _ => return Some(rpc_error(id, -32601, &format!("method not found: {}", method))),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

const INSTRUCTIONS: &str = "Lever runs a developer's local services (dev servers, databases, \
watchers) and tasks (one-shot commands such as builds or migrations), organised into groups, \
per project and per git worktree. Each worktree has its own copy of the services, under the \
same labels. Lever works out which checkout you are in from your working directory and scopes \
every tool to it, so `web` means your worktree's web server, not the main checkout's; pass \
`checkout` to reach another one, or `checkout: \"all\"` to list every one. Only projects loaded \
in Lever are visible. Call list_services to find ids, get_logs to read what a service \
printed (the same text the user sees in Lever), and start_service / stop_service / \
restart_service to act. Everything you do shows up live in Lever's window when one is open.

Before you start a dev server, watcher, database or a build/test/migration task with a shell \
command, call list_services. If Lever has it, run it through start_service and read it with \
get_logs rather than launching it yourself: a second copy fights Lever's for the same port, and \
its output is invisible to the user.";

/// At most this many services are named in a briefing; the rest are one
/// list_services call away.
const BRIEFING_MAX_SERVICES: usize = 15;
const BRIEFING_MAX_COMMAND: usize = 80;

/// One service as a briefing names it.
struct BriefLine {
    label: String,
    kind: &'static str,
    command: String,
    running: bool,
    ports: Vec<u16>,
}

/// What an agent is told on connecting from inside a checkout Lever manages:
/// where it is and what already runs there, so it reaches for Lever before it
/// reaches for `npm run dev`. Built once per session — Claude Code reads it
/// when the session starts — so statuses are a snapshot and say so.
fn checkout_briefing(project: &str, checkout: &str, services: &[BriefLine]) -> String {
    // The part only this session can be told goes first, in case a client
    // trims long instructions.
    let mut out = format!("You are working in {} of the Lever project \"{}\".", checkout, project);
    if services.is_empty() {
        out.push_str(" It has no services or tasks defined in Lever.\n\n");
        out.push_str(INSTRUCTIONS);
        return out;
    }
    out.push_str(" Lever manages these services and tasks here (status as of the start of this session):");
    for s in services.iter().take(BRIEFING_MAX_SERVICES) {
        let mut command: String = s.command.chars().take(BRIEFING_MAX_COMMAND).collect();
        if command.len() < s.command.len() {
            command.push('…');
        }
        let status = match (s.kind, s.running, s.ports.as_slice()) {
            (_, true, []) => "running".to_string(),
            (_, true, ports) => format!("running on {}",
                ports.iter().map(|p| format!(":{}", p)).collect::<Vec<_>>().join(", ")),
            ("task", false, _) => "not running".to_string(),
            _ => "stopped".to_string(),
        };
        out.push_str(&format!("\n- {} ({}): `{}` — {}", s.label, s.kind, command, status));
    }
    if services.len() > BRIEFING_MAX_SERVICES {
        out.push_str(&format!("\n- …and {} more; call list_services.", services.len() - BRIEFING_MAX_SERVICES));
    }
    out.push_str("\nWhen you need one of these, or a command that matches one, use start_service / \
restart_service and get_logs instead of running it in your shell. If one is already running, \
read its logs rather than starting another.\n\n");
    out.push_str(INSTRUCTIONS);
    out
}

/// The instructions for a caller: the briefing for its checkout when it is in
/// one Lever manages, the general rules otherwise.
fn instructions_for(state: &AppState, cwd: Option<&Path>) -> String {
    let here = match cwd.and_then(|c| locate(&open_checkouts(state), &canon(c))) {
        Some(h) => h,
        None => return INSTRUCTIONS.to_string(),
    };
    let (project_id, checkout) = here;
    let name = project_names(state).remove(&project_id).unwrap_or_else(|| project_id.clone());
    let ports = state.agent_cache.lock().unwrap().ports.clone();
    let projects = state.projects.lock().unwrap();
    let ps = match projects.get(&project_id) {
        Some(ps) => ps,
        None => return INSTRUCTIONS.to_string(),
    };
    let lines: Vec<BriefLine> = services_in(&ps.config, &checkout).into_iter().map(|s| BriefLine {
        label: s.label.clone(),
        kind: if s.service_type == "task" { "task" } else { "service" },
        command: service_shell_line(s),
        running: ps.tracked.get(&s.id).map_or(false, |t| is_pid_alive(t.pid)),
        ports: ports.get(&s.id).cloned().unwrap_or_default(),
    }).collect();
    checkout_briefing(&name, &describe_checkout(&ps.config, &checkout), &lines)
}

fn tool_definitions() -> Vec<Value> {
    let project = json!({
        "type": "string",
        "description": "Project id or name. Defaults to the project your working directory is in."
    });
    let checkout = json!({
        "type": "string",
        "description": "\"main\", a worktree's branch or path, or \"all\". Defaults to the checkout your working directory is in."
    });
    let service = json!({
        "type": "string",
        "description": "Service or task id from list_services, or its label (looked up in your checkout)."
    });
    vec![
        json!({
            "name": "list_projects",
            "description": "Projects open in Lever, with their repo paths and worktrees, and which one you are working in.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true },
        }),
        json!({
            "name": "list_services",
            "description": "The groups in your checkout (main or worktree) and the services and tasks in each: id, label, kind, command, whether it is running, its listening ports, and how its last run ended.",
            "inputSchema": { "type": "object", "properties": { "project": project, "checkout": checkout } },
            "annotations": { "readOnlyHint": true },
        }),
        json!({
            "name": "get_logs",
            "description": "The output of a service or task's current or most recent run, as shown in Lever's log panel (plain text, colours removed). Returns the newest lines by default; any reply is capped at 40,000 characters and says which lines it holds.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": project,
                    "checkout": checkout,
                    "service": service,
                    "lines": { "type": "integer", "description": "How many lines to return (default 200, at most 2000). The newest ones, or with `from`, the first ones from there." },
                    "from": { "type": "integer", "description": "First line to return, numbered from 1 over the whole output. Use it to page forward, or with `to` for an exact range." },
                    "to": { "type": "integer", "description": "Last line to return. Alone, returns the lines leading up to it." },
                    "contains": { "type": "string", "description": "Only lines containing this text, case-insensitive; each comes back with its line number, so you can ask for the lines around it with from/to." },
                },
                "required": ["service"],
            },
            "annotations": { "readOnlyHint": true },
        }),
        json!({
            "name": "start_service",
            "description": "Start a service or run a task. Waits up to 10s for it to come up (listening on a port, or its output settling) and returns its ports and first output. With wait_seconds, waits instead for it to finish (meant for tasks) and returns its exit code and the end of its output.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": project,
                    "checkout": checkout,
                    "service": service,
                    "wait_seconds": { "type": "integer", "description": "Wait up to this long for it to exit (at most 600). Leave out for long-running services." },
                },
                "required": ["service"],
            },
        }),
        json!({
            "name": "stop_service",
            "description": "Stop a running service or task, using its configured stop command if it has one.",
            "inputSchema": {
                "type": "object",
                "properties": { "project": project, "checkout": checkout, "service": service },
                "required": ["service"],
            },
            "annotations": { "destructiveHint": true },
        }),
        json!({
            "name": "restart_service",
            "description": "Stop a service if it is running, wait for it to exit, and start it again. Returns once it is back up, as start_service does.",
            "inputSchema": {
                "type": "object",
                "properties": { "project": project, "checkout": checkout, "service": service },
                "required": ["service"],
            },
            "annotations": { "destructiveHint": true },
        }),
    ]
}

// ---------------------------------------------------------------------------
// Who is asking
//
// An HTTP request says nothing about where the agent is working, and asking
// it to say would be one more thing for it to get wrong. The connection does
// say: its far end is a socket some process on this Mac holds, and that
// process's working directory is the checkout it was started in.
// ---------------------------------------------------------------------------

/// How long a connection's answer is reused. Clients keep one connection
/// open across calls, and one lookup is an `lsof` (~80ms).
const CALLER_CACHE_TTL: Duration = Duration::from_secs(30);

/// The pid holding the client end of a connection to us, from
/// `lsof -iTCP:<peer port> -F pn`: the socket whose local end is the peer's
/// port and whose remote end is our server's. Our own accepted socket matches
/// the reverse, and is skipped by pid as well.
fn pid_owning(lsof: &str, peer_port: u16, server_port: u16, own_pid: u32) -> Option<u32> {
    let local = format!(":{}", peer_port);
    let remote = format!(":{}", server_port);
    let mut pid = None;
    for line in lsof.lines() {
        if let Some(p) = line.strip_prefix('p') {
            pid = p.parse::<u32>().ok();
        } else if let Some((l, r)) = line.strip_prefix('n').and_then(|n| n.split_once("->")) {
            if l.ends_with(&local) && r.ends_with(&remote) {
                if let Some(p) = pid.filter(|p| *p != own_pid) {
                    return Some(p);
                }
            }
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn process_cwd(pid: u32) -> Option<PathBuf> {
    unsafe {
        let mut info: libc::proc_vnodepathinfo = std::mem::zeroed();
        let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as i32;
        let got = libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            size,
        );
        if got != size {
            return None;
        }
        let path = std::ffi::CStr::from_ptr(info.pvi_cdir.vip_path.as_ptr() as *const libc::c_char);
        path.to_str().ok().filter(|p| !p.is_empty()).map(PathBuf::from)
    }
}

#[cfg(not(target_os = "macos"))]
fn process_cwd(_pid: u32) -> Option<PathBuf> {
    None
}

/// The working directory of whoever is on the other end of `peer`.
fn caller_cwd(peer: std::net::SocketAddr, server_port: u16) -> Option<PathBuf> {
    static CACHE: OnceLock<Mutex<HashMap<u16, (Option<PathBuf>, std::time::Instant)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((cwd, at)) = cache.lock().unwrap().get(&peer.port()) {
        if at.elapsed() < CALLER_CACHE_TTL {
            return cwd.clone();
        }
    }
    let out = std::process::Command::new("lsof")
        .args(["-nP", &format!("-iTCP:{}", peer.port()), "-sTCP:ESTABLISHED", "-Fpn"])
        .output()
        .ok()?;
    let cwd = pid_owning(&String::from_utf8_lossy(&out.stdout), peer.port(), server_port, std::process::id())
        .and_then(process_cwd);
    let mut cache = cache.lock().unwrap();
    cache.retain(|_, (_, at)| at.elapsed() < CALLER_CACHE_TTL);
    cache.insert(peer.port(), (cwd.clone(), std::time::Instant::now()));
    cwd
}

// ---------------------------------------------------------------------------
// Scope: which project and checkout a call is about
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
enum Checkout {
    Main,
    /// A worktree, by its id in the project config.
    Worktree(String),
    All,
}

struct Scope {
    project_id: String,
    checkout: Checkout,
    /// Worked out from the caller's directory rather than asked for.
    detected: bool,
}

fn canon(p: &Path) -> PathBuf {
    fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// The checkout whose directory holds `cwd`. The deepest wins, so a worktree
/// kept inside the repo is not taken for the main checkout.
fn locate(checkouts: &[(String, Checkout, PathBuf)], cwd: &Path) -> Option<(String, Checkout)> {
    checkouts.iter()
        .filter(|(_, _, dir)| !dir.as_os_str().is_empty() && cwd.starts_with(dir))
        .max_by_key(|(_, _, dir)| dir.components().count())
        .map(|(id, c, _)| (id.clone(), c.clone()))
}

/// Every checkout of every open project, as (project id, checkout, directory).
fn open_checkouts(state: &AppState) -> Vec<(String, Checkout, PathBuf)> {
    let projects = state.projects.lock().unwrap();
    let mut out = Vec::new();
    for (id, ps) in projects.iter().filter(|(id, _)| !id.starts_with("scratch-")) {
        if !ps.repo_path.is_empty() {
            out.push((id.clone(), Checkout::Main, canon(Path::new(&ps.repo_path))));
        }
        for wt in &ps.config.worktrees {
            out.push((id.clone(), Checkout::Worktree(wt.id.clone()), canon(Path::new(&wt.path))));
        }
    }
    out
}

fn parse_checkout(worktrees: &[WorktreeDef], want: &str) -> Result<Checkout, String> {
    if want.eq_ignore_ascii_case("all") {
        return Ok(Checkout::All);
    }
    if want.eq_ignore_ascii_case("main") {
        return Ok(Checkout::Main);
    }
    let want_path = canon(Path::new(want));
    worktrees.iter()
        .find(|w| w.id == want || w.branch == want || canon(Path::new(&w.path)) == want_path)
        .map(|w| Checkout::Worktree(w.id.clone()))
        .ok_or_else(|| format!(
            "No checkout '{}'. Use \"main\", \"all\", or a worktree branch: {}",
            want,
            if worktrees.is_empty() { "(this project has none)".to_string() }
            else { worktrees.iter().map(|w| w.branch.as_str()).collect::<Vec<_>>().join(", ") }
        ))
}

fn resolve_scope(state: &AppState, args: &Value, cwd: Option<&Path>) -> Result<Scope, String> {
    let here = cwd.and_then(|c| locate(&open_checkouts(state), &canon(c)));
    let project_id = match (&here, arg_str(args, "project")) {
        (Some((id, _)), None) => id.clone(),
        _ => resolve_project(state, args)?,
    };
    let checkout = match arg_str(args, "checkout") {
        Some(want) => {
            let projects = state.projects.lock().unwrap();
            let ps = projects.get(&project_id).ok_or("Project not loaded")?;
            parse_checkout(&ps.config.worktrees, want)?
        }
        None => match here {
            Some((id, c)) if id == project_id => {
                return Ok(Scope { project_id, checkout: c, detected: true });
            }
            // An agent working outside the project sees all of it.
            _ => Checkout::All,
        },
    };
    Ok(Scope { project_id, checkout, detected: false })
}

fn groups_in<'a>(config: &'a AppConfig, checkout: &Checkout) -> Vec<(Option<&'a WorktreeDef>, &'a [ServiceGroup])> {
    let main = (None, config.groups.as_slice());
    let wts = config.worktrees.iter().map(|w| (Some(w), w.groups.as_slice()));
    match checkout {
        Checkout::Main => vec![main],
        Checkout::Worktree(id) => wts.filter(|(w, _)| w.map_or(false, |w| &w.id == id)).collect(),
        Checkout::All => std::iter::once(main).chain(wts).collect(),
    }
}

fn services_in<'a>(config: &'a AppConfig, checkout: &Checkout) -> Vec<&'a ServiceDef> {
    groups_in(config, checkout).into_iter()
        .flat_map(|(_, groups)| groups.iter().flat_map(|g| g.services.iter()))
        .collect()
}

fn describe_checkout(config: &AppConfig, checkout: &Checkout) -> String {
    match checkout {
        Checkout::Main => "the main checkout".into(),
        Checkout::All => "every checkout".into(),
        Checkout::Worktree(id) => config.worktrees.iter().find(|w| &w.id == id)
            .map(|w| format!("worktree {}", w.branch))
            .unwrap_or_else(|| format!("worktree {}", id)),
    }
}

/// A service's label, with the worktree it belongs to when it is in one —
/// every worktree has a service of that label.
fn service_name(config: &AppConfig, def: &ServiceDef) -> String {
    match config.worktrees.iter().find(|w| w.groups.iter().any(|g| g.services.iter().any(|s| s.id == def.id))) {
        Some(w) => format!("{} (worktree {})", def.label, w.branch),
        None => def.label.clone(),
    }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

fn window_label(project_id: &str) -> String {
    format!("project-{}", project_id)
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

fn arg_u64(args: &Value, key: &str) -> Option<u64> {
    args.get(key).and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
}

/// Compact, not pretty: an agent reads it just as well, in fewer tokens.
fn to_json(v: Value) -> Result<String, String> {
    serde_json::to_string(&v).map_err(|e| e.to_string())
}

fn project_names(state: &AppState) -> HashMap<String, String> {
    load_project_index(&state.projects_dir).projects.into_iter()
        .map(|p| (p.id, p.name))
        .collect()
}

/// Open projects, as (id, name). Scratch terminals have no services.
fn open_projects(state: &AppState) -> Vec<(String, String)> {
    let names = project_names(state);
    let projects = state.projects.lock().unwrap();
    let mut open: Vec<(String, String)> = projects.keys()
        .filter(|id| !id.starts_with("scratch-"))
        .map(|id| (id.clone(), names.get(id).cloned().unwrap_or_else(|| id.clone())))
        .collect();
    open.sort();
    open
}

fn resolve_project(state: &AppState, args: &Value) -> Result<String, String> {
    let open = open_projects(state);
    let listing = || open.iter().map(|(id, name)| format!("{} ({})", name, id)).collect::<Vec<_>>().join(", ");
    match arg_str(args, "project") {
        Some(want) => open.iter()
            .find(|(id, _)| id == want)
            .or_else(|| open.iter().find(|(_, name)| name.eq_ignore_ascii_case(want)))
            .map(|(id, _)| id.clone())
            .ok_or_else(|| if open.is_empty() {
                "No project is loaded in Lever. Ask the user to open it.".to_string()
            } else {
                format!("'{}' is not loaded in Lever. Loaded projects: {}", want, listing())
            }),
        None => match open.as_slice() {
            [(id, _)] => Ok(id.clone()),
            [] => Err("No project is loaded in Lever. Ask the user to open one.".into()),
            _ => Err(format!("Several projects are loaded; pass `project`. Loaded projects: {}", listing())),
        },
    }
}

/// A service in `scoped` — the checkout the caller is in, where every other
/// worktree's copy of `web` is not in the way — by id or by a label naming
/// exactly one; failing that, by id anywhere in the project. Scoped comes
/// first because a main-checkout id can read like a label (`web`), and must
/// not win over the caller's own worktree's `Web`.
fn resolve_service<'a>(all: &[&'a ServiceDef], scoped: &[&'a ServiceDef], want: &str) -> Result<&'a ServiceDef, String> {
    if let Some(s) = scoped.iter().find(|s| s.id == want) {
        return Ok(s);
    }
    let by_label: Vec<&&ServiceDef> = scoped.iter().filter(|s| s.label.eq_ignore_ascii_case(want)).collect();
    match by_label.as_slice() {
        [s] => Ok(s),
        [] => all.iter().find(|s| s.id == want).copied()
            .ok_or_else(|| format!("No service '{}' here. Call list_services for ids.", want)),
        _ => Err(format!("Several services are labelled '{}'; pass `checkout`, or one of their ids: {}",
            want, by_label.iter().map(|s| s.id.as_str()).collect::<Vec<_>>().join(", "))),
    }
}

/// The service a call names, and a name for it that says which checkout.
fn service_target(state: &AppState, args: &Value, cwd: Option<&Path>) -> Result<(String, ServiceDef, String), String> {
    let scope = resolve_scope(state, args, cwd)?;
    let want = arg_str(args, "service").ok_or("`service` is required")?;
    let projects = state.projects.lock().unwrap();
    let ps = projects.get(&scope.project_id).ok_or("Project not loaded")?;
    let def = resolve_service(&all_services(&ps.config), &services_in(&ps.config, &scope.checkout), want)?.clone();
    let name = service_name(&ps.config, &def);
    Ok((scope.project_id, def, name))
}

fn call_tool(app: &tauri::AppHandle, name: &str, args: &Value, cwd: Option<&Path>) -> Result<String, String> {
    let state = app.state::<AppState>();
    let state: &AppState = &state;
    match name {
        "list_projects" => list_projects(state, cwd),
        "list_services" => list_services(state, args, cwd),
        "get_logs" => get_logs(state, args, cwd),
        "start_service" => start_service(app, state, args, cwd),
        "stop_service" => stop_service(state, args, cwd),
        "restart_service" => restart_service(app, state, args, cwd),
        _ => Err(format!("unknown tool: {}", name)),
    }
}

fn list_projects(state: &AppState, cwd: Option<&Path>) -> Result<String, String> {
    let here = cwd.and_then(|c| locate(&open_checkouts(state), &canon(c)));
    let open = open_projects(state);
    let projects = state.projects.lock().unwrap();
    let list: Vec<Value> = open.iter().filter_map(|(id, name)| {
        let ps = projects.get(id)?;
        let mut v = json!({
            "id": id,
            "name": name,
            "repoPath": ps.repo_path,
            "worktrees": ps.config.worktrees.iter()
                .map(|w| json!({ "branch": w.branch, "path": w.path }))
                .collect::<Vec<_>>(),
        });
        if let Some((_, c)) = here.as_ref().filter(|(pid, _)| pid == id) {
            v["youAreIn"] = json!(describe_checkout(&ps.config, c));
        }
        Some(v)
    }).collect();
    to_json(json!({ "projects": list }))
}

fn list_services(state: &AppState, args: &Value, cwd: Option<&Path>) -> Result<String, String> {
    let scope = resolve_scope(state, args, cwd)?;
    let ports = state.agent_cache.lock().unwrap().ports.clone();
    let projects = state.projects.lock().unwrap();
    let ps = projects.get(&scope.project_id).ok_or("Project not loaded")?;

    let service_json = |s: &ServiceDef| {
        let tracked = ps.tracked.get(&s.id).filter(|t| is_pid_alive(t.pid));
        let mut v = json!({
            "id": s.id,
            "label": s.label,
            "kind": if s.service_type == "task" { "task" } else { "service" },
            "command": service_shell_line(s),
            "status": if tracked.is_some() { "running" } else { "stopped" },
        });
        if !s.description.is_empty() {
            v["description"] = json!(s.description);
        }
        if !s.cwd.is_empty() {
            v["cwd"] = json!(s.cwd);
        }
        if let Some(t) = tracked {
            v["pid"] = json!(t.pid);
            if let Some(p) = ports.get(&s.id) {
                v["ports"] = json!(p);
            }
        } else if let Some(exit) = ps.last_exit.get(&s.id) {
            v["lastRun"] = json!({
                "exitCode": exit.code,
                "signal": exit.signal,
                "endedSecondsAgo": now_unix() - exit.at,
            });
        }
        v
    };

    let checkouts: Vec<Value> = groups_in(&ps.config, &scope.checkout).into_iter().map(|(wt, groups)| {
        let groups: Vec<Value> = groups.iter().map(|g| json!({
            "id": g.id,
            "label": g.label,
            "services": g.services.iter().map(&service_json).collect::<Vec<_>>(),
        })).collect();
        match wt {
            None => json!({ "checkout": "main", "path": ps.repo_path, "groups": groups }),
            Some(w) => json!({ "checkout": "worktree", "branch": w.branch, "path": w.path, "groups": groups }),
        }
    }).collect();

    let mut scope_note = format!("Showing {}", describe_checkout(&ps.config, &scope.checkout));
    if scope.detected {
        scope_note.push_str(", the one you are working in. Pass checkout: \"all\" to see the others");
    }
    scope_note.push('.');
    to_json(json!({ "project": scope.project_id, "scope": scope_note, "checkouts": checkouts }))
}

fn get_logs(state: &AppState, args: &Value, cwd: Option<&Path>) -> Result<String, String> {
    let (project_id, def, name) = service_target(state, args, cwd)?;
    // A service found still running when Lever opened was adopted by pid, with
    // no terminal to read — its output went to a Lever that has since quit.
    let adopted = state.projects.lock().unwrap().get(&project_id)
        .and_then(|ps| ps.tracked.get(&def.id))
        .map_or(false, |t| t.pty_id.is_none());
    if adopted {
        return Err(format!(
            "{} has been running since before Lever was last opened, so its output was not captured. Restart it (restart_service) to see its logs.",
            name
        ));
    }
    let lines = read_output(state, &project_id, &def.id)?;
    let query = LogQuery {
        from: arg_u64(args, "from").map(|n| n.max(1) as usize),
        to: arg_u64(args, "to").map(|n| n as usize),
        lines: arg_u64(args, "lines").map_or(DEFAULT_LOG_LINES, |n| n as usize),
        contains: arg_str(args, "contains"),
    };
    Ok(select_logs(&name, &lines, &query))
}

/// Waits for a service just started on `pty_id` to come up, exit, or settle,
/// and says which, with its ports and first lines of output.
fn await_ready(state: &AppState, project_id: &str, service_id: &str, pty_id: &str, name: &str) -> String {
    let started = std::time::Instant::now();
    let (exit, ports) = loop {
        std::thread::sleep(Duration::from_millis(200));
        let (exit, last_output) = {
            let projects = state.projects.lock().unwrap();
            let ps = match projects.get(project_id) {
                Some(ps) => ps,
                None => return format!("Started {}, but its project was closed.", name),
            };
            (
                ps.last_exit.get(service_id).filter(|e| e.pty_id == pty_id).cloned(),
                ps.pty_sessions.get(pty_id).map(|s| s.last_output.load(std::sync::atomic::Ordering::Relaxed)),
            )
        };
        // Only a scan made after the start counts: until then the cache still
        // holds the ports of the run this one may be replacing.
        let ports = {
            let cache = state.agent_cache.lock().unwrap();
            cache.last_scan.filter(|t| *t > started)
                .and_then(|_| cache.ports.get(service_id).cloned())
                .unwrap_or_default()
        };
        let quiet = last_output.map_or(true, |t| now_millis().saturating_sub(t) >= QUIET_MS);
        let elapsed = started.elapsed();
        if exit.is_some() || !ports.is_empty() || (quiet && elapsed >= MIN_READY_WAIT) || elapsed >= READY_TIMEOUT {
            break (exit, ports);
        }
    };
    // The newest output may still be in the pump's batch.
    std::thread::sleep(Duration::from_millis(100));
    let output = read_output(state, project_id, service_id)
        .map(|l| tail(l, START_OUTPUT_LINES).join("\n"))
        .unwrap_or_else(|e| format!("(output unavailable: {})", e));
    let outcome = match (&exit, ports.as_slice()) {
        (Some(e), _) => exit_sentence(name, e),
        (None, []) => format!("{} is running; it is not listening on a port yet.", name),
        (None, ports) => format!("{} is up on {}.", name,
            ports.iter().map(|p| format!(":{}", p)).collect::<Vec<_>>().join(", ")),
    };
    format!("{}\n\nOutput so far:\n{}", outcome, output)
}

fn exit_sentence(name: &str, exit: &LastExit) -> String {
    match exit {
        LastExit { code: Some(c), .. } => format!("{} exited with code {}.", name, c),
        LastExit { signal: Some(s), .. } => format!("{} was ended by {}.", name, s),
        _ => format!("{} exited.", name),
    }
}

/// Tells the window a service it did not start is up, so it builds the
/// terminal now — on its next poll the first lines would already be gone.
fn announce_start(app: &tauri::AppHandle, project_id: &str, service_id: &str, pty_id: &str) {
    let _ = app.emit_to(window_label(project_id).as_str(), "svc-started", SvcExitEvent {
        id: service_id.to_string(),
        pty_id: pty_id.to_string(),
    });
}

fn start_service(app: &tauri::AppHandle, state: &AppState, args: &Value, cwd: Option<&Path>) -> Result<String, String> {
    let (project_id, def, name) = service_target(state, args, cwd)?;
    debug_action("mcp", &format!("agent starts {}", name));
    let started = start_service_in(app, state, &project_id, &def.id, &window_label(&project_id))?;
    announce_start(app, &project_id, &def.id, &started.pty_id);

    let wait = arg_u64(args, "wait_seconds").unwrap_or(0).min(MAX_WAIT_SECS);
    if wait == 0 {
        return Ok(await_ready(state, &project_id, &def.id, &started.pty_id, &name));
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(wait);
    let exit = loop {
        let done = state.projects.lock().unwrap().get(&project_id)
            .and_then(|ps| ps.last_exit.get(&def.id).cloned())
            .filter(|e| e.pty_id == started.pty_id);
        if done.is_some() || std::time::Instant::now() >= deadline {
            break done;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    // The last output may still be in the pump's batch.
    std::thread::sleep(Duration::from_millis(100));
    let output = read_output(state, &project_id, &def.id)
        .map(|l| tail(l, 100).join("\n"))
        .unwrap_or_else(|e| format!("(output unavailable: {})", e));
    let outcome = match exit {
        None => format!("{} is still running after {}s.", name, wait),
        Some(e) => exit_sentence(&name, &e),
    };
    Ok(format!("{}\n\nLast output:\n{}", outcome, output))
}

fn stop_service(state: &AppState, args: &Value, cwd: Option<&Path>) -> Result<String, String> {
    let (project_id, def, name) = service_target(state, args, cwd)?;
    let running = state.projects.lock().unwrap().get(&project_id)
        .map_or(false, |ps| ps.tracked.contains_key(&def.id));
    if !running {
        return Ok(format!("{} is not running.", name));
    }
    debug_action("mcp", &format!("agent stops {}", name));
    stop_service_in(state, &project_id, &def.id)?;
    Ok(format!("Stopped {}.", name))
}

fn restart_service(app: &tauri::AppHandle, state: &AppState, args: &Value, cwd: Option<&Path>) -> Result<String, String> {
    let (project_id, def, name) = service_target(state, args, cwd)?;
    let pid = state.projects.lock().unwrap().get(&project_id)
        .and_then(|ps| ps.tracked.get(&def.id).map(|t| t.pid));
    debug_action("mcp", &format!("agent restarts {}", name));
    if let Some(pid) = pid {
        stop_service_in(state, &project_id, &def.id)?;
        if !wait_for_exit(&[pid], 10_000).is_empty() {
            return Err(format!("{} did not exit within 10s of being stopped; not starting it again.", name));
        }
    }
    let started = start_service_in(app, state, &project_id, &def.id, &window_label(&project_id))?;
    announce_start(app, &project_id, &def.id, &started.pty_id);
    Ok(format!("Restarted. {}", await_ready(state, &project_id, &def.id, &started.pty_id, &name)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> String {
        INSTRUCTIONS.to_string()
    }

    fn no_tools(_: &str, _: &Value) -> Result<String, String> {
        Err("no tools in this test".into())
    }

    #[test]
    fn initialize_echoes_a_version_it_speaks_and_falls_back_otherwise() {
        let reply = handle_rpc(&json!({"jsonrpc":"2.0","id":1,"method":"initialize",
            "params":{"protocolVersion":"2025-03-26"}}), no_tools, base).unwrap();
        assert_eq!(reply["result"]["protocolVersion"], "2025-03-26");
        assert!(reply["result"]["capabilities"]["tools"].is_object());

        let reply = handle_rpc(&json!({"jsonrpc":"2.0","id":2,"method":"initialize",
            "params":{"protocolVersion":"1999-01-01"}}), no_tools, base).unwrap();
        assert_eq!(reply["result"]["protocolVersion"], PROTOCOL_VERSIONS[0]);
    }

    #[test]
    fn notifications_get_no_reply() {
        assert!(handle_rpc(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}), no_tools, base).is_none());
    }

    #[test]
    fn every_listed_tool_has_a_schema() {
        let reply = handle_rpc(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}), no_tools, base).unwrap();
        let tools = reply["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 6);
        for t in tools {
            assert_eq!(t["inputSchema"]["type"], "object", "{}", t["name"]);
        }
    }

    #[test]
    fn a_failing_tool_is_a_result_not_a_protocol_error() {
        let reply = handle_rpc(&json!({"jsonrpc":"2.0","id":7,"method":"tools/call",
            "params":{"name":"list_projects","arguments":{}}}), no_tools, base).unwrap();
        assert_eq!(reply["result"]["isError"], true);
        assert_eq!(reply["result"]["content"][0]["text"], "no tools in this test");
    }

    #[test]
    fn tool_arguments_reach_the_tool() {
        let reply = handle_rpc(&json!({"jsonrpc":"2.0","id":"a","method":"tools/call",
            "params":{"name":"get_logs","arguments":{"service":"web"}}}),
            |name, args| Ok(format!("{}:{}", name, args["service"].as_str().unwrap())), base).unwrap();
        assert_eq!(reply["id"], "a");
        assert_eq!(reply["result"]["content"][0]["text"], "get_logs:web");
        assert_eq!(reply["result"]["isError"], false);
    }

    #[test]
    fn unknown_methods_and_tools_are_rpc_errors() {
        let r = handle_rpc(&json!({"jsonrpc":"2.0","id":1,"method":"resources/list"}), no_tools, base).unwrap();
        assert_eq!(r["error"]["code"], -32601);
        let r = handle_rpc(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
            "params":{"name":"rm_rf"}}), no_tools, base).unwrap();
        assert_eq!(r["error"]["code"], -32602);
    }

    #[test]
    fn the_token_must_match_exactly() {
        assert!(token_matches(Some("Bearer abc123"), "abc123"));
        assert!(!token_matches(Some("Bearer abc12"), "abc123"));
        assert!(!token_matches(Some("Bearer abc124"), "abc123"));
        assert!(!token_matches(Some("abc123"), "abc123"));
        assert!(!token_matches(None, "abc123"));
    }

    #[test]
    fn only_local_origins_get_through() {
        assert!(origin_allowed(None));
        assert!(origin_allowed(Some("http://localhost:3000")));
        assert!(origin_allowed(Some("http://127.0.0.1:7438")));
        assert!(!origin_allowed(Some("https://evil.example")));
        assert!(origin_allowed(Some("http://[::1]:7438")));
        assert!(!origin_allowed(Some("http://localhost.evil.example")));
        assert!(!origin_allowed(Some("http://127.0.0.1.evil.example")));
        assert!(!origin_allowed(Some("null")));
    }

    /// One raw HTTP exchange against `serve` on a real socket.
    fn exchange(request: String) -> String {
        use std::io::Write;
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let addr = server.server_addr().to_ip().unwrap();
        let handle = std::thread::spawn(move || {
            let req = server.recv().unwrap();
            serve("s3cret", req, &|name, _, _| Ok(format!("called {}", name)), &|_| base());
        });
        let mut stream = std::net::TcpStream::connect(addr).unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut out = String::new();
        stream.read_to_string(&mut out).unwrap();
        handle.join().unwrap();
        out
    }

    fn post(auth: &str, extra: &str, body: &str) -> String {
        exchange(format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n{}{}Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            auth, extra, body.len(), body
        ))
    }

    const AUTH: &str = "Authorization: Bearer s3cret\r\n";

    #[test]
    fn a_tool_call_goes_through_over_http() {
        let out = post(AUTH, "", r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_services","arguments":{}}}"#);
        assert!(out.starts_with("HTTP/1.1 200"), "{}", out);
        assert!(out.contains("called list_services"), "{}", out);
    }

    #[test]
    fn a_request_without_the_token_is_refused() {
        let out = post("", "", r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#);
        assert!(out.starts_with("HTTP/1.1 401"), "{}", out);
        let out = post("Authorization: Bearer nope\r\n", "", r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#);
        assert!(out.starts_with("HTTP/1.1 401"), "{}", out);
    }

    #[test]
    fn a_browser_page_is_refused_even_with_the_token() {
        let out = post(AUTH, "Origin: https://evil.example\r\n", r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#);
        assert!(out.starts_with("HTTP/1.1 403"), "{}", out);
    }

    #[test]
    fn a_notification_is_accepted_with_no_body() {
        let out = post(AUTH, "", r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
        assert!(out.starts_with("HTTP/1.1 202"), "{}", out);
    }

    #[test]
    fn get_is_not_offered() {
        let out = exchange(format!("GET /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n{}\r\n", AUTH));
        assert!(out.starts_with("HTTP/1.1 405"), "{}", out);
    }

    #[test]
    fn initialize_carries_the_callers_briefing() {
        let reply = handle_rpc(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}),
            no_tools, || "you are in feat/a".to_string()).unwrap();
        assert_eq!(reply["result"]["instructions"], "you are in feat/a");
    }

    fn line(label: &str, kind: &'static str, command: &str, running: bool, ports: &[u16]) -> BriefLine {
        BriefLine { label: label.into(), kind, command: command.into(), running, ports: ports.to_vec() }
    }

    #[test]
    fn a_briefing_names_the_checkout_and_what_runs_there() {
        let b = checkout_briefing("Shop", "worktree feat/a", &[
            line("Web", "service", "npm run dev", true, &[5173]),
            line("API", "service", "uvicorn app:app", false, &[]),
            line("Migrate", "task", "npm run migrate", false, &[]),
        ]);
        assert!(b.starts_with("You are working in worktree feat/a of the Lever project \"Shop\"."), "{}", b);
        assert!(b.ends_with(INSTRUCTIONS), "keeps the general rules");
        assert!(b.contains("- Web (service): `npm run dev` — running on :5173"), "{}", b);
        assert!(b.contains("- API (service): `uvicorn app:app` — stopped"), "{}", b);
        assert!(b.contains("- Migrate (task): `npm run migrate` — not running"), "{}", b);
        assert!(b.contains("instead of running it in your shell"), "{}", b);
    }

    /// Not a check: `cargo test print_a_briefing -- --nocapture` shows one.
    #[test]
    fn print_a_briefing() {
        println!("{}", checkout_briefing("Shop", "worktree feat/a", &[
            line("Web", "service", "npm run dev", true, &[5173]),
            line("API", "service", "uvicorn app:app --reload", false, &[]),
            line("Migrate", "task", "npm run migrate", false, &[]),
        ]));
    }

    #[test]
    fn a_long_briefing_is_cut_short() {
        let many: Vec<BriefLine> = (0..20).map(|i| line(&format!("svc{}", i), "service", &"x".repeat(200), false, &[])).collect();
        let b = checkout_briefing("Big", "the main checkout", &many);
        assert!(b.contains("svc14") && !b.contains("svc15"), "{}", b);
        assert!(b.contains("…and 5 more"), "{}", b);
        assert!(b.contains(&format!("`{}…`", "x".repeat(BRIEFING_MAX_COMMAND))), "commands are trimmed");
    }

    #[test]
    fn a_checkout_with_nothing_defined_says_so() {
        let b = checkout_briefing("Empty", "the main checkout", &[]);
        assert!(b.contains("no services or tasks defined in Lever."), "{}", b);
        assert!(b.ends_with(INSTRUCTIONS));
    }

    fn cfg() -> McpConfig {
        McpConfig { enabled: true, port: 7438, token: "tok".into() }
    }

    const CODEX_USER: &str = "model = \"o4\"\n\n[mcp_servers.github]\ncommand = \"gh-mcp\"\n\n[profiles.fast]\nmodel = \"mini\"\n";

    #[test]
    fn lever_is_appended_to_a_codex_config_and_the_rest_is_untouched() {
        let out = with_codex_table(CODEX_USER, &cfg());
        assert!(out.starts_with(CODEX_USER), "{}", out);
        assert!(out.ends_with(&format!(
            "{}\n[mcp_servers.lever]\nurl = \"http://127.0.0.1:7438/mcp\"\nhttp_headers = {{ \"Authorization\" = \"Bearer tok\" }}\n",
            CODEX_MARKER)), "{}", out);
    }

    #[test]
    fn adding_twice_leaves_one_table_with_the_new_token() {
        let once = with_codex_table(CODEX_USER, &cfg());
        let twice = with_codex_table(&once, &McpConfig { token: "new".into(), ..cfg() });
        assert_eq!(twice.matches("[mcp_servers.lever]").count(), 1, "{}", twice);
        assert!(twice.contains("Bearer new") && !twice.contains("Bearer tok"), "{}", twice);
    }

    #[test]
    fn removing_lever_gives_back_the_config_it_started_from() {
        assert_eq!(without_codex_table(&with_codex_table(CODEX_USER, &cfg())), CODEX_USER);
    }

    #[test]
    fn a_lever_table_in_the_middle_is_removed_with_its_subtables_and_nothing_else() {
        let mid = "a = 1\n\n[mcp_servers.lever]\nurl = \"x\"\n\n[mcp_servers.lever.tools.get_logs]\napproval_mode = \"auto\"\n\n[mcp_servers.leverage]\ncommand = \"keep\"\n";
        assert_eq!(without_codex_table(mid), "a = 1\n\n[mcp_servers.leverage]\ncommand = \"keep\"\n");
    }

    #[test]
    fn an_empty_codex_config_gets_just_the_table() {
        assert!(with_codex_table("", &cfg()).starts_with(CODEX_MARKER));
        assert_eq!(without_codex_table(&with_codex_table("", &cfg())), "");
    }

    fn numbered(n: usize) -> Vec<String> {
        (1..=n).map(|i| format!("line {}", i)).collect()
    }

    fn q<'a>(from: Option<usize>, to: Option<usize>, lines: usize, contains: Option<&'a str>) -> LogQuery<'a> {
        LogQuery { from, to, lines, contains }
    }

    #[test]
    fn logs_default_to_the_newest_lines() {
        let out = select_logs("Web", &numbered(500), &q(None, None, 3, None));
        assert_eq!(out, "Web: lines 498–500 of 500\nline 498\nline 499\nline 500");
    }

    #[test]
    fn a_range_is_returned_exactly() {
        let out = select_logs("Web", &numbered(500), &q(Some(10), Some(12), 200, None));
        assert_eq!(out, "Web: lines 10–12 of 500\nline 10\nline 11\nline 12");
    }

    #[test]
    fn from_alone_pages_forward_and_to_alone_reads_up_to_it() {
        let fwd = select_logs("Web", &numbered(500), &q(Some(100), None, 2, None));
        assert!(fwd.starts_with("Web: lines 100–101 of 500\n"), "{}", fwd);
        let back = select_logs("Web", &numbered(500), &q(None, Some(50), 2, None));
        assert!(back.starts_with("Web: lines 49–50 of 500\n"), "{}", back);
    }

    #[test]
    fn matches_carry_their_line_numbers() {
        let lines: Vec<String> = ["ok", "ERROR a", "ok", "error b", "ok"].iter().map(|s| s.to_string()).collect();
        let out = select_logs("API", &lines, &q(None, None, 200, Some("error")));
        assert_eq!(out, "API: 2 lines containing \"error\", between lines 2 and 4 of 5\n2: ERROR a\n4: error b");
    }

    #[test]
    fn a_reply_is_capped_and_says_where_to_pick_up() {
        let big: Vec<String> = (1..=2000).map(|i| format!("{:05} {}", i, "x".repeat(94))).collect();
        let newest = select_logs("Web", &big, &q(None, None, 2000, None));
        assert!(newest.len() <= MAX_LOG_CHARS + 200, "{}", newest.len());
        assert!(newest.ends_with(&big[1999]), "the newest line survives");
        assert!(newest.lines().next().unwrap().contains("pass to="), "{}", newest.lines().next().unwrap());

        let forward = select_logs("Web", &big, &q(Some(1), None, 2000, None));
        assert!(forward.lines().nth(1) == Some(big[0].as_str()), "reading forward keeps the start");
        assert!(forward.lines().next().unwrap().contains("pass from="), "{}", forward.lines().next().unwrap());
    }

    #[test]
    fn one_enormous_line_still_comes_back_cut() {
        let out = select_logs("Web", &["é".repeat(MAX_LOG_CHARS)], &q(None, None, 200, None));
        assert!(out.ends_with('…') && out.len() <= MAX_LOG_CHARS + 100, "{}", out.len());
    }

    #[test]
    fn empty_and_out_of_range_logs_say_so() {
        assert_eq!(select_logs("Web", &[], &q(None, None, 200, None)), "Web has printed nothing yet.");
        assert_eq!(select_logs("Web", &numbered(5), &q(Some(9), None, 200, None)),
            "Web has no lines there; its output has 5 lines.");
        assert!(select_logs("Web", &numbered(5), &q(None, None, 200, Some("panic"))).starts_with("No line of Web contains"));
    }

    fn svc(id: &str, label: &str) -> ServiceDef {
        ServiceDef {
            id: id.into(), label: label.into(), description: String::new(), command: "true".into(),
            args: vec![], cwd: String::new(), service_type: "service".into(), stop_command: vec![],
        }
    }

    #[test]
    fn a_label_is_looked_up_in_the_callers_checkout() {
        // Each worktree carries a copy of `web` under the same label.
        let (main_web, wt_web, wt_api) = (svc("web", "Web"), svc("web-wt-a", "Web"), svc("api-wt-a", "API"));
        let all = vec![&main_web, &wt_web, &wt_api];
        let in_worktree = vec![&wt_web, &wt_api];
        assert_eq!(resolve_service(&all, &in_worktree, "web").unwrap().id, "web-wt-a");
        assert_eq!(resolve_service(&all, &vec![&main_web], "web").unwrap().id, "web");
        // An id outside the scope still reaches its service.
        assert_eq!(resolve_service(&all, &in_worktree, "api-wt-a").unwrap().id, "api-wt-a");
        assert_eq!(resolve_service(&all, &vec![&main_web], "web-wt-a").unwrap().id, "web-wt-a");
        // With no checkout to go by, the label is ambiguous and says so.
        match resolve_service(&all, &all, "Web") {
            Err(e) => assert!(e.contains("web, web-wt-a"), "{}", e),
            Ok(_) => panic!("main and the worktree both have a Web"),
        }
        assert!(resolve_service(&all, &in_worktree, "db").is_err());
    }

    fn checkouts() -> Vec<(String, Checkout, PathBuf)> {
        vec![
            ("p1".into(), Checkout::Main, PathBuf::from("/code/app")),
            ("p1".into(), Checkout::Worktree("wt-a".into()), PathBuf::from("/code/app-worktrees/feat-a")),
            // Kept inside the repo, as some people do.
            ("p1".into(), Checkout::Worktree("wt-b".into()), PathBuf::from("/code/app/.worktrees/feat-b")),
            ("p2".into(), Checkout::Main, PathBuf::from("/code/other")),
        ]
    }

    #[test]
    fn the_callers_directory_picks_its_checkout() {
        let c = checkouts();
        assert_eq!(locate(&c, Path::new("/code/app")), Some(("p1".into(), Checkout::Main)));
        assert_eq!(locate(&c, Path::new("/code/app/src/lib")), Some(("p1".into(), Checkout::Main)));
        assert_eq!(locate(&c, Path::new("/code/app-worktrees/feat-a/ui")),
            Some(("p1".into(), Checkout::Worktree("wt-a".into()))));
        assert_eq!(locate(&c, Path::new("/code/other")), Some(("p2".into(), Checkout::Main)));
        assert_eq!(locate(&c, Path::new("/somewhere/else")), None);
    }

    #[test]
    fn a_worktree_inside_the_repo_beats_the_repo() {
        assert_eq!(locate(&checkouts(), Path::new("/code/app/.worktrees/feat-b/src")),
            Some(("p1".into(), Checkout::Worktree("wt-b".into()))));
    }

    #[test]
    fn a_sibling_directory_with_a_longer_name_is_not_inside() {
        // `/code/app-worktrees` starts with the string `/code/app`, not the path.
        assert_eq!(locate(&checkouts(), Path::new("/code/app-worktrees")), None);
    }

    #[test]
    fn a_checkout_is_named_by_branch_path_or_keyword() {
        let wts = vec![WorktreeDef {
            id: "wt-a".into(), branch: "feat/a".into(), path: "/code/app-worktrees/feat-a".into(), groups: vec![],
        }];
        assert_eq!(parse_checkout(&wts, "feat/a").unwrap(), Checkout::Worktree("wt-a".into()));
        assert_eq!(parse_checkout(&wts, "wt-a").unwrap(), Checkout::Worktree("wt-a".into()));
        assert_eq!(parse_checkout(&wts, "/code/app-worktrees/feat-a").unwrap(), Checkout::Worktree("wt-a".into()));
        assert_eq!(parse_checkout(&wts, "MAIN").unwrap(), Checkout::Main);
        assert_eq!(parse_checkout(&wts, "all").unwrap(), Checkout::All);
        assert!(parse_checkout(&wts, "feat/b").unwrap_err().contains("feat/a"));
    }

    #[test]
    fn the_client_end_of_the_connection_is_the_one_found() {
        // Our accepted socket (pid 10) and the agent's (pid 42) both match
        // `-iTCP:51591`; only the agent's runs from that port to ours.
        let out = "p10\nf5\nn127.0.0.1:7438->127.0.0.1:51591\np42\nf21\nn127.0.0.1:51591->127.0.0.1:7438\n";
        assert_eq!(pid_owning(out, 51591, 7438, 10), Some(42));
        // A port that merely ends in the same digits is someone else's.
        let out = "p42\nf21\nn127.0.0.1:151591->127.0.0.1:7438\n";
        assert_eq!(pid_owning(out, 51591, 7438, 10), None);
    }

    /// The whole chain on a real connection: a client started in some other
    /// directory is found from its socket, and that directory comes back.
    #[test]
    fn a_callers_directory_is_found_from_its_connection() {
        let dir = std::env::temp_dir().join(format!("lever-mcp-caller-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let client = std::process::Command::new("curl")
            .args(["-s", "-X", "POST", "-d", "{}", &format!("http://127.0.0.1:{}/mcp", port)])
            .current_dir(&dir)
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let req = server.recv().unwrap();
        let cwd = caller_cwd(*req.remote_addr().unwrap(), port);
        let _ = req.respond(tiny_http::Response::empty(200));
        let _ = client.wait_with_output();
        let (got, want) = (cwd.map(|p| canon(&p)), Some(canon(&dir)));
        let _ = fs::remove_dir(&dir);
        assert_eq!(got, want);
    }

    #[test]
    fn this_process_reads_its_own_working_directory() {
        assert_eq!(process_cwd(std::process::id()).map(|p| canon(&p)), Some(canon(&std::env::current_dir().unwrap())));
    }
}

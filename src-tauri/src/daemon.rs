//! The socket the `lever` command line talks to.
//!
//! Lever owns the services it runs whether or not a window is open, so the CLI
//! is a client of the running Lever rather than a second way to run things: a
//! service started from the terminal shows in the window, and one started in
//! the window can be read from the terminal. When no Lever is running, the CLI
//! starts one headless (see cli.rs).
//!
//! One request per connection, as a line of JSON: `{op, cwd, args}`. Replies
//! are lines of JSON too — any number of `{"type":"data"}` chunks of output,
//! then one `{"type":"done"}` with the result or the error.
//!
//! The socket sits in ~/.lever and is made 0600: only this user can drive it.

use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::Manager;

use super::{
    ensure_project_loaded, load_project_config, load_project_index, mcp, open_project, output,
    start_service_in, stop_service_in, AppState,
};
use mcp::{arg_str, canon, locate, Checkout};

const SOCKET_SUBPATH: &str = ".lever/lever.sock";

/// Whether this Lever bound the socket.
static SERVING: AtomicBool = AtomicBool::new(false);

pub fn socket_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(SOCKET_SUBPATH))
}

#[derive(Deserialize)]
struct Request {
    op: String,
    #[serde(default)]
    cwd: Option<PathBuf>,
    #[serde(default)]
    args: Value,
}

pub fn start(app: tauri::AppHandle) {
    let Some(path) = socket_path() else { return };
    // Someone answering is another Lever (a dev build next to the installed
    // one); leave it be. Nobody answering is a socket left by a Lever that
    // did not exit cleanly.
    if UnixStream::connect(&path).is_ok() {
        super::debug_log("cli", "error", "another Lever is serving the CLI socket; not taking it over");
        return;
    }
    let _ = fs::remove_file(&path);
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            super::debug_log("cli", "error", &format!("could not open {}: {}", path.display(), e));
            return;
        }
    };
    let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    SERVING.store(true, Ordering::SeqCst);

    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            // Own thread each: `logs --follow` and `run` last as long as the
            // service does.
            std::thread::spawn(move || serve(&app, stream));
        }
    });
}

/// Removes the socket on quit, so the next CLI call starts a fresh Lever
/// instead of waiting on one that is gone. Only the Lever that bound it: the
/// socket may be another Lever's.
pub fn stop() {
    if !SERVING.load(Ordering::SeqCst) {
        return;
    }
    if let Some(path) = socket_path() {
        let _ = fs::remove_file(path);
    }
}

fn send(out: &mut UnixStream, v: Value) -> bool {
    let mut line = v.to_string();
    line.push('\n');
    out.write_all(line.as_bytes()).is_ok()
}

fn serve(app: &tauri::AppHandle, stream: UnixStream) {
    let mut out = match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let mut line = String::new();
    if BufReader::new(&stream).read_line(&mut line).is_err() {
        return;
    }
    let reply = match serde_json::from_str::<Request>(&line) {
        Ok(req) => handle(app, &req, &stream, &mut out),
        Err(e) => Err(format!("bad request: {}", e)),
    };
    let _ = send(&mut out, match reply {
        Ok(result) => json!({ "type": "done", "ok": true, "result": result }),
        Err(error) => json!({ "type": "done", "ok": false, "error": error }),
    });
}

fn handle(app: &tauri::AppHandle, req: &Request, input: &UnixStream, out: &mut UnixStream) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let state: &AppState = &state;
    let cwd = req.cwd.as_deref();
    let args = &req.args;
    match req.op.as_str() {
        "ping" | "shutdown" => {}
        // A tool's own arguments carry the project.
        "tool" => load_for(state, cwd, args.get("args").unwrap_or(&Value::Null)),
        _ => load_for(state, cwd, args),
    }
    match req.op.as_str() {
        "ping" => Ok(json!({ "pid": std::process::id(), "version": env!("CARGO_PKG_VERSION") })),
        // The MCP tools already say everything the CLI needs, in the same
        // words an agent gets; the CLI only lays them out.
        "tool" => {
            let name = arg_str(args, "name").ok_or("`name` is required")?;
            let empty = json!({});
            let tool_args = args.get("args").unwrap_or(&empty);
            mcp::call_tool(app, name, tool_args, cwd).map(Value::String)
        }
        "projects" => {
            let loaded: Vec<String> = state.projects.lock().unwrap().keys().cloned().collect();
            let here = cwd.and_then(|c| locate(&mcp::open_checkouts(state), &canon(c))).map(|(id, _)| id);
            Ok(json!(load_project_index(&state.projects_dir).projects.iter().map(|p| json!({
                "id": p.id,
                "name": p.name,
                "repoPath": p.repo_path,
                "loaded": loaded.contains(&p.id),
                "here": here.as_deref() == Some(p.id.as_str()),
            })).collect::<Vec<_>>()))
        }
        "up" => up(app, state, args, cwd),
        "logs" => logs(state, args, cwd, input, out),
        "run" => run(app, state, args, cwd, input, out),
        "open" => {
            let scope = mcp::resolve_scope(state, args, cwd)?;
            // Windows are made, and AppKit touched, on the main thread.
            let (tx, rx) = std::sync::mpsc::channel();
            let (handle, id) = (app.clone(), scope.project_id.clone());
            app.run_on_main_thread(move || {
                let _ = tx.send(open_project(id, handle.clone(), handle.state()));
            }).map_err(|e| e.to_string())?;
            rx.recv().map_err(|e| e.to_string())??;
            Ok(json!(scope.project_id))
        }
        "shutdown" => {
            let app = app.clone();
            // After the reply is out.
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(100));
                app.exit(0);
            });
            Ok(Value::Null)
        }
        op => Err(format!("unknown op: {}", op)),
    }
}

/// Loads the project a call is about, when nothing has loaded it yet: the one
/// named, or the one whose checkout holds the caller's directory.
fn load_for(state: &AppState, cwd: Option<&Path>, args: &Value) {
    let index = load_project_index(&state.projects_dir);
    if let Some(want) = arg_str(args, "project") {
        if let Some(meta) = index.projects.iter()
            .find(|p| p.id == want)
            .or_else(|| index.projects.iter().find(|p| p.name.eq_ignore_ascii_case(want)))
        {
            let _ = ensure_project_loaded(state, &meta.id);
        }
        return;
    }
    let Some(cwd) = cwd else { return };
    let mut checkouts = Vec::new();
    for meta in &index.projects {
        if !meta.repo_path.is_empty() {
            checkouts.push((meta.id.clone(), Checkout::Main, canon(Path::new(&meta.repo_path))));
        }
        if let Ok(config) = load_project_config(&state.projects_dir, &meta.id) {
            for wt in &config.worktrees {
                checkouts.push((meta.id.clone(), Checkout::Worktree(wt.id.clone()), canon(Path::new(&wt.path))));
            }
        }
    }
    if let Some((id, _)) = locate(&checkouts, &canon(cwd)) {
        let _ = ensure_project_loaded(state, &id);
    }
}

/// Starts a group's services — or, with no group named, every service (not
/// task) in the checkout — skipping the ones already running.
fn up(app: &tauri::AppHandle, state: &AppState, args: &Value, cwd: Option<&Path>) -> Result<Value, String> {
    let scope = mcp::resolve_scope(state, args, cwd)?;
    let want = arg_str(args, "group");
    let targets: Vec<(String, String, bool)> = {
        let projects = state.projects.lock().unwrap();
        let ps = projects.get(&scope.project_id).ok_or("Project not loaded")?;
        let groups: Vec<_> = mcp::groups_in(&ps.config, &scope.checkout).into_iter()
            .flat_map(|(_, gs)| gs.iter())
            .filter(|g| want.map_or(true, |w| g.id == w || g.label.eq_ignore_ascii_case(w)))
            .collect();
        if let (Some(w), true) = (want, groups.is_empty()) {
            return Err(format!("No group '{}' here.", w));
        }
        groups.iter()
            .flat_map(|g| g.services.iter())
            // Naming a group asks for all of it; `up` alone means what stays up.
            .filter(|s| want.is_some() || s.service_type != "task")
            .map(|s| (s.id.clone(), mcp::service_name(&ps.config, s), ps.tracked.contains_key(&s.id)))
            .collect()
    };
    let mut report = Vec::new();
    for (id, name, running) in targets {
        if running {
            report.push(json!({ "service": name, "status": "already running" }));
            continue;
        }
        match start_service_in(app, state, &scope.project_id, &id, &mcp::window_label(&scope.project_id)) {
            Ok(started) => {
                mcp::announce_start(app, &scope.project_id, &id, &started.pty_id);
                report.push(json!({ "service": name, "status": "started" }));
            }
            Err(e) => report.push(json!({ "service": name, "status": "failed", "error": e })),
        }
    }
    Ok(json!(report))
}

/// The last `n` lines of raw terminal output, escape sequences and all, so
/// colours survive to the user's terminal.
fn last_lines(raw: &str, n: usize) -> &str {
    let body = raw.strip_suffix('\n').unwrap_or(raw);
    match body.rmatch_indices('\n').nth(n.saturating_sub(1)) {
        Some((i, _)) if n > 0 => &raw[i + 1..],
        _ if n == 0 => "",
        _ => raw,
    }
}

fn logs(state: &AppState, args: &Value, cwd: Option<&Path>, input: &UnixStream, out: &mut UnixStream) -> Result<Value, String> {
    let (project_id, def, name) = mcp::service_target(state, args, cwd)?;
    let pty = mcp::service_run(state, &project_id, &def.id)
        .ok_or_else(|| format!("{} has not run since Lever started, so there is no output to show.", name))?;
    let (backlog, rx) = output::hub().subscribe(&pty)
        .ok_or_else(|| format!("{}'s output was not kept.", name))?;
    let n = args.get("lines").and_then(Value::as_u64).unwrap_or(200) as usize;
    if !send(out, json!({ "type": "data", "data": last_lines(&backlog.data, n) })) {
        return Ok(Value::Null);
    }
    if !args.get("follow").and_then(Value::as_bool).unwrap_or(false) {
        return Ok(Value::Null);
    }
    // A quiet service sends nothing to fail on, so watch for the caller
    // hanging up (as `run` does) and look between waits.
    let gone = Arc::new(AtomicBool::new(false));
    if let Ok(mut watch) = input.try_clone() {
        let gone = gone.clone();
        std::thread::spawn(move || {
            let _ = watch.read(&mut [0u8; 1]);
            gone.store(true, Ordering::SeqCst);
        });
    }
    while !gone.load(Ordering::SeqCst) {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(output::Event::Data(d)) => {
                if !send(out, json!({ "type": "data", "data": d })) {
                    break;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            _ => break,
        }
    }
    Ok(Value::Null)
}

/// Runs a service in the foreground: its output streams to the caller, the
/// caller hanging up (Ctrl-C) stops it, and the result carries its exit code.
fn run(app: &tauri::AppHandle, state: &AppState, args: &Value, cwd: Option<&Path>, input: &UnixStream, out: &mut UnixStream) -> Result<Value, String> {
    let (project_id, def, name) = mcp::service_target(state, args, cwd)?;
    let started = start_service_in(app, state, &project_id, &def.id, &mcp::window_label(&project_id))?;
    mcp::announce_start(app, &project_id, &def.id, &started.pty_id);
    let (backlog, rx) = output::hub().subscribe(&started.pty_id)
        .ok_or("the run's output was not kept")?;

    // The CLI sends nothing after its request, so a read returning means it
    // has gone.
    if let Ok(mut watch) = input.try_clone() {
        let app = app.clone();
        let (project_id, service_id, pty_id) = (project_id.clone(), def.id.clone(), started.pty_id.clone());
        std::thread::spawn(move || {
            let _ = watch.read(&mut [0u8; 1]);
            let state = app.state::<AppState>();
            if mcp::service_run(&state, &project_id, &service_id).as_deref() == Some(&pty_id)
                && state.projects.lock().unwrap().get(&project_id).map_or(false, |ps| ps.tracked.contains_key(&service_id))
            {
                let _ = stop_service_in(&state, &project_id, &service_id);
            }
        });
    }

    let mut connected = send(out, json!({ "type": "data", "data": backlog.data }));
    while connected {
        match rx.recv() {
            Ok(output::Event::Data(d)) => connected = send(out, json!({ "type": "data", "data": d })),
            _ => break,
        }
    }

    // The pump closes the run just before it records how it ended.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    let exit = loop {
        let exit = state.projects.lock().unwrap().get(&project_id)
            .and_then(|ps| ps.last_exit.get(&def.id).cloned())
            .filter(|e| e.pty_id == started.pty_id);
        if exit.is_some() || std::time::Instant::now() >= deadline {
            break exit;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    Ok(match exit {
        Some(e) => json!({ "exitCode": e.code, "signal": e.signal, "summary": mcp::exit_sentence(&name, &e) }),
        None => json!({ "exitCode": null, "summary": format!("{} ended.", name) }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_lines_keeps_the_newest_whole_lines() {
        assert_eq!(last_lines("a\nb\nc\n", 2), "b\nc\n");
        assert_eq!(last_lines("a\nb\nc", 2), "b\nc");
        assert_eq!(last_lines("a\nb\n", 5), "a\nb\n");
        assert_eq!(last_lines("a\nb\n", 0), "");
    }
}

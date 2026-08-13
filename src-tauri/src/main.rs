// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read as IoRead, Write as IoWrite};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{Emitter, Manager, State};


// ---------------------------------------------------------------------------
// Config: group-based
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
struct ServiceDef {
    id: String,
    label: String,
    #[serde(default)]
    description: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: String,
    #[serde(default = "default_service_type")]
    service_type: String,
    #[serde(default)]
    stop_command: Vec<String>,
}

fn default_service_type() -> String {
    "service".to_string()
}

#[derive(Clone, Serialize, Deserialize)]
struct ServiceGroup {
    id: String,
    label: String,
    #[serde(default)]
    services: Vec<ServiceDef>,
}

#[derive(Clone, Serialize, Deserialize)]
struct WorktreeDef {
    id: String,
    branch: String,
    path: String,
    groups: Vec<ServiceGroup>,
}

#[derive(Clone, Serialize, Deserialize)]
struct AppConfig {
    #[serde(default)]
    groups: Vec<ServiceGroup>,
    #[serde(default)]
    worktrees: Vec<WorktreeDef>,
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            groups: vec![],
            worktrees: vec![],
        }
    }
}

// ---------------------------------------------------------------------------
// Project metadata & index
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
struct ProjectMeta {
    id: String,
    name: String,
    #[serde(default)]
    repo_path: String,
    created_at: i64,
    last_opened: i64,
}

#[derive(Clone, Serialize, Deserialize, Default)]
struct ProjectIndex {
    projects: Vec<ProjectMeta>,
}

// ---------------------------------------------------------------------------
// Persistent state
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize, Default)]
struct PersistentState {
    running: HashMap<String, u32>,
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

struct TrackedService {
    pid: u32,
    pty_id: Option<String>,
}

struct PtySession {
    writer: Box<dyn IoWrite + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child_pid: Option<u32>,
    /// Epoch millis of the last output read from this PTY, written by the
    /// background streaming thread. Used to tell "agent working" from "agent
    /// idle at its prompt".
    last_output: Arc<AtomicU64>,
    /// Epoch millis of the last user input written to this PTY. Output that
    /// immediately follows input is keystroke echo / TUI redraw and must not
    /// count as agent activity.
    last_input: Arc<AtomicU64>,
}

#[derive(Clone, Serialize)]
struct PtyDataEvent {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct PtyExitEvent {
    id: String,
}

#[derive(Clone, Serialize)]
struct SvcExitEvent {
    id: String,
    pty_id: String,
}

/// Debug trace emitted for backend actions (git commands, service/PTY/worktree
/// operations) so the UI can show a live mini-terminal of what the app is doing.
/// Gated behind a setting in the UI; the backend always emits (events are cheap
/// and only fire on discrete actions, never per-keystroke PTY output).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DebugLogEvent {
    /// Coarse grouping shown as a tag, e.g. "git", "service", "worktree", "pty".
    category: String,
    /// "action" | "cmd" | "stdout" | "stderr" | "info" | "error"
    kind: String,
    text: String,
}

/// Set once at setup; lets any helper emit debug events without threading an
/// AppHandle through every command signature.
static DEBUG_APP: OnceLock<tauri::AppHandle> = OnceLock::new();

fn debug_log(category: &str, kind: &str, text: &str) {
    if let Some(app) = DEBUG_APP.get() {
        let _ = app.emit("debug-log", DebugLogEvent {
            category: category.to_string(),
            kind: kind.to_string(),
            text: text.to_string(),
        });
    }
}

/// Marks the start of a user-triggered action; the UI groups the lines that
/// follow (commands, output) under it with a divider.
fn debug_action(category: &str, summary: &str) {
    debug_log(category, "action", summary);
}

/// Run a git command, tracing the invocation and its stdout/stderr/exit to the
/// debug console. Returns the raw Output so callers keep their existing logic.
fn run_git_logged(args: &[&str], cwd: &str) -> std::io::Result<std::process::Output> {
    let shell_path = get_shell_path();
    debug_log("git", "cmd", &format!("git {}  (in {})", args.join(" "), cwd));
    let out = Command::new("git").args(args).current_dir(cwd)
        .env("PATH", &shell_path).output();
    match &out {
        Ok(o) => {
            let so = String::from_utf8_lossy(&o.stdout);
            let se = String::from_utf8_lossy(&o.stderr);
            if !so.trim().is_empty() { debug_log("git", "stdout", so.trim_end()); }
            if !se.trim().is_empty() { debug_log("git", "stderr", se.trim_end()); }
            debug_log("git", "info", &format!("exit {}", o.status.code()
                .map(|c| c.to_string()).unwrap_or_else(|| "signal".into())));
        }
        Err(e) => debug_log("git", "error", &format!("failed to spawn git: {}", e)),
    }
    out
}

#[derive(Serialize)]
struct StartServiceResult {
    pty_id: String,
}

struct ProjectState {
    config: AppConfig,
    repo_path: String,
    tracked: HashMap<String, TrackedService>,
    pty_sessions: HashMap<String, PtySession>,
}

struct AppState {
    projects: Mutex<HashMap<String, ProjectState>>,
    pty_counter: Mutex<u32>,
    projects_dir: PathBuf,
    agent_cache: Mutex<AgentScanCache>,
    /// Mirrors the UI's "stop services when this window closes" preference.
    /// Held here because the decision is made on CloseRequested, by which point
    /// the web view may already be tearing down and cannot be asked.
    stop_services_on_quit: AtomicBool,
}

#[derive(Default)]
struct AgentScanCache {
    last_scan: Option<std::time::Instant>,
    agents: HashMap<String, String>, // pty_id -> agent CLI name
}

#[derive(Serialize)]
struct ServiceStatus {
    id: String,
    status: String,
    pty_id: Option<String>,
}

#[derive(Serialize)]
struct AgentInfo {
    name: String,
    active: bool,
}

#[derive(Serialize)]
struct PollResult {
    statuses: Vec<ServiceStatus>,
    logs: HashMap<String, Vec<String>>,
    agents: HashMap<String, AgentInfo>,
}

#[derive(Serialize)]
struct PtyInfo {
    id: String,
}

// ---------------------------------------------------------------------------
// Helpers: shell / process
// ---------------------------------------------------------------------------

fn shell_escape(s: &str) -> String {
    if s.is_empty() {
        return "''".to_string();
    }
    if s.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '/' || c == ':' || c == '=' || c == '@') {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn get_shell_path() -> String {
    // Spawning an interactive login zsh sources the user's full rc files and
    // can take hundreds of ms — compute once and reuse.
    static SHELL_PATH: OnceLock<String> = OnceLock::new();
    SHELL_PATH
        .get_or_init(|| {
            if let Ok(output) = Command::new("/bin/zsh")
                .args(["-il", "-c", "echo $PATH"])
                .output()
            {
                if let Ok(path) = String::from_utf8(output.stdout) {
                    let trimmed = path.trim();
                    if !trimmed.is_empty() {
                        return trimmed.to_string();
                    }
                }
            }
            std::env::var("PATH").unwrap_or_default()
        })
        .clone()
}

fn is_pid_alive(pid: u32) -> bool {
    unsafe {
        let mut status: i32 = 0;
        let ret = libc::waitpid(pid as i32, &mut status, libc::WNOHANG);
        if ret == pid as i32 {
            return false;
        }
        libc::kill(pid as i32, 0) == 0
    }
}

/// AI agent CLIs we recognize in terminal process trees. Matched by exact
/// executable basename — substring matching would false-positive on things
/// like macOS's CursorUIViewService.
const AGENT_COMMANDS: &[&str] = &[
    "claude", "codex", "gemini", "aider", "opencode", "amp", "goose", "cursor-agent", "copilot",
];

/// Interpreters whose first script argument is the real command (npm-installed
/// CLIs show up as e.g. `node /path/node_modules/.bin/claude`).
const INTERPRETERS: &[&str] = &["node", "bun", "deno", "python", "python3"];

fn path_basename(s: &str) -> &str {
    s.rsplit('/').next().unwrap_or(s)
}

/// Output arriving within this window after user input is treated as
/// keystroke echo / TUI redraw rather than agent activity.
const ECHO_WINDOW_MS: u64 = 500;

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Coalesce PTY output into at most ~60 events/sec per terminal. Unthrottled
/// per-read emits can flood the webview hard enough that macOS kills its
/// WebContent process (black window until reload).
const PTY_FLUSH_INTERVAL_MS: u64 = 16;
const PTY_MAX_BATCH_BYTES: usize = 262_144;

fn spawn_pty_pump(
    app_handle: tauri::AppHandle,
    window_label: String,
    pty_id: String,
    mut reader: Box<dyn IoRead + Send>,
    last_output: Arc<AtomicU64>,
    last_input: Arc<AtomicU64>,
    on_exit: Box<dyn FnOnce(&tauri::AppHandle) + Send>,
) {
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();

    std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let now = now_millis();
                    if now.saturating_sub(last_input.load(Ordering::Relaxed)) > ECHO_WINDOW_MS {
                        last_output.store(now, Ordering::Relaxed);
                    }
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    std::thread::spawn(move || {
        // Per-session event name, delivered only to the owning window —
        // avoids broadcasting every chunk to every window and listener.
        let data_event = format!("pty-data-{}", pty_id);
        let mut leftover: Vec<u8> = Vec::new();
        loop {
            let first = match rx.recv() {
                Ok(d) => d,
                Err(_) => break,
            };
            let mut data = std::mem::take(&mut leftover);
            data.extend_from_slice(&first);
            let deadline = std::time::Instant::now()
                + std::time::Duration::from_millis(PTY_FLUSH_INTERVAL_MS);
            while data.len() < PTY_MAX_BATCH_BYTES {
                let now = std::time::Instant::now();
                if now >= deadline {
                    break;
                }
                match rx.recv_timeout(deadline - now) {
                    Ok(more) => data.extend_from_slice(&more),
                    Err(_) => break,
                }
            }
            match std::str::from_utf8(&data) {
                Ok(s) => {
                    let _ = app_handle.emit_to(window_label.as_str(), &data_event, PtyDataEvent {
                        id: pty_id.clone(),
                        data: s.to_string(),
                    });
                }
                Err(e) => {
                    let valid_up_to = e.valid_up_to();
                    if valid_up_to > 0 {
                        let s = std::str::from_utf8(&data[..valid_up_to]).unwrap();
                        let _ = app_handle.emit_to(window_label.as_str(), &data_event, PtyDataEvent {
                            id: pty_id.clone(),
                            data: s.to_string(),
                        });
                    }
                    leftover = data[valid_up_to..].to_vec();
                }
            }
        }
        on_exit(&app_handle);
    });
}

fn agent_name_for_command(tokens: &[&str]) -> Option<String> {
    let first = match tokens.first() {
        Some(t) => path_basename(t),
        None => return None,
    };
    if AGENT_COMMANDS.contains(&first) {
        return Some(first.to_string());
    }
    if INTERPRETERS.contains(&first) {
        if let Some(second) = tokens.get(1) {
            let second = path_basename(second);
            if AGENT_COMMANDS.contains(&second) {
                return Some(second.to_string());
            }
        }
    }
    None
}

/// Scan the process table once and return, for each (pty_id, shell_pid) root,
/// the name of an AI agent CLI running anywhere under that shell.
fn detect_agents(roots: &[(String, u32)]) -> HashMap<String, String> {
    let mut result = HashMap::new();
    if roots.is_empty() {
        return result;
    }
    let output = match Command::new("ps").args(["-axo", "pid=,ppid=,command="]).output() {
        Ok(o) => o,
        Err(_) => return result,
    };
    let text = String::from_utf8_lossy(&output.stdout);

    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut agents_by_pid: HashMap<u32, String> = HashMap::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let pid = match parts.next().and_then(|s| s.parse::<u32>().ok()) {
            Some(p) => p,
            None => continue,
        };
        let ppid = match parts.next().and_then(|s| s.parse::<u32>().ok()) {
            Some(p) => p,
            None => continue,
        };
        let tokens: Vec<&str> = parts.collect();
        children.entry(ppid).or_default().push(pid);
        if let Some(name) = agent_name_for_command(&tokens) {
            agents_by_pid.insert(pid, name);
        }
    }

    for (pty_id, root) in roots {
        let mut queue = vec![*root];
        while let Some(pid) = queue.pop() {
            if let Some(name) = agents_by_pid.get(&pid) {
                result.insert(pty_id.clone(), name.clone());
                break;
            }
            if let Some(kids) = children.get(&pid) {
                queue.extend(kids);
            }
        }
    }
    result
}

/// Find a service and return its worktree path (if it belongs to one).
fn find_service_with_worktree_path<'a>(config: &'a AppConfig, id: &str) -> Option<(&'a ServiceDef, Option<&'a str>)> {
    for g in &config.groups {
        if let Some(s) = g.services.iter().find(|s| s.id == id) {
            return Some((s, None));
        }
    }
    for w in &config.worktrees {
        for g in &w.groups {
            if let Some(s) = g.services.iter().find(|s| s.id == id) {
                return Some((s, Some(&w.path)));
            }
        }
    }
    None
}

fn all_services(config: &AppConfig) -> Vec<&ServiceDef> {
    config.groups.iter().flat_map(|g| g.services.iter())
        .chain(config.worktrees.iter().flat_map(|w| w.groups.iter().flat_map(|g| g.services.iter())))
        .collect()
}

// ---------------------------------------------------------------------------
// Helpers: project storage
// ---------------------------------------------------------------------------

fn projects_dir(data_dir: &PathBuf) -> PathBuf {
    data_dir.join("projects")
}

fn project_dir(projects_dir: &PathBuf, id: &str) -> PathBuf {
    projects_dir.join(id)
}

fn index_path(projects_dir: &PathBuf) -> PathBuf {
    projects_dir.join("index.json")
}

fn load_project_index(projects_dir: &PathBuf) -> ProjectIndex {
    let path = index_path(projects_dir);
    match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => ProjectIndex::default(),
    }
}

fn save_project_index(projects_dir: &PathBuf, index: &ProjectIndex) -> Result<(), String> {
    let _ = fs::create_dir_all(projects_dir);
    let json = serde_json::to_string_pretty(index).map_err(|e| e.to_string())?;
    fs::write(index_path(projects_dir), json).map_err(|e| e.to_string())
}

fn load_project_config(projects_dir: &PathBuf, id: &str) -> Result<AppConfig, String> {
    let path = project_dir(projects_dir, id).join("config.json");
    let contents = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read project config: {}", e))?;
    serde_json::from_str(&contents).map_err(|e| format!("Invalid project config: {}", e))
}

fn save_project_config(projects_dir: &PathBuf, id: &str, config: &AppConfig) -> Result<(), String> {
    let dir = project_dir(projects_dir, id);
    let _ = fs::create_dir_all(&dir);
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(dir.join("config.json"), json).map_err(|e| e.to_string())
}

fn project_state_file_path(projects_dir: &PathBuf, project_id: &str) -> PathBuf {
    project_dir(projects_dir, project_id).join("state.json")
}

fn save_project_persistent_state(projects_dir: &PathBuf, project_id: &str, tracked: &HashMap<String, TrackedService>) {
    let ps = PersistentState {
        running: tracked.iter().map(|(k, v)| (k.clone(), v.pid)).collect(),
    };
    if let Ok(json) = serde_json::to_string_pretty(&ps) {
        let _ = fs::write(project_state_file_path(projects_dir, project_id), json);
    }
}

fn load_project_persistent_state(projects_dir: &PathBuf, project_id: &str) -> PersistentState {
    match fs::read_to_string(project_state_file_path(projects_dir, project_id)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => PersistentState::default(),
    }
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn name_to_id(name: &str) -> String {
    name.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/// Migrate old configs: move repo_path from groups to project meta
fn migrate_repo_path(projects_dir: &PathBuf, id: &str) -> Option<String> {
    let config_path = project_dir(projects_dir, id).join("config.json");
    let contents = fs::read_to_string(&config_path).ok()?;
    let mut json: serde_json::Value = serde_json::from_str(&contents).ok()?;

    let groups = json.get_mut("groups")?.as_array_mut()?;
    let mut repo_path: Option<String> = None;

    for group in groups.iter_mut() {
        if let Some(rp) = group.get("repo_path").and_then(|v| v.as_str()) {
            if !rp.is_empty() && repo_path.is_none() {
                repo_path = Some(rp.to_string());
            }
        }
        if let Some(obj) = group.as_object_mut() {
            obj.remove("repo_path");
        }
    }

    // Re-save cleaned config
    if let Ok(json_str) = serde_json::to_string_pretty(&json) {
        let _ = fs::write(&config_path, json_str);
    }

    repo_path
}

// ---------------------------------------------------------------------------
// Tauri commands: project CRUD
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct ProjectListEntry {
    id: String,
    name: String,
    repo_path: String,
    created_at: i64,
    last_opened: i64,
    group_count: usize,
    service_count: usize,
    service_names: Vec<String>,
}

#[tauri::command(async)]
fn list_projects(state: State<'_, AppState>) -> Result<Vec<ProjectListEntry>, String> {
    let index = load_project_index(&state.projects_dir);
    let mut entries = Vec::new();
    for meta in index.projects {
        let (group_count, service_count, service_names) =
            match load_project_config(&state.projects_dir, &meta.id) {
                Ok(config) => {
                    let gc = config.groups.len();
                    let names: Vec<String> = config.groups.iter()
                        .flat_map(|g| g.services.iter().map(|s| s.label.clone()))
                        .collect();
                    let sc = names.len();
                    (gc, sc, names)
                }
                Err(_) => (0, 0, vec![]),
            };
        entries.push(ProjectListEntry {
            id: meta.id,
            name: meta.name,
            repo_path: meta.repo_path,
            created_at: meta.created_at,
            last_opened: meta.last_opened,
            group_count,
            service_count,
            service_names,
        });
    }
    Ok(entries)
}

#[tauri::command]
fn create_project(name: String, repo_path: Option<String>, state: State<'_, AppState>) -> Result<ProjectMeta, String> {
    debug_action("project", &format!("create project '{}'{}", name,
        repo_path.as_deref().map(|p| format!(" (repo {})", p)).unwrap_or_default()));
    let mut index = load_project_index(&state.projects_dir);
    let id = name_to_id(&name);
    if id.is_empty() {
        return Err("Project name cannot be empty".to_string());
    }
    if index.projects.iter().any(|p| p.id == id) {
        return Err(format!("Project '{}' already exists", name));
    }
    let config = AppConfig::default();
    save_project_config(&state.projects_dir, &id, &config)?;
    let meta = ProjectMeta {
        id: id.clone(),
        name,
        repo_path: repo_path.unwrap_or_default(),
        created_at: now_unix(),
        last_opened: now_unix(),
    };
    index.projects.push(meta.clone());
    save_project_index(&state.projects_dir, &index)?;
    Ok(meta)
}

/// Pushed from the settings panel on load and on every change.
#[tauri::command]
fn set_stop_services_on_quit(enabled: bool, state: State<'_, AppState>) {
    state.stop_services_on_quit.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
fn delete_project(id: String, app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    debug_action("project", &format!("delete project '{}'", id));
    // Stop all running services for this project before deleting
    {
        let mut projects = state.projects.lock().unwrap();
        if let Some(ps) = projects.get_mut(&id) {
            let pids: Vec<(String, u32)> = ps.tracked.iter()
                .map(|(k, v)| (k.clone(), v.pid))
                .collect();
            for (_svc_id, pid) in &pids {
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(*pid as i32), libc::SIGTERM);
                    libc::kill(*pid as i32, libc::SIGTERM);
                }
            }
            ps.tracked.clear();
            ps.pty_sessions.clear();
        }
    }

    // Close window if open
    let label = format!("project-{}", id);
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.close();
    }

    // Remove from memory
    {
        let mut projects = state.projects.lock().unwrap();
        projects.remove(&id);
    }

    // Remove project directory
    let dir = project_dir(&state.projects_dir, &id);
    if dir.exists() {
        let _ = fs::remove_dir_all(&dir);
    }
    let mut index = load_project_index(&state.projects_dir);
    index.projects.retain(|p| p.id != id);
    save_project_index(&state.projects_dir, &index)?;
    Ok(())
}

#[tauri::command]
fn rename_project(id: String, name: String, state: State<'_, AppState>) -> Result<(), String> {
    debug_action("project", &format!("rename project '{}' -> '{}'", id, name));
    let mut index = load_project_index(&state.projects_dir);
    if let Some(meta) = index.projects.iter_mut().find(|p| p.id == id) {
        meta.name = name;
    } else {
        return Err("Project not found".to_string());
    }
    save_project_index(&state.projects_dir, &index)
}

#[tauri::command]
fn set_repo_path(id: String, repo_path: String, state: State<'_, AppState>) -> Result<(), String> {
    debug_action("project", &format!("set repo path for '{}' -> {}", id, repo_path));
    let mut index = load_project_index(&state.projects_dir);
    if let Some(meta) = index.projects.iter_mut().find(|p| p.id == id) {
        meta.repo_path = repo_path.clone();
    } else {
        return Err("Project not found".to_string());
    }
    // Also update in-memory project state if loaded
    if let Ok(mut projects) = state.projects.lock() {
        if let Some(ps) = projects.get_mut(&id) {
            ps.repo_path = repo_path;
        }
    }
    save_project_index(&state.projects_dir, &index)
}

#[tauri::command]
fn get_repo_path(id: String, state: State<'_, AppState>) -> Result<String, String> {
    let index = load_project_index(&state.projects_dir);
    let meta = index.projects.iter().find(|p| p.id == id)
        .ok_or("Project not found")?;
    Ok(meta.repo_path.clone())
}

#[tauri::command]
fn clone_project(source_id: String, name: String, state: State<'_, AppState>) -> Result<ProjectMeta, String> {
    debug_action("project", &format!("clone project '{}' -> '{}'", source_id, name));
    let config = load_project_config(&state.projects_dir, &source_id)?;
    let new_id = name_to_id(&name);
    if new_id.is_empty() {
        return Err("Project name cannot be empty".to_string());
    }
    let mut index = load_project_index(&state.projects_dir);
    if index.projects.iter().any(|p| p.id == new_id) {
        return Err(format!("Project '{}' already exists", name));
    }
    save_project_config(&state.projects_dir, &new_id, &config)?;
    // Copy repo_path from source project
    let source_repo_path = index.projects.iter()
        .find(|p| p.id == source_id)
        .map(|p| p.repo_path.clone())
        .unwrap_or_default();
    let meta = ProjectMeta {
        id: new_id,
        name,
        repo_path: source_repo_path,
        created_at: now_unix(),
        last_opened: now_unix(),
    };
    index.projects.push(meta.clone());
    save_project_index(&state.projects_dir, &index)?;
    Ok(meta)
}

#[tauri::command]
fn import_project(
    name: String,
    config_json: String,
    repo_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<ProjectMeta, String> {
    debug_action("project", &format!("import project '{}'", name));
    let config: AppConfig = serde_json::from_str(&config_json)
        .map_err(|e| format!("Invalid config JSON: {}", e))?;
    let id = name_to_id(&name);
    if id.is_empty() {
        return Err("Project name cannot be empty".to_string());
    }
    let mut index = load_project_index(&state.projects_dir);
    if index.projects.iter().any(|p| p.id == id) {
        return Err(format!("Project '{}' already exists", name));
    }
    save_project_config(&state.projects_dir, &id, &config)?;
    let meta = ProjectMeta {
        id,
        name,
        repo_path: repo_path.unwrap_or_default(),
        created_at: now_unix(),
        last_opened: now_unix(),
    };
    index.projects.push(meta.clone());
    save_project_index(&state.projects_dir, &index)?;
    Ok(meta)
}

// ---------------------------------------------------------------------------
// macOS traffic light positioning
// ---------------------------------------------------------------------------

/// Inset of the close button's frame from the window's top-left corner.
/// Chosen so the 12px light circles center vertically in the UI's 38px
/// unified header (button frame is ~16px tall: 13 + 8 = 21 ≈ header center).
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_INSET: (f64, f64) = (14.0, 12.5);

/// Reposition the standard window buttons. Port of tao's
/// `inset_traffic_lights`; needed because the position set at window
/// creation is discarded whenever macOS rebuilds the title bar (first
/// show, focus changes, theme switches, fullscreen round-trips).
#[cfg(target_os = "macos")]
unsafe fn position_traffic_lights(ns_window_ptr: *mut std::ffi::c_void, x: f64, y: f64) {
    use objc2::msg_send;
    use objc2_app_kit::{NSWindow, NSWindowButton};

    let ns_window = &*(ns_window_ptr as *const NSWindow);
    let Some(close) = ns_window.standardWindowButton(NSWindowButton::CloseButton) else {
        return;
    };
    let Some(miniaturize) = ns_window.standardWindowButton(NSWindowButton::MiniaturizeButton)
    else {
        return;
    };
    let Some(zoom) = ns_window.standardWindowButton(NSWindowButton::ZoomButton) else {
        return;
    };
    let Some(container) = close.superview().and_then(|v| v.superview()) else {
        return;
    };

    // Size the title-bar container symmetrically around the buttons and set
    // each button's origin explicitly: on current macOS the buttons stay
    // anchored to the container's TOP, so merely growing the container (the
    // classic tao technique) never moves them down.
    let close_rect = close.frame();
    let button_h = close_rect.size.height;
    let title_bar_frame_height = button_h + y * 2.0;
    let mut title_bar_rect = container.frame();
    title_bar_rect.size.height = title_bar_frame_height;
    title_bar_rect.origin.y = ns_window.frame().size.height - title_bar_frame_height;
    let _: () = msg_send![&*container, setFrame: title_bar_rect];

    let space_between = miniaturize.frame().origin.x - close_rect.origin.x;
    for (i, button) in [close, miniaturize, zoom].into_iter().enumerate() {
        let mut rect = button.frame();
        rect.origin.x = x + (i as f64) * space_between;
        rect.origin.y = y; // symmetric container → y from bottom == y from top
        button.setFrameOrigin(rect.origin);
    }
}

/// Apply the traffic light inset now and re-apply whenever macOS resets it.
#[cfg(target_os = "macos")]
fn keep_traffic_lights_positioned(window: &tauri::WebviewWindow) {
    fn apply(window: &tauri::WebviewWindow) {
        let w = window.clone();
        let _ = window.run_on_main_thread(move || {
            if let Ok(ptr) = w.ns_window() {
                unsafe {
                    position_traffic_lights(ptr, TRAFFIC_LIGHT_INSET.0, TRAFFIC_LIGHT_INSET.1)
                };
            }
        });
    }

    apply(window);
    let win = window.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            tauri::WindowEvent::Focused(_)
                | tauri::WindowEvent::Resized(_)
                | tauri::WindowEvent::ThemeChanged(_)
        ) {
            apply(&win);
        }
    });
}

// ---------------------------------------------------------------------------
// Tauri commands: start page + open project window
// ---------------------------------------------------------------------------

#[tauri::command]
fn show_start_page(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.set_focus().map_err(|e| e.to_string())?;
    } else {
        tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("Lever — Start")
        .inner_size(700.0, 500.0)
        .min_inner_size(500.0, 350.0)
        .build()
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn open_scratch_terminal(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let scratch_id = format!("scratch-{}", now_unix());
    let label = format!("project-{}", scratch_id);

    {
        let mut projects = state.projects.lock().unwrap();
        projects.insert(scratch_id.clone(), ProjectState {
            config: AppConfig::default(),
            repo_path: String::new(),
            tracked: HashMap::new(),
            pty_sessions: HashMap::new(),
        });
    }

    tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Lever — Terminal")
    .inner_size(900.0, 600.0)
    .min_inner_size(500.0, 300.0)
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn open_project(id: String, app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let label = format!("project-{}", id);

    if let Some(window) = app.get_webview_window(&label) {
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Migrate repo_path from groups to project meta if needed
    let repo_path;
    {
        let mut index = load_project_index(&state.projects_dir);
        let mut needs_save = false;
        if let Some(meta) = index.projects.iter_mut().find(|p| p.id == id) {
            if meta.repo_path.is_empty() {
                if let Some(rp) = migrate_repo_path(&state.projects_dir, &id) {
                    meta.repo_path = rp;
                    needs_save = true;
                }
            }
            repo_path = meta.repo_path.clone();
        } else {
            repo_path = String::new();
        }
        if needs_save {
            let _ = save_project_index(&state.projects_dir, &index);
        }
    }

    let config = load_project_config(&state.projects_dir, &id)?;

    let ps = load_project_persistent_state(&state.projects_dir, &id);
    let mut tracked = HashMap::new();

    for (svc_id, pid) in &ps.running {
        if is_pid_alive(*pid) {
            tracked.insert(svc_id.clone(), TrackedService { pid: *pid, pty_id: None });
        }
    }

    save_project_persistent_state(&state.projects_dir, &id, &tracked);

    {
        let mut projects = state.projects.lock().unwrap();
        projects.insert(id.clone(), ProjectState {
            config,
            repo_path: repo_path.clone(),
            tracked,
            pty_sessions: HashMap::new(),
        });
    }

    let mut index = load_project_index(&state.projects_dir);
    if let Some(meta) = index.projects.iter_mut().find(|p| p.id == id) {
        meta.last_opened = now_unix();
    }
    let _ = save_project_index(&state.projects_dir, &index);

    let project_name = index.projects.iter()
        .find(|p| p.id == id)
        .map(|p| p.name.clone())
        .unwrap_or_else(|| id.clone());

    // Project windows draw their own header into the title bar area
    // (unified top bar in the UI); the native title stays hidden and the
    // traffic lights are repositioned to center in the 38px header.
    let window = tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title(format!("Lever — {}", project_name))
    .inner_size(900.0, 700.0)
    .min_inner_size(600.0, 400.0)
    .title_bar_style(tauri::TitleBarStyle::Overlay)
    .hidden_title(true)
    .build()
    .map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    keep_traffic_lights_positioned(&window);
    #[cfg(not(target_os = "macos"))]
    let _ = window;

    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands: config (project-scoped)
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_config(project_id: String, state: State<'_, AppState>) -> Result<AppConfig, String> {
    let projects = state.projects.lock().unwrap();
    let ps = projects.get(&project_id).ok_or("Project not loaded")?;
    Ok(ps.config.clone())
}

#[tauri::command(async)]
fn save_config(project_id: String, config: AppConfig, state: State<'_, AppState>) -> Result<(), String> {
    save_project_config(&state.projects_dir, &project_id, &config)?;
    let mut projects = state.projects.lock().unwrap();
    if let Some(ps) = projects.get_mut(&project_id) {
        ps.config = config;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands: services (project-scoped)
// ---------------------------------------------------------------------------

#[tauri::command(async)]
fn start_service(project_id: String, id: String, window: tauri::WebviewWindow, app: tauri::AppHandle, state: State<'_, AppState>) -> Result<StartServiceResult, String> {
    let mut projects = state.projects.lock().unwrap();
    let ps = projects.get_mut(&project_id).ok_or("Project not loaded")?;

    let (def, worktree_path) = find_service_with_worktree_path(&ps.config, &id)
        .ok_or_else(|| format!("Unknown service: {}", id))?;
    let def = def.clone();
    let worktree_path = worktree_path.map(String::from);

    if ps.tracked.contains_key(&id) {
        return Err(format!("{} is already running", id));
    }

    let cwd = if !def.cwd.is_empty() {
        def.cwd.clone()
    } else if let Some(ref wt_path) = worktree_path {
        wt_path.clone()
    } else if !ps.repo_path.is_empty() {
        ps.repo_path.clone()
    } else {
        ".".to_string()
    };

    // Build shell command string
    let mut shell_cmd = shell_escape(&def.command);
    for arg in &def.args {
        shell_cmd.push(' ');
        shell_cmd.push_str(&shell_escape(arg));
    }

    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let mut cmd = CommandBuilder::new("/bin/zsh");
    cmd.args(["-il", "-c", &shell_cmd]);
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    debug_action("service", &format!("start '{}': {}  (in {})", def.label, shell_cmd, cwd));

    let child = pair.slave.spawn_command(cmd)
        .map_err(|e| {
            debug_log("service", "error", &format!("failed to spawn {}: {}", def.label, e));
            format!("Failed to spawn {}: {}", def.label, e)
        })?;

    let pid = child.process_id().unwrap_or(0);
    debug_log("service", "info", &format!("'{}' started, pid {}", def.label, pid));

    let reader = pair.master.try_clone_reader()
        .map_err(|e| format!("Failed to clone reader: {}", e))?;
    let writer = pair.master.take_writer()
        .map_err(|e| format!("Failed to take writer: {}", e))?;

    let mut counter = state.pty_counter.lock().unwrap();
    *counter += 1;
    let pty_id = format!("svc-pty-{}", *counter);
    drop(counter);

    let last_output = Arc::new(AtomicU64::new(now_millis()));
    let last_input = Arc::new(AtomicU64::new(0));
    let svc_last_output = last_output.clone();
    let svc_last_input = last_input.clone();
    let session = PtySession { writer, master: pair.master, child_pid: Some(pid), last_output, last_input };
    ps.pty_sessions.insert(pty_id.clone(), session);
    ps.tracked.insert(id.clone(), TrackedService { pid, pty_id: Some(pty_id.clone()) });
    save_project_persistent_state(&state.projects_dir, &project_id, &ps.tracked);

    let projects_dir = state.projects_dir.clone();
    let proj_id = project_id.clone();
    let id_clone = id.clone();
    let pty_id_clone = pty_id.clone();
    let app_handle = app.clone();
    let window_label = window.label().to_string();

    drop(projects);

    let exit_window = window_label.clone();
    spawn_pty_pump(app_handle, window_label, pty_id_clone.clone(), reader, svc_last_output, svc_last_input,
        Box::new(move |app| {
            // PTY exited — emit svc-exit event and clean up
            let _ = app.emit_to(exit_window.as_str(), "svc-exit", SvcExitEvent {
                id: id_clone.clone(),
                pty_id: pty_id_clone,
            });

            // Clean up persistent state
            let sp = project_state_file_path(&projects_dir, &proj_id);
            if let Ok(s) = fs::read_to_string(&sp) {
                if let Ok(mut ps) = serde_json::from_str::<PersistentState>(&s) {
                    ps.running.remove(&id_clone);
                    if let Ok(json) = serde_json::to_string_pretty(&ps) {
                        let _ = fs::write(&sp, json);
                    }
                }
            }
        }));

    Ok(StartServiceResult { pty_id })
}

#[tauri::command(async)]
fn stop_service(project_id: String, id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut projects = state.projects.lock().unwrap();
    let ps = projects.get_mut(&project_id).ok_or("Project not loaded")?;

    let found = find_service_with_worktree_path(&ps.config, &id)
        .map(|(def, wt)| (def.clone(), wt.map(String::from)));
    let tracked = ps.tracked.remove(&id);

    if let (Some((def, worktree_path)), Some(ref t)) = (&found, &tracked) {
        debug_action("service", &format!("stop '{}' (pid {})", def.label, t.pid));
        if !def.stop_command.is_empty() {
            let shell_path = get_shell_path();
            let (cmd, args) = def.stop_command.split_first().unwrap();
            let cwd = if !def.cwd.is_empty() {
                def.cwd.as_str()
            } else if let Some(wt_path) = worktree_path {
                wt_path.as_str()
            } else if !ps.repo_path.is_empty() {
                ps.repo_path.as_str()
            } else {
                "."
            };
            debug_log("service", "cmd", &format!("{} {}  (in {})", cmd, args.join(" "), cwd));
            let _ = Command::new(cmd).args(args).current_dir(cwd).env("PATH", &shell_path).output();
        }

        // Remove the PTY session (closing master fd causes reader to exit)
        if let Some(ref pty_id) = t.pty_id {
            ps.pty_sessions.remove(pty_id);
        }

        // Kill process group as fallback
        #[cfg(unix)]
        unsafe {
            libc::kill(-(t.pid as i32), libc::SIGTERM);
            libc::kill(t.pid as i32, libc::SIGTERM);
        }
    } else if let Some(ref t) = tracked {
        // No service def found but we have a tracked service — still clean up
        if let Some(ref pty_id) = t.pty_id {
            ps.pty_sessions.remove(pty_id);
        }

        #[cfg(unix)]
        unsafe {
            libc::kill(-(t.pid as i32), libc::SIGTERM);
            libc::kill(t.pid as i32, libc::SIGTERM);
        }
    }

    save_project_persistent_state(&state.projects_dir, &project_id, &ps.tracked);

    Ok(())
}

#[tauri::command(async)]
fn poll(project_id: String, state: State<'_, AppState>) -> Result<PollResult, String> {
    // Snapshot everything we need under the projects lock, then drop it
    // before the (slow) process-table scan so write_pty — called on every
    // keystroke — never waits behind `ps`.
    let (statuses, roots, last_outputs) = {
        let mut projects = state.projects.lock().unwrap();
        let ps = projects.get_mut(&project_id).ok_or("Project not loaded")?;

        let dead: Vec<String> = ps.tracked.iter()
            .filter(|(_, t)| !is_pid_alive(t.pid))
            .map(|(k, _)| k.clone())
            .collect();
        if !dead.is_empty() {
            for id in &dead {
                if let Some(t) = ps.tracked.remove(id) {
                    if let Some(ref pty_id) = t.pty_id {
                        ps.pty_sessions.remove(pty_id);
                    }
                }
            }
            save_project_persistent_state(&state.projects_dir, &project_id, &ps.tracked);
        }

        let svcs = all_services(&ps.config);
        let statuses: Vec<ServiceStatus> = svcs.iter().map(|s| {
            let tracked = ps.tracked.get(&s.id);
            ServiceStatus {
                id: s.id.clone(),
                status: if tracked.is_some() { "running" } else { "stopped" }.to_string(),
                // Lets the frontend reattach terminals to live PTYs after a
                // webview reload.
                pty_id: tracked.and_then(|t| t.pty_id.clone()),
            }
        }).collect();

        let roots: Vec<(String, u32)> = ps.pty_sessions.iter()
            .filter_map(|(id, s)| s.child_pid.map(|p| (id.clone(), p)))
            .collect();
        let last_outputs: HashMap<String, u64> = ps.pty_sessions.iter()
            .map(|(id, s)| (id.clone(), s.last_output.load(Ordering::Relaxed)))
            .collect();

        (statuses, roots, last_outputs)
    };

    // AI agent indicator: rescan the process table at most every 2s; poll
    // itself runs every 300ms from the frontend.
    let agent_names = {
        let mut cache = state.agent_cache.lock().unwrap();
        let stale = cache.last_scan
            .map_or(true, |t| t.elapsed() >= std::time::Duration::from_secs(2));
        if stale {
            cache.agents = detect_agents(&roots);
            cache.last_scan = Some(std::time::Instant::now());
        }
        cache.agents.clone()
    };

    // An agent is "active" (doing inference / streaming output) if its PTY
    // produced output recently — agent TUIs redraw their spinner continuously
    // while working and go quiet at the input prompt.
    const ACTIVE_WINDOW_MS: u64 = 2000;
    let now = now_millis();
    let agents: HashMap<String, AgentInfo> = agent_names.into_iter()
        .filter_map(|(pty_id, name)| {
            last_outputs.get(&pty_id).map(|last| {
                let active = now.saturating_sub(*last) <= ACTIVE_WINDOW_MS;
                (pty_id, AgentInfo { name, active })
            })
        })
        .collect();

    Ok(PollResult { statuses, logs: HashMap::new(), agents })
}

// ---------------------------------------------------------------------------
// Tauri commands: PTY terminals (project-scoped)
// ---------------------------------------------------------------------------

#[tauri::command(async)]
fn create_pty(project_id: String, cols: u16, rows: u16, cwd: Option<String>, window: tauri::WebviewWindow, app: tauri::AppHandle, state: State<'_, AppState>) -> Result<PtyInfo, String> {
    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-l");
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    if let Some(ref cwd_path) = cwd {
        if !cwd_path.is_empty() {
            cmd.cwd(cwd_path);
        }
    }

    let child = pair.slave.spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {}", e))?;
    let shell_pid = child.process_id();

    let reader = pair.master.try_clone_reader()
        .map_err(|e| format!("Failed to clone reader: {}", e))?;
    let writer = pair.master.take_writer()
        .map_err(|e| format!("Failed to take writer: {}", e))?;

    let mut counter = state.pty_counter.lock().unwrap();
    *counter += 1;
    let pty_id = format!("pty-{}", *counter);
    drop(counter);

    let last_output = Arc::new(AtomicU64::new(now_millis()));
    let last_input = Arc::new(AtomicU64::new(0));
    let reader_last_output = last_output.clone();
    let reader_last_input = last_input.clone();
    let session = PtySession { writer, master: pair.master, child_pid: shell_pid, last_output, last_input };

    {
        let mut projects = state.projects.lock().unwrap();
        let ps = projects.get_mut(&project_id).ok_or("Project not loaded")?;
        ps.pty_sessions.insert(pty_id.clone(), session);
    }

    let app_handle = app.clone();
    let pty_id_clone = pty_id.clone();
    let window_label = window.label().to_string();
    let exit_window = window_label.clone();
    let pty_id_exit = pty_id.clone();
    spawn_pty_pump(app_handle, window_label, pty_id_clone, reader, reader_last_output, reader_last_input,
        Box::new(move |app| {
            let exit_event = format!("pty-exit-{}", pty_id_exit);
            let _ = app.emit_to(exit_window.as_str(), &exit_event, PtyExitEvent {
                id: pty_id_exit,
            });
        }));

    Ok(PtyInfo { id: pty_id })
}

#[tauri::command]
fn write_pty(project_id: String, id: String, data: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut projects = state.projects.lock().unwrap();
    let ps = projects.get_mut(&project_id).ok_or("Project not loaded")?;
    let session = ps.pty_sessions.get_mut(&id).ok_or("PTY not found")?;
    session.last_input.store(now_millis(), Ordering::Relaxed);
    session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn resize_pty(project_id: String, id: String, cols: u16, rows: u16, state: State<'_, AppState>) -> Result<(), String> {
    let projects = state.projects.lock().unwrap();
    let ps = projects.get(&project_id).ok_or("Project not loaded")?;
    let session = ps.pty_sessions.get(&id).ok_or("PTY not found")?;
    session.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn close_pty(project_id: String, id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut projects = state.projects.lock().unwrap();
    let ps = projects.get_mut(&project_id).ok_or("Project not loaded")?;
    ps.pty_sessions.remove(&id);
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands: Git (unchanged — take path directly)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct GitFileStatus {
    path: String,
    status: String, // "modified", "new", "deleted", "renamed", "typechange"
    staged: bool,
    is_dir: bool,
}

#[derive(Serialize)]
struct GitRepoInfo {
    current_branch: String,
    is_dirty: bool,
    changed_files: Vec<GitFileStatus>,
}

fn git_status_str(s: git2::Status) -> &'static str {
    if s.contains(git2::Status::WT_NEW) || s.contains(git2::Status::INDEX_NEW) { "new" }
    else if s.contains(git2::Status::WT_DELETED) || s.contains(git2::Status::INDEX_DELETED) { "deleted" }
    else if s.contains(git2::Status::WT_RENAMED) || s.contains(git2::Status::INDEX_RENAMED) { "renamed" }
    else if s.contains(git2::Status::WT_TYPECHANGE) || s.contains(git2::Status::INDEX_TYPECHANGE) { "typechange" }
    else { "modified" }
}

fn is_staged(s: git2::Status) -> bool {
    s.intersects(
        git2::Status::INDEX_NEW
            | git2::Status::INDEX_MODIFIED
            | git2::Status::INDEX_DELETED
            | git2::Status::INDEX_RENAMED
            | git2::Status::INDEX_TYPECHANGE,
    )
}

#[tauri::command(async)]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, &contents).map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command(async)]
fn check_is_git_repo(path: String) -> bool {
    git2::Repository::open(&path).is_ok()
}

#[tauri::command(async)]
fn git_info(path: String) -> Result<GitRepoInfo, String> {
    let repo = git2::Repository::open(&path).map_err(|e| format!("Not a git repo: {}", e))?;

    let head = repo.head().map_err(|e| format!("No HEAD: {}", e))?;
    let current_branch = head
        .shorthand()
        .unwrap_or("HEAD")
        .to_string();

    let mut changed_files = Vec::new();
    let statuses = repo.statuses(Some(
        git2::StatusOptions::new()
            .include_untracked(true)
            .exclude_submodules(true)
            // Refresh the index stat-cache like `git status` does. After a
            // checkout/switch every changed file's mtime is new and the scan
            // re-hashes them; without this flag that cost is paid again on
            // every poll instead of once.
            .update_index(true),
    )).map_err(|e| e.to_string())?;
    let is_dirty = !statuses.is_empty();

    let repo_root = std::path::Path::new(&path);
    for entry in statuses.iter() {
        if let Some(p) = entry.path() {
            let is_dir = repo_root.join(p).is_dir();
            changed_files.push(GitFileStatus {
                path: p.to_string(),
                status: git_status_str(entry.status()).to_string(),
                staged: is_staged(entry.status()),
                is_dir,
            });
        }
    }

    Ok(GitRepoInfo {
        current_branch,
        is_dirty,
        changed_files,
    })
}

#[tauri::command(async)]
fn git_diff(path: String, file_path: String, staged: bool) -> Result<String, String> {
    let repo = git2::Repository::open(&path).map_err(|e| format!("Not a git repo: {}", e))?;

    // Untracked files/dirs won't show up in standard diffs — synthesize a full "added" patch.
    if !staged {
        let abs = std::path::Path::new(&path).join(&file_path);
        let in_index = repo.index().ok().and_then(|idx| idx.get_path(std::path::Path::new(&file_path), 0)).is_some();
        if !in_index && abs.exists() {
            if abs.is_dir() {
                return Ok(synth_added_dir_diff(&file_path, &abs));
            }
            return Ok(synth_added_diff(&file_path, &abs));
        }
    }

    let mut opts = git2::DiffOptions::new();
    opts.pathspec(&file_path);
    opts.context_lines(3);
    opts.include_untracked(true);
    opts.recurse_untracked_dirs(true);

    let diff = if staged {
        let head_tree = repo
            .head()
            .ok()
            .and_then(|h| h.peel_to_tree().ok());
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
            .map_err(|e| format!("git diff failed: {}", e))?
    } else {
        repo.diff_index_to_workdir(None, Some(&mut opts))
            .map_err(|e| format!("git diff failed: {}", e))?
    };

    let mut output = String::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        let origin = line.origin();
        if matches!(origin, '+' | '-' | ' ') {
            output.push(origin);
        }
        if let Ok(s) = std::str::from_utf8(line.content()) {
            output.push_str(s);
        }
        true
    }).map_err(|e| format!("git diff print failed: {}", e))?;

    if output.is_empty() {
        return Ok(String::from("(no changes)"));
    }
    Ok(output)
}

fn synth_added_dir_diff(rel_dir: &str, abs_dir: &std::path::Path) -> String {
    let mut files: Vec<(String, std::path::PathBuf)> = Vec::new();
    collect_files(rel_dir, abs_dir, &mut files);
    if files.is_empty() {
        return format!("(empty directory: {})\n", rel_dir);
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut out = String::new();
    for (rel, abs) in files {
        out.push_str(&synth_added_diff(&rel, &abs));
    }
    out
}

fn collect_files(rel_dir: &str, abs_dir: &std::path::Path, out: &mut Vec<(String, std::path::PathBuf)>) {
    let entries = match fs::read_dir(abs_dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = match entry.file_name().into_string() {
            Ok(s) => s,
            Err(_) => continue,
        };
        let abs = entry.path();
        let rel = if rel_dir.is_empty() || rel_dir.ends_with('/') {
            format!("{}{}", rel_dir, name)
        } else {
            format!("{}/{}", rel_dir, name)
        };
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            collect_files(&rel, &abs, out);
        } else if ft.is_file() {
            out.push((rel, abs));
        }
    }
}

fn synth_added_diff(rel_path: &str, abs_path: &std::path::Path) -> String {
    let mut out = String::new();
    out.push_str(&format!("diff --git a/{p} b/{p}\n", p = rel_path));
    out.push_str("new file\n");
    out.push_str(&format!("--- /dev/null\n+++ b/{}\n", rel_path));
    match fs::read(abs_path) {
        Ok(bytes) => {
            if std::str::from_utf8(&bytes).is_err() {
                out.push_str("Binary file\n");
                return out;
            }
            let text = String::from_utf8_lossy(&bytes);
            let lines: Vec<&str> = text.split_inclusive('\n').collect();
            out.push_str(&format!("@@ -0,0 +1,{} @@\n", lines.len().max(1)));
            for line in &lines {
                out.push('+');
                out.push_str(line);
                if !line.ends_with('\n') {
                    out.push('\n');
                }
            }
        }
        Err(e) => {
            out.push_str(&format!("(failed to read file: {})\n", e));
        }
    }
    out
}

#[tauri::command(async)]
fn git_stage(path: String, file_path: String) -> Result<(), String> {
    debug_action("git", &format!("stage {}", file_path));
    let output = run_git_logged(&["add", "--", &file_path], &path)
        .map_err(|e| format!("Failed to run git add: {}", e))?;
    if !output.status.success() {
        return Err(format!("git add failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    Ok(())
}

#[tauri::command(async)]
fn git_stage_many(path: String, file_paths: Vec<String>) -> Result<(), String> {
    if file_paths.is_empty() {
        return Ok(());
    }
    debug_action("git", &format!("stage {} file(s)", file_paths.len()));
    let mut args: Vec<&str> = vec!["add", "--"];
    for p in &file_paths {
        args.push(p);
    }
    let output = run_git_logged(&args, &path)
        .map_err(|e| format!("Failed to run git add: {}", e))?;
    if !output.status.success() {
        return Err(format!("git add failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    Ok(())
}

#[tauri::command(async)]
fn git_stage_all(path: String) -> Result<(), String> {
    debug_action("git", "stage all");
    let output = run_git_logged(&["add", "-A"], &path)
        .map_err(|e| format!("Failed to run git add -A: {}", e))?;
    if !output.status.success() {
        return Err(format!("git add -A failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    Ok(())
}

#[tauri::command(async)]
fn git_unstage(path: String, file_path: String) -> Result<(), String> {
    git_unstage_paths(&path, &[file_path])
}

#[tauri::command(async)]
fn git_unstage_many(path: String, file_paths: Vec<String>) -> Result<(), String> {
    if file_paths.is_empty() {
        return Ok(());
    }
    git_unstage_paths(&path, &file_paths)
}

#[tauri::command(async)]
fn git_unstage_all(path: String) -> Result<(), String> {
    debug_action("git", "unstage all");
    // Prefer `git restore --staged .`; fall back to `git reset HEAD`.
    let restore = run_git_logged(&["restore", "--staged", "."], &path)
        .map_err(|e| format!("Failed to run git restore: {}", e))?;
    if restore.status.success() {
        return Ok(());
    }
    let reset = run_git_logged(&["reset", "HEAD"], &path)
        .map_err(|e| format!("Failed to run git reset: {}", e))?;
    if !reset.status.success() {
        return Err(format!(
            "git unstage all failed: {}",
            String::from_utf8_lossy(&reset.stderr)
        ));
    }
    Ok(())
}

fn git_unstage_paths(path: &str, file_paths: &[String]) -> Result<(), String> {
    debug_action("git", &format!("unstage {} file(s)", file_paths.len()));
    let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
    for p in file_paths {
        args.push(p);
    }
    let restore = run_git_logged(&args, path)
        .map_err(|e| format!("Failed to run git restore: {}", e))?;
    if restore.status.success() {
        return Ok(());
    }
    // Fallback: git reset HEAD -- <files>
    let mut reset_args: Vec<&str> = vec!["reset", "HEAD", "--"];
    for p in file_paths {
        reset_args.push(p);
    }
    let reset = run_git_logged(&reset_args, path)
        .map_err(|e| format!("Failed to run git reset: {}", e))?;
    if !reset.status.success() {
        return Err(format!(
            "git unstage failed: {}",
            String::from_utf8_lossy(&reset.stderr)
        ));
    }
    Ok(())
}

#[tauri::command(async)]
fn git_discard(path: String, file_path: String) -> Result<(), String> {
    debug_action("git", &format!("discard {}", file_path));
    let repo = git2::Repository::open(&path).map_err(|e| format!("Not a git repo: {}", e))?;
    let abs = std::path::Path::new(&path).join(&file_path);
    let rel = std::path::Path::new(&file_path);

    let in_index = repo
        .index()
        .ok()
        .and_then(|idx| idx.get_path(rel, 0))
        .is_some();
    let in_head = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_tree().ok())
        .and_then(|t| t.get_path(rel).ok())
        .is_some();

    // Untracked file or directory — remove from disk.
    if !in_index && !in_head {
        if abs.is_dir() {
            fs::remove_dir_all(&abs).map_err(|e| format!("Failed to remove dir: {}", e))?;
        } else if abs.exists() {
            fs::remove_file(&abs).map_err(|e| format!("Failed to remove file: {}", e))?;
        }
        return Ok(());
    }

    // Tracked — revert working-tree to index version.
    let output = run_git_logged(&["checkout", "--", &file_path], &path)
        .map_err(|e| format!("Failed to run git checkout: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "git checkout failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

#[tauri::command(async)]
fn git_fetch(path: String) -> Result<(), String> {
    debug_action("git", "fetch --all --prune");
    let output = run_git_logged(&["fetch", "--all", "--prune"], &path)
        .map_err(|e| format!("Failed to run git fetch: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git fetch failed: {}", stderr));
    }
    Ok(())
}

#[tauri::command(async)]
fn git_pull(path: String) -> Result<String, String> {
    debug_action("git", "pull");
    let output = run_git_logged(&["pull"], &path)
        .map_err(|e| format!("Failed to run git pull: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git pull failed: {}", stderr));
    }
    Ok(stdout)
}

// ---------------------------------------------------------------------------
// Tauri commands: Worktrees
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct ExistingWorktree {
    path: String,
    branch: Option<String>,
}

#[tauri::command(async)]
fn list_existing_worktrees(project_id: String, state: State<'_, AppState>) -> Result<Vec<ExistingWorktree>, String> {
    let index = load_project_index(&state.projects_dir);
    let meta = index.projects.iter().find(|p| p.id == project_id)
        .ok_or("Project not found")?;
    if meta.repo_path.is_empty() {
        return Ok(vec![]);
    }
    let repo_path = &meta.repo_path;
    Ok(list_git_worktrees(repo_path).into_iter()
        .filter(|(p, _)| p != repo_path)
        .map(|(path, branch)| ExistingWorktree { path, branch })
        .collect())
}

/// A branch offered in the new-worktree picker. Remote-only branches are listed
/// under the local name they would get, with `remoteRef` naming the ref to track
/// — the UI needs that distinction to know a "branch from" base is meaningless.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BranchEntry {
    name: String,
    remote_ref: Option<String>,
}

#[tauri::command(async)]
fn list_branches(project_id: String, state: State<'_, AppState>) -> Result<Vec<BranchEntry>, String> {
    let index = load_project_index(&state.projects_dir);
    let meta = index.projects.iter().find(|p| p.id == project_id)
        .ok_or("Project not found")?;
    if meta.repo_path.is_empty() {
        return Err("No repository path set for this project".to_string());
    }
    let repo = git2::Repository::open(&meta.repo_path)
        .map_err(|e| format!("Not a git repo: {}", e))?;

    let mut locals: Vec<String> = Vec::new();
    for branch_result in repo.branches(Some(git2::BranchType::Local)).map_err(|e| e.to_string())? {
        let (branch, _) = branch_result.map_err(|e| e.to_string())?;
        if let Some(name) = branch.name().map_err(|e| e.to_string())? {
            locals.push(name.to_string());
        }
    }
    locals.sort();
    locals.dedup();

    // Remote-only branches, keyed by the local name they'd take. A remote HEAD
    // pointer ("origin/HEAD") is an alias, not a branch, so it's skipped.
    let mut remotes: Vec<BranchEntry> = Vec::new();
    for branch_result in repo.branches(Some(git2::BranchType::Remote)).map_err(|e| e.to_string())? {
        let (branch, _) = branch_result.map_err(|e| e.to_string())?;
        let Some(full) = branch.name().map_err(|e| e.to_string())? else { continue };
        let Some(short) = strip_remote_prefix(&repo, full) else { continue };
        if short == "HEAD" || locals.contains(&short) { continue; }
        if remotes.iter().any(|e| e.name == short) { continue; }
        remotes.push(BranchEntry { name: short, remote_ref: Some(full.to_string()) });
    }
    remotes.sort_by(|a, b| a.name.cmp(&b.name));

    let mut entries: Vec<BranchEntry> = locals.into_iter()
        .map(|name| BranchEntry { name, remote_ref: None })
        .collect();
    entries.extend(remotes);
    Ok(entries)
}

/// "origin/feature/x" -> "feature/x", for any configured remote. None when the
/// name isn't prefixed with a known remote.
fn strip_remote_prefix(repo: &git2::Repository, name: &str) -> Option<String> {
    let remotes = repo.remotes().ok()?;
    remotes.iter().flatten()
        .filter_map(|r| name.strip_prefix(&format!("{}/", r)))
        .map(str::to_string)
        .next()
}

/// The remote-tracking ref for a local branch name, preferring `origin`.
fn find_remote_branch(repo: &git2::Repository, name: &str) -> Option<String> {
    let remotes = repo.remotes().ok()?;
    let mut names: Vec<String> = remotes.iter().flatten().map(str::to_string).collect();
    names.sort_by_key(|r| r != "origin");
    names.into_iter()
        .map(|r| format!("{}/{}", r, name))
        .find(|full| repo.find_branch(full, git2::BranchType::Remote).is_ok())
}

/// Upstream of a local branch as a ref name, e.g. "origin/main".
fn upstream_of(repo: &git2::Repository, name: &str) -> Option<String> {
    let local = repo.find_branch(name, git2::BranchType::Local).ok()?;
    let upstream = local.upstream().ok()?;
    upstream.name().ok().flatten().map(str::to_string)
}

/// Where a new worktree's branch comes from.
enum BranchSourceKind {
    /// Already exists locally: check it out, fast-forwarding to `upstream` if set.
    Existing { upstream: Option<String> },
    /// Exists only on a remote: create the local branch tracking `remote_ref`.
    Track { remote_ref: String },
    /// Doesn't exist yet: branch off `base` (None = current HEAD of the repo).
    New { base: Option<String> },
}

struct BranchSource {
    /// Local branch name to check out — never remote-qualified.
    local_name: String,
    kind: BranchSourceKind,
}

/// Work out what the requested branch means against freshly fetched refs.
///
/// The picker lists remote-only branches, so "na/fix" may exist only as
/// "origin/na/fix"; that must become a local branch tracking the remote, not a
/// literal branch named "origin/na/fix" cut from whatever HEAD happens to be.
fn resolve_branch_source(
    repo: &git2::Repository, requested: &str, base_branch: Option<&str>,
) -> BranchSource {
    let requested = requested.trim();

    // A remote-qualified request ("origin/na/fix") names the local branch "na/fix".
    let (local_name, explicit_remote) =
        match strip_remote_prefix(repo, requested)
            .filter(|_| repo.find_branch(requested, git2::BranchType::Remote).is_ok())
        {
            Some(short) => (short, Some(requested.to_string())),
            None => (requested.to_string(), None),
        };

    if repo.find_branch(&local_name, git2::BranchType::Local).is_ok() {
        let upstream = upstream_of(repo, &local_name);
        return BranchSource { local_name, kind: BranchSourceKind::Existing { upstream } };
    }

    if let Some(remote_ref) = explicit_remote.or_else(|| find_remote_branch(repo, &local_name)) {
        return BranchSource { local_name, kind: BranchSourceKind::Track { remote_ref } };
    }

    let base = base_branch
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|b| resolve_base_ref(repo, b));
    BranchSource { local_name, kind: BranchSourceKind::New { base } }
}

/// Resolve a base branch to the newest commit we have for it: its remote-tracking
/// ref when there is one, so a stale local copy of `main` doesn't become the base.
fn resolve_base_ref(repo: &git2::Repository, base: &str) -> String {
    if repo.find_branch(base, git2::BranchType::Remote).is_ok() {
        return base.to_string();
    }
    if repo.find_branch(base, git2::BranchType::Local).is_ok() {
        if let Some(upstream) = upstream_of(repo, base) {
            return upstream;
        }
    }
    find_remote_branch(repo, base).unwrap_or_else(|| base.to_string())
}

#[tauri::command(async)]
fn get_default_branch(project_id: String, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let index = load_project_index(&state.projects_dir);
    let meta = index.projects.iter().find(|p| p.id == project_id)
        .ok_or("Project not found")?;
    if meta.repo_path.is_empty() {
        return Ok(None);
    }
    let repo = git2::Repository::open(&meta.repo_path)
        .map_err(|e| format!("Not a git repo: {}", e))?;

    if let Ok(r) = repo.find_reference("refs/remotes/origin/HEAD") {
        if let Some(target) = r.symbolic_target() {
            if let Some(name) = target.strip_prefix("refs/remotes/origin/") {
                return Ok(Some(name.to_string()));
            }
        }
    }

    for candidate in ["main", "master"] {
        if repo.find_branch(candidate, git2::BranchType::Local).is_ok() {
            return Ok(Some(candidate.to_string()));
        }
    }
    Ok(None)
}

fn sanitize_branch_for_path(branch: &str) -> String {
    branch.replace('/', "-")
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn list_git_worktrees(repo_path: &str) -> Vec<(String, Option<String>)> {
    let shell_path = get_shell_path();
    let output = Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(repo_path)
        .env("PATH", &shell_path)
        .output();
    let Ok(output) = output else { return vec![]; };
    if !output.status.success() { return vec![]; }
    let stdout = String::from_utf8_lossy(&output.stdout);

    let mut result = vec![];
    let mut current_path: Option<String> = None;
    let mut current_branch: Option<String> = None;

    for line in stdout.lines() {
        if line.is_empty() {
            if let Some(p) = current_path.take() {
                result.push((p, current_branch.take()));
            }
        } else if let Some(p) = line.strip_prefix("worktree ") {
            current_path = Some(p.to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            current_branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
        }
    }
    if let Some(p) = current_path.take() {
        result.push((p, current_branch.take()));
    }
    result
}

#[tauri::command(async)]
fn create_worktree(
    project_id: String, branch: String, path: String, base_branch: Option<String>,
    replace_stale: Option<bool>, state: State<'_, AppState>,
) -> Result<WorktreeDef, String> {
    let index = load_project_index(&state.projects_dir);
    let meta = index.projects.iter().find(|p| p.id == project_id)
        .ok_or("Project not found")?;
    if meta.repo_path.is_empty() {
        return Err("No repository path set for this project".to_string());
    }
    let repo_path = &meta.repo_path;
    debug_action("worktree", &format!("create worktree on branch '{}' at {}", branch, path));

    // A worktree should start from the latest remote state, so fetch before
    // resolving any ref. Offline is not fatal — branching off slightly stale
    // refs beats refusing to create the worktree at all.
    match run_git_logged(&["fetch", "--all", "--prune"], repo_path) {
        Ok(out) if out.status.success() => {}
        _ => debug_log("git", "warn",
            "fetch before worktree create failed; falling back to local refs"),
    }

    let repo = git2::Repository::open(repo_path)
        .map_err(|e| format!("Not a git repo: {}", e))?;
    let source = resolve_branch_source(&repo, &branch, base_branch.as_deref());
    // From here on, `branch` is the local branch name — the request may have
    // named a remote ref ("origin/na/fix"), which is not a local branch name.
    let branch = source.local_name.clone();
    drop(repo);

    // If the branch is already checked out in a worktree (other than the main repo),
    // adopt that existing worktree instead of erroring.
    let existing_worktrees = list_git_worktrees(repo_path);
    let adopted_path: Option<String> = existing_worktrees.iter()
        .find(|(p, b)| p != repo_path && b.as_deref() == Some(branch.as_str()))
        .map(|(p, _)| p.clone());

    let final_path = if let Some(p) = adopted_path {
        p
    } else {
        // Check if requested path already has a worktree on a different branch
        if let Some((_, other_branch)) = existing_worktrees.iter().find(|(p, _)| p == &path) {
            return Err(format!(
                "Path '{}' already has a worktree on branch '{}'",
                path,
                other_branch.as_deref().unwrap_or("(detached)")
            ));
        }

        // A non-empty directory git doesn't register as a worktree is a leftover
        // from a failed removal; git would refuse with a bare "already exists".
        // The STALE_DIR prefix lets the UI offer to delete it and retry.
        let target = std::path::Path::new(&path);
        if target.exists()
            && target.read_dir().map(|mut d| d.next().is_some()).unwrap_or(true)
        {
            if !replace_stale.unwrap_or(false) {
                return Err(format!(
                    "STALE_DIR: Directory '{}' already exists but is not a registered worktree (likely left over from a failed delete).",
                    path
                ));
            }
            if path == *repo_path || target.join(".git").is_dir() {
                return Err(format!(
                    "Refusing to delete '{}': it looks like a full repository",
                    path
                ));
            }
            std::fs::remove_dir_all(target)
                .map_err(|e| format!("Failed to delete stale directory '{}': {}", path, e))?;
        }

        let mut args: Vec<String> = vec!["worktree".into(), "add".into()];
        match &source.kind {
            BranchSourceKind::Existing { .. } => {
                args.push(path.clone());
                args.push(branch.clone());
            }
            // --track makes the new local branch follow the remote one, so pulls
            // and status in the worktree work without extra setup.
            BranchSourceKind::Track { remote_ref } => {
                args.extend(["--track".into(), "-b".into(), branch.clone(), path.clone(),
                    remote_ref.clone()]);
            }
            // --no-track because the base is resolved to a remote ref
            // ("origin/main"); without it git would make the new branch track
            // the base, so a later pull in the worktree would merge main into it.
            BranchSourceKind::New { base } => {
                args.extend(["--no-track".into(), "-b".into(), branch.clone(), path.clone()]);
                if let Some(base) = base {
                    args.push(base.clone());
                }
            }
        }

        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let output = run_git_logged(&arg_refs, repo_path)
            .map_err(|e| format!("Failed to run git worktree add: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git worktree add failed: {}", stderr));
        }

        // An existing local branch may lag its remote; the worktree is freshly
        // checked out and clean, so fast-forward it to the fetched upstream.
        // Divergence or local-only commits make this impossible — keep the
        // branch as it is rather than touching the user's commits.
        if let BranchSourceKind::Existing { upstream: Some(upstream) } = &source.kind {
            let ok = run_git_logged(&["merge", "--ff-only", upstream], &path)
                .map(|o| o.status.success()).unwrap_or(false);
            if !ok {
                debug_log("git", "warn", &format!(
                    "could not fast-forward '{}' to '{}' — left at its current commit",
                    branch, upstream));
            }
        }

        path.clone()
    };

    let mut projects = state.projects.lock().unwrap();
    let ps = projects.get_mut(&project_id).ok_or("Project not loaded")?;

    // If lever already tracks this worktree path, return the existing entry.
    if let Some(existing) = ps.config.worktrees.iter().find(|w| w.path == final_path) {
        return Ok(existing.clone());
    }

    let worktree_id = format!("wt-{}-{}", sanitize_branch_for_path(&branch),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default().as_millis() % 100000);

    let cloned_groups: Vec<ServiceGroup> = ps.config.groups.iter().map(|g| {
        let cloned_services: Vec<ServiceDef> = g.services.iter().map(|s| {
            let new_cwd = if s.cwd.starts_with(repo_path.as_str()) {
                s.cwd.replacen(repo_path.as_str(), &final_path, 1)
            } else if s.cwd.is_empty() {
                final_path.clone()
            } else {
                format!("{}/{}", final_path, s.cwd)
            };
            ServiceDef {
                id: format!("{}-{}", s.id, worktree_id),
                label: s.label.clone(),
                description: s.description.clone(),
                command: s.command.clone(),
                args: s.args.clone(),
                cwd: new_cwd,
                service_type: s.service_type.clone(),
                stop_command: s.stop_command.clone(),
            }
        }).collect();
        ServiceGroup {
            id: format!("{}-{}", g.id, worktree_id),
            label: g.label.clone(),
            services: cloned_services,
        }
    }).collect();

    let worktree_def = WorktreeDef {
        id: worktree_id, branch, path: final_path, groups: cloned_groups,
    };

    ps.config.worktrees.push(worktree_def.clone());
    save_project_config(&state.projects_dir, &project_id, &ps.config)?;

    Ok(worktree_def)
}

#[cfg(unix)]
fn signal_pids(pids: &[u32], sig: i32) {
    for &pid in pids {
        unsafe {
            libc::kill(-(pid as i32), sig);
            libc::kill(pid as i32, sig);
        }
    }
}

#[cfg(unix)]
fn wait_for_exit(pids: &[u32], timeout_ms: u64) -> Vec<u32> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    loop {
        let alive: Vec<u32> = pids.iter().copied()
            .filter(|&pid| unsafe { libc::kill(pid as i32, 0) } == 0)
            .collect();
        if alive.is_empty() || std::time::Instant::now() >= deadline {
            return alive;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

fn cleanup_worktree_dir(repo_path: &str, wt_path: &str) -> Result<(), String> {
    let stderr = match run_git_logged(&["worktree", "remove", "--force", wt_path], repo_path) {
        Ok(o) if o.status.success() => String::new(),
        Ok(o) => String::from_utf8_lossy(&o.stderr).to_string(),
        Err(e) => format!("failed to run git: {}", e),
    };

    let path = std::path::Path::new(wt_path);
    if !path.exists() {
        debug_log("worktree", "info", "directory no longer exists — removal complete");
        return Ok(());
    }

    // git aborted partway or the worktree was never registered: drop any dangling
    // registration and delete what's left ourselves. Never touch the main repo or
    // anything with a real .git directory (worktrees only have a .git file).
    debug_log("worktree", "info", "directory still present after remove — pruning and falling back to manual delete");
    let _ = run_git_logged(&["worktree", "prune"], repo_path);
    if wt_path == repo_path || path.join(".git").is_dir() {
        debug_log("worktree", "error", "refusing to delete: path is the main repo or has a real .git directory");
        return Err(format!("git worktree remove failed: {}", stderr.trim()));
    }
    debug_log("worktree", "cmd", &format!("rm -rf {}", wt_path));
    std::fs::remove_dir_all(path).map_err(|e| {
        debug_log("worktree", "error", &format!("manual delete failed: {}", e));
        format!(
            "git worktree remove failed ({}); deleting the directory also failed: {}",
            stderr.trim(), e
        )
    })?;
    debug_log("worktree", "info", "manual delete succeeded — removal complete");
    Ok(())
}

/// Is `wt_path` still registered as a worktree of `repo_path`? A removal that
/// deletes the directory but leaves a dangling registration (or vice versa) is
/// not actually done. Paths are compared with any trailing slash stripped.
fn worktree_is_registered(repo_path: &str, wt_path: &str) -> bool {
    let target = wt_path.trim_end_matches('/');
    list_git_worktrees(repo_path)
        .iter()
        .any(|(p, _)| p.trim_end_matches('/') == target)
}

/// A worktree is only fully removed once its directory is gone from disk AND it
/// is no longer registered with git.
fn worktree_fully_removed(repo_path: &str, wt_path: &str) -> bool {
    !std::path::Path::new(wt_path).exists() && !worktree_is_registered(repo_path, wt_path)
}

/// Human-readable summary of whatever is still hanging around, for logs/errors.
fn describe_worktree_remnants(repo_path: &str, wt_path: &str) -> String {
    let dir = std::path::Path::new(wt_path).exists();
    let reg = worktree_is_registered(repo_path, wt_path);
    match (dir, reg) {
        (true, true) => "directory + git registration".to_string(),
        (true, false) => "directory".to_string(),
        (false, true) => "git registration".to_string(),
        (false, false) => "nothing".to_string(),
    }
}

/// Remove the worktree directory and git registration, then verify it actually
/// happened — retrying a few times if anything is left behind.
///
/// Removal can fail transiently: a shell or dev server inside the worktree may
/// still be releasing files the instant git/`remove_dir_all` runs, leaving the
/// directory or a dangling registration behind. That is exactly the case that
/// used to force a manual second attempt. Here we re-check after each attempt
/// and, while remnants remain, give it another go with a short escalating
/// backoff so the offending process has time to exit.
fn cleanup_worktree_dir_verified(repo_path: &str, wt_path: &str) -> Result<(), String> {
    const MAX_ATTEMPTS: u32 = 4;
    let mut last_err = String::new();

    for attempt in 1..=MAX_ATTEMPTS {
        debug_log("worktree", "info",
            &format!("cleanup attempt {}/{}", attempt, MAX_ATTEMPTS));

        if let Err(e) = cleanup_worktree_dir(repo_path, wt_path) {
            last_err = e;
        }

        if worktree_fully_removed(repo_path, wt_path) {
            debug_log("worktree", "info",
                "verified removed — directory and git registration both clear");
            return Ok(());
        }

        let remnants = describe_worktree_remnants(repo_path, wt_path);
        debug_log("worktree", "info",
            &format!("after attempt {}, still present: {}", attempt, remnants));

        if attempt < MAX_ATTEMPTS {
            // 300ms, 600ms, 900ms — enough for a lingering process to release files.
            std::thread::sleep(std::time::Duration::from_millis(300 * attempt as u64));
        }
    }

    let remnants = describe_worktree_remnants(repo_path, wt_path);
    let detail = if last_err.is_empty() {
        String::new()
    } else {
        format!(" (last error: {})", last_err)
    };
    Err(format!(
        "worktree still present after {} attempts — leftover: {}{}",
        MAX_ATTEMPTS, remnants, detail
    ))
}

#[tauri::command(async)]
fn remove_worktree(
    project_id: String, worktree_id: String, cleanup: bool, state: State<'_, AppState>,
) -> Result<(), String> {
    let worktree;
    let mut pids: Vec<u32> = vec![];
    {
        let mut projects = state.projects.lock().unwrap();
        let ps = projects.get_mut(&project_id).ok_or("Project not loaded")?;

        worktree = ps.config.worktrees.iter().find(|w| w.id == worktree_id)
            .cloned().ok_or("Worktree not found")?;

        debug_action("worktree", &format!("Removing worktree '{}' (branch {}) at {}{}",
            worktree.id, worktree.branch, worktree.path,
            if cleanup { " [with directory cleanup]" } else { " [config only]" }));

        // Stop all running services in the worktree
        let wt_service_ids: Vec<String> = worktree.groups.iter()
            .flat_map(|g| g.services.iter().map(|s| s.id.clone())).collect();
        for svc_id in &wt_service_ids {
            if let Some(tracked) = ps.tracked.remove(svc_id) {
                if let Some(ref pty_id) = tracked.pty_id {
                    ps.pty_sessions.remove(pty_id);
                }
                pids.push(tracked.pid);
            }
        }
        save_project_persistent_state(&state.projects_dir, &project_id, &ps.tracked);
    }

    #[cfg(unix)]
    {
        if !pids.is_empty() {
            debug_log("worktree", "info", &format!("Stopping {} running service(s): SIGTERM {:?}", pids.len(), pids));
        }
        signal_pids(&pids, libc::SIGTERM);
        if cleanup {
            // Anything still writing while git deletes the directory can abort the
            // removal halfway and orphan it.
            let alive = wait_for_exit(&pids, 3000);
            if !alive.is_empty() {
                debug_log("worktree", "info", &format!("Still alive after 3s, sending SIGKILL: {:?}", alive));
                signal_pids(&alive, libc::SIGKILL);
                wait_for_exit(&alive, 1000);
            }
        }
    }
    #[cfg(not(unix))]
    let _ = &pids;

    if cleanup {
        let index = load_project_index(&state.projects_dir);
        if let Some(meta) = index.projects.iter().find(|p| p.id == project_id) {
            if !meta.repo_path.is_empty() {
                debug_log("worktree", "info", &format!("repo: {}", meta.repo_path));
                // Propagating the error keeps the worktree in config so the
                // removal stays visible and retryable.
                if let Err(e) = cleanup_worktree_dir_verified(&meta.repo_path, &worktree.path) {
                    debug_log("worktree", "error", &format!("removal failed: {}", e));
                    return Err(e);
                }
            } else {
                debug_log("worktree", "error", "project has no repo_path — skipping directory cleanup");
            }
        } else {
            debug_log("worktree", "error", "project not found in index — skipping directory cleanup");
        }
    }

    let mut projects = state.projects.lock().unwrap();
    let ps = projects.get_mut(&project_id).ok_or("Project not loaded")?;
    ps.config.worktrees.retain(|w| w.id != worktree_id);
    save_project_config(&state.projects_dir, &project_id, &ps.config)?;
    debug_log("worktree", "info", "worktree removed from lever config — done");
    Ok(())
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir().expect("failed to get app data dir");
            let _ = fs::create_dir_all(&data_dir);

            let proj_dir = projects_dir(&data_dir);
            let _ = fs::create_dir_all(&proj_dir);

            app.manage(AppState {
                projects: Mutex::new(HashMap::new()),
                pty_counter: Mutex::new(0),
                projects_dir: proj_dir,
                agent_cache: Mutex::new(AgentScanCache::default()),
                stop_services_on_quit: AtomicBool::new(true),
            });

            let _ = DEBUG_APP.set(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_projects,
            create_project,
            delete_project,
            rename_project,
            set_repo_path,
            get_repo_path,
            clone_project,
            import_project,
            show_start_page,
            open_project,
            open_scratch_terminal,
            get_config,
            save_config,
            start_service,
            stop_service,
            poll,
            create_pty,
            write_pty,
            resize_pty,
            close_pty,
            write_text_file,
            check_is_git_repo,
            git_info,
            git_diff,
            git_stage,
            git_stage_many,
            git_stage_all,
            git_unstage,
            git_unstage_many,
            git_unstage_all,
            git_discard,
            git_fetch,
            git_pull,
            list_branches,
            list_existing_worktrees,
            create_worktree,
            remove_worktree,
            get_default_branch,
            set_stop_services_on_quit,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let label = window.label().to_string();
                if label.starts_with("project-") {
                    let project_id = label[8..].to_string();
                    let state = window.state::<AppState>();
                    let stop_on_quit = state.stop_services_on_quit.load(Ordering::Relaxed);
                    let mut projects = state.projects.lock().unwrap();
                    if let Some(ps) = projects.get_mut(&project_id) {
                        // Closing the window used to leave every spawned service
                        // running with nothing on screen left to stop it.
                        if stop_on_quit {
                            for (_svc_id, t) in ps.tracked.iter() {
                                #[cfg(unix)]
                                unsafe {
                                    libc::kill(-(t.pid as i32), libc::SIGTERM);
                                    libc::kill(t.pid as i32, libc::SIGTERM);
                                }
                            }
                            ps.tracked.clear();
                        }
                        if !project_id.starts_with("scratch-") {
                            save_project_persistent_state(&state.projects_dir, &project_id, &ps.tracked);
                        }
                        ps.pty_sessions.clear();
                    }
                    projects.remove(&project_id);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

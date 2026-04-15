// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read as IoRead, Write as IoWrite};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
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
    // reader is owned by the background streaming thread
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
}

#[derive(Serialize)]
struct ServiceStatus {
    id: String,
    status: String,
}

#[derive(Serialize)]
struct PollResult {
    statuses: Vec<ServiceStatus>,
    logs: HashMap<String, Vec<String>>,
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
    if let Ok(output) = Command::new("/bin/zsh")
        .args(["-il", "-c", "echo $PATH"])
        .output()
    {
        if let Ok(path) = String::from_utf8(output.stdout) {
            return path.trim().to_string();
        }
    }
    std::env::var("PATH").unwrap_or_default()
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

#[tauri::command]
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

#[tauri::command]
fn delete_project(id: String, app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
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
fn import_project(name: String, config_json: String, state: State<'_, AppState>) -> Result<ProjectMeta, String> {
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
        repo_path: String::new(),
        created_at: now_unix(),
        last_opened: now_unix(),
    };
    index.projects.push(meta.clone());
    save_project_index(&state.projects_dir, &index)?;
    Ok(meta)
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

    tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title(format!("Lever — {}", project_name))
    .inner_size(900.0, 700.0)
    .min_inner_size(600.0, 400.0)
    .build()
    .map_err(|e| e.to_string())?;

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

#[tauri::command]
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

#[tauri::command]
fn start_service(project_id: String, id: String, app: tauri::AppHandle, state: State<'_, AppState>) -> Result<StartServiceResult, String> {
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

    let child = pair.slave.spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn {}: {}", def.label, e))?;

    let pid = child.process_id().unwrap_or(0);

    let mut reader = pair.master.try_clone_reader()
        .map_err(|e| format!("Failed to clone reader: {}", e))?;
    let writer = pair.master.take_writer()
        .map_err(|e| format!("Failed to take writer: {}", e))?;

    let mut counter = state.pty_counter.lock().unwrap();
    *counter += 1;
    let pty_id = format!("svc-pty-{}", *counter);
    drop(counter);

    let session = PtySession { writer, master: pair.master };
    ps.pty_sessions.insert(pty_id.clone(), session);
    ps.tracked.insert(id.clone(), TrackedService { pid, pty_id: Some(pty_id.clone()) });
    save_project_persistent_state(&state.projects_dir, &project_id, &ps.tracked);

    let projects_dir = state.projects_dir.clone();
    let proj_id = project_id.clone();
    let id_clone = id.clone();
    let pty_id_clone = pty_id.clone();
    let app_handle = app.clone();

    drop(projects);

    std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        let mut leftover: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let mut data = Vec::with_capacity(leftover.len() + n);
                    data.extend_from_slice(&leftover);
                    data.extend_from_slice(&buf[..n]);
                    leftover.clear();
                    match std::str::from_utf8(&data) {
                        Ok(s) => {
                            let _ = app_handle.emit("pty-data", PtyDataEvent {
                                id: pty_id_clone.clone(),
                                data: s.to_string(),
                            });
                        }
                        Err(e) => {
                            let valid_up_to = e.valid_up_to();
                            if valid_up_to > 0 {
                                let s = std::str::from_utf8(&data[..valid_up_to]).unwrap();
                                let _ = app_handle.emit("pty-data", PtyDataEvent {
                                    id: pty_id_clone.clone(),
                                    data: s.to_string(),
                                });
                            }
                            leftover.extend_from_slice(&data[valid_up_to..]);
                        }
                    }
                }
                Err(_) => break,
            }
        }
        // PTY exited — emit svc-exit event and clean up
        let _ = app_handle.emit("svc-exit", SvcExitEvent {
            id: id_clone.clone(),
            pty_id: pty_id_clone.clone(),
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
    });

    Ok(StartServiceResult { pty_id })
}

#[tauri::command]
fn stop_service(project_id: String, id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut projects = state.projects.lock().unwrap();
    let ps = projects.get_mut(&project_id).ok_or("Project not loaded")?;

    let found = find_service_with_worktree_path(&ps.config, &id)
        .map(|(def, wt)| (def.clone(), wt.map(String::from)));
    let tracked = ps.tracked.remove(&id);

    if let (Some((def, worktree_path)), Some(ref t)) = (&found, &tracked) {
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

#[tauri::command]
fn poll(project_id: String, state: State<'_, AppState>) -> Result<PollResult, String> {
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
        ServiceStatus {
            id: s.id.clone(),
            status: if ps.tracked.contains_key(&s.id) { "running" } else { "stopped" }.to_string(),
        }
    }).collect();

    Ok(PollResult { statuses, logs: HashMap::new() })
}

// ---------------------------------------------------------------------------
// Tauri commands: PTY terminals (project-scoped)
// ---------------------------------------------------------------------------

#[tauri::command]
fn create_pty(project_id: String, cols: u16, rows: u16, cwd: Option<String>, app: tauri::AppHandle, state: State<'_, AppState>) -> Result<PtyInfo, String> {
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

    pair.slave.spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {}", e))?;

    let mut reader = pair.master.try_clone_reader()
        .map_err(|e| format!("Failed to clone reader: {}", e))?;
    let writer = pair.master.take_writer()
        .map_err(|e| format!("Failed to take writer: {}", e))?;

    let mut counter = state.pty_counter.lock().unwrap();
    *counter += 1;
    let pty_id = format!("pty-{}", *counter);
    drop(counter);

    let session = PtySession { writer, master: pair.master };

    {
        let mut projects = state.projects.lock().unwrap();
        let ps = projects.get_mut(&project_id).ok_or("Project not loaded")?;
        ps.pty_sessions.insert(pty_id.clone(), session);
    }

    let app_handle = app.clone();
    let pty_id_clone = pty_id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        let mut leftover: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let mut data = Vec::with_capacity(leftover.len() + n);
                    data.extend_from_slice(&leftover);
                    data.extend_from_slice(&buf[..n]);
                    leftover.clear();
                    match std::str::from_utf8(&data) {
                        Ok(s) => {
                            let _ = app_handle.emit("pty-data", PtyDataEvent {
                                id: pty_id_clone.clone(),
                                data: s.to_string(),
                            });
                        }
                        Err(e) => {
                            let valid_up_to = e.valid_up_to();
                            if valid_up_to > 0 {
                                let s = std::str::from_utf8(&data[..valid_up_to]).unwrap();
                                let _ = app_handle.emit("pty-data", PtyDataEvent {
                                    id: pty_id_clone.clone(),
                                    data: s.to_string(),
                                });
                            }
                            leftover.extend_from_slice(&data[valid_up_to..]);
                        }
                    }
                }
                Err(_) => break,
            }
        }
        let _ = app_handle.emit("pty-exit", PtyExitEvent {
            id: pty_id_clone,
        });
    });

    Ok(PtyInfo { id: pty_id })
}

#[tauri::command]
fn write_pty(project_id: String, id: String, data: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut projects = state.projects.lock().unwrap();
    let ps = projects.get_mut(&project_id).ok_or("Project not loaded")?;
    let session = ps.pty_sessions.get_mut(&id).ok_or("PTY not found")?;
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

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, &contents).map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
fn check_is_git_repo(path: String) -> bool {
    git2::Repository::open(&path).is_ok()
}

#[tauri::command]
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
            .exclude_submodules(true),
    )).map_err(|e| e.to_string())?;
    let is_dirty = !statuses.is_empty();

    for entry in statuses.iter() {
        if let Some(p) = entry.path() {
            changed_files.push(GitFileStatus {
                path: p.to_string(),
                status: git_status_str(entry.status()).to_string(),
                staged: is_staged(entry.status()),
            });
        }
    }

    Ok(GitRepoInfo {
        current_branch,
        is_dirty,
        changed_files,
    })
}

#[tauri::command]
fn git_fetch(path: String) -> Result<(), String> {
    let shell_path = get_shell_path();
    let output = Command::new("git")
        .args(["fetch", "--all", "--prune"])
        .current_dir(&path)
        .env("PATH", &shell_path)
        .output()
        .map_err(|e| format!("Failed to run git fetch: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git fetch failed: {}", stderr));
    }
    Ok(())
}

#[tauri::command]
fn git_pull(path: String) -> Result<String, String> {
    let shell_path = get_shell_path();
    let output = Command::new("git")
        .args(["pull"])
        .current_dir(&path)
        .env("PATH", &shell_path)
        .output()
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

#[tauri::command]
fn list_branches(project_id: String, state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let index = load_project_index(&state.projects_dir);
    let meta = index.projects.iter().find(|p| p.id == project_id)
        .ok_or("Project not found")?;
    if meta.repo_path.is_empty() {
        return Err("No repository path set for this project".to_string());
    }
    let repo = git2::Repository::open(&meta.repo_path)
        .map_err(|e| format!("Not a git repo: {}", e))?;
    let mut branches = Vec::new();
    for branch_result in repo.branches(None).map_err(|e| e.to_string())? {
        let (branch, _branch_type) = branch_result.map_err(|e| e.to_string())?;
        if let Some(name) = branch.name().map_err(|e| e.to_string())? {
            branches.push(name.to_string());
        }
    }
    branches.sort();
    branches.dedup();
    Ok(branches)
}

fn sanitize_branch_for_path(branch: &str) -> String {
    branch.replace('/', "-")
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

#[tauri::command]
fn create_worktree(
    project_id: String, branch: String, path: String, state: State<'_, AppState>,
) -> Result<WorktreeDef, String> {
    let index = load_project_index(&state.projects_dir);
    let meta = index.projects.iter().find(|p| p.id == project_id)
        .ok_or("Project not found")?;
    if meta.repo_path.is_empty() {
        return Err("No repository path set for this project".to_string());
    }
    let repo_path = &meta.repo_path;

    // Check if branch exists locally
    let repo = git2::Repository::open(repo_path)
        .map_err(|e| format!("Not a git repo: {}", e))?;
    let branch_exists = repo.find_branch(&branch, git2::BranchType::Local).is_ok();

    let shell_path = get_shell_path();
    let args = if branch_exists {
        vec!["worktree".to_string(), "add".to_string(), path.clone(), branch.clone()]
    } else {
        vec!["worktree".to_string(), "add".to_string(), "-b".to_string(), branch.clone(), path.clone()]
    };

    let output = Command::new("git").args(&args).current_dir(repo_path)
        .env("PATH", &shell_path).output()
        .map_err(|e| format!("Failed to run git worktree add: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree add failed: {}", stderr));
    }

    let mut projects = state.projects.lock().unwrap();
    let ps = projects.get_mut(&project_id).ok_or("Project not loaded")?;

    let worktree_id = format!("wt-{}-{}", sanitize_branch_for_path(&branch),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default().as_millis() % 100000);

    let cloned_groups: Vec<ServiceGroup> = ps.config.groups.iter().map(|g| {
        let cloned_services: Vec<ServiceDef> = g.services.iter().map(|s| {
            let new_cwd = if s.cwd.starts_with(repo_path.as_str()) {
                s.cwd.replacen(repo_path.as_str(), &path, 1)
            } else if s.cwd.is_empty() {
                path.clone()
            } else {
                format!("{}/{}", path, s.cwd)
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
        id: worktree_id, branch, path, groups: cloned_groups,
    };

    ps.config.worktrees.push(worktree_def.clone());
    save_project_config(&state.projects_dir, &project_id, &ps.config)?;

    Ok(worktree_def)
}

#[tauri::command]
fn remove_worktree(
    project_id: String, worktree_id: String, cleanup: bool, state: State<'_, AppState>,
) -> Result<(), String> {
    let mut projects = state.projects.lock().unwrap();
    let ps = projects.get_mut(&project_id).ok_or("Project not loaded")?;

    let worktree = ps.config.worktrees.iter().find(|w| w.id == worktree_id)
        .cloned().ok_or("Worktree not found")?;

    // Stop all running services in the worktree
    let wt_service_ids: Vec<String> = worktree.groups.iter()
        .flat_map(|g| g.services.iter().map(|s| s.id.clone())).collect();
    for svc_id in &wt_service_ids {
        if let Some(tracked) = ps.tracked.remove(svc_id) {
            if let Some(ref pty_id) = tracked.pty_id {
                ps.pty_sessions.remove(pty_id);
            }
            #[cfg(unix)]
            unsafe {
                libc::kill(-(tracked.pid as i32), libc::SIGTERM);
                libc::kill(tracked.pid as i32, libc::SIGTERM);
            }
        }
    }
    save_project_persistent_state(&state.projects_dir, &project_id, &ps.tracked);

    ps.config.worktrees.retain(|w| w.id != worktree_id);
    save_project_config(&state.projects_dir, &project_id, &ps.config)?;

    if cleanup {
        let shell_path = get_shell_path();
        let index = load_project_index(&state.projects_dir);
        if let Some(meta) = index.projects.iter().find(|p| p.id == project_id) {
            if !meta.repo_path.is_empty() {
                let output = Command::new("git")
                    .args(["worktree", "remove", "--force", &worktree.path])
                    .current_dir(&meta.repo_path)
                    .env("PATH", &shell_path).output();
                if let Ok(output) = output {
                    if !output.status.success() {
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        return Err(format!("Worktree removed from config but git cleanup failed: {}", stderr));
                    }
                }
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir().expect("failed to get app data dir");
            let _ = fs::create_dir_all(&data_dir);

            let proj_dir = projects_dir(&data_dir);
            let _ = fs::create_dir_all(&proj_dir);

            app.manage(AppState {
                projects: Mutex::new(HashMap::new()),
                pty_counter: Mutex::new(0),
                projects_dir: proj_dir,
            });

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
            git_fetch,
            git_pull,
            list_branches,
            create_worktree,
            remove_worktree,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let label = window.label().to_string();
                if label.starts_with("project-") {
                    let project_id = label[8..].to_string();
                    let state = window.state::<AppState>();
                    let mut projects = state.projects.lock().unwrap();
                    if let Some(ps) = projects.get_mut(&project_id) {
                        save_project_persistent_state(&state.projects_dir, &project_id, &ps.tracked);
                        ps.pty_sessions.clear();
                    }
                    projects.remove(&project_id);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

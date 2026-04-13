// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read as IoRead, Seek, SeekFrom, Write as IoWrite};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

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
    #[serde(default)]
    repo_path: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct AppConfig {
    #[serde(default)]
    groups: Vec<ServiceGroup>,
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig { groups: vec![] }
    }
}

// ---------------------------------------------------------------------------
// Project metadata & index
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
struct ProjectMeta {
    id: String,
    name: String,
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

struct ProjectState {
    config: AppConfig,
    tracked: HashMap<String, TrackedService>,
    log_offsets: HashMap<String, u64>,
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

fn get_shell_path() -> String {
    if let Ok(output) = Command::new("/bin/zsh")
        .args(["-l", "-c", "echo $PATH"])
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

fn find_service<'a>(config: &'a AppConfig, id: &str) -> Option<&'a ServiceDef> {
    config.groups.iter().flat_map(|g| g.services.iter()).find(|s| s.id == id)
}

fn all_services(config: &AppConfig) -> Vec<&ServiceDef> {
    config.groups.iter().flat_map(|g| g.services.iter()).collect()
}

// Updated tail_log_file: caller passes the log path directly
fn tail_log_file(log_path: &PathBuf, id: &str, offsets: &mut HashMap<String, u64>) -> Vec<String> {
    let mut lines = Vec::new();
    let file = match File::open(log_path) {
        Ok(f) => f,
        Err(_) => return lines,
    };
    let file_size = match file.metadata() {
        Ok(m) => m.len(),
        Err(_) => return lines,
    };
    let current_offset = offsets.get(id).copied().unwrap_or_else(|| {
        // First poll for this service: skip to end so we don't read the entire log history
        offsets.insert(id.to_string(), file_size);
        file_size
    });
    let offset = if current_offset > file_size { 0 } else { current_offset };
    if offset >= file_size {
        return lines;
    }
    let mut reader = BufReader::new(file);
    if reader.seek(SeekFrom::Start(offset)).is_err() {
        return lines;
    }
    let mut new_offset = offset;
    let mut line_buf = String::new();
    while let Ok(n) = reader.read_line(&mut line_buf) {
        if n == 0 { break; }
        new_offset += n as u64;
        let trimmed = line_buf.trim_end_matches('\n').trim_end_matches('\r').to_string();
        if !trimmed.is_empty() {
            lines.push(trimmed);
        }
        line_buf.clear();
    }
    offsets.insert(id.to_string(), new_offset);
    lines
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

fn project_log_file_path(projects_dir: &PathBuf, project_id: &str, service_id: &str) -> PathBuf {
    let p = project_dir(projects_dir, project_id).join("logs");
    let _ = fs::create_dir_all(&p);
    p.join(format!("{}.log", service_id))
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

fn migrate_old_config(data_dir: &PathBuf) {
    let proj_dir = projects_dir(data_dir);
    if proj_dir.exists() {
        return;
    }

    let old_config_path = data_dir.join("config.json");
    if !old_config_path.exists() {
        let _ = fs::create_dir_all(&proj_dir);
        let _ = save_project_index(&proj_dir, &ProjectIndex::default());
        return;
    }

    let config: AppConfig = match fs::read_to_string(&old_config_path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => AppConfig::default(),
    };

    let _ = fs::create_dir_all(&proj_dir);
    let project_id = "default";
    let _ = save_project_config(&proj_dir, project_id, &config);

    let old_state = data_dir.join("state.json");
    let new_state = project_state_file_path(&proj_dir, project_id);
    if old_state.exists() {
        let _ = fs::rename(&old_state, &new_state);
    }

    let old_logs = data_dir.join("logs");
    let new_logs = project_dir(&proj_dir, project_id).join("logs");
    if old_logs.exists() {
        let _ = fs::rename(&old_logs, &new_logs);
    }

    let index = ProjectIndex {
        projects: vec![ProjectMeta {
            id: project_id.to_string(),
            name: "Default".to_string(),
            created_at: now_unix(),
            last_opened: now_unix(),
        }],
    };
    let _ = save_project_index(&proj_dir, &index);
    let _ = fs::remove_file(&old_config_path);
}

// ---------------------------------------------------------------------------
// Tauri commands: project CRUD
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct ProjectListEntry {
    id: String,
    name: String,
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
fn create_project(name: String, state: State<'_, AppState>) -> Result<ProjectMeta, String> {
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
    let meta = ProjectMeta {
        id: new_id,
        name,
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

    let config = load_project_config(&state.projects_dir, &id)?;

    let ps = load_project_persistent_state(&state.projects_dir, &id);
    let mut tracked = HashMap::new();
    let mut log_offsets = HashMap::new();

    for (svc_id, pid) in &ps.running {
        if is_pid_alive(*pid) {
            tracked.insert(svc_id.clone(), TrackedService { pid: *pid });
            let log_path = project_log_file_path(&state.projects_dir, &id, svc_id);
            if let Ok(meta) = fs::metadata(&log_path) {
                log_offsets.insert(svc_id.clone(), meta.len());
            }

            let projects_dir = state.projects_dir.clone();
            let project_id = id.clone();
            let svc_id_clone = svc_id.clone();
            let pid_val = *pid;
            let log_path_clone = log_path.clone();
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    if !is_pid_alive(pid_val) {
                        if let Ok(mut f) = OpenOptions::new().append(true).open(&log_path_clone) {
                            let _ = writeln!(f, "\n--- Process exited (PID {}) ---", pid_val);
                        }
                        let sp = project_state_file_path(&projects_dir, &project_id);
                        if let Ok(s) = fs::read_to_string(&sp) {
                            if let Ok(mut ps) = serde_json::from_str::<PersistentState>(&s) {
                                ps.running.remove(&svc_id_clone);
                                if let Ok(json) = serde_json::to_string_pretty(&ps) {
                                    let _ = fs::write(&sp, json);
                                }
                            }
                        }
                        break;
                    }
                }
            });
        }
    }

    save_project_persistent_state(&state.projects_dir, &id, &tracked);

    {
        let mut projects = state.projects.lock().unwrap();
        projects.insert(id.clone(), ProjectState {
            config,
            tracked,
            log_offsets,
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
fn start_service(project_id: String, id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut projects = state.projects.lock().unwrap();
    let ps = projects.get_mut(&project_id).ok_or("Project not loaded")?;

    let def = find_service(&ps.config, &id).cloned()
        .ok_or_else(|| format!("Unknown service: {}", id))?;

    if ps.tracked.contains_key(&id) {
        return Err(format!("{} is already running", id));
    }

    let shell_path = get_shell_path();
    let log_path = project_log_file_path(&state.projects_dir, &project_id, &id);
    let log_file = OpenOptions::new().create(true).write(true).truncate(true).open(&log_path)
        .map_err(|e| format!("Failed to open log file: {}", e))?;
    let log_file_err = log_file.try_clone().map_err(|e| format!("Clone: {}", e))?;

    ps.log_offsets.insert(id.clone(), 0);

    let cwd = if def.cwd.is_empty() { ".".to_string() } else { def.cwd.clone() };
    let mut cmd = Command::new(&def.command);
    cmd.args(&def.args)
        .current_dir(&cwd)
        .env("PATH", &shell_path)
        .env("FORCE_COLOR", "0")
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_file_err));

    #[cfg(unix)]
    cmd.process_group(0);

    let child = cmd.spawn().map_err(|e| format!("Failed to start {}: {}", def.label, e))?;
    let pid = child.id();

    ps.tracked.insert(id.clone(), TrackedService { pid });
    save_project_persistent_state(&state.projects_dir, &project_id, &ps.tracked);

    drop(projects);

    if let Ok(mut f) = OpenOptions::new().append(true).open(&log_path) {
        let _ = writeln!(f, "Starting {} (PID {})...\n", def.label, pid);
    }

    let projects_dir = state.projects_dir.clone();
    let proj_id = project_id.clone();
    let id_clone = id.clone();
    let log_path_clone = log_path.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
            if !is_pid_alive(pid) {
                if let Ok(mut f) = OpenOptions::new().append(true).open(&log_path_clone) {
                    let _ = writeln!(f, "\n--- Process exited (PID {}) ---", pid);
                }
                let sp = project_state_file_path(&projects_dir, &proj_id);
                if let Ok(s) = fs::read_to_string(&sp) {
                    if let Ok(mut ps) = serde_json::from_str::<PersistentState>(&s) {
                        ps.running.remove(&id_clone);
                        if let Ok(json) = serde_json::to_string_pretty(&ps) {
                            let _ = fs::write(&sp, json);
                        }
                    }
                }
                break;
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn stop_service(project_id: String, id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut projects = state.projects.lock().unwrap();
    let ps = projects.get_mut(&project_id).ok_or("Project not loaded")?;

    let def = find_service(&ps.config, &id).cloned();
    let pid = ps.tracked.get(&id).map(|t| t.pid);

    if let (Some(def), Some(_)) = (&def, pid) {
        if !def.stop_command.is_empty() {
            let shell_path = get_shell_path();
            let (cmd, args) = def.stop_command.split_first().unwrap();
            let cwd = if def.cwd.is_empty() { "." } else { &def.cwd };
            let _ = Command::new(cmd).args(args).current_dir(cwd).env("PATH", &shell_path).output();
        }
    }

    if let Some(pid) = pid {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
            libc::kill(pid as i32, libc::SIGTERM);
        }
        let log_path = project_log_file_path(&state.projects_dir, &project_id, &id);
        if let Ok(mut f) = OpenOptions::new().append(true).open(&log_path) {
            let _ = writeln!(f, "\n--- Stopped by user ---");
        }
    }

    ps.tracked.remove(&id);
    save_project_persistent_state(&state.projects_dir, &project_id, &ps.tracked);

    let log_path = project_log_file_path(&state.projects_dir, &project_id, &id);
    let _ = fs::remove_file(&log_path);
    ps.log_offsets.remove(&id);

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
        for id in &dead { ps.tracked.remove(id); }
        save_project_persistent_state(&state.projects_dir, &project_id, &ps.tracked);
    }

    let svcs = all_services(&ps.config);
    let statuses: Vec<ServiceStatus> = svcs.iter().map(|s| {
        ServiceStatus {
            id: s.id.clone(),
            status: if ps.tracked.contains_key(&s.id) { "running" } else { "stopped" }.to_string(),
        }
    }).collect();

    let mut all_logs: HashMap<String, Vec<String>> = HashMap::new();
    for svc in &svcs {
        if !ps.tracked.contains_key(&svc.id) { continue; }
        let log_path = project_log_file_path(&state.projects_dir, &project_id, &svc.id);
        let lines = tail_log_file(&log_path, &svc.id, &mut ps.log_offsets);
        if !lines.is_empty() {
            all_logs.insert(svc.id.clone(), lines);
        }
    }

    Ok(PollResult { statuses, logs: all_logs })
}

// ---------------------------------------------------------------------------
// Tauri commands: PTY terminals (project-scoped)
// ---------------------------------------------------------------------------

#[tauri::command]
fn create_pty(project_id: String, cols: u16, rows: u16, app: tauri::AppHandle, state: State<'_, AppState>) -> Result<PtyInfo, String> {
    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-l");
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

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
// Main
// ---------------------------------------------------------------------------

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir().expect("failed to get app data dir");
            let _ = fs::create_dir_all(&data_dir);

            migrate_old_config(&data_dir);

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
            git_info,
            git_fetch,
            git_pull,
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

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
        AppConfig {
            groups: vec![ServiceGroup {
                id: "autohive".into(),
                label: "Autohive".into(),
                repo_path: "/Users/onil/Repos/Work/Autohive".into(),
                services: vec![
                    ServiceDef {
                        id: "build".into(),
                        label: "Build Solution".into(),
                        description: "dotnet build".into(),
                        command: "dotnet".into(),
                        args: vec!["build".into()],
                        cwd: "/Users/onil/Repos/Work/Autohive".into(),
                        service_type: "task".into(),
                        stop_command: vec![],
                    },
                    ServiceDef {
                        id: "docker".into(),
                        label: "Docker Compose".into(),
                        description: "PostgreSQL, S3 Mock, Storage, Execution Engine".into(),
                        command: "docker".into(),
                        args: vec!["compose".into(), "up".into()],
                        cwd: "/Users/onil/Repos/Work/Autohive".into(),
                        service_type: "service".into(),
                        stop_command: vec!["docker".into(), "compose".into(), "stop".into()],
                    },
                    ServiceDef {
                        id: "r2platform".into(),
                        label: "R2.Platform".into(),
                        description: "ASP.NET backend — localhost:5001".into(),
                        command: "dotnet".into(),
                        args: vec!["run".into(), "--project".into(), "src/R2.Platform/".into()],
                        cwd: "/Users/onil/Repos/Work/Autohive".into(),
                        service_type: "service".into(),
                        stop_command: vec![],
                    },
                    ServiceDef {
                        id: "rrapp".into(),
                        label: "rr-app".into(),
                        description: "React frontend — localhost:3000".into(),
                        command: "bun".into(),
                        args: vec!["run".into(), "dev".into()],
                        cwd: "/Users/onil/Repos/Work/Autohive/rr-app".into(),
                        service_type: "service".into(),
                        stop_command: vec![],
                    },
                ],
            }],
        }
    }
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

struct AppState {
    config: Mutex<AppConfig>,
    tracked: Mutex<HashMap<String, TrackedService>>,
    log_offsets: Mutex<HashMap<String, u64>>,
    pty_sessions: Mutex<HashMap<String, PtySession>>,
    pty_counter: Mutex<u32>,
    data_dir: PathBuf,
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
// Helpers
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

fn log_file_path(data_dir: &PathBuf, id: &str) -> PathBuf {
    let p = data_dir.join("logs");
    let _ = fs::create_dir_all(&p);
    p.join(format!("{}.log", id))
}

fn state_file_path(data_dir: &PathBuf) -> PathBuf {
    data_dir.join("state.json")
}

fn save_persistent_state(data_dir: &PathBuf, tracked: &HashMap<String, TrackedService>) {
    let ps = PersistentState {
        running: tracked.iter().map(|(k, v)| (k.clone(), v.pid)).collect(),
    };
    if let Ok(json) = serde_json::to_string_pretty(&ps) {
        let _ = fs::write(state_file_path(data_dir), json);
    }
}

fn load_persistent_state(data_dir: &PathBuf) -> PersistentState {
    match fs::read_to_string(state_file_path(data_dir)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => PersistentState::default(),
    }
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

fn save_config_to_disk(config: &AppConfig, data_dir: &PathBuf) -> Result<(), String> {
    let path = data_dir.join("config.json");
    let _ = fs::create_dir_all(data_dir);
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn load_config_from_disk(data_dir: &PathBuf) -> AppConfig {
    let path = data_dir.join("config.json");
    match fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(_) => {
            let config = AppConfig::default();
            let _ = save_config_to_disk(&config, data_dir);
            config
        }
    }
}

fn tail_log_file(data_dir: &PathBuf, id: &str, offsets: &mut HashMap<String, u64>) -> Vec<String> {
    let path = log_file_path(data_dir, id);
    let mut lines = Vec::new();
    let file = match File::open(&path) {
        Ok(f) => f,
        Err(_) => return lines,
    };
    let file_size = match file.metadata() {
        Ok(m) => m.len(),
        Err(_) => return lines,
    };
    let current_offset = offsets.get(id).copied().unwrap_or(0);
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

fn find_service<'a>(config: &'a AppConfig, id: &str) -> Option<&'a ServiceDef> {
    config.groups.iter().flat_map(|g| g.services.iter()).find(|s| s.id == id)
}

fn all_services(config: &AppConfig) -> Vec<&ServiceDef> {
    config.groups.iter().flat_map(|g| g.services.iter()).collect()
}

// ---------------------------------------------------------------------------
// Tauri commands: config
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> AppConfig {
    state.config.lock().unwrap().clone()
}

#[tauri::command]
fn save_config(config: AppConfig, state: State<'_, AppState>) -> Result<(), String> {
    save_config_to_disk(&config, &state.data_dir)?;
    *state.config.lock().unwrap() = config;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands: services
// ---------------------------------------------------------------------------

#[tauri::command]
fn start_service(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let config = state.config.lock().unwrap();
    let def = find_service(&config, &id).cloned()
        .ok_or_else(|| format!("Unknown service: {}", id))?;
    drop(config);

    {
        let tracked = state.tracked.lock().unwrap();
        if tracked.contains_key(&id) {
            return Err(format!("{} is already running", id));
        }
    }

    let shell_path = get_shell_path();
    let log_path = log_file_path(&state.data_dir, &id);
    let log_file = OpenOptions::new().create(true).write(true).truncate(true).open(&log_path)
        .map_err(|e| format!("Failed to open log file: {}", e))?;
    let log_file_err = log_file.try_clone().map_err(|e| format!("Clone: {}", e))?;

    {
        let mut offsets = state.log_offsets.lock().unwrap();
        offsets.insert(id.clone(), 0);
    }

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

    {
        let mut tracked = state.tracked.lock().unwrap();
        tracked.insert(id.clone(), TrackedService { pid });
        save_persistent_state(&state.data_dir, &tracked);
    }

    // Write starting message to log
    if let Ok(mut f) = OpenOptions::new().append(true).open(&log_path) {
        let _ = writeln!(f, "Starting {} (PID {})...\n", def.label, pid);
    }

    // Exit watcher
    let data_dir = state.data_dir.clone();
    let id_clone = id.clone();
    let log_path_clone = log_path.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
            if !is_pid_alive(pid) {
                if let Ok(mut f) = OpenOptions::new().append(true).open(&log_path_clone) {
                    let _ = writeln!(f, "\n--- Process exited (PID {}) ---", pid);
                }
                let sp = state_file_path(&data_dir);
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
fn stop_service(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let config = state.config.lock().unwrap();
    let def = find_service(&config, &id).cloned();
    drop(config);

    let tracked = state.tracked.lock().unwrap();
    let pid = tracked.get(&id).map(|t| t.pid);
    drop(tracked);

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
        let log_path = log_file_path(&state.data_dir, &id);
        if let Ok(mut f) = OpenOptions::new().append(true).open(&log_path) {
            let _ = writeln!(f, "\n--- Stopped by user ---");
        }
    }

    {
        let mut tracked = state.tracked.lock().unwrap();
        tracked.remove(&id);
        save_persistent_state(&state.data_dir, &tracked);
    }
    Ok(())
}

#[tauri::command]
fn poll(state: State<'_, AppState>) -> PollResult {
    let config = state.config.lock().unwrap();

    // Reap dead processes
    {
        let mut tracked = state.tracked.lock().unwrap();
        let dead: Vec<String> = tracked.iter()
            .filter(|(_, t)| !is_pid_alive(t.pid))
            .map(|(k, _)| k.clone())
            .collect();
        if !dead.is_empty() {
            for id in &dead { tracked.remove(id); }
            save_persistent_state(&state.data_dir, &tracked);
        }
    }

    let tracked = state.tracked.lock().unwrap();
    let svcs = all_services(&config);
    let statuses: Vec<ServiceStatus> = svcs.iter().map(|s| {
        ServiceStatus {
            id: s.id.clone(),
            status: if tracked.contains_key(&s.id) { "running" } else { "stopped" }.to_string(),
        }
    }).collect();
    drop(tracked);

    let mut all_logs: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut offsets = state.log_offsets.lock().unwrap();
        for svc in &svcs {
            let lines = tail_log_file(&state.data_dir, &svc.id, &mut offsets);
            if !lines.is_empty() {
                all_logs.insert(svc.id.clone(), lines);
            }
        }
    }
    drop(config);

    PollResult { statuses, logs: all_logs }
}

// ---------------------------------------------------------------------------
// Tauri commands: PTY terminals
// ---------------------------------------------------------------------------

#[tauri::command]
fn create_pty(cols: u16, rows: u16, app: tauri::AppHandle, state: State<'_, AppState>) -> Result<PtyInfo, String> {
    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-l"); // login shell to get full PATH

    // Set terminal capabilities so TUI apps (Claude Code, etc.) use correct escape sequences
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    pair.slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {}", e))?;

    let mut reader = pair.master.try_clone_reader()
        .map_err(|e| format!("Failed to clone reader: {}", e))?;
    let writer = pair.master.take_writer()
        .map_err(|e| format!("Failed to take writer: {}", e))?;

    let mut counter = state.pty_counter.lock().unwrap();
    *counter += 1;
    let pty_id = format!("pty-{}", *counter);
    drop(counter);

    let session = PtySession {
        writer,
        master: pair.master,
    };

    state.pty_sessions.lock().unwrap().insert(pty_id.clone(), session);

    // Spawn a background thread that reads PTY output and pushes it to the frontend via events.
    // This replaces IPC polling — data is streamed as soon as it's available.
    let app_handle = app.clone();
    let pty_id_clone = pty_id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        let mut leftover: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF — PTY closed
                Ok(n) => {
                    // Prepend any leftover bytes from a previous incomplete UTF-8 sequence
                    let mut data = Vec::with_capacity(leftover.len() + n);
                    data.extend_from_slice(&leftover);
                    data.extend_from_slice(&buf[..n]);
                    leftover.clear();

                    // Find the last valid UTF-8 boundary to avoid splitting multi-byte chars
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
                            // Buffer the incomplete trailing bytes for the next read
                            leftover.extend_from_slice(&data[valid_up_to..]);
                        }
                    }
                }
                Err(_) => break, // read error — PTY closed
            }
        }
    });

    Ok(PtyInfo { id: pty_id })
}

#[tauri::command]
fn write_pty(id: String, data: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut sessions = state.pty_sessions.lock().unwrap();
    let session = sessions.get_mut(&id).ok_or("PTY not found")?;
    session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn resize_pty(id: String, cols: u16, rows: u16, state: State<'_, AppState>) -> Result<(), String> {
    let sessions = state.pty_sessions.lock().unwrap();
    let session = sessions.get(&id).ok_or("PTY not found")?;
    session.master.resize(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }).map_err(|e| e.to_string())
}

#[tauri::command]
fn close_pty(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.pty_sessions.lock().unwrap().remove(&id);
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands: Git
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct GitBranchInfo {
    name: String,
    is_current: bool,
    is_remote: bool,
}

#[derive(Serialize)]
struct GitCommitInfo {
    hash: String,
    short_hash: String,
    summary: String,
    author: String,
    time_ago: String,
}

#[derive(Serialize)]
struct GitFileStatus {
    path: String,
    status: String, // "modified", "new", "deleted", "renamed", "typechange"
    staged: bool,
}

#[derive(Serialize)]
struct GitRepoInfo {
    current_branch: String,
    branches: Vec<GitBranchInfo>,
    is_dirty: bool,
    changed_files: Vec<GitFileStatus>,
    recent_commits: Vec<GitCommitInfo>,
}

#[derive(Serialize)]
struct GitPrInfo {
    number: u64,
    title: String,
    author: String,
    branch: String,
    state: String,
    url: String,
    is_draft: bool,
    updated: String,
}

fn format_time_ago(secs: i64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let diff = now - secs;
    if diff < 60 { return "just now".into(); }
    if diff < 3600 { return format!("{}m ago", diff / 60); }
    if diff < 86400 { return format!("{}h ago", diff / 3600); }
    if diff < 604800 { return format!("{}d ago", diff / 86400); }
    format!("{}w ago", diff / 604800)
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

    // Current branch
    let head = repo.head().map_err(|e| format!("No HEAD: {}", e))?;
    let current_branch = head
        .shorthand()
        .unwrap_or("HEAD")
        .to_string();

    // Local branches
    let mut branches = Vec::new();
    let local = repo.branches(Some(git2::BranchType::Local)).map_err(|e| e.to_string())?;
    for branch_result in local {
        let (branch, _) = branch_result.map_err(|e| e.to_string())?;
        if let Some(name) = branch.name().ok().flatten() {
            branches.push(GitBranchInfo {
                name: name.to_string(),
                is_current: name == current_branch,
                is_remote: false,
            });
        }
    }

    // Remote branches
    let remote = repo.branches(Some(git2::BranchType::Remote)).map_err(|e| e.to_string())?;
    for branch_result in remote {
        let (branch, _) = branch_result.map_err(|e| e.to_string())?;
        if let Some(name) = branch.name().ok().flatten() {
            // Skip HEAD pointers like origin/HEAD
            if name.ends_with("/HEAD") { continue; }
            // Skip if a local branch with the same short name exists
            let short = name.splitn(2, '/').nth(1).unwrap_or(name);
            if branches.iter().any(|b| !b.is_remote && b.name == short) { continue; }
            branches.push(GitBranchInfo {
                name: name.to_string(),
                is_current: false,
                is_remote: true,
            });
        }
    }

    // Sort: current first, then local alpha, then remote alpha
    branches.sort_by(|a, b| {
        b.is_current
            .cmp(&a.is_current)
            .then(a.is_remote.cmp(&b.is_remote))
            .then(a.name.cmp(&b.name))
    });

    // File statuses
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

    // Recent commits (last 20)
    let mut recent_commits = Vec::new();
    if let Ok(mut revwalk) = repo.revwalk() {
        let _ = revwalk.push_head();
        revwalk.set_sorting(git2::Sort::TIME).ok();
        for (i, oid) in revwalk.enumerate() {
            if i >= 20 { break; }
            if let Ok(oid) = oid {
                if let Ok(commit) = repo.find_commit(oid) {
                    recent_commits.push(GitCommitInfo {
                        hash: oid.to_string(),
                        short_hash: oid.to_string()[..7].to_string(),
                        summary: commit.summary().unwrap_or("").to_string(),
                        author: commit.author().name().unwrap_or("").to_string(),
                        time_ago: format_time_ago(commit.time().seconds()),
                    });
                }
            }
        }
    }

    Ok(GitRepoInfo {
        current_branch,
        branches,
        is_dirty,
        changed_files,
        recent_commits,
    })
}

#[tauri::command]
fn git_checkout(path: String, branch: String, is_remote: bool) -> Result<(), String> {
    let repo = git2::Repository::open(&path).map_err(|e| format!("Not a git repo: {}", e))?;

    if is_remote {
        // Remote branch: create a local tracking branch and check it out
        let short = branch.splitn(2, '/').nth(1).unwrap_or(&branch);
        let remote_ref = repo
            .find_branch(&branch, git2::BranchType::Remote)
            .map_err(|e| format!("Remote branch '{}' not found: {}", branch, e))?;
        let commit = remote_ref.get().peel_to_commit().map_err(|e| e.to_string())?;

        // Create local branch from remote
        let local_branch = repo
            .branch(short, &commit, false)
            .map_err(|e| format!("Failed to create local branch '{}': {}", short, e))?;

        let obj = local_branch.get().peel(git2::ObjectType::Commit).map_err(|e| e.to_string())?;
        repo.checkout_tree(&obj, Some(git2::build::CheckoutBuilder::new().safe()))
            .map_err(|e| format!("Checkout failed: {}", e))?;
        let refname = local_branch.get().name().ok_or("Invalid ref")?;
        repo.set_head(refname).map_err(|e| e.to_string())?;
    } else {
        let branch_ref = repo
            .find_branch(&branch, git2::BranchType::Local)
            .map_err(|e| format!("Branch '{}' not found: {}", branch, e))?;

        let obj = branch_ref
            .get()
            .peel(git2::ObjectType::Commit)
            .map_err(|e| format!("Cannot resolve branch: {}", e))?;

        repo.checkout_tree(&obj, Some(git2::build::CheckoutBuilder::new().safe()))
            .map_err(|e| format!("Checkout failed: {}", e))?;

        let refname = branch_ref.get().name()
            .ok_or_else(|| "Invalid branch ref name".to_string())?;
        repo.set_head(refname)
            .map_err(|e| format!("Failed to set HEAD: {}", e))?;
    }

    Ok(())
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

#[tauri::command]
fn git_pr_list(path: String) -> Result<Vec<GitPrInfo>, String> {
    let shell_path = get_shell_path();
    let output = Command::new("gh")
        .args([
            "pr", "list",
            "--json", "number,title,author,headRefName,state,url,isDraft,updatedAt",
            "--limit", "30",
        ])
        .current_dir(&path)
        .env("PATH", &shell_path)
        .output()
        .map_err(|e| format!("Failed to run gh: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh pr list failed: {}", stderr));
    }

    let json: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;

    let mut prs = Vec::new();
    if let Some(arr) = json.as_array() {
        for item in arr {
            prs.push(GitPrInfo {
                number: item["number"].as_u64().unwrap_or(0),
                title: item["title"].as_str().unwrap_or("").to_string(),
                author: item["author"]["login"].as_str().unwrap_or("").to_string(),
                branch: item["headRefName"].as_str().unwrap_or("").to_string(),
                state: item["state"].as_str().unwrap_or("").to_string(),
                url: item["url"].as_str().unwrap_or("").to_string(),
                is_draft: item["isDraft"].as_bool().unwrap_or(false),
                updated: item["updatedAt"].as_str().unwrap_or("").to_string(),
            });
        }
    }
    Ok(prs)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir().expect("failed to get app data dir");
            let _ = fs::create_dir_all(&data_dir);

            let config = load_config_from_disk(&data_dir);

            // Reconnect to running processes
            let ps = load_persistent_state(&data_dir);
            let mut tracked = HashMap::new();
            let mut log_offsets = HashMap::new();

            for (id, pid) in &ps.running {
                if is_pid_alive(*pid) {
                    tracked.insert(id.clone(), TrackedService { pid: *pid });
                    let log_path = log_file_path(&data_dir, id);
                    if let Ok(meta) = fs::metadata(&log_path) {
                        log_offsets.insert(id.clone(), meta.len());
                    }

                    let data_dir_clone = data_dir.clone();
                    let id_clone = id.clone();
                    let pid_val = *pid;
                    let log_path_clone = log_path.clone();
                    std::thread::spawn(move || {
                        loop {
                            std::thread::sleep(std::time::Duration::from_secs(1));
                            if !is_pid_alive(pid_val) {
                                if let Ok(mut f) = OpenOptions::new().append(true).open(&log_path_clone) {
                                    let _ = writeln!(f, "\n--- Process exited (PID {}) ---", pid_val);
                                }
                                let sp = state_file_path(&data_dir_clone);
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
                }
            }
            save_persistent_state(&data_dir, &tracked);

            app.manage(AppState {
                config: Mutex::new(config),
                tracked: Mutex::new(tracked),
                log_offsets: Mutex::new(log_offsets),
                pty_sessions: Mutex::new(HashMap::new()),
                pty_counter: Mutex::new(0),
                data_dir,
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
            git_checkout,
            git_fetch,
            git_pull,
            git_pr_list,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state = window.state::<AppState>();
                let tracked = state.tracked.lock().unwrap();
                save_persistent_state(&state.data_dir, &tracked);
                // Don't kill services — they survive
                // But do close PTY sessions
                state.pty_sessions.lock().unwrap().clear();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

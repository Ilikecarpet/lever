# Worktree Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add git worktree support so users can create isolated worktrees per project, each with cloned service groups and scoped workspaces.

**Architecture:** Move `repo_path` from `ServiceGroup` to `ProjectMeta`. Add `WorktreeDef` to `AppConfig` containing cloned groups with rewritten `cwd` paths. Add `worktreeId` to `Workspace` for scoping. New Rust commands for creating/removing worktrees and listing branches. Frontend gets a worktree store, sidebar worktree sections, and workspace filtering.

**Tech Stack:** Rust/Tauri (backend), React/TypeScript/Zustand (frontend), git2 crate (git operations)

---

## File Map

### Files to modify
- `src-tauri/src/main.rs` — Rust structs, helpers, Tauri commands
- `ui/src/types/index.ts` — TypeScript types
- `ui/src/types/pane.ts` — Workspace type
- `ui/src/lib/tauri.ts` — Tauri API bindings
- `ui/src/stores/configStore.ts` — Config store (worktrees array)
- `ui/src/stores/workspaceStore.ts` — Workspace scoping
- `ui/src/stores/gitStore.ts` — Refactor from per-group to project-level
- `ui/src/components/Sidebar/Sidebar.tsx` — New Worktree button, worktree sections
- `ui/src/components/Sidebar/Sidebar.module.css` — Worktree section styles
- `ui/src/components/Sidebar/GroupItem.tsx` — Remove per-group git branch display
- `ui/src/components/Sidebar/GroupItem.module.css` — Remove git branch styles (keep for reuse)
- `ui/src/components/MainPanel/WorkspaceBar.tsx` — Filter by active worktree
- `ui/src/components/MainPanel/GitPanel.tsx` — Use project-level repo_path
- `ui/src/components/MainPanel/MainPanel.tsx` — Pass worktree context
- `ui/src/App.tsx` — Update git polling to use project-level repo_path
- `ui/src/hooks/usePty.ts` — Pass cwd to createPty for worktree-scoped terminals

### Files to create
- `ui/src/stores/worktreeStore.ts` — Worktree state management
- `ui/src/components/Sidebar/WorktreeSection.tsx` — Worktree section divider + groups
- `ui/src/components/Sidebar/WorktreeSection.module.css` — Worktree section styles
- `ui/src/components/Modals/NewWorktreeModal.tsx` — Branch picker + path input dialog
- `ui/src/components/Modals/NewWorktreeModal.module.css` — Modal styles

---

### Task 1: Move `repo_path` from ServiceGroup to ProjectMeta (Rust backend)

**Files:**
- Modify: `src-tauri/src/main.rs:42-56` (ServiceGroup, AppConfig structs)
- Modify: `src-tauri/src/main.rs:68-74` (ProjectMeta struct)
- Modify: `src-tauri/src/main.rs:308-317` (ProjectListEntry struct)

- [ ] **Step 1: Add `repo_path` to `ProjectMeta` and remove from `ServiceGroup`**

In `src-tauri/src/main.rs`, update the `ProjectMeta` struct:

```rust
#[derive(Clone, Serialize, Deserialize)]
struct ProjectMeta {
    id: String,
    name: String,
    #[serde(default)]
    repo_path: String,
    created_at: i64,
    last_opened: i64,
}
```

Remove `repo_path` from `ServiceGroup`:

```rust
#[derive(Clone, Serialize, Deserialize)]
struct ServiceGroup {
    id: String,
    label: String,
    #[serde(default)]
    services: Vec<ServiceDef>,
}
```

- [ ] **Step 2: Add migration helper to `open_project`**

Add a migration function that runs when loading a project config. Find it in `open_project` (around line 506) where `load_project_config` is called. After loading config, check if any group has a `repo_path` field. Since we're removing the field from the struct, we need to handle this at the JSON level.

Add a migration function before the config structs:

```rust
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
        // Remove repo_path from group regardless
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
```

- [ ] **Step 3: Call migration in `open_project` and update `ProjectListEntry`**

In `open_project`, before `load_project_config`, call the migration:

```rust
// Migrate repo_path from groups to project meta if needed
let mut index = load_project_index(&state.projects_dir);
let meta = index.projects.iter_mut().find(|p| p.id == id);
if let Some(meta) = meta {
    if meta.repo_path.is_empty() {
        if let Some(rp) = migrate_repo_path(&state.projects_dir, &id) {
            meta.repo_path = rp;
            let _ = save_project_index(&state.projects_dir, &index);
        }
    }
}
```

Add `repo_path` to `ProjectListEntry`:

```rust
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
```

Update `list_projects` to include `repo_path`:

```rust
entries.push(ProjectListEntry {
    id: meta.id.clone(),
    name: meta.name.clone(),
    repo_path: meta.repo_path.clone(),
    created_at: meta.created_at,
    last_opened: meta.last_opened,
    group_count,
    service_count,
    service_names,
});
```

- [ ] **Step 4: Add `set_repo_path` command**

Add a new Tauri command so the frontend can set/update the project repo path:

```rust
#[tauri::command]
fn set_repo_path(id: String, repo_path: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut index = load_project_index(&state.projects_dir);
    if let Some(meta) = index.projects.iter_mut().find(|p| p.id == id) {
        meta.repo_path = repo_path;
    } else {
        return Err("Project not found".to_string());
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
```

Register both in `invoke_handler`:

```rust
.invoke_handler(tauri::generate_handler![
    // ... existing commands ...
    set_repo_path,
    get_repo_path,
])
```

- [ ] **Step 5: Build and verify**

Run: `cd src-tauri && cargo build 2>&1 | head -50`
Expected: Compiles successfully (warnings about unused fields are OK for now)

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/main.rs
git commit -m "refactor: move repo_path from ServiceGroup to ProjectMeta"
```

---

### Task 2: Update TypeScript types and Tauri API bindings

**Files:**
- Modify: `ui/src/types/index.ts`
- Modify: `ui/src/types/pane.ts`
- Modify: `ui/src/lib/tauri.ts`

- [ ] **Step 1: Update `ServiceGroup` — remove `repo_path`, add `WorktreeDef`, update `AppConfig` and `ProjectMeta`**

In `ui/src/types/index.ts`:

```typescript
export interface ServiceGroup {
  id: string;
  label: string;
  services: ServiceDef[];
}

export interface WorktreeDef {
  id: string;
  branch: string;
  path: string;
  groups: ServiceGroup[];
}

export interface AppConfig {
  groups: ServiceGroup[];
  worktrees: WorktreeDef[];
}

export interface ProjectMeta {
  id: string;
  name: string;
  repo_path: string;
  created_at: number;
  last_opened: number;
  group_count: number;
  service_count: number;
  service_names: string[];
}
```

- [ ] **Step 2: Add `worktreeId` to `Workspace`**

In `ui/src/types/pane.ts`:

```typescript
export interface Workspace {
  id: string;
  label: string;
  root: PaneNode;
  activePaneId: string;
  worktreeId: string | null;
}
```

- [ ] **Step 3: Add new Tauri API bindings**

In `ui/src/lib/tauri.ts`, add new functions and update existing ones:

```typescript
// Add to project management section
export function setRepoPath(id: string, repoPath: string): Promise<void> {
  return invoke<void>("set_repo_path", { id, repoPath });
}

export function getRepoPath(id: string): Promise<string> {
  return invoke<string>("get_repo_path", { id });
}

// Add new worktree commands
export function createWorktree(
  projectId: string,
  branch: string,
  path: string
): Promise<void> {
  return invoke<void>("create_worktree", {
    projectId: projectId,
    branch,
    path,
  });
}

export function removeWorktree(
  projectId: string,
  worktreeId: string,
  cleanup: boolean
): Promise<void> {
  return invoke<void>("remove_worktree", {
    projectId: projectId,
    worktreeId,
    cleanup,
  });
}

export function listBranches(projectId: string): Promise<string[]> {
  return invoke<string[]>("list_branches", { projectId: projectId });
}
```

Also update `createPty` to accept an optional `cwd` parameter:

```typescript
export function createPty(
  cols: number,
  rows: number,
  cwd?: string
): Promise<PtyInfo> {
  return invoke<PtyInfo>("create_pty", {
    projectId: _projectId,
    cols,
    rows,
    cwd: cwd ?? null,
  });
}
```

- [ ] **Step 4: Commit**

```bash
git add ui/src/types/index.ts ui/src/types/pane.ts ui/src/lib/tauri.ts
git commit -m "refactor: update TypeScript types for worktree support"
```

---

### Task 3: Add worktree Rust backend commands

**Files:**
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add `WorktreeDef` struct and update `AppConfig`**

Add after the `ServiceGroup` struct:

```rust
#[derive(Clone, Serialize, Deserialize)]
struct WorktreeDef {
    id: String,
    branch: String,
    path: String,
    groups: Vec<ServiceGroup>,
}
```

Update `AppConfig`:

```rust
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
```

- [ ] **Step 2: Update `find_service` and `all_services` helpers to include worktree services**

```rust
fn find_service<'a>(config: &'a AppConfig, id: &str) -> Option<&'a ServiceDef> {
    config
        .groups
        .iter()
        .flat_map(|g| g.services.iter())
        .chain(
            config
                .worktrees
                .iter()
                .flat_map(|w| w.groups.iter().flat_map(|g| g.services.iter())),
        )
        .find(|s| s.id == id)
}

fn all_services(config: &AppConfig) -> Vec<&ServiceDef> {
    config
        .groups
        .iter()
        .flat_map(|g| g.services.iter())
        .chain(
            config
                .worktrees
                .iter()
                .flat_map(|w| w.groups.iter().flat_map(|g| g.services.iter())),
        )
        .collect()
}
```

- [ ] **Step 3: Add `list_branches` command**

```rust
#[tauri::command]
fn list_branches(project_id: String, state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let index = load_project_index(&state.projects_dir);
    let meta = index
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or("Project not found")?;

    if meta.repo_path.is_empty() {
        return Err("No repository path set for this project".to_string());
    }

    let repo =
        git2::Repository::open(&meta.repo_path).map_err(|e| format!("Not a git repo: {}", e))?;

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
```

- [ ] **Step 4: Add `create_worktree` command**

```rust
fn sanitize_branch_for_path(branch: &str) -> String {
    branch
        .replace('/', "-")
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

#[tauri::command]
fn create_worktree(
    project_id: String,
    branch: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<WorktreeDef, String> {
    let index = load_project_index(&state.projects_dir);
    let meta = index
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or("Project not found")?;

    if meta.repo_path.is_empty() {
        return Err("No repository path set for this project".to_string());
    }

    let repo_path = &meta.repo_path;

    // Check if branch exists locally
    let repo =
        git2::Repository::open(repo_path).map_err(|e| format!("Not a git repo: {}", e))?;
    let branch_exists = repo.find_branch(&branch, git2::BranchType::Local).is_ok();

    // Run git worktree add
    let shell_path = get_shell_path();
    let args = if branch_exists {
        vec!["worktree".to_string(), "add".to_string(), path.clone(), branch.clone()]
    } else {
        vec![
            "worktree".to_string(),
            "add".to_string(),
            "-b".to_string(),
            branch.clone(),
            path.clone(),
        ]
    };

    let output = Command::new("git")
        .args(&args)
        .current_dir(repo_path)
        .env("PATH", &shell_path)
        .output()
        .map_err(|e| format!("Failed to run git worktree add: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree add failed: {}", stderr));
    }

    // Clone groups with rewritten cwd
    let mut projects = state.projects.lock().unwrap();
    let ps = projects
        .get_mut(&project_id)
        .ok_or("Project not loaded")?;

    let worktree_id = format!(
        "wt-{}-{}",
        sanitize_branch_for_path(&branch),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            % 100000
    );

    let cloned_groups: Vec<ServiceGroup> = ps
        .config
        .groups
        .iter()
        .map(|g| {
            let cloned_services: Vec<ServiceDef> = g
                .services
                .iter()
                .map(|s| {
                    let new_cwd = if s.cwd.starts_with(repo_path) {
                        s.cwd.replacen(repo_path, &path, 1)
                    } else {
                        // If cwd doesn't start with repo root, prefix with worktree path
                        if s.cwd.is_empty() {
                            path.clone()
                        } else {
                            format!("{}/{}", path, s.cwd)
                        }
                    };
                    let new_id = format!("{}-{}", s.id, worktree_id);
                    ServiceDef {
                        id: new_id,
                        label: s.label.clone(),
                        description: s.description.clone(),
                        command: s.command.clone(),
                        args: s.args.clone(),
                        cwd: new_cwd,
                        service_type: s.service_type.clone(),
                        stop_command: s.stop_command.clone(),
                    }
                })
                .collect();
            ServiceGroup {
                id: format!("{}-{}", g.id, worktree_id),
                label: g.label.clone(),
                services: cloned_services,
            }
        })
        .collect();

    let worktree_def = WorktreeDef {
        id: worktree_id,
        branch,
        path,
        groups: cloned_groups,
    };

    ps.config.worktrees.push(worktree_def.clone());
    save_project_config(&state.projects_dir, &project_id, &ps.config)?;

    Ok(worktree_def)
}
```

- [ ] **Step 5: Add `remove_worktree` command**

```rust
#[tauri::command]
fn remove_worktree(
    project_id: String,
    worktree_id: String,
    cleanup: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut projects = state.projects.lock().unwrap();
    let ps = projects
        .get_mut(&project_id)
        .ok_or("Project not loaded")?;

    let worktree = ps
        .config
        .worktrees
        .iter()
        .find(|w| w.id == worktree_id)
        .cloned()
        .ok_or("Worktree not found")?;

    // Stop all running services in the worktree
    let wt_service_ids: Vec<String> = worktree
        .groups
        .iter()
        .flat_map(|g| g.services.iter().map(|s| s.id.clone()))
        .collect();

    for svc_id in &wt_service_ids {
        if let Some(tracked) = ps.tracked.remove(svc_id) {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(tracked.pid as i32), libc::SIGTERM);
                libc::kill(tracked.pid as i32, libc::SIGTERM);
            }
        }
        ps.log_offsets.remove(svc_id);
    }

    save_project_persistent_state(&state.projects_dir, &project_id, &ps.tracked);

    // Remove worktree from config
    ps.config.worktrees.retain(|w| w.id != worktree_id);
    save_project_config(&state.projects_dir, &project_id, &ps.config)?;

    // Optionally remove from disk
    if cleanup {
        let shell_path = get_shell_path();
        let index = load_project_index(&state.projects_dir);
        let meta = index.projects.iter().find(|p| p.id == project_id);
        if let Some(meta) = meta {
            if !meta.repo_path.is_empty() {
                let output = Command::new("git")
                    .args(["worktree", "remove", "--force", &worktree.path])
                    .current_dir(&meta.repo_path)
                    .env("PATH", &shell_path)
                    .output();
                if let Ok(output) = output {
                    if !output.status.success() {
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        return Err(format!(
                            "Worktree removed from config but git cleanup failed: {}",
                            stderr
                        ));
                    }
                }
            }
        }
    }

    Ok(())
}
```

- [ ] **Step 6: Update `create_pty` to accept optional `cwd`**

Update the `create_pty` command signature and body:

```rust
#[tauri::command]
fn create_pty(
    project_id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<PtyInfo, String> {
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
    cmd.arg("-l");
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    if let Some(ref cwd_path) = cwd {
        if !cwd_path.is_empty() {
            cmd.cwd(cwd_path);
        }
    }

    pair.slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {}", e))?;
    // ... rest unchanged
```

- [ ] **Step 7: Register new commands in invoke_handler**

Update the `invoke_handler` in `main()`:

```rust
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
    set_repo_path,
    get_repo_path,
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
    list_branches,
    create_worktree,
    remove_worktree,
])
```

- [ ] **Step 8: Build and verify**

Run: `cd src-tauri && cargo build 2>&1 | head -50`
Expected: Compiles successfully

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/main.rs
git commit -m "feat: add worktree backend commands (create, remove, list_branches)"
```

---

### Task 4: Create worktree store (frontend)

**Files:**
- Create: `ui/src/stores/worktreeStore.ts`

- [ ] **Step 1: Create the worktree store**

```typescript
import { create } from "zustand";
import type { WorktreeDef } from "../types";
import * as api from "../lib/tauri";

interface WorktreeState {
  worktrees: WorktreeDef[];
  activeWorktreeId: string | null;

  setWorktrees: (worktrees: WorktreeDef[]) => void;
  setActiveWorktree: (id: string | null) => void;
  addWorktree: (worktree: WorktreeDef) => void;
  removeWorktree: (id: string) => void;

  createWorktree: (branch: string, path: string) => Promise<WorktreeDef>;
  deleteWorktree: (worktreeId: string, cleanup: boolean) => Promise<void>;
}

export const useWorktreeStore = create<WorktreeState>((set, get) => ({
  worktrees: [],
  activeWorktreeId: null,

  setWorktrees: (worktrees) => set({ worktrees }),

  setActiveWorktree: (id) => set({ activeWorktreeId: id }),

  addWorktree: (worktree) =>
    set((s) => ({ worktrees: [...s.worktrees, worktree] })),

  removeWorktree: (id) =>
    set((s) => ({
      worktrees: s.worktrees.filter((w) => w.id !== id),
      activeWorktreeId: s.activeWorktreeId === id ? null : s.activeWorktreeId,
    })),

  createWorktree: async (branch, path) => {
    const projectId = api.getProjectId();
    if (!projectId) throw new Error("No project ID");
    const worktree = await api.createWorktree(projectId, branch, path);
    get().addWorktree(worktree);
    return worktree;
  },

  deleteWorktree: async (worktreeId, cleanup) => {
    const projectId = api.getProjectId();
    if (!projectId) throw new Error("No project ID");
    await api.removeWorktree(projectId, worktreeId, cleanup);
    get().removeWorktree(worktreeId);
  },
}));
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/stores/worktreeStore.ts
git commit -m "feat: add worktree Zustand store"
```

---

### Task 5: Update configStore for worktrees

**Files:**
- Modify: `ui/src/stores/configStore.ts`

- [ ] **Step 1: Add worktrees to config store state and load/save**

```typescript
import { create } from "zustand";
import type { AppConfig, ServiceDef, ServiceGroup, WorktreeDef } from "../types";
import * as api from "../lib/tauri";
import { useWorktreeStore } from "./worktreeStore";

interface ConfigState {
  groups: ServiceGroup[];
  loaded: boolean;

  loadConfig: () => Promise<void>;
  saveConfig: () => Promise<void>;

  addGroup: (group: ServiceGroup) => void;
  removeGroup: (groupId: string) => void;
  updateGroup: (groupId: string, patch: Partial<ServiceGroup>) => void;

  addService: (groupId: string, service: ServiceDef) => void;
  updateService: (
    groupId: string,
    serviceId: string,
    patch: Partial<ServiceDef>
  ) => void;
  moveService: (serviceId: string, fromGroupId: string, toGroupId: string) => void;
  removeService: (groupId: string, serviceId: string) => void;
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  groups: [],
  loaded: false,

  loadConfig: async () => {
    try {
      const config = await api.getConfig();
      set({ groups: config.groups, loaded: true });
      useWorktreeStore.getState().setWorktrees(config.worktrees ?? []);
    } catch {
      set({ groups: [], loaded: true });
    }
  },

  saveConfig: async () => {
    const worktrees = useWorktreeStore.getState().worktrees;
    const config: AppConfig = { groups: get().groups, worktrees };
    await api.saveConfig(config);
  },

  // ... rest of the methods stay the same, just remove repo_path from addGroup default
  addGroup: (group) => {
    set((s) => ({ groups: [...s.groups, group] }));
  },

  removeGroup: (groupId) => {
    set((s) => ({ groups: s.groups.filter((g) => g.id !== groupId) }));
  },

  updateGroup: (groupId, patch) => {
    set((s) => ({
      groups: s.groups.map((g) =>
        g.id === groupId ? { ...g, ...patch } : g
      ),
    }));
  },

  addService: (groupId, service) => {
    set((s) => ({
      groups: s.groups.map((g) =>
        g.id === groupId
          ? { ...g, services: [...g.services, service] }
          : g
      ),
    }));
  },

  updateService: (groupId, serviceId, patch) => {
    set((s) => ({
      groups: s.groups.map((g) =>
        g.id === groupId
          ? {
              ...g,
              services: g.services.map((svc) =>
                svc.id === serviceId ? { ...svc, ...patch } : svc
              ),
            }
          : g
      ),
    }));
  },

  moveService: (serviceId, fromGroupId, toGroupId) => {
    const groups = get().groups;
    const fromGroup = groups.find((g) => g.id === fromGroupId);
    if (!fromGroup) return;

    const service = fromGroup.services.find((s) => s.id === serviceId);
    if (!service) return;

    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.id === fromGroupId) {
          return { ...g, services: g.services.filter((svc) => svc.id !== serviceId) };
        }
        if (g.id === toGroupId) {
          return { ...g, services: [...g.services, service] };
        }
        return g;
      }),
    }));
  },

  removeService: (groupId, serviceId) => {
    set((s) => ({
      groups: s.groups.map((g) =>
        g.id === groupId
          ? { ...g, services: g.services.filter((svc) => svc.id !== serviceId) }
          : g
      ),
    }));
  },
}));
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/stores/configStore.ts
git commit -m "refactor: configStore loads/saves worktrees via worktreeStore"
```

---

### Task 6: Refactor gitStore to project-level

**Files:**
- Modify: `ui/src/stores/gitStore.ts`

- [ ] **Step 1: Simplify gitStore to use a single project-level repo path**

The git store currently tracks git info per group. Simplify it to track a single project-level git info, plus optionally per-worktree info.

```typescript
import { create } from "zustand";
import type { GitRepoInfo } from "../types";
import * as api from "../lib/tauri";

interface GitState {
  repoPath: string;
  gitInfo: GitRepoInfo | null;
  worktreeGitInfo: Record<string, GitRepoInfo>;
  activeGitGroupId: string | null;
  statusMessage: string | null;

  setRepoPath: (path: string) => void;
  refreshGitInfo: () => Promise<void>;
  refreshWorktreeGitInfo: (worktreeId: string, worktreePath: string) => Promise<void>;
  fetch: () => Promise<void>;
  pull: () => Promise<void>;
  setActiveGitGroup: (groupId: string | null) => void;
  setStatusMessage: (msg: string | null) => void;
}

function autoClearStatus(set: (partial: Partial<GitState>) => void) {
  setTimeout(() => {
    set({ statusMessage: null });
  }, 3500);
}

export const useGitStore = create<GitState>((set, get) => ({
  repoPath: "",
  gitInfo: null,
  worktreeGitInfo: {},
  activeGitGroupId: null,
  statusMessage: null,

  setRepoPath: (path) => set({ repoPath: path }),

  refreshGitInfo: async () => {
    const { repoPath } = get();
    if (!repoPath) return;
    try {
      const info = await api.gitInfo(repoPath);
      set({ gitInfo: info });
    } catch (e) {
      console.error("Failed to get git info:", e);
    }
  },

  refreshWorktreeGitInfo: async (worktreeId, worktreePath) => {
    if (!worktreePath) return;
    try {
      const info = await api.gitInfo(worktreePath);
      set((s) => ({
        worktreeGitInfo: { ...s.worktreeGitInfo, [worktreeId]: info },
      }));
    } catch (e) {
      console.error(`Failed to get worktree git info for ${worktreeId}:`, e);
    }
  },

  fetch: async () => {
    const { repoPath } = get();
    if (!repoPath) return;
    try {
      set({ statusMessage: "Fetching..." });
      await api.gitFetch(repoPath);
      await get().refreshGitInfo();
      set({ statusMessage: "Fetch complete" });
      autoClearStatus(set);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ statusMessage: `Fetch failed: ${msg}` });
      autoClearStatus(set);
    }
  },

  pull: async () => {
    const { repoPath } = get();
    if (!repoPath) return;
    try {
      set({ statusMessage: "Pulling..." });
      const result = await api.gitPull(repoPath);
      await get().refreshGitInfo();
      const summary = result.trim().split("\n")[0] || "Pull complete";
      set({ statusMessage: summary });
      autoClearStatus(set);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ statusMessage: `Pull failed: ${msg}` });
      autoClearStatus(set);
    }
  },

  setActiveGitGroup: (groupId) => {
    set({ activeGitGroupId: groupId });
  },

  setStatusMessage: (msg) => {
    set({ statusMessage: msg });
    if (msg) autoClearStatus(set);
  },
}));
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/stores/gitStore.ts
git commit -m "refactor: gitStore uses project-level repo_path instead of per-group"
```

---

### Task 7: Update workspace store for worktree scoping

**Files:**
- Modify: `ui/src/stores/workspaceStore.ts`

- [ ] **Step 1: Add `worktreeId` to workspace creation and filtering**

Update `createWorkspace` to accept an optional `worktreeId`:

```typescript
function createWorkspace(
  label: string,
  worktreeId: string | null = null
): Workspace {
  const leaf = makeLeaf();
  return {
    id: nextId("ws"),
    label,
    root: leaf,
    activePaneId: leaf.id,
    worktreeId,
  };
}
```

Add `addWorkspaceForWorktree` and `closeWorktreeWorkspaces` to the store interface and implementation:

Add to the `WorkspaceState` interface:

```typescript
addWorkspaceForWorktree: (worktreeId: string) => string;
closeWorktreeWorkspaces: (worktreeId: string) => void;
```

Add implementations:

```typescript
addWorkspaceForWorktree: (worktreeId) => {
  const allWs = get().workspaces;
  const wtWorkspaces = allWs.filter((w) => w.worktreeId === worktreeId);
  const ws = createWorkspace(nextWorkspaceName(wtWorkspaces), worktreeId);
  set((s) => ({
    workspaces: [...s.workspaces, ws],
    activeWorkspaceId: ws.id,
  }));
  return ws.id;
},

closeWorktreeWorkspaces: (worktreeId) => {
  const toClose = get().workspaces.filter(
    (w) => w.worktreeId === worktreeId
  );
  for (const ws of toClose) {
    collectLeaves(ws.root).forEach((leaf) => destroyPty(leaf.id));
  }
  set((s) => {
    const workspaces = s.workspaces.filter(
      (w) => w.worktreeId !== worktreeId
    );
    let activeWorkspaceId = s.activeWorkspaceId;
    if (toClose.some((w) => w.id === activeWorkspaceId)) {
      activeWorkspaceId = workspaces[0]?.id ?? null;
    }
    return { workspaces, activeWorkspaceId };
  });
},
```

Also update the existing `addWorkspace` to explicitly pass `null`:

```typescript
addWorkspace: () => {
  const ws = createWorkspace(nextWorkspaceName(get().workspaces), null);
  set((s) => ({
    workspaces: [...s.workspaces, ws],
    activeWorkspaceId: ws.id,
  }));
  return ws.id;
},
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/stores/workspaceStore.ts
git commit -m "feat: workspace store supports worktree scoping"
```

---

### Task 8: Update App.tsx — project-level git polling

**Files:**
- Modify: `ui/src/App.tsx`

- [ ] **Step 1: Replace per-group git polling with project-level**

```typescript
import { useEffect, useRef, useState } from "react";
import { initProjectId, getProjectId } from "./lib/tauri";
import * as api from "./lib/tauri";
import { useConfigStore } from "./stores/configStore";
import { useServiceStore } from "./stores/serviceStore";
import { useGitStore } from "./stores/gitStore";
import { useWorktreeStore } from "./stores/worktreeStore";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import Sidebar from "./components/Sidebar/Sidebar";
import MainPanel from "./components/MainPanel/MainPanel";
import StatusBar from "./components/StatusBar/StatusBar";
import ConfigModal from "./components/Modals/ConfigModal";
import StartPage from "./components/StartPage/StartPage";
import styles from "./App.module.css";

const projectId = initProjectId();

function ProjectApp() {
  const loaded = useConfigStore((s) => s.loaded);
  const loadConfig = useConfigStore((s) => s.loadConfig);
  const poll = useServiceStore((s) => s.poll);
  const setRepoPath = useGitStore((s) => s.setRepoPath);
  const refreshGitInfo = useGitStore((s) => s.refreshGitInfo);
  const refreshWorktreeGitInfo = useGitStore((s) => s.refreshWorktreeGitInfo);
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const initialized = useRef(false);

  useKeyboardShortcuts();

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    if (!loaded || initialized.current) return;
    initialized.current = true;

    addWorkspace();

    // Load project repo path and init git
    const pid = getProjectId();
    if (pid) {
      api.getRepoPath(pid).then((rp) => {
        if (rp) {
          setRepoPath(rp);
          refreshGitInfo();
        }
      });
    }

    const servicePollId = setInterval(poll, 300);

    const gitPollId = setInterval(() => {
      const repoPath = useGitStore.getState().repoPath;
      if (repoPath) {
        useGitStore.getState().refreshGitInfo();
        // Also refresh worktree git info
        const worktrees = useWorktreeStore.getState().worktrees;
        for (const wt of worktrees) {
          useGitStore
            .getState()
            .refreshWorktreeGitInfo(wt.id, wt.path);
        }
      }
    }, 5000);

    return () => {
      clearInterval(servicePollId);
      clearInterval(gitPollId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  return (
    <>
      <div className={styles.layout}>
        <Sidebar onOpenSettings={() => setSettingsOpen(true)} />
        <MainPanel />
      </div>
      <StatusBar />
      {settingsOpen && (
        <ConfigModal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </>
  );
}

export default function App() {
  if (projectId) {
    return <ProjectApp />;
  }
  return <StartPage />;
}
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/App.tsx
git commit -m "refactor: App.tsx uses project-level git polling"
```

---

### Task 9: Update GroupItem — remove per-group git branch

**Files:**
- Modify: `ui/src/components/Sidebar/GroupItem.tsx`

- [ ] **Step 1: Remove git branch display from GroupItem**

```typescript
import { useState } from "react";
import type { ServiceGroup } from "../../types";
import { useServiceStore } from "../../stores/serviceStore";
import ServiceItem from "./ServiceItem";
import styles from "./GroupItem.module.css";

interface Props {
  group: ServiceGroup;
}

export default function GroupItem({ group }: Props) {
  const [collapsed, setCollapsed] = useState(false);

  const statuses = useServiceStore((s) => s.statuses);
  const startService = useServiceStore((s) => s.startService);
  const stopService = useServiceStore((s) => s.stopService);

  const runningCount = group.services.filter(
    (svc) => (statuses[svc.id] ?? "stopped") === "running"
  ).length;

  const handleStartAll = async (e: React.MouseEvent) => {
    e.stopPropagation();
    for (const svc of group.services) {
      if (svc.service_type === "task") continue;
      if ((statuses[svc.id] ?? "stopped") === "running") continue;
      await startService(svc.id);
    }
  };

  const handleStopAll = async (e: React.MouseEvent) => {
    e.stopPropagation();
    for (const svc of [...group.services].reverse()) {
      if ((statuses[svc.id] ?? "stopped") === "running") {
        await stopService(svc.id);
      }
    }
  };

  return (
    <div className={styles.group}>
      <div
        className={styles.groupHeader}
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className={styles.groupLabel}>
          <span
            className={`${styles.groupChevron}${collapsed ? ` ${styles.groupChevronCollapsed}` : ""}`}
          >
            &#9660;
          </span>
          {group.label}{" "}
          <span className={styles.groupCount}>
            {runningCount}/{group.services.length}
          </span>
        </span>
        <div className={styles.groupActions}>
          <button
            className={`${styles.groupBtn} ${styles.groupBtnStart}`}
            onClick={handleStartAll}
            title="Start all"
          >
            &#9654;
          </button>
          <button
            className={`${styles.groupBtn} ${styles.groupBtnStop}`}
            onClick={handleStopAll}
            title="Stop all"
          >
            &#9724;
          </button>
        </div>
      </div>

      <div
        className={`${styles.groupServices}${collapsed ? ` ${styles.groupServicesCollapsed}` : ""}`}
      >
        {group.services.map((svc) => (
          <ServiceItem key={svc.id} service={svc} />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/components/Sidebar/GroupItem.tsx
git commit -m "refactor: remove per-group git branch from GroupItem"
```

---

### Task 10: Create NewWorktreeModal component

**Files:**
- Create: `ui/src/components/Modals/NewWorktreeModal.tsx`
- Create: `ui/src/components/Modals/NewWorktreeModal.module.css`

- [ ] **Step 1: Create the modal CSS**

```css
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
}

.modal {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 24px;
  width: 420px;
  max-width: 90vw;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}

.title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 16px;
}

.field {
  margin-bottom: 14px;
}

.label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 6px;
}

.input {
  width: 100%;
  background: var(--terminal-bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font-size: 13px;
  padding: 8px 10px;
  outline: none;
  font-family: "SF Mono", "JetBrains Mono", monospace;
}
.input:focus {
  border-color: var(--blue);
}

.suggestions {
  position: absolute;
  z-index: 10;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  max-height: 160px;
  overflow-y: auto;
  margin-top: 2px;
  width: calc(100% - 48px);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}

.suggestion {
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text);
  cursor: pointer;
  font-family: "SF Mono", "JetBrains Mono", monospace;
}
.suggestion:hover {
  background: var(--surface-hover);
}

.actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 20px;
}

.btn {
  padding: 7px 16px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.1s;
}

.btnCancel {
  color: var(--text-dim);
  background: var(--surface-hover);
  border: 1px solid var(--border);
}
.btnCancel:hover {
  background: var(--border);
}

.btnCreate {
  color: #fff;
  background: var(--blue);
  border: 1px solid var(--blue);
}
.btnCreate:hover {
  opacity: 0.9;
}
.btnCreate:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.error {
  color: var(--red);
  font-size: 12px;
  margin-top: 8px;
}
```

- [ ] **Step 2: Create the modal component**

```typescript
import { useState, useEffect, useRef } from "react";
import * as api from "../../lib/tauri";
import { useGitStore } from "../../stores/gitStore";
import styles from "./NewWorktreeModal.module.css";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreate: (branch: string, path: string) => Promise<void>;
}

function sanitizeBranchForPath(branch: string): string {
  return branch
    .replace(/\//g, "-")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export default function NewWorktreeModal({ open, onClose, onCreate }: Props) {
  const repoPath = useGitStore((s) => s.repoPath);
  const [branch, setBranch] = useState("");
  const [path, setPath] = useState("");
  const [pathEdited, setPathEdited] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setBranch("");
    setPath("");
    setPathEdited(false);
    setError("");
    setCreating(false);

    const pid = api.getProjectId();
    if (pid) {
      api.listBranches(pid).then(setBranches).catch(() => setBranches([]));
    }

    setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  // Auto-populate path when branch changes (unless user has edited it)
  useEffect(() => {
    if (!pathEdited && branch && repoPath) {
      const sanitized = sanitizeBranchForPath(branch);
      setPath(`${repoPath}-worktrees/${sanitized}`);
    }
  }, [branch, repoPath, pathEdited]);

  if (!open) return null;

  const filteredBranches = branch
    ? branches.filter(
        (b) =>
          b.toLowerCase().includes(branch.toLowerCase()) && b !== branch
      )
    : branches;

  const handleCreate = async () => {
    if (!branch.trim() || !path.trim()) return;
    setCreating(true);
    setError("");
    try {
      await onCreate(branch.trim(), path.trim());
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCreating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleCreate();
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className={styles.title}>New Worktree</div>

        <div className={styles.field}>
          <div className={styles.label}>Branch</div>
          <input
            ref={inputRef}
            className={styles.input}
            placeholder="feature/my-branch"
            value={branch}
            onChange={(e) => {
              setBranch(e.target.value);
              setShowSuggestions(true);
            }}
            onFocus={() => setShowSuggestions(true)}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
          />
          {showSuggestions && filteredBranches.length > 0 && (
            <div className={styles.suggestions}>
              {filteredBranches.slice(0, 10).map((b) => (
                <div
                  key={b}
                  className={styles.suggestion}
                  onMouseDown={() => {
                    setBranch(b);
                    setShowSuggestions(false);
                  }}
                >
                  {b}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className={styles.field}>
          <div className={styles.label}>Path</div>
          <input
            className={styles.input}
            placeholder="/path/to/worktree"
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              setPathEdited(true);
            }}
          />
        </div>

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.actions}>
          <button
            className={`${styles.btn} ${styles.btnCancel}`}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className={`${styles.btn} ${styles.btnCreate}`}
            onClick={handleCreate}
            disabled={!branch.trim() || !path.trim() || creating}
          >
            {creating ? "Creating..." : "Create Worktree"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/Modals/NewWorktreeModal.tsx ui/src/components/Modals/NewWorktreeModal.module.css
git commit -m "feat: add NewWorktreeModal component with branch autocomplete"
```

---

### Task 11: Create WorktreeSection sidebar component

**Files:**
- Create: `ui/src/components/Sidebar/WorktreeSection.tsx`
- Create: `ui/src/components/Sidebar/WorktreeSection.module.css`

- [ ] **Step 1: Create WorktreeSection CSS**

```css
.sectionDivider {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px 4px;
  font-size: 11px;
  color: var(--blue);
  font-weight: 600;
  letter-spacing: 0.04em;
  cursor: pointer;
  user-select: none;
}
.sectionDivider:hover {
  background: var(--surface-hover);
}

.branchIcon {
  font-size: 12px;
}

.branchName {
  font-family: "SF Mono", "JetBrains Mono", monospace;
  font-size: 11px;
}

.worktreePath {
  font-size: 10px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 120px;
}

.sectionActions {
  margin-left: auto;
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;
}
.sectionDivider:hover .sectionActions {
  opacity: 1;
}

.removeBtn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 3px;
  color: var(--red);
}
.removeBtn:hover {
  background: var(--red-dim);
}

.worktreeGroup {
  border-left: 3px solid var(--blue);
}

.contextMenu {
  position: fixed;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px 0;
  z-index: 1000;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  min-width: 160px;
}

.contextMenuItem {
  display: block;
  width: 100%;
  text-align: left;
  padding: 7px 12px;
  font-size: 12px;
  color: var(--text);
  cursor: pointer;
  background: none;
  border: none;
}
.contextMenuItem:hover {
  background: var(--surface-hover);
}

.contextMenuDanger {
  color: var(--red);
}
```

- [ ] **Step 2: Create WorktreeSection component**

```typescript
import { useState } from "react";
import type { WorktreeDef } from "../../types";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import GroupItem from "./GroupItem";
import styles from "./WorktreeSection.module.css";

interface Props {
  worktree: WorktreeDef;
}

interface ContextMenu {
  x: number;
  y: number;
}

export default function WorktreeSection({ worktree }: Props) {
  const activeWorktreeId = useWorktreeStore((s) => s.activeWorktreeId);
  const setActiveWorktree = useWorktreeStore((s) => s.setActiveWorktree);
  const deleteWorktree = useWorktreeStore((s) => s.deleteWorktree);
  const closeWorktreeWorkspaces = useWorkspaceStore(
    (s) => s.closeWorktreeWorkspaces
  );
  const addWorkspaceForWorktree = useWorkspaceStore(
    (s) => s.addWorkspaceForWorktree
  );
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);

  const isActive = activeWorktreeId === worktree.id;

  const handleClick = () => {
    if (isActive) return;
    setActiveWorktree(worktree.id);
    // Ensure at least one workspace exists for this worktree
    const workspaces = useWorkspaceStore.getState().workspaces;
    const hasWtWorkspace = workspaces.some(
      (w) => w.worktreeId === worktree.id
    );
    if (!hasWtWorkspace) {
      addWorkspaceForWorktree(worktree.id);
    } else {
      const first = workspaces.find((w) => w.worktreeId === worktree.id);
      if (first) {
        useWorkspaceStore.getState().setActiveWorkspace(first.id);
      }
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleRemove = async (cleanup: boolean) => {
    setContextMenu(null);
    closeWorktreeWorkspaces(worktree.id);
    try {
      await deleteWorktree(worktree.id, cleanup);
    } catch (e) {
      console.error("Failed to remove worktree:", e);
    }
  };

  // Shorten the path for display
  const shortPath = worktree.path.replace(/^\/Users\/[^/]+/, "~");

  return (
    <>
      <div
        className={styles.sectionDivider}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        style={{ opacity: isActive ? 1 : 0.7 }}
      >
        <span className={styles.branchIcon}>&#9579;</span>
        <span className={styles.branchName}>{worktree.branch}</span>
        <span className={styles.worktreePath}>{shortPath}</span>
      </div>

      {worktree.groups.map((group) => (
        <div key={group.id} className={styles.worktreeGroup}>
          <GroupItem group={group} />
        </div>
      ))}

      {contextMenu && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 999 }}
            onClick={() => setContextMenu(null)}
          />
          <div
            className={styles.contextMenu}
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              className={styles.contextMenuItem}
              onClick={() => handleRemove(false)}
            >
              Remove from sidebar
            </button>
            <button
              className={`${styles.contextMenuItem} ${styles.contextMenuDanger}`}
              onClick={() => handleRemove(true)}
            >
              Remove + delete from disk
            </button>
          </div>
        </>
      )}
    </>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/Sidebar/WorktreeSection.tsx ui/src/components/Sidebar/WorktreeSection.module.css
git commit -m "feat: add WorktreeSection sidebar component"
```

---

### Task 12: Update Sidebar — git info, worktree sections, new worktree button

**Files:**
- Modify: `ui/src/components/Sidebar/Sidebar.tsx`
- Modify: `ui/src/components/Sidebar/Sidebar.module.css`

- [ ] **Step 1: Add worktree section styles to Sidebar.module.css**

Append to `Sidebar.module.css`:

```css
.mainContext {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  font-size: 11px;
  color: var(--text-dim);
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  user-select: none;
}
.mainContext:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.mainContextActive {
  color: var(--blue);
}

.mainContextDot {
  font-size: 8px;
}

.mainContextBranch {
  font-family: "SF Mono", "JetBrains Mono", monospace;
  font-size: 11px;
}

.mainContextDirty {
  color: var(--yellow);
  font-size: 9px;
  margin-left: 2px;
}

.bottomBar {
  display: flex;
  gap: 12px;
  padding: 8px 14px;
}

.newWorktreeBtn {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--blue);
  cursor: pointer;
  border: none;
  background: none;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 0;
}
.newWorktreeBtn:hover {
  opacity: 0.8;
}
.newWorktreeBtn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
```

- [ ] **Step 2: Update Sidebar.tsx**

```typescript
import { useState, useRef, useEffect } from "react";
import { useConfigStore } from "../../stores/configStore";
import { useGitStore } from "../../stores/gitStore";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import * as api from "../../lib/tauri";
import GroupItem from "./GroupItem";
import WorktreeSection from "./WorktreeSection";
import NewWorktreeModal from "../Modals/NewWorktreeModal";
import styles from "./Sidebar.module.css";

interface Props {
  onOpenSettings: () => void;
}

export default function Sidebar({ onOpenSettings }: Props) {
  const groups = useConfigStore((s) => s.groups);
  const addGroup = useConfigStore((s) => s.addGroup);
  const saveConfig = useConfigStore((s) => s.saveConfig);

  const gitInfo = useGitStore((s) => s.gitInfo);
  const repoPath = useGitStore((s) => s.repoPath);
  const setActiveGitGroup = useGitStore((s) => s.setActiveGitGroup);

  const worktrees = useWorktreeStore((s) => s.worktrees);
  const activeWorktreeId = useWorktreeStore((s) => s.activeWorktreeId);
  const setActiveWorktree = useWorktreeStore((s) => s.setActiveWorktree);
  const createWorktree = useWorktreeStore((s) => s.createWorktree);

  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);

  const [adding, setAdding] = useState(false);
  const [worktreeModalOpen, setWorktreeModalOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (adding && inputRef.current) {
      inputRef.current.focus();
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    }
  }, [adding]);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const handleAddConfirm = (value: string) => {
    setAdding(false);
    const name = value.trim();
    if (!name) return;
    const gid = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    if (groups.find((g) => g.id === gid)) return;
    addGroup({ id: gid, label: name, services: [] });
    saveConfig();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      handleAddConfirm(e.currentTarget.value);
    } else if (e.key === "Escape") {
      setAdding(false);
    }
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    handleAddConfirm(e.currentTarget.value);
  };

  const handleHome = async () => {
    setMenuOpen(false);
    await api.showStartPage();
  };

  const handleExport = async () => {
    setMenuOpen(false);
    const config = await api.getConfig();
    const json = JSON.stringify(config, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const projectId = api.getProjectId() ?? "project";
    a.download = `${projectId}-config.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSettings = () => {
    setMenuOpen(false);
    onOpenSettings();
  };

  const handleMainContextClick = () => {
    setActiveWorktree(null);
    setActiveGitGroup(null);
    // Switch to first main workspace
    const workspaces = useWorkspaceStore.getState().workspaces;
    const mainWs = workspaces.find((w) => w.worktreeId === null);
    if (mainWs) {
      setActiveWorkspace(mainWs.id);
    }
  };

  const handleOpenGitPanel = (e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveWorktree(null);
    setActiveWorkspace(null);
    setActiveGitGroup("project");
  };

  const handleCreateWorktree = async (branch: string, path: string) => {
    const wt = await createWorktree(branch, path);
    await saveConfig();
    // Switch to the new worktree and create a workspace for it
    setActiveWorktree(wt.id);
    useWorkspaceStore.getState().addWorkspaceForWorktree(wt.id);
  };

  const isMainActive = activeWorktreeId === null;

  return (
    <div className={styles.sidebar}>
      <div className={styles.sidebarTop} ref={menuRef}>
        <button
          className={styles.titleBtn}
          onClick={() => setMenuOpen((o) => !o)}
        >
          Lever
          <span className={styles.chevron}>{menuOpen ? "▴" : "▾"}</span>
        </button>

        {menuOpen && (
          <div className={styles.menu}>
            <button className={styles.menuItem} onClick={handleHome}>
              Projects
            </button>
            <button className={styles.menuItem} onClick={handleExport}>
              Export Config
            </button>
            <div className={styles.menuDivider} />
            <button className={styles.menuItem} onClick={handleSettings}>
              Settings
            </button>
          </div>
        )}
      </div>

      {repoPath && (
        <div
          className={`${styles.mainContext}${isMainActive ? ` ${styles.mainContextActive}` : ""}`}
          onClick={handleMainContextClick}
        >
          <span className={styles.mainContextDot}>●</span>
          <span className={styles.mainContextBranch}>
            {gitInfo?.current_branch ?? "..."}
          </span>
          {gitInfo?.is_dirty && (
            <span className={styles.mainContextDirty}>●</span>
          )}
          <span
            style={{ marginLeft: "auto", cursor: "pointer" }}
            onClick={handleOpenGitPanel}
            title="Git panel"
          >
            &#9579;
          </span>
        </div>
      )}

      <div className={styles.sidebarScroll} ref={scrollRef}>
        {groups.map((group) => (
          <GroupItem key={group.id} group={group} />
        ))}

        {worktrees.map((wt) => (
          <WorktreeSection key={wt.id} worktree={wt} />
        ))}

        {adding ? (
          <div className={styles.addGroupInput}>
            <input
              ref={inputRef}
              placeholder="Group name..."
              onKeyDown={handleKeyDown}
              onBlur={handleBlur}
            />
          </div>
        ) : (
          <div className={styles.bottomBar}>
            <button
              className={styles.addGroupBtn}
              onClick={() => setAdding(true)}
            >
              + Add Group
            </button>
            {repoPath && (
              <button
                className={styles.newWorktreeBtn}
                onClick={() => setWorktreeModalOpen(true)}
              >
                + New Worktree
              </button>
            )}
          </div>
        )}
      </div>

      <NewWorktreeModal
        open={worktreeModalOpen}
        onClose={() => setWorktreeModalOpen(false)}
        onCreate={handleCreateWorktree}
      />
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/Sidebar/Sidebar.tsx ui/src/components/Sidebar/Sidebar.module.css
git commit -m "feat: sidebar shows main context, worktree sections, and new worktree button"
```

---

### Task 13: Update WorkspaceBar to filter by active worktree

**Files:**
- Modify: `ui/src/components/MainPanel/WorkspaceBar.tsx`

- [ ] **Step 1: Filter workspaces by active worktree**

Add import and filtering logic. The key change is that `workspaces` shown in the bar are filtered by the active worktree context.

At the top of `WorkspaceBar`, add the import and filter:

```typescript
import { useWorktreeStore } from "../../stores/worktreeStore";
```

Inside the component, after the existing store hooks:

```typescript
const activeWorktreeId = useWorktreeStore((s) => s.activeWorktreeId);

const filteredWorkspaces = workspaces.filter(
  (w) => w.worktreeId === activeWorktreeId
);
```

Then replace all references to `workspaces` in the JSX with `filteredWorkspaces`. Specifically:

1. The `.map((ws, i) =>` in the tab rendering
2. The `tabRefs.current` array sizing

Update the `handleNew` function to create a workspace scoped to the active worktree:

```typescript
const addWorkspaceForWorktree = useWorkspaceStore(
  (s) => s.addWorkspaceForWorktree
);

const handleNew = () => {
  if (activeWorktreeId) {
    addWorkspaceForWorktree(activeWorktreeId);
  } else {
    addWorkspace();
  }
  setActiveGitGroup(null);
  setActiveLog(null);
};
```

In the JSX, replace `workspaces.map` with `filteredWorkspaces.map`:

```tsx
{filteredWorkspaces.map((ws, i) => (
  <div
    key={ws.id}
    ref={(el) => { tabRefs.current[i] = el; }}
    className={`${styles.tab}${activeWorkspaceId === ws.id ? ` ${styles.tabActive}` : ""}${draggingId === ws.id ? ` ${styles.tabDragging}` : ""}`}
    onClick={() => handleClick(ws.id)}
    onContextMenu={(e) => handleContextMenu(e, ws.id)}
    onMouseDown={(e) => handleTabMouseDown(e, i, ws.id)}
  >
    {/* ... same content ... */}
  </div>
))}
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/components/MainPanel/WorkspaceBar.tsx
git commit -m "feat: WorkspaceBar filters workspaces by active worktree"
```

---

### Task 14: Update GitPanel for project-level repo_path

**Files:**
- Modify: `ui/src/components/MainPanel/GitPanel.tsx`

- [ ] **Step 1: Update GitPanel to use project-level git info**

```typescript
import { useState } from "react";
import { useGitStore } from "../../stores/gitStore";
import type { GitFileStatus } from "../../types";
import styles from "./GitPanel.module.css";

function ChangesSection({ files }: { files: GitFileStatus[] }) {
  const [shown, setShown] = useState(10);

  if (files.length === 0) return null;

  const visible = files.slice(0, shown);
  const remaining = files.length - shown;

  return (
    <div className={styles.gitSection}>
      <div className={styles.gitSectionHeader}>
        Changes{" "}
        <span className={styles.gitSectionCount}>{files.length}</span>
      </div>
      <div className={styles.gitSectionBody}>
        {visible.map((f, i) => {
          const badge =
            f.status === "new"
              ? "A"
              : f.status === "deleted"
                ? "D"
                : f.status === "renamed"
                  ? "R"
                  : "M";
          const badgeCls = f.staged
            ? styles.badgeStaged
            : f.status === "new"
              ? styles.badgeNew
              : f.status === "deleted"
                ? styles.badgeDeleted
                : styles.badgeModified;

          return (
            <div key={i} className={styles.gitFileItem}>
              <span className={`${styles.gitFileBadge} ${badgeCls}`}>
                {badge}
              </span>
              <span className={styles.filePath}>{f.path}</span>
              {f.staged && (
                <span className={styles.stagedLabel}>staged</span>
              )}
            </div>
          );
        })}
        {remaining > 0 && (
          <button
            className={styles.gitShowMore}
            onClick={() => setShown((s) => s + 10)}
          >
            Show more ({remaining} remaining)
          </button>
        )}
      </div>
    </div>
  );
}

export default function GitPanel() {
  const activeGitGroupId = useGitStore((s) => s.activeGitGroupId);
  const gitInfo = useGitStore((s) => s.gitInfo);
  const fetchGit = useGitStore((s) => s.fetch);
  const pull = useGitStore((s) => s.pull);

  if (!activeGitGroupId) return null;

  if (!gitInfo) {
    return (
      <div className={styles.gitPanel}>
        <div className={styles.gitLoading}>Loading git info...</div>
      </div>
    );
  }

  return (
    <div className={styles.gitPanel}>
      <div className={styles.gitPanelHeader}>
        <h3>
          <span>&#9579;</span>
          <span className={styles.branchMono}>{gitInfo.current_branch}</span>
          {gitInfo.is_dirty ? (
            <span className={styles.dirtyIndicator}>
              &#9679; modified
            </span>
          ) : (
            <span className={styles.cleanIndicator}>clean</span>
          )}
        </h3>
        <div className={styles.gitActions}>
          <button
            className={styles.actionBtn}
            onClick={() => fetchGit()}
          >
            Fetch
          </button>
          <button
            className={styles.actionBtn}
            onClick={() => pull()}
          >
            Pull
          </button>
        </div>
      </div>
      <div className={styles.gitPanelBody}>
        <ChangesSection files={gitInfo.changed_files} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/components/MainPanel/GitPanel.tsx
git commit -m "refactor: GitPanel uses project-level git info"
```

---

### Task 15: Update usePty to support worktree cwd

**Files:**
- Modify: `ui/src/hooks/usePty.ts`

- [ ] **Step 1: Accept optional `cwd` and pass it to `createPty`**

Update the `usePty` hook signature and PTY creation:

```typescript
export function usePty(
  paneId: string,
  containerRef: React.RefObject<HTMLDivElement | null>,
  cwd?: string
) {
```

In the `api.createPty` call (around line 172), pass the cwd:

```typescript
api
  .createPty(term.cols, term.rows, cwd)
  .then(async (info) => {
```

- [ ] **Step 2: Update PaneView to pass worktree cwd**

Read the PaneView component to understand how it calls `usePty`, then update it to pass the worktree path when applicable. In `PaneView.tsx`, the `usePty` hook is called in a `PaneLeafView` sub-component. The worktree path needs to flow from the active worktree context.

In the `PaneLeafView` component within `PaneView.tsx`, import `useWorktreeStore`:

```typescript
import { useWorktreeStore } from "../../stores/worktreeStore";
```

Inside `PaneLeafView`, get the active worktree's path:

```typescript
const activeWorktreeId = useWorktreeStore((s) => s.activeWorktreeId);
const worktrees = useWorktreeStore((s) => s.worktrees);
const activeWorktree = worktrees.find((w) => w.id === activeWorktreeId);
const cwd = activeWorktree?.path;
```

Pass it to `usePty`:

```typescript
const { fit } = usePty(node.id, containerRef, cwd);
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/hooks/usePty.ts ui/src/components/MainPanel/PaneView.tsx
git commit -m "feat: PTY terminals open in worktree directory when active"
```

---

### Task 16: Build, test, and verify

- [ ] **Step 1: Build the Rust backend**

Run: `cd /Users/onil/Repos/Personal/lever/src-tauri && cargo build 2>&1 | tail -20`
Expected: Compiles successfully

- [ ] **Step 2: Build the frontend**

Run: `cd /Users/onil/Repos/Personal/lever && npm run build --prefix ui 2>&1 | tail -20`
Expected: Builds successfully with no TypeScript errors

- [ ] **Step 3: Fix any build errors**

If there are build errors, fix them in the relevant files and re-build.

- [ ] **Step 4: Start the dev server and test**

Run: `cd /Users/onil/Repos/Personal/lever && npm run dev --prefix ui`

Test the following:
1. Open an existing project — verify sidebar loads without git branch on individual groups
2. Main context indicator shows at top of sidebar with branch name
3. Click "+ New Worktree" — modal appears with branch autocomplete and auto-populated path
4. Create a worktree — new section appears in sidebar with cloned groups
5. Click worktree section — workspace bar switches to worktree's workspaces
6. Open a terminal in worktree workspace — verify it opens in worktree directory
7. Click main context — switches back to main workspaces
8. Right-click worktree section — context menu with remove options appears

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete worktree feature with sidebar sections and workspace scoping"
```

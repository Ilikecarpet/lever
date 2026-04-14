import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
  AppConfig,
  PollResult,
  PtyInfo,
  GitRepoInfo,
  ProjectMeta,
  WorktreeDef,
} from "../types";

// ---------------------------------------------------------------------------
// Project ID detection — derived from window label
// ---------------------------------------------------------------------------

let _projectId: string | null = null;

export function initProjectId(): string | null {
  const label = getCurrentWindow().label;
  if (label.startsWith("project-")) {
    _projectId = label.slice(8);
  }
  return _projectId;
}

export function getProjectId(): string | null {
  return _projectId;
}

// ---------------------------------------------------------------------------
// Project management commands (no projectId needed)
// ---------------------------------------------------------------------------

export function listProjects(): Promise<ProjectMeta[]> {
  return invoke<ProjectMeta[]>("list_projects");
}

export function createProject(name: string): Promise<ProjectMeta> {
  return invoke<ProjectMeta>("create_project", { name });
}

export function deleteProject(id: string): Promise<void> {
  return invoke<void>("delete_project", { id });
}

export function renameProject(id: string, name: string): Promise<void> {
  return invoke<void>("rename_project", { id, name });
}

export function cloneProject(sourceId: string, name: string): Promise<ProjectMeta> {
  return invoke<ProjectMeta>("clone_project", { sourceId, name });
}

export function importProject(name: string, configJson: string): Promise<ProjectMeta> {
  return invoke<ProjectMeta>("import_project", { name, configJson });
}

export function openProject(id: string): Promise<void> {
  return invoke<void>("open_project", { id });
}

export function showStartPage(): Promise<void> {
  return invoke<void>("show_start_page");
}

// ---------------------------------------------------------------------------
// Config commands (project-scoped)
// ---------------------------------------------------------------------------

export function getConfig(): Promise<AppConfig> {
  return invoke<AppConfig>("get_config", { projectId: _projectId });
}

export function saveConfig(config: AppConfig): Promise<void> {
  return invoke<void>("save_config", { projectId: _projectId, config });
}

// ---------------------------------------------------------------------------
// Service commands (project-scoped)
// ---------------------------------------------------------------------------

export function startService(id: string): Promise<void> {
  return invoke<void>("start_service", { projectId: _projectId, id });
}

export function stopService(id: string): Promise<void> {
  return invoke<void>("stop_service", { projectId: _projectId, id });
}

export function poll(): Promise<PollResult> {
  return invoke<PollResult>("poll", { projectId: _projectId });
}

// ---------------------------------------------------------------------------
// PTY commands (project-scoped)
// ---------------------------------------------------------------------------

export function createPty(cols: number, rows: number, cwd?: string): Promise<PtyInfo> {
  return invoke<PtyInfo>("create_pty", { projectId: _projectId, cols, rows, cwd: cwd ?? null });
}

export function writePty(id: string, data: string): Promise<void> {
  return invoke<void>("write_pty", { projectId: _projectId, id, data });
}

export function resizePty(
  id: string,
  cols: number,
  rows: number
): Promise<void> {
  return invoke<void>("resize_pty", { projectId: _projectId, id, cols, rows });
}

export function closePty(id: string): Promise<void> {
  return invoke<void>("close_pty", { projectId: _projectId, id });
}

// ---------------------------------------------------------------------------
// Project repo path commands
// ---------------------------------------------------------------------------

export function setRepoPath(id: string, repoPath: string): Promise<void> {
  return invoke<void>("set_repo_path", { id, repoPath });
}

export function getRepoPath(id: string): Promise<string> {
  return invoke<string>("get_repo_path", { id });
}

// ---------------------------------------------------------------------------
// Worktree commands
// ---------------------------------------------------------------------------

export function createWorktree(projectId: string, branch: string, path: string): Promise<WorktreeDef> {
  return invoke<WorktreeDef>("create_worktree", { projectId, branch, path });
}

export function removeWorktree(projectId: string, worktreeId: string, cleanup: boolean): Promise<void> {
  return invoke<void>("remove_worktree", { projectId, worktreeId, cleanup });
}

export function listBranches(projectId: string): Promise<string[]> {
  return invoke<string[]>("list_branches", { projectId });
}

// ---------------------------------------------------------------------------
// Git commands (unchanged — path-based, not project-scoped)
// ---------------------------------------------------------------------------

export function gitInfo(path: string): Promise<GitRepoInfo> {
  return invoke<GitRepoInfo>("git_info", { path });
}

export function gitFetch(path: string): Promise<void> {
  return invoke<void>("git_fetch", { path });
}

export function gitPull(path: string): Promise<string> {
  return invoke<string>("git_pull", { path });
}

// ---------------------------------------------------------------------------
// Event listener helper
// ---------------------------------------------------------------------------

export function tauriListen<T>(
  event: string,
  callback: (payload: T) => void
): Promise<UnlistenFn> {
  return listen<T>(event, (e) => callback(e.payload));
}

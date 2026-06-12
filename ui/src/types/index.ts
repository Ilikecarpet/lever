// ---------------------------------------------------------------------------
// Config types (mirrors Rust structs in src-tauri/src/main.rs)
// ---------------------------------------------------------------------------

export interface ServiceDef {
  id: string;
  label: string;
  description: string;
  command: string;
  args: string[];
  cwd: string;
  service_type: string;
  stop_command: string[];
}

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

// ---------------------------------------------------------------------------
// Config export wrapper (on-disk format, versioned)
// ---------------------------------------------------------------------------

export interface ProjectExport {
  version: 1;
  name: string;
  repo_path: string;
  config: AppConfig;
}

// ---------------------------------------------------------------------------
// Service runtime types
// ---------------------------------------------------------------------------

export interface ServiceStatus {
  id: string;
  status: "running" | "stopped";
  pty_id: string | null;
}

export interface AgentInfo {
  name: string;
  /** true while the agent is producing terminal output (inference/streaming) */
  active: boolean;
}

export interface PollResult {
  statuses: ServiceStatus[];
  logs: Record<string, string[]>;
  /** pty_id -> AI agent CLI detected in that terminal */
  agents: Record<string, AgentInfo>;
}

// ---------------------------------------------------------------------------
// PTY types
// ---------------------------------------------------------------------------

export interface PtyInfo {
  id: string;
}

export interface PtyDataEvent {
  id: string;
  data: string;
}

export interface PtyExitEvent {
  id: string;
}

export interface SvcExitEvent {
  id: string;
  pty_id: string;
}

export interface StartServiceResult {
  pty_id: string;
}

// ---------------------------------------------------------------------------
// Git types
// ---------------------------------------------------------------------------

export interface GitFileStatus {
  path: string;
  status: "modified" | "new" | "deleted" | "renamed" | "typechange";
  staged: boolean;
  is_dir: boolean;
}

export interface GitRepoInfo {
  current_branch: string;
  is_dirty: boolean;
  changed_files: GitFileStatus[];
}

// ---------------------------------------------------------------------------
// Project types
// ---------------------------------------------------------------------------

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


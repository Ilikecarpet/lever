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
  repo_path: string;
}

export interface AppConfig {
  groups: ServiceGroup[];
}

// ---------------------------------------------------------------------------
// Service runtime types
// ---------------------------------------------------------------------------

export interface ServiceStatus {
  id: string;
  status: "running" | "stopped";
}

export interface PollResult {
  statuses: ServiceStatus[];
  logs: Record<string, string[]>;
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

// ---------------------------------------------------------------------------
// Git types
// ---------------------------------------------------------------------------

export interface GitFileStatus {
  path: string;
  status: "modified" | "new" | "deleted" | "renamed" | "typechange";
  staged: boolean;
}

export interface GitRepoInfo {
  current_branch: string;
  is_dirty: boolean;
  changed_files: GitFileStatus[];
}


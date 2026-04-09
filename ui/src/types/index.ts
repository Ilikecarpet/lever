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
  status: string;
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

export interface GitBranchInfo {
  name: string;
  is_current: boolean;
  is_remote: boolean;
}

export interface GitCommitInfo {
  hash: string;
  short_hash: string;
  summary: string;
  author: string;
  time_ago: string;
}

export interface GitFileStatus {
  path: string;
  status: string;
  staged: boolean;
}

export interface GitRepoInfo {
  current_branch: string;
  branches: GitBranchInfo[];
  is_dirty: boolean;
  changed_files: GitFileStatus[];
  recent_commits: GitCommitInfo[];
}

export interface GitPrInfo {
  number: number;
  title: string;
  author: string;
  branch: string;
  state: string;
  url: string;
  is_draft: boolean;
  updated: string;
}

// ---------------------------------------------------------------------------
// UI-only types
// ---------------------------------------------------------------------------

export interface TerminalTab {
  id: string;
  label: string;
  ptyId: string | null;
}

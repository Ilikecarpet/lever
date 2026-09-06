// ---------------------------------------------------------------------------
// Config types (mirrors Rust structs in src-tauri/src/main.rs)
// ---------------------------------------------------------------------------

export interface ServiceDef {
  id: string;
  label: string;
  description: string;
  /** A whole shell command line, run as typed (env prefixes, quotes, pipes). */
  command: string;
  /** Legacy: separate argv tokens, only on configs written before the merge. */
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

/** Token stats read from an agent CLI's own on-disk session records. */
export interface AgentUsage {
  sessionId: string;
  /** The label the agent derives for the session, e.g. "lever-4f". */
  sessionName: string | null;
  model: string | null;
  cliVersion: string | null;

  /** Conversation size after the last turn. A floor: tool results added since
   *  the last API call are not counted anywhere yet. */
  contextTokens: number;
  contextLimit: number;
  /** "reported" when Claude Code handed over the real window through the
   *  statusLine bridge, "inferred" when it is the 200k-until-proven-larger
   *  guess. */
  contextLimitSource: "reported" | "inferred";
  /** The four parts of contextTokens, in the order they read on the meter. */
  cacheReadTokens: number;
  cacheWriteTokens: number;
  freshInputTokens: number;
  replyTokens: number;

  /** Billed totals for the whole session, subagents included. */
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  /** Output spent by subagents, which never lands in this context window. */
  sidechainOutputTokens: number;
  /** API responses on the main thread. */
  turns: number;
  /** True while the reader is still working through a long transcript's
   *  backlog, so the session totals are still climbing toward the real figure. */
  catchingUp: boolean;
  /** What Claude Code itself reports about the session through the statusLine
   *  bridge. Absent with the bridge off. */
  reported?: ReportedDetails;
}

/** Per-session extras from the statusLine payload. Each is optional: the
 *  payload has grown release by release, and an older CLI sends a subset. */
export interface ReportedDetails {
  /** The conversation's title, as opposed to the derived session label. */
  title: string | null;
  /** "Fable 5.1" rather than the raw model id. */
  modelName: string | null;
  effort: string | null;
  fastMode: boolean | null;
  thinking: boolean | null;
  /** Running cost at API list price — nominal on a subscription. */
  costUsd: number | null;
  durationMs: number | null;
  apiDurationMs: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  cacheWarm: boolean | null;
  cacheTtl: string | null;
  /** Unix seconds when the server-side prompt cache lapses. */
  cacheExpiresAt: number | null;
  cacheHitRatio: number | null;
  /** Tokens a cold resume would re-read. */
  cacheRecacheTokens: number | null;
  /** Unix seconds the payload was written. */
  reportedAt: number;
}

/** One of the Claude account's rolling usage windows, as Claude Code last
 *  reported it through the statusLine bridge. */
export interface RateLimitWindow {
  /** 0–100, rounded by Claude Code. */
  usedPercentage: number;
  /** Unix seconds at which the window rolls over. */
  resetsAt: number;
  /** Unix seconds when the figure was last written. Payloads only refresh
   *  while some session is rendering, so this can fall behind. */
  reportedAt: number;
}

/** Plan usage for the whole account — one figure, not one per session. Either
 *  window may be missing: Claude Code omits one it has no data for. */
export interface RateLimits {
  fiveHour: RateLimitWindow | null;
  sevenDay: RateLimitWindow | null;
}

/** Whether Lever's statusLine hook is installed in ~/.claude/settings.json. */
export interface BridgeState {
  installed: boolean;
  /** A statusLine command already in the slot that is not ours. Installing
   *  chains to it rather than replacing it. */
  foreignCommand: string | null;
}

export interface AgentInfo {
  name: string;
  /** true while the agent is working. Read from Claude Code's own record when
   *  available, otherwise inferred from recent terminal output. */
  active: boolean;
  /** The agent finished a turn and nobody has been back to the terminal since. */
  needsAttention: boolean;
  /** Present only for agents whose usage we can read (Claude Code today). */
  usage?: AgentUsage;
}

export interface PollResult {
  statuses: ServiceStatus[];
  logs: Record<string, string[]>;
  /** pty_id -> AI agent CLI detected in that terminal */
  agents: Record<string, AgentInfo>;
  /** service id -> TCP ports it is listening on */
  ports: Record<string, number[]>;
  /** The Claude account's plan usage, when the bridge has reported it. */
  rateLimits: RateLimits | null;
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


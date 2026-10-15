import { useSyncExternalStore } from "react";
import * as api from "./tauri";
import { tauriListen } from "./tauri";
import { useChatMetaStore } from "../stores/chatMetaStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

// ---------------------------------------------------------------------------
// Agent Client Protocol, client side.
//
// The backend only pipes JSON-RPC lines between a chat pane and its agent
// (src-tauri/src/acp.rs). Everything protocol-shaped happens here: the
// handshake, sign-in, prompts, permission requests, loading past sessions, and
// folding the agent's stream of session/update notifications into a
// transcript the pane can render.
//
// Chats live in a module-level store keyed by pane id, like terminals in
// usePty: a pane can unmount and remount (switching workspace or worktree)
// without the conversation going anywhere. It ends only via destroyChat.
// ---------------------------------------------------------------------------

export type AgentId = "claude" | "codex";

export const AGENTS: Record<AgentId, { name: string; maker: string }> = {
  claude: { name: "Claude", maker: "Anthropic" },
  codex: { name: "Codex", maker: "OpenAI" },
};

const AGENT_KEY = "lever-chat-agent";

/** The agent a new chat starts with: whichever was picked last. */
export function defaultAgent(): AgentId {
  try {
    const v = localStorage.getItem(AGENT_KEY);
    if (v === "claude" || v === "codex") return v;
  } catch {}
  return "claude";
}

function rememberAgent(agent: AgentId) {
  try {
    localStorage.setItem(AGENT_KEY, agent);
  } catch {}
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

export interface ConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: string;
  currentValue: string;
  options: { value: string; name: string; description?: string }[];
}

export interface ToolContent {
  type: "content" | "diff" | "terminal" | string;
  content?: { type: string; text?: string };
  path?: string;
  oldText?: string | null;
  newText?: string;
}

export interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed" | string;
  priority?: string;
}

export interface ImageAttachment {
  mimeType: string;
  /** base64, no data: prefix */
  data: string;
  name?: string;
}

export interface SessionSummary {
  sessionId: string;
  title?: string | null;
  updatedAt?: string | null;
  cwd?: string;
  /** The branch the session was last on, where the agent records one. */
  branch?: string;
}

export type ToolItem = {
  kind: "tool";
  id: string;
  title: string;
  toolKind?: string;
  status?: string;
  content: ToolContent[];
  rawInput?: Record<string, unknown>;
  rawOutput?: string;
  /** For a tool call that launched a subagent: what that agent did — its own
   *  tool calls and notes — and whether it is still at it. */
  subagent?: SubagentRun;
};

export interface SubagentRun {
  title?: string;
  description?: string;
  /** "running", "completed", "failed"… as the agent reports it. */
  state?: string;
  steps: (ToolItem | { kind: "note"; id: string; messageId?: string; text: string })[];
}

/** Every tool call in a transcript, subagents' included — for counting edits
 *  and undoing them, which a subagent's count as much as the main thread's. */
export function allTools(items: ChatItem[]): ToolItem[] {
  const out: ToolItem[] = [];
  for (const i of items) {
    if (i.kind !== "tool") continue;
    out.push(i);
    for (const step of i.subagent?.steps ?? []) if (step.kind === "tool") out.push(step);
  }
  return out;
}

/** A tool call with an update folded in; the update carries only what changed. */
function mergeTool(prev: ToolItem | null, u: any): ToolItem {
  const rawInput = u.rawInput && Object.keys(u.rawInput).length ? u.rawInput : prev?.rawInput;
  return {
    kind: "tool",
    id: u.toolCallId,
    title: u.title ?? prev?.title ?? u.name ?? "Tool",
    toolKind: u.kind ?? prev?.toolKind,
    status: u.status ?? prev?.status,
    content: u.content ?? prev?.content ?? [],
    rawInput,
    rawOutput: typeof u.rawOutput === "string" ? u.rawOutput : prev?.rawOutput,
    subagent: prev?.subagent,
  };
}

export type ChatItem =
  | { kind: "user"; id: string; text: string; images?: ImageAttachment[]; attached?: string[] }
  | { kind: "agent"; id: string; messageId?: string; text: string }
  | { kind: "thought"; id: string; text: string }
  | ToolItem
  | {
      kind: "permission";
      id: string;
      rpcId: number | string;
      toolCallId?: string;
      title: string;
      toolKind?: string;
      /** What is being asked for: a command, or the edit's diff. */
      preview?: { command?: string; diff?: ToolContent };
      options: PermissionOption[];
      /** optionId picked, "cancelled", or undefined while waiting. */
      outcome?: string;
    }
  | { kind: "turnEnd"; id: string; durationMs: number; stopReason?: string }
  | { kind: "notice"; id: string; text: string; tone: "info" | "error" };

export interface ChatState {
  agent: AgentId;
  /** "auth": the agent wants a sign-in before it will open a session. */
  status: "starting" | "auth" | "ready" | "working" | "exited";
  sessionId: string | null;
  title: string | null;
  items: ChatItem[];
  configOptions: ConfigOption[];
  commands: { name: string; description?: string }[];
  plan: PlanEntry[];
  usage: { used: number; size: number; cost?: number } | null;
  authMethods: { id: string; name: string; description?: string }[];
  turnStartedAt: number | null;
  /** What this session's turns have cost in tokens, summed from each
   *  prompt's reported usage — the session totals the status bar shows. */
  totals: SessionTotals;
  /** Replaying a past session into the transcript. */
  loading: boolean;
  canLoad: boolean;
  canList: boolean;
  /** The agent can copy a conversation up to a given reply, which is what
   *  rewinding needs. Claude's adapter only: the fork point is named in its
   *  own extension. */
  canFork: boolean;
}

export interface SessionTotals {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const NO_TOTALS: SessionTotals = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

type Pending = { resolve: (v: any) => void; reject: (e: Error & { code?: number }) => void };

let chatCounter = 0;

export class Chat {
  state: ChatState;
  private listeners = new Set<() => void>();
  private pending = new Map<number, Pending>();
  private nextRpcId = 0;
  private promptsInFlight = 0;
  private unlisten: (() => void)[] = [];
  private itemSeq = 0;
  private chatId = "";
  /** Bumped whenever the agent process is replaced, so a dying one's
   *  late messages are ignored. */
  private generation = 0;
  /** What was sent, newest last, for ↑ in the composer. */
  readonly sent: string[] = [];
  disposed = false;
  /** Set by the pane while it is on screen and focused. */
  watched = false;

  constructor(readonly paneId: string, readonly cwd: string, agent: AgentId, private resumeId?: string) {
    this.state = Chat.initialState(agent);
  }

  private static initialState(agent: AgentId): ChatState {
    return {
      agent,
      status: "starting",
      sessionId: null,
      title: null,
      items: [],
      configOptions: [],
      commands: [],
      plan: [],
      usage: null,
      authMethods: [],
      turnStartedAt: null,
      totals: NO_TOTALS,
      loading: false,
      canLoad: false,
      canList: false,
      canFork: false,
    };
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private set(patch: Partial<ChatState>) {
    const prev = this.state;
    this.state = { ...prev, ...patch };
    if (patch.title !== undefined && patch.title !== prev.title && patch.title) {
      useWorkspaceStore.getState().setPaneTitle(this.paneId, patch.title);
    }
    this.report();
    this.listeners.forEach((fn) => fn());
  }

  /** Line counts per tool call, kept while the call's object is unchanged, so
   *  a streamed reply does not re-diff every edit on each chunk. */
  private lineCache = new WeakMap<ToolItem, { added: number; removed: number }>();

  /** Tell the sidebar and tab bar what they show for this chat: the same
   *  things a terminal running `claude` reports. The store ignores a report
   *  that changes nothing. */
  private report() {
    const st = this.state;
    let added = 0;
    let removed = 0;
    for (const item of allTools(st.items)) {
      if (item.status === "failed") continue;
      let n = this.lineCache.get(item);
      if (!n) {
        n = { added: 0, removed: 0 };
        for (const c of item.content) {
          if (c.type !== "diff") continue;
          const d = lineCounts(c.oldText ?? "", c.newText ?? "");
          n.added += d.added;
          n.removed += d.removed;
        }
        this.lineCache.set(item, n);
      }
      added += n.added;
      removed += n.removed;
    }
    const opt = (id: string) => st.configOptions.find((o) => o.id === id);
    const model = opt("model");
    const picked = model?.options.find((o) => o.value === model.currentValue);
    // "Default (recommended)" says which model it is in its description.
    const modelName = picked ? (picked.value === "default" && picked.description ? picked.description : picked.name) : null;
    const effort = opt("effort")?.currentValue;
    const fast = opt("fast")?.currentValue;
    useChatMetaStore.getState().patch(this.paneId, {
      working: st.status === "working",
      agentName: AGENTS[st.agent].name,
      title: st.title,
      linesAdded: added,
      linesRemoved: removed,
      contextUsed: st.usage?.used ?? 0,
      contextSize: st.usage?.size ?? 0,
      costUsd: st.usage?.cost ?? null,
      modelName,
      effort: effort && effort !== "default" ? effort : null,
      fastMode: fast == null ? null : fast === "on",
      totals: st.totals,
    });
  }

  private newItemId() {
    this.itemSeq += 1;
    return `i${this.itemSeq}`;
  }

  private push(item: ChatItem) {
    this.set({ items: [...this.state.items, item] });
  }

  private notice(text: string, tone: "info" | "error" = "info") {
    this.push({ kind: "notice", id: this.newItemId(), text, tone });
  }

  // --- transport ----------------------------------------------------------

  private write(msg: object) {
    return api.acpSend(this.chatId, JSON.stringify({ jsonrpc: "2.0", ...msg }));
  }

  private request<T = any>(method: string, params: object): Promise<T> {
    const id = ++this.nextRpcId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params }).catch((e) => {
        this.pending.delete(id);
        reject(new Error(String(e)));
      });
    });
  }

  private notify(method: string, params: object) {
    return this.write({ method, params }).catch(() => {});
  }

  private onLine(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id != null && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(msg.error.message ?? "Agent error") as Error & { code?: number };
        err.code = msg.error.code;
        p.reject(err);
      } else p.resolve(msg.result);
      return;
    }
    if (msg.method === "session/update") {
      const sid = msg.params?.sessionId;
      const u = msg.params?.update ?? {};
      // A subagent's activity names the tool call that launched it; it goes
      // under that call rather than into the conversation.
      if (u.sessionUpdate === "session_message" && sid && typeof u.messageId === "string") {
        this.childParents.set(sid, u.messageId);
        this.updateSubagent(u.messageId, (r) => ({ ...r, ...this.subagentInfo.get(sid) }));
        return;
      }
      const parent = u._meta?.claudeCode?.parentToolUseId ?? (sid ? this.childParents.get(sid) : undefined);
      if (parent && u.sessionUpdate !== "subagent_update") {
        if (sid && sid !== this.state.sessionId) this.childParents.set(sid, parent);
        this.onSubagentUpdate(parent, u);
        return;
      }
      if (sid && this.state.sessionId && sid !== this.state.sessionId) return;
      this.onUpdate(u);
      return;
    }
    if (msg.method === "session/request_permission" && msg.id != null) {
      this.onPermission(msg.id, msg.params ?? {});
      return;
    }
    // A request for something Lever did not offer (fs, terminal): say so
    // rather than leave the agent waiting on it.
    if (msg.id != null && msg.method) {
      this.write({ id: msg.id, error: { code: -32601, message: `Lever does not support ${msg.method}` } });
    }
  }

  /** Subagent session id -> the tool call that launched it. */
  private childParents = new Map<string, string>();
  /** What a subagent said about itself, kept until its tool call is known. */
  private subagentInfo = new Map<string, { title?: string; description?: string; state?: string }>();

  private updateSubagent(parentId: string, fn: (run: SubagentRun) => SubagentRun) {
    const items = this.state.items;
    const idx = items.findIndex((i) => i.kind === "tool" && i.id === parentId);
    if (idx < 0) return;
    const tool = items[idx] as ToolItem;
    const copy = items.slice();
    copy[idx] = { ...tool, subagent: fn(tool.subagent ?? { steps: [] }) };
    this.set({ items: copy });
  }

  private onSubagentUpdate(parentId: string, u: any) {
    switch (u.sessionUpdate) {
      case "tool_call":
      case "tool_call_update":
        this.updateSubagent(parentId, (run) => {
          const steps = run.steps.slice();
          const at = steps.findIndex((s) => s.kind === "tool" && s.id === u.toolCallId);
          const next = mergeTool(at >= 0 ? (steps[at] as ToolItem) : null, u);
          if (at >= 0) steps[at] = next;
          else steps.push(next);
          return { ...run, steps };
        });
        return;
      case "agent_message_chunk": {
        const text = u.content?.type === "text" ? u.content.text ?? "" : "";
        if (!text) return;
        this.updateSubagent(parentId, (run) => {
          const steps = run.steps.slice();
          const last = steps[steps.length - 1];
          if (last && last.kind === "note" && last.messageId === u.messageId) {
            steps[steps.length - 1] = { ...last, text: last.text + text };
          } else {
            steps.push({ kind: "note", id: `${parentId}-n${steps.length}`, messageId: u.messageId, text });
          }
          return { ...run, steps };
        });
        return;
      }
    }
  }

  private onPermission(rpcId: number | string, params: any) {
    const tc = params.toolCall ?? {};
    const tool = this.state.items.find((i): i is ToolItem => i.kind === "tool" && i.id === tc.toolCallId);
    const rawInput = (tc.rawInput ?? tool?.rawInput ?? {}) as Record<string, unknown>;
    const content: ToolContent[] = tc.content ?? tool?.content ?? [];
    const diff = content.find((c) => c.type === "diff");
    const command = typeof rawInput.command === "string" ? rawInput.command : undefined;
    this.push({
      kind: "permission",
      id: this.newItemId(),
      rpcId,
      toolCallId: tc.toolCallId,
      title: tc.title ?? tool?.title ?? "Permission needed",
      toolKind: tc.kind ?? tool?.toolKind,
      preview: diff || command ? { diff, command } : undefined,
      options: params.options ?? [],
    });
    this.flagIfUnwatched();
  }

  private onUpdate(u: any) {
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const text = u.content?.type === "text" ? u.content.text ?? "" : "";
        if (!text) return;
        const kind = u.sessionUpdate === "agent_message_chunk" ? "agent" : "thought";
        const items = this.state.items;
        const last = items[items.length - 1];
        if (last && last.kind === kind && (kind === "thought" || (last as any).messageId === u.messageId)) {
          this.set({ items: [...items.slice(0, -1), { ...last, text: last.text + text } as ChatItem] });
        } else if (kind === "agent") {
          this.push({ kind: "agent", id: this.newItemId(), messageId: u.messageId, text });
        } else {
          this.push({ kind: "thought", id: this.newItemId(), text });
        }
        return;
      }
      case "user_message_chunk": {
        // Sent when replaying a loaded session; live prompts are added
        // locally when sent. Consecutive chunks are one message.
        const c = u.content ?? {};
        const items = this.state.items;
        const last = items[items.length - 1];
        if (c.type === "text" && c.text) {
          if (last?.kind === "user" && this.state.loading) {
            this.set({ items: [...items.slice(0, -1), { ...last, text: last.text + c.text }] });
          } else {
            this.push({ kind: "user", id: this.newItemId(), text: c.text });
          }
        } else if (c.type === "image" && c.data) {
          const img = { mimeType: c.mimeType, data: c.data };
          if (last?.kind === "user") {
            this.set({ items: [...items.slice(0, -1), { ...last, images: [...(last.images ?? []), img] }] });
          } else {
            this.push({ kind: "user", id: this.newItemId(), text: "", images: [img] });
          }
        }
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        const items = this.state.items;
        const idx = items.findIndex((i) => i.kind === "tool" && i.id === u.toolCallId);
        const prev = idx >= 0 ? (items[idx] as ToolItem) : null;
        const next = mergeTool(prev, u);
        if (idx >= 0) {
          const copy = items.slice();
          copy[idx] = next;
          this.set({ items: copy });
        } else {
          this.push(next);
        }
        return;
      }
      case "subagent_update": {
        // A subagent announced (or finished). Its own messages, under its own
        // session id, name the tool call that launched it.
        const run = this.subagentInfo.get(u.sessionId) ?? {};
        this.subagentInfo.set(u.sessionId, {
          title: u.title ?? run.title,
          description: u.description ?? run.description,
          state: u.state?.state ?? run.state,
        });
        const parent = this.childParents.get(u.sessionId);
        if (parent) this.updateSubagent(parent, (r) => ({ ...r, ...this.subagentInfo.get(u.sessionId) }));
        return;
      }
      case "plan":
        this.set({ plan: u.entries ?? [] });
        return;
      case "available_commands_update":
        this.set({ commands: u.availableCommands ?? [] });
        return;
      case "config_option_update":
        if (u.configOptions) this.set({ configOptions: u.configOptions });
        return;
      case "current_mode_update":
        this.set({
          configOptions: this.state.configOptions.map((o) =>
            o.id === "mode" ? { ...o, currentValue: u.currentModeId } : o
          ),
        });
        return;
      case "session_info_update":
        if (typeof u.title === "string" && u.title) this.set({ title: u.title });
        return;
      case "usage_update":
        this.set({ usage: { used: u.used, size: u.size, cost: u.cost?.amount ?? this.state.usage?.cost } });
        return;
    }
  }

  // --- lifecycle ----------------------------------------------------------

  async start() {
    this.generation += 1;
    const gen = this.generation;
    chatCounter += 1;
    this.chatId = `chat-${Date.now()}-${chatCounter}`;
    const chatId = this.chatId;
    const live = () => !this.disposed && gen === this.generation;

    this.unlisten.push(
      await tauriListen<{ line: string }>(`acp-msg-${chatId}`, (p) => live() && this.onLine(p.line)),
      await tauriListen<{ code: number | null; stderr: string }>(`acp-exit-${chatId}`, (p) => live() && this.onExit(p))
    );
    if (!live()) return;
    try {
      await api.acpStart(chatId, this.cwd, this.state.agent);
      const init = await this.request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "lever", title: "Lever" },
        // `subagents`: a subagent's activity comes as its own session, which
        // is also what lets a loaded conversation bring that activity back —
        // without it only the main thread is replayed.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, subagents: {} },
      });
      if (!live()) return;
      const caps = init?.agentCapabilities ?? {};
      this.set({
        canLoad: !!caps.loadSession,
        canList: !!caps.sessionCapabilities?.list,
        canFork: !!caps.sessionCapabilities?.fork && this.state.agent === "claude",
        authMethods: init?.authMethods ?? [],
      });
      await this.openSession(this.resumeId);
      this.resumeId = undefined;
    } catch (e) {
      if (live()) this.fail(e);
    }
  }

  /** Open a fresh session, or load a past one. Asks for sign-in if the agent
   *  refuses for want of it. */
  private async openSession(resumeId?: string) {
    try {
      if (resumeId && this.state.canLoad) {
        this.set({ loading: true, sessionId: resumeId });
        const res = await this.request("session/load", { sessionId: resumeId, cwd: this.cwd, mcpServers: [] });
        // A replayed tool call that never reported an outcome is history, not
        // something still running.
        const settle = (t: ToolItem): ToolItem =>
          t.status === "pending" || t.status === "in_progress" || !t.status ? { ...t, status: "replayed" } : t;
        // A subagent still "running" at the end of a replay ran in a process
        // that is gone; it is history now, like the tool calls above.
        const items = this.state.items.map((i) => {
          if (i.kind !== "tool") return i;
          const t = settle(i);
          if (!t.subagent) return t;
          return {
            ...t,
            subagent: {
              ...t.subagent,
              state: t.subagent.state === "running" ? "ended" : t.subagent.state,
              steps: t.subagent.steps.map((st) => (st.kind === "tool" ? settle(st) : st)),
            },
          };
        });
        this.set({ status: "ready", loading: false, items, configOptions: res?.configOptions ?? this.state.configOptions });
      } else {
        const res = await this.request("session/new", { cwd: this.cwd, mcpServers: [] });
        this.set({ status: "ready", sessionId: res.sessionId, configOptions: res.configOptions ?? [] });
      }
    } catch (e) {
      this.set({ loading: false });
      const err = e as Error & { code?: number };
      if (err.code === -32000 && this.state.authMethods.length > 0) {
        this.set({ status: "auth" });
        return;
      }
      throw e;
    }
  }

  private fail(e: unknown) {
    this.notice(`Could not start ${AGENTS[this.state.agent].name}: ${(e as Error).message ?? e}`, "error");
  }

  private onExit({ code, stderr }: { code: number | null; stderr: string }) {
    for (const p of this.pending.values()) p.reject(new Error("The agent exited"));
    this.pending.clear();
    this.promptsInFlight = 0;
    const why = stderr.trim() ? `\n${stderr.trim().split("\n").slice(-6).join("\n")}` : "";
    this.notice(`${AGENTS[this.state.agent].name} exited${code != null ? ` (code ${code})` : ""}.${why}`, code ? "error" : "info");
    this.set({ status: "exited", turnStartedAt: null });
  }

  private stopProcess() {
    this.unlisten.forEach((u) => u());
    this.unlisten = [];
    for (const p of this.pending.values()) p.reject(new Error("Closed"));
    this.pending.clear();
    this.promptsInFlight = 0;
    if (this.chatId) api.acpStop(this.chatId).catch(() => {});
  }

  dispose() {
    this.disposed = true;
    this.stopProcess();
    useChatMetaStore.getState().remove(this.paneId);
  }

  /** Start over with another agent, or a restarted one. Only before the
   *  conversation has begun, or after the agent died. */
  switchAgent(agent: AgentId) {
    rememberAgent(agent);
    this.stopProcess();
    this.itemSeq = 0;
    this.state = Chat.initialState(agent);
    this.report();
    this.listeners.forEach((fn) => fn());
    this.start();
  }

  async authenticate(methodId: string) {
    try {
      this.set({ status: "starting" });
      await this.request("authenticate", { methodId });
      await this.openSession();
    } catch (e) {
      this.set({ status: "auth" });
      this.notice(`Sign-in failed: ${(e as Error).message}`, "error");
    }
  }

  // --- sessions -----------------------------------------------------------

  async listSessions(): Promise<SessionSummary[]> {
    if (!this.state.canList) return [];
    const res = await this.request("session/list", { cwd: this.cwd });
    // The agent filters by checkout already; hold it to that, since a session
    // from another checkout would load against the wrong files.
    const sessions: SessionSummary[] = (res?.sessions ?? []).filter(
      (s: SessionSummary) => s.sessionId !== this.state.sessionId && (!s.cwd || s.cwd === this.cwd)
    );
    // A checkout has had many branches checked out; say which each was on.
    if (this.state.agent === "claude" && sessions.length) {
      const branches = await api.acpSessionBranches(this.cwd, sessions.map((s) => s.sessionId)).catch(() => ({}) as Record<string, string>);
      for (const s of sessions) s.branch = branches[s.sessionId];
    }
    return sessions;
  }

  /** Swap this pane's conversation for a past one. The one being left stays
   *  in the agent's history. */
  async loadSession(summary: SessionSummary) {
    if (this.state.status === "working") this.cancel();
    this.itemSeq = 0;
    this.set({
      items: [],
      plan: [],
      usage: null,
      totals: NO_TOTALS,
      title: summary.title ?? null,
      turnStartedAt: null,
      status: "starting",
    });
    try {
      await this.openSession(summary.sessionId);
    } catch (e) {
      this.set({ status: "ready" });
      this.notice(`Could not open that conversation: ${(e as Error).message}`, "error");
    }
  }

  /** A blank conversation in the same pane, with the same agent. */
  async newSession() {
    if (this.state.status === "working") this.cancel();
    this.itemSeq = 0;
    this.set({ items: [], plan: [], usage: null, totals: NO_TOTALS, title: null, turnStartedAt: null, status: "starting" });
    try {
      await this.openSession();
    } catch (e) {
      this.fail(e);
    }
  }

  // --- user actions -------------------------------------------------------

  /** `files` are @-mentions, relative to the checkout; `paths` are files
   *  attached by absolute path, from anywhere on disk. */
  async prompt(text: string, opts: { images?: ImageAttachment[]; files?: string[]; paths?: string[] } = {}) {
    const sessionId = this.state.sessionId;
    const images = opts.images ?? [];
    const paths = opts.paths ?? [];
    if (!sessionId || (!text.trim() && images.length === 0 && paths.length === 0)) return;
    if (text.trim()) this.sent.push(text);
    // Until the agent names the conversation, it is called what it was asked.
    if (!this.state.title && text.trim()) this.set({ title: text.trim().split("\n")[0].slice(0, 60) });
    this.push({
      kind: "user",
      id: this.newItemId(),
      text,
      images: images.length ? images : undefined,
      attached: paths.length ? paths : undefined,
    });

    this.promptsInFlight += 1;
    const startedAt = this.state.turnStartedAt ?? Date.now();
    this.set({ status: "working", turnStartedAt: startedAt });
    let stopReason: string | undefined;
    try {
      const blocks: object[] = [];
      if (text.trim()) blocks.push({ type: "text", text });
      const files = [
        ...(opts.files ?? []).map((f) => ({ abs: `${this.cwd}/${f}`, name: f })),
        ...paths.map((p) => ({ abs: p, name: p.split("/").pop() ?? p })),
      ];
      // Small text files go in whole, as `@file` does in Claude Code, so the
      // agent has them without spending a step (or a permission) opening
      // them. Anything big or binary goes as a link it can read from.
      const contents = await Promise.all(files.map((f) => api.acpReadText(f.abs).catch(() => null)));
      files.forEach((f, i) => {
        const uri = `file://${f.abs}`;
        const body = contents[i];
        blocks.push(
          body != null
            ? { type: "resource", resource: { uri, mimeType: "text/plain", text: body } }
            : { type: "resource_link", uri, name: f.name }
        );
      });
      for (const img of images) blocks.push({ type: "image", mimeType: img.mimeType, data: img.data });

      const res = await this.request("session/prompt", { sessionId, prompt: blocks });
      stopReason = res?.stopReason;
      // Each turn reports the tokens its requests used; the session's totals
      // are their sum, as Claude Code's own `/usage` counts them.
      const u = res?.usage;
      if (u) {
        const t = this.state.totals;
        this.set({
          totals: {
            turns: t.turns + 1,
            input: t.input + (u.inputTokens ?? 0),
            output: t.output + (u.outputTokens ?? 0),
            cacheRead: t.cacheRead + (u.cachedReadTokens ?? 0),
            cacheWrite: t.cacheWrite + (u.cachedWriteTokens ?? 0),
          },
        });
      }
    } catch (e) {
      if (!this.disposed && this.state.status !== "exited") this.notice((e as Error).message, "error");
      stopReason = "error";
    } finally {
      this.promptsInFlight = Math.max(0, this.promptsInFlight - 1);
      if (this.promptsInFlight === 0 && this.state.status === "working") {
        this.push({ kind: "turnEnd", id: this.newItemId(), durationMs: Date.now() - startedAt, stopReason });
        this.set({ status: "ready", turnStartedAt: null });
        this.flagIfUnwatched();
      }
    }
  }

  /** A finished turn or a question nobody is looking at marks the pane, and
   *  bounces the Dock when Lever is in the background. */
  private flagIfUnwatched() {
    if (this.watched && document.hasFocus()) return;
    useChatMetaStore.getState().patch(this.paneId, { attention: true });
    if (!document.hasFocus()) {
      import("@tauri-apps/api/window")
        .then(({ getCurrentWindow, UserAttentionType }) =>
          getCurrentWindow().requestUserAttention(UserAttentionType.Informational)
        )
        .catch(() => {});
    }
  }

  cancel() {
    const sessionId = this.state.sessionId;
    if (!sessionId) return;
    // The protocol asks a client cancelling a turn to answer whatever
    // permission requests are still open with "cancelled".
    for (const item of this.state.items) {
      if (item.kind === "permission" && !item.outcome) this.answer(item.id, null);
    }
    this.notify("session/cancel", { sessionId });
  }

  /** Answer a permission request: an option id, or null to cancel it. */
  answer(itemId: string, optionId: string | null) {
    const item = this.state.items.find((i) => i.id === itemId);
    if (!item || item.kind !== "permission" || item.outcome) return;
    this.write({
      id: item.rpcId,
      result: { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } },
    }).catch(() => {});
    this.set({
      items: this.state.items.map((i) => (i.id === itemId ? { ...item, outcome: optionId ?? "cancelled" } : i)),
    });
  }

  async setOption(configId: string, value: string) {
    const sessionId = this.state.sessionId;
    if (!sessionId) return;
    const before = this.state.configOptions;
    this.set({ configOptions: before.map((o) => (o.id === configId ? { ...o, currentValue: value } : o)) });
    try {
      const res = await this.request("session/set_config_option", { sessionId, configId, value });
      if (res?.configOptions) this.set({ configOptions: res.configOptions });
    } catch (e) {
      this.set({ configOptions: before });
      this.notice(`Could not change ${configId}: ${(e as Error).message}`, "error");
    }
  }

  /** The edits made after a message — what "restore code" would undo. */
  editsAfter(userItemId: string): ToolItem[] {
    const idx = this.state.items.findIndex((i) => i.id === userItemId);
    if (idx < 0) return [];
    return allTools(this.state.items.slice(idx + 1)).filter(
      (i) => i.status !== "failed" && i.content.some((c) => c.type === "diff")
    );
  }

  /**
   * Go back to just before one of your messages, as double-Esc does in Claude
   * Code. The conversation is forked at the reply before it, so the agent
   * forgets everything after; the original stays in History. With `code`, the
   * chat's own edits since then are undone too, newest first, each only if the
   * file still holds it exactly. Returns the message, for the composer.
   */
  async rewind(userItemId: string, opts: { code: boolean }): Promise<string | null> {
    const st = this.state;
    const idx = st.items.findIndex((i) => i.id === userItemId);
    const target = st.items[idx];
    if (!target || target.kind !== "user" || !st.sessionId || st.status !== "ready") return null;

    let reverted = 0;
    const skipped: string[] = [];
    if (opts.code) {
      const edits = this.editsAfter(userItemId).flatMap((t) => t.content.filter((c) => c.type === "diff" && c.path));
      for (const c of edits.reverse()) {
        try {
          await api.acpRevertEdit(c.path!, c.oldText ?? null, c.newText ?? "");
          reverted++;
        } catch (e) {
          skipped.push(String(e));
        }
      }
    }

    // The reply the conversation should end on: the last one before the
    // message. With none, rewinding means starting over.
    const before = st.items.slice(0, idx);
    const lastReply = [...before].reverse().find((i): i is Extract<ChatItem, { kind: "agent" }> => i.kind === "agent" && !!i.messageId);
    this.set({ status: "starting" });
    try {
      if (lastReply && st.canFork) {
        const res = await this.request("session/fork", {
          sessionId: st.sessionId,
          cwd: this.cwd,
          mcpServers: [],
          _meta: { jetbrains: { air: { fork: { version: 1, messageId: lastReply.messageId } } } },
        });
        this.set({ sessionId: res.sessionId, configOptions: res.configOptions ?? st.configOptions });
      } else {
        const res = await this.request("session/new", { cwd: this.cwd, mcpServers: [] });
        this.set({ sessionId: res.sessionId, configOptions: res.configOptions ?? st.configOptions });
      }
    } catch (e) {
      this.set({ status: "ready" });
      this.notice(`Could not rewind: ${(e as Error).message}`, "error");
      return null;
    }

    const lines = [`Rewound to before "${target.text.split("\n")[0].slice(0, 60)}". The conversation before the rewind is still in History.`];
    if (opts.code) {
      lines.push(
        reverted || !skipped.length ? `Undid ${reverted} ${reverted === 1 ? "edit" : "edits"}.` : "",
        skipped.length ? `Left ${skipped.length} as they are, changed since:\n${skipped.join("\n")}` : ""
      );
    }
    this.set({ items: before, plan: [], usage: null, status: "ready" });
    this.notice(lines.filter(Boolean).join(" "), skipped.length ? "error" : "info");
    return target.text;
  }

  /** Step through the agent's permission modes, as ⇧Tab does in Claude Code. */
  cycleMode() {
    const mode = this.state.configOptions.find((o) => o.id === "mode");
    if (!mode || mode.options.length < 2) return;
    const i = mode.options.findIndex((o) => o.value === mode.currentValue);
    this.setOption("mode", mode.options[(i + 1) % mode.options.length].value);
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const chats = new Map<string, Chat>();

/** The chat for a pane, started in `cwd` the first time it is asked for. */
export function ensureChat(paneId: string, cwd: string, init?: { agent?: AgentId; resumeSessionId?: string }): Chat {
  let chat = chats.get(paneId);
  if (!chat) {
    chat = new Chat(paneId, cwd, init?.agent ?? defaultAgent(), init?.resumeSessionId);
    chats.set(paneId, chat);
    chat.start();
  }
  return chat;
}

/** End a pane's chat and stop its agent. Only when the pane is truly closed. */
export function destroyChat(paneId: string) {
  const chat = chats.get(paneId);
  if (!chat) return;
  chat.dispose();
  chats.delete(paneId);
}

export function useChatState(chat: Chat): ChatState {
  return useSyncExternalStore(chat.subscribe, () => chat.state);
}

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  /** Each edit the chat made to the file, in order. An edit carries only the
   *  stretch it changed, not the whole file. */
  hunks: { before: string | null; after: string }[];
  /** The chat wrote the file from nothing. */
  created: boolean;
}

/** Every file this conversation's edits touched, with their edits. */
export function fileChanges(items: ChatItem[], cwd: string): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const item of allTools(items)) {
    if (item.status === "failed") continue;
    for (const c of item.content) {
      if (c.type !== "diff" || !c.path) continue;
      let f = byPath.get(c.path);
      if (!f) {
        f = { path: shortPath(c.path, cwd), added: 0, removed: 0, hunks: [], created: c.oldText == null };
        byPath.set(c.path, f);
      }
      const n = lineCounts(c.oldText ?? "", c.newText ?? "");
      f.added += n.added;
      f.removed += n.removed;
      f.hunks.push({ before: c.oldText ?? null, after: c.newText ?? "" });
    }
  }
  return [...byPath.values()];
}

/** How many different files a run of tool calls edited. */
export function editedFiles(items: ChatItem[]): number {
  const paths = new Set<string>();
  for (const item of items) {
    if (item.kind !== "tool") continue;
    for (const c of item.content) if (c.type === "diff" && c.path) paths.add(c.path);
  }
  return paths.size;
}

export function lineCounts(before: string, after: string) {
  let added = 0;
  let removed = 0;
  for (const r of lineDiff(before, after, Infinity)) {
    if (r.op === "+") added++;
    else if (r.op === "-") removed++;
  }
  return { added, removed };
}

export type DiffRow = { op: " " | "+" | "-" | "…"; text: string; a?: number; b?: number };

/** Longest-common-subsequence line diff with `context` unchanged lines kept
 *  around each change. A very large edit falls back to old-then-new. */
export function lineDiff(oldText: string, newText: string, context = 3): DiffRow[] {
  const a = oldText ? oldText.split("\n") : [];
  const b = newText ? newText.split("\n") : [];
  let all: DiffRow[];
  if (a.length * b.length > 4_000_000) {
    all = [
      ...a.map((text, i) => ({ op: "-" as const, text, a: i + 1 })),
      ...b.map((text, i) => ({ op: "+" as const, text, b: i + 1 })),
    ];
  } else {
    const dp: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    all = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        all.push({ op: " ", text: a[i], a: i + 1, b: j + 1 });
        i++;
        j++;
      } else if (i < a.length && (j === b.length || dp[i + 1][j] >= dp[i][j + 1])) {
        // Removals before additions, as every diff tool shows them.
        all.push({ op: "-", text: a[i], a: i + 1 });
        i++;
      } else {
        all.push({ op: "+", text: b[j], b: j + 1 });
        j++;
      }
    }
  }
  if (!isFinite(context)) return all;
  const near = new Array(all.length).fill(false);
  all.forEach((r, idx) => {
    if (r.op === " ") return;
    for (let k = Math.max(0, idx - context); k <= Math.min(all.length - 1, idx + context); k++) near[k] = true;
  });
  const out: DiffRow[] = [];
  all.forEach((r, idx) => {
    if (near[idx]) out.push(r);
    else if (out.length && out[out.length - 1].op !== "…") out.push({ op: "…", text: "" });
  });
  if (out.length && out[out.length - 1].op === "…") out.pop();
  return out;
}

/** A path as worth showing: relative inside the checkout, the last two
 *  segments outside it. */
export function shortPath(path: string, cwd: string): string {
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  if (path.startsWith(prefix)) return path.slice(prefix.length) || ".";
  const parts = path.split("/").filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : path;
}

/** Every absolute path in a line of text, shortened. Tool titles name files
 *  by their full path, which buries the part that matters. */
export function shortenPaths(text: string, cwd: string): string {
  return text.replace(/(?:\/[^\s/:"'`]+){2,}\/?/g, (m) => shortPath(m, cwd));
}

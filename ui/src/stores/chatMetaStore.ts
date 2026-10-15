import { create } from "zustand";
import type { AgentInfo } from "../types";
import type { SessionTotals } from "../lib/acpChat";

/**
 * What the rest of the window needs to know about each chat pane, without
 * subscribing to its whole transcript: whether its agent is working, whether
 * it finished a turn nobody has looked at yet, what the conversation is
 * called and how much it has changed. Keyed by pane id.
 *
 * Terminals report the same things through `serviceStore.agents`, as an
 * `AgentInfo` per terminal. Each chat gets one too (`info`), built here and
 * kept as the same object until something in it changes, so the sidebar and
 * tab bar can treat a chat exactly as they treat `claude` in a terminal.
 */
export interface ChatFacts {
  working: boolean;
  attention: boolean;
  agentName: string;
  title: string | null;
  linesAdded: number;
  linesRemoved: number;
  contextUsed: number;
  contextSize: number;
  costUsd: number | null;
  /** "Opus 5.5" — the model the chat's picker is on. */
  modelName: string | null;
  effort: string | null;
  fastMode: boolean | null;
  totals: SessionTotals;
}

export interface ChatMeta extends ChatFacts {
  info: AgentInfo;
}

const EMPTY: ChatFacts = {
  working: false,
  attention: false,
  agentName: "Claude",
  title: null,
  linesAdded: 0,
  linesRemoved: 0,
  contextUsed: 0,
  contextSize: 0,
  costUsd: null,
  modelName: null,
  effort: null,
  fastMode: null,
  totals: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** A chat described the way a terminal's agent is, for the sidebar, the tab
 *  bar and the status bar's meter. Context, cost, lines and session totals
 *  are the agent's own figures. What only a terminal's transcript or the
 *  statusLine bridge knows — the split of the last reply's context, the
 *  prompt cache's state — is left empty, and `origin` tells the meter so. */
function toAgentInfo(f: ChatFacts): AgentInfo {
  return {
    name: f.agentName,
    active: f.working,
    needsAttention: f.attention,
    usage: {
      origin: "chat",
      sessionId: "",
      sessionName: f.title,
      model: f.modelName,
      cliVersion: null,
      contextTokens: f.contextUsed,
      contextLimit: f.contextSize,
      contextLimitSource: "reported",
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      freshInputTokens: 0,
      replyTokens: 0,
      totalInputTokens: f.totals.input,
      totalOutputTokens: f.totals.output,
      totalCacheReadTokens: f.totals.cacheRead,
      totalCacheWriteTokens: f.totals.cacheWrite,
      sidechainOutputTokens: 0,
      turns: f.totals.turns,
      catchingUp: false,
      reported: {
        title: f.title,
        modelName: f.modelName ?? f.agentName,
        effort: f.effort,
        fastMode: f.fastMode,
        thinking: null,
        costUsd: f.costUsd,
        durationMs: null,
        apiDurationMs: null,
        linesAdded: f.linesAdded || f.linesRemoved ? f.linesAdded : null,
        linesRemoved: f.linesAdded || f.linesRemoved ? f.linesRemoved : null,
        cacheWarm: null,
        cacheTtl: null,
        cacheExpiresAt: null,
        cacheHitRatio: null,
        cacheRecacheTokens: null,
        cacheCarried: false,
        reportedAt: Math.floor(Date.now() / 1000),
      },
    },
  };
}

interface ChatMetaState {
  meta: Record<string, ChatMeta>;
  patch: (paneId: string, patch: Partial<ChatFacts>) => void;
  remove: (paneId: string) => void;
}

export const useChatMetaStore = create<ChatMetaState>((set) => ({
  meta: {},
  patch: (paneId, patch) =>
    set((s) => {
      const prev = s.meta[paneId];
      const base: ChatFacts = prev ?? EMPTY;
      const next: ChatFacts = { ...base, ...patch };
      if (prev && (Object.keys(next) as (keyof ChatFacts)[]).every((k) => next[k] === prev[k])) return s;
      return { meta: { ...s.meta, [paneId]: { ...next, info: toAgentInfo(next) } } };
    }),
  remove: (paneId) =>
    set((s) => {
      if (!(paneId in s.meta)) return s;
      const meta = { ...s.meta };
      delete meta[paneId];
      return { meta };
    }),
}));

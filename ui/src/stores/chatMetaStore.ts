import { create } from "zustand";
import type { AgentInfo } from "../types";

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
};

/** A chat described the way a terminal's agent is. Only the fields the
 *  sidebar and tab bar read are real; the token breakdown a terminal's
 *  transcript gives is not something a chat has. */
function toAgentInfo(f: ChatFacts): AgentInfo {
  return {
    name: f.agentName,
    active: f.working,
    needsAttention: f.attention,
    usage: {
      sessionId: "",
      sessionName: f.title,
      model: null,
      cliVersion: null,
      contextTokens: f.contextUsed,
      contextLimit: f.contextSize,
      contextLimitSource: "reported",
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      freshInputTokens: 0,
      replyTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      sidechainOutputTokens: 0,
      turns: 0,
      catchingUp: false,
      reported: {
        title: f.title,
        modelName: f.agentName,
        effort: null,
        fastMode: null,
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

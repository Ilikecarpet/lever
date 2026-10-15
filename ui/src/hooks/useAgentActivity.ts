import { useWorkspaceStore } from "../stores/workspaceStore";
import { useServiceStore } from "../stores/serviceStore";
import { useChatMetaStore, type ChatMeta } from "../stores/chatMetaStore";
import type { AgentInfo } from "../types";
import type { PaneNode, Workspace } from "../types/pane";
import { findNode } from "../lib/paneTree";

function collectPtyIds(node: PaneNode, out: string[]): void {
  if (node.type === "leaf") {
    if (node.ptyId) out.push(node.ptyId);
  } else {
    collectPtyIds(node.children[0], out);
    collectPtyIds(node.children[1], out);
  }
}

function collectChatPanes(node: PaneNode, out: string[]): void {
  if (node.type === "leaf") {
    if (node.kind === "chat") out.push(node.id);
  } else {
    collectChatPanes(node.children[0], out);
    collectChatPanes(node.children[1], out);
  }
}

/** The chat agent in these workspaces, preferring one that is working. */
function anyChatAgent(workspaces: Workspace[], meta: Record<string, ChatMeta>): AgentInfo | null {
  let found: AgentInfo | null = null;
  for (const w of workspaces) {
    const ids: string[] = [];
    collectChatPanes(w.root, ids);
    for (const id of ids) {
      const m = meta[id];
      if (!m) continue;
      if (m.working) return m.info;
      found = found ?? m.info;
    }
  }
  return found;
}

/** A terminal's agent and a chat's, as one: whichever is working, else
 *  whichever there is, terminals first as they were here before chats. */
function either(terminal: AgentInfo | null, chat: AgentInfo | null): AgentInfo | null {
  if (terminal?.active) return terminal;
  if (chat?.active) return chat;
  return terminal ?? chat;
}

/** Whether any chat pane in these workspaces satisfies `test`. */
function anyChat(workspaces: Workspace[], meta: Record<string, ChatMeta>, test: (m: ChatMeta) => boolean): boolean {
  for (const w of workspaces) {
    const ids: string[] = [];
    collectChatPanes(w.root, ids);
    if (ids.some((id) => meta[id] && test(meta[id]))) return true;
  }
  return false;
}

function anyWorktreeAgent(
  agents: Record<string, AgentInfo>,
  workspaces: Workspace[],
  worktreeId: string | null
): AgentInfo | null {
  let found: AgentInfo | null = null;
  for (const w of workspaces) {
    if (w.worktreeId !== worktreeId) continue;
    const ptyIds: string[] = [];
    collectPtyIds(w.root, ptyIds);
    for (const id of ptyIds) {
      const agent = agents[id];
      if (agent) {
        if (agent.active) return agent;
        found = found ?? agent;
      }
    }
  }
  return found;
}

/**
 * The AI agent CLI (e.g. "claude") running in any terminal pane belonging to
 * this worktree, or null. Pass null for the main repo context. Prefers an
 * actively-working agent when several terminals have one.
 */
export function useWorktreeAgent(worktreeId: string | null): AgentInfo | null {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const terminal = useServiceStore((s) => anyWorktreeAgent(s.agents, workspaces, worktreeId));
  const chat = useChatMetaStore((s) => anyChatAgent(workspaces.filter((w) => w.worktreeId === worktreeId), s.meta));
  return either(terminal, chat);
}

/**
 * The agent the user is looking at in this worktree: the one in the focused
 * pane, when the active workspace belongs here. A worktree can hold several
 * conversations, and a row that names one should name the one in front of
 * you — so this follows focus, and only falls back to `useWorktreeAgent`'s
 * pick when focus is elsewhere.
 */
export function useWorktreeFocusedAgent(worktreeId: string | null): AgentInfo | null {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const worktreeAgent = useWorktreeAgent(worktreeId);
  // A chat in the focused pane is the conversation in front of you.
  const focusedChat = useChatMetaStore((s) => {
    const active = workspaces.find((w) => w.id === activeWorkspaceId);
    if (!active || active.worktreeId !== worktreeId) return null;
    const pane = findNode(active.root, active.activePaneId);
    return pane?.type === "leaf" && pane.kind === "chat" ? s.meta[pane.id]?.info ?? null : null;
  });
  const focusedTerminal = useServiceStore((s) => {
    const active = workspaces.find((w) => w.id === activeWorkspaceId);
    if (active && active.worktreeId === worktreeId) {
      const pane = findNode(active.root, active.activePaneId);
      const ptyId = pane?.type === "leaf" ? pane.ptyId : null;
      const agent = ptyId ? s.agents[ptyId] : undefined;
      if (agent) return agent;
    }
    return null;
  });
  return focusedChat ?? focusedTerminal ?? worktreeAgent;
}

/**
 * True when any agent in this worktree has finished a turn that nobody has been
 * back to yet. Separate from `useWorktreeAgent` because the sidebar asks a
 * different question of it: not "what is running here" but "does this want me".
 */
export function useWorktreeNeedsAttention(worktreeId: string | null): boolean {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const chatWants = useChatMetaStore((s) =>
    anyChat(workspaces.filter((w) => w.worktreeId === worktreeId), s.meta, (m) => m.attention)
  );
  const terminalWants = useServiceStore((s) => {
    for (const w of workspaces) {
      if (w.worktreeId !== worktreeId) continue;
      const ptyIds: string[] = [];
      collectPtyIds(w.root, ptyIds);
      if (ptyIds.some((id) => s.agents[id]?.needsAttention)) return true;
    }
    return false;
  });
  return chatWants || terminalWants;
}

/** The same question, for one workspace — which tab to go to once you know
 *  which worktree. */
export function useWorkspaceNeedsAttention(workspaceId: string): boolean {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const chatWants = useChatMetaStore((s) =>
    anyChat(workspaces.filter((x) => x.id === workspaceId), s.meta, (m) => m.attention)
  );
  const terminalWants = useServiceStore((s) => {
    const w = workspaces.find((x) => x.id === workspaceId);
    if (!w) return false;
    const ptyIds: string[] = [];
    collectPtyIds(w.root, ptyIds);
    return ptyIds.some((id) => s.agents[id]?.needsAttention);
  });
  return chatWants || terminalWants;
}

/** A chat in this workspace has its agent mid-turn. */
export function useWorkspaceChatWorking(workspaceId: string): boolean {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  return useChatMetaStore((s) => anyChat(workspaces.filter((x) => x.id === workspaceId), s.meta, (m) => m.working));
}

/**
 * The agent running in the focused terminal pane, or null. This is the one the
 * status bar reports on — usage is per-session, so it has to follow a single
 * terminal rather than aggregate whatever happens to be running.
 */
export function useFocusedPaneAgent(): AgentInfo | null {
  const ptyId = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
    if (!ws) return null;
    const pane = findNode(ws.root, ws.activePaneId);
    return pane?.type === "leaf" ? pane.ptyId : null;
  });
  return useServiceStore((s) => (ptyId ? s.agents[ptyId] ?? null : null));
}

import { useWorkspaceStore } from "../stores/workspaceStore";
import { useServiceStore } from "../stores/serviceStore";
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
  return useServiceStore((s) => anyWorktreeAgent(s.agents, workspaces, worktreeId));
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
  return useServiceStore((s) => {
    const active = workspaces.find((w) => w.id === activeWorkspaceId);
    if (active && active.worktreeId === worktreeId) {
      const pane = findNode(active.root, active.activePaneId);
      const ptyId = pane?.type === "leaf" ? pane.ptyId : null;
      const agent = ptyId ? s.agents[ptyId] : undefined;
      if (agent) return agent;
    }
    return anyWorktreeAgent(s.agents, workspaces, worktreeId);
  });
}

/**
 * True when any agent in this worktree has finished a turn that nobody has been
 * back to yet. Separate from `useWorktreeAgent` because the sidebar asks a
 * different question of it: not "what is running here" but "does this want me".
 */
export function useWorktreeNeedsAttention(worktreeId: string | null): boolean {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  return useServiceStore((s) => {
    for (const w of workspaces) {
      if (w.worktreeId !== worktreeId) continue;
      const ptyIds: string[] = [];
      collectPtyIds(w.root, ptyIds);
      if (ptyIds.some((id) => s.agents[id]?.needsAttention)) return true;
    }
    return false;
  });
}

/** The same question, for one workspace — which tab to go to once you know
 *  which worktree. */
export function useWorkspaceNeedsAttention(workspaceId: string): boolean {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  return useServiceStore((s) => {
    const w = workspaces.find((x) => x.id === workspaceId);
    if (!w) return false;
    const ptyIds: string[] = [];
    collectPtyIds(w.root, ptyIds);
    return ptyIds.some((id) => s.agents[id]?.needsAttention);
  });
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

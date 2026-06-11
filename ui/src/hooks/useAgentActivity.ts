import { useWorkspaceStore } from "../stores/workspaceStore";
import { useServiceStore } from "../stores/serviceStore";
import type { AgentInfo } from "../types";
import type { PaneNode } from "../types/pane";

function collectPtyIds(node: PaneNode, out: string[]): void {
  if (node.type === "leaf") {
    if (node.ptyId) out.push(node.ptyId);
  } else {
    collectPtyIds(node.children[0], out);
    collectPtyIds(node.children[1], out);
  }
}

/**
 * The AI agent CLI (e.g. "claude") running in any terminal pane belonging to
 * this worktree, or null. Pass null for the main repo context. Prefers an
 * actively-working agent when several terminals have one.
 */
export function useWorktreeAgent(worktreeId: string | null): AgentInfo | null {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  return useServiceStore((s) => {
    let found: AgentInfo | null = null;
    for (const w of workspaces) {
      if (w.worktreeId !== worktreeId) continue;
      const ptyIds: string[] = [];
      collectPtyIds(w.root, ptyIds);
      for (const id of ptyIds) {
        const agent = s.agents[id];
        if (agent) {
          if (agent.active) return agent;
          found = found ?? agent;
        }
      }
    }
    return found;
  });
}

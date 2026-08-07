import { useWorktreeStore } from "../stores/worktreeStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

/**
 * Switch the main area to a worktree context (null = main repo).
 * Activates the context's first workspace; a worktree with none gets one
 * created. The main repo with none shows the empty state (active workspace
 * cleared so another context's panes don't stay visible).
 */
export function switchContext(worktreeId: string | null) {
  useWorktreeStore.getState().setActiveWorktree(worktreeId);
  const ws = useWorkspaceStore.getState();
  const first = ws.workspaces.find((w) => w.worktreeId === worktreeId);
  if (first) {
    ws.setActiveWorkspace(first.id);
  } else if (worktreeId) {
    ws.addWorkspaceForWorktree(worktreeId);
  } else {
    ws.setActiveWorkspace(null);
  }
}

/** Cycle through contexts in sidebar order: main repo, then each worktree. */
export function cycleContext(direction: 1 | -1) {
  const { worktrees, activeWorktreeId } = useWorktreeStore.getState();
  const order: (string | null)[] = [null, ...worktrees.map((w) => w.id)];
  if (order.length < 2) return;
  const idx = order.indexOf(activeWorktreeId);
  const next = order[(idx + direction + order.length) % order.length];
  switchContext(next);
}

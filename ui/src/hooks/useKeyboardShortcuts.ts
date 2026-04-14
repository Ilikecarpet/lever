import { useEffect } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useWorktreeStore } from "../stores/worktreeStore";

/** Return the worktree context: current workspace's worktreeId, or the global activeWorktreeId. */
function currentWorktreeId(): string | null {
  const store = useWorkspaceStore.getState();
  const currentWs = store.workspaces.find((w) => w.id === store.activeWorkspaceId);
  return currentWs?.worktreeId ?? useWorktreeStore.getState().activeWorktreeId;
}

/** Return workspaces scoped to the current worktree context. */
function contextWorkspaces() {
  const store = useWorkspaceStore.getState();
  const wtId = currentWorktreeId();
  return store.workspaces.filter((w) => w.worktreeId === wtId);
}

export function useKeyboardShortcuts() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;

      const store = useWorkspaceStore.getState();

      // Cmd+D — split vertical (only if active workspace is in current context)
      if (e.key === "d" && !e.shiftKey) {
        e.preventDefault();
        const scoped = contextWorkspaces();
        if (scoped.some((w) => w.id === store.activeWorkspaceId)) {
          store.splitPane("vertical");
        }
        return;
      }

      // Cmd+Shift+D — split horizontal
      if (e.key === "D" || (e.key === "d" && e.shiftKey)) {
        e.preventDefault();
        const scoped = contextWorkspaces();
        if (scoped.some((w) => w.id === store.activeWorkspaceId)) {
          store.splitPane("horizontal");
        }
        return;
      }

      // Cmd+W — close pane (only if active workspace is in current context)
      if (e.key === "w" && !e.shiftKey) {
        e.preventDefault();
        const scoped = contextWorkspaces();
        if (scoped.some((w) => w.id === store.activeWorkspaceId)) {
          store.closePane();
        }
        return;
      }

      // Cmd+T — new workspace in current worktree context
      if (e.key === "t" && !e.shiftKey) {
        e.preventDefault();
        const wtId = currentWorktreeId();
        if (wtId) {
          store.addWorkspaceForWorktree(wtId);
        } else {
          store.addWorkspace();
        }
        return;
      }

      // Cmd+] — focus next pane
      if (e.key === "]" && !e.shiftKey) {
        e.preventDefault();
        store.focusNextPane();
        return;
      }

      // Cmd+[ — focus prev pane
      if (e.key === "[" && !e.shiftKey) {
        e.preventDefault();
        store.focusPrevPane();
        return;
      }

      // Cmd+1..9 — switch to workspace by index (scoped to current context)
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= 9) {
        e.preventDefault();
        const scoped = contextWorkspaces();
        const ws = scoped[num - 1];
        if (ws) store.setActiveWorkspace(ws.id);
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}

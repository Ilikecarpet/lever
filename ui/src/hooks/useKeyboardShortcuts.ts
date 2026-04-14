import { useEffect } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useWorktreeStore } from "../stores/worktreeStore";

export function useKeyboardShortcuts() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;

      const store = useWorkspaceStore.getState();

      // Cmd+D — split vertical
      if (e.key === "d" && !e.shiftKey) {
        e.preventDefault();
        store.splitPane("vertical");
        return;
      }

      // Cmd+Shift+D — split horizontal
      if (e.key === "D" || (e.key === "d" && e.shiftKey)) {
        e.preventDefault();
        store.splitPane("horizontal");
        return;
      }

      // Cmd+W — close pane
      if (e.key === "w" && !e.shiftKey) {
        e.preventDefault();
        store.closePane();
        return;
      }

      // Cmd+T — new workspace (inherits worktree from current workspace)
      if (e.key === "t" && !e.shiftKey) {
        e.preventDefault();
        const currentWs = store.workspaces.find((w) => w.id === store.activeWorkspaceId);
        const wtId = currentWs?.worktreeId ?? useWorktreeStore.getState().activeWorktreeId;
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

      // Cmd+1..9 — switch to workspace by index
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= 9) {
        e.preventDefault();
        const ws = store.workspaces[num - 1];
        if (ws) store.setActiveWorkspace(ws.id);
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}

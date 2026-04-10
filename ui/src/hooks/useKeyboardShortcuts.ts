import { useEffect } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";

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

      // Cmd+T — new workspace
      if (e.key === "t" && !e.shiftKey) {
        e.preventDefault();
        store.addWorkspace();
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

      // Cmd+Shift+] — next workspace
      if (e.key === "}" || (e.key === "]" && e.shiftKey)) {
        e.preventDefault();
        const { workspaces, activeWorkspaceId } = store;
        const idx = workspaces.findIndex((w) => w.id === activeWorkspaceId);
        const next = workspaces[(idx + 1) % workspaces.length];
        if (next) store.setActiveWorkspace(next.id);
        return;
      }

      // Cmd+Shift+[ — prev workspace
      if (e.key === "{" || (e.key === "[" && e.shiftKey)) {
        e.preventDefault();
        const { workspaces, activeWorkspaceId } = store;
        const idx = workspaces.findIndex((w) => w.id === activeWorkspaceId);
        const prev =
          workspaces[(idx - 1 + workspaces.length) % workspaces.length];
        if (prev) store.setActiveWorkspace(prev.id);
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}

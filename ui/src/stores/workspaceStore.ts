import { create } from "zustand";
import type { Workspace, PaneNode, PaneKind } from "../types/pane";
import {
  makeLeaf,
  nextId,
  splitNode,
  removeNode,
  updateRatio,
  collectLeaves,
  setPtyIdInTree,
  setTitleInTree,
} from "../lib/paneTree";
import { destroyPty } from "../hooks/usePty";
import { destroyChat } from "../lib/acpChat";
import { useDbStore } from "./dbStore";
import { useSettingsStore } from "./settingsStore";

/** Whatever the pane holds — shell or chat — goes with it. */
function destroyPane(paneId: string) {
  destroyPty(paneId);
  destroyChat(paneId);
  useDbStore.getState().dropPane(paneId);
}

interface WorkspaceState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;

  addWorkspace: (kind?: PaneKind) => string;
  addWorkspaceForWorktree: (worktreeId: string, kind?: PaneKind) => string;
  /** Focuses the connection's tab in a context, opening one if it has none. */
  openDatabase: (connId: string, label: string, worktreeId: string | null) => string;
  /** Closes every tab on a connection, when it is deleted. */
  closeDatabase: (connId: string) => void;
  renameDatabase: (connId: string, label: string) => void;
  closeWorkspace: (id: string) => void;
  closeWorktreeWorkspaces: (worktreeId: string) => void;
  setActiveWorkspace: (id: string | null) => void;
  renameWorkspace: (id: string, label: string) => void;
  moveWorkspace: (fromIndex: number, toIndex: number) => void;

  splitPane: (direction: "horizontal" | "vertical") => void;
  closePane: () => void;
  resizePane: (splitId: string, ratio: number) => void;
  setActivePane: (paneId: string) => void;
  focusNextPane: () => void;
  focusPrevPane: () => void;
  setPtyId: (paneId: string, ptyId: string) => void;
  setPaneTitle: (paneId: string, title: string) => void;
}

function createWorkspace(label: string, worktreeId: string | null = null, kind: PaneKind = "terminal"): Workspace {
  const leaf = makeLeaf(kind);
  return {
    id: nextId("ws"),
    label,
    root: leaf,
    activePaneId: leaf.id,
    worktreeId,
  };
}

function nextWorkspaceName(workspaces: Workspace[], kind: PaneKind = "terminal"): string {
  const base = kind === "chat" ? "Chat" : "Workspace";
  const pattern = new RegExp(`^${base} (\\d+)$`);
  const numbers = workspaces
    .map((w) => w.label.match(pattern))
    .filter(Boolean)
    .map((m) => parseInt(m![1], 10));
  const max = numbers.length > 0 ? Math.max(...numbers) : 0;
  return `${base} ${max + 1}`;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,

  // A tab opened without saying what it is — the first one at startup, a new
  // worktree's, the one a worktree with none gets when you switch to it — is
  // whatever Settings says new tabs open as.
  addWorkspace: (kind = useSettingsStore.getState().defaultPaneKind) => {
    const ws = createWorkspace(nextWorkspaceName(get().workspaces, kind), null, kind);
    set((s) => ({
      workspaces: [...s.workspaces, ws],
      activeWorkspaceId: ws.id,
    }));
    return ws.id;
  },

  addWorkspaceForWorktree: (worktreeId, kind = useSettingsStore.getState().defaultPaneKind) => {
    const allWs = get().workspaces;
    const wtWorkspaces = allWs.filter((w) => w.worktreeId === worktreeId);
    const ws = createWorkspace(nextWorkspaceName(wtWorkspaces, kind), worktreeId, kind);
    set((s) => ({
      workspaces: [...s.workspaces, ws],
      activeWorkspaceId: ws.id,
    }));
    return ws.id;
  },

  openDatabase: (connId, label, worktreeId) => {
    const existing = get().workspaces.find(
      (w) => w.worktreeId === worktreeId && w.root.type === "leaf" && w.root.dbConnId === connId
    );
    if (existing) {
      set({ activeWorkspaceId: existing.id });
      return existing.id;
    }
    const leaf = { ...makeLeaf("db"), dbConnId: connId };
    const ws: Workspace = { id: nextId("ws"), label, root: leaf, activePaneId: leaf.id, worktreeId };
    set((s) => ({ workspaces: [...s.workspaces, ws], activeWorkspaceId: ws.id }));
    return ws.id;
  },

  closeDatabase: (connId) => {
    const onIt = get().workspaces.filter((w) =>
      collectLeaves(w.root).some((l) => l.dbConnId === connId)
    );
    for (const ws of onIt) {
      if (ws.root.type === "leaf") {
        get().closeWorkspace(ws.id);
        continue;
      }
      // Split with a terminal: only the database pane goes.
      for (const leaf of collectLeaves(ws.root).filter((l) => l.dbConnId === connId)) {
        const root = removeNode(ws.root, leaf.id);
        if (!root) continue;
        destroyPane(leaf.id);
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === ws.id ? { ...w, root, activePaneId: collectLeaves(root)[0].id } : w
          ),
        }));
      }
    }
  },

  renameDatabase: (connId, label) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.root.type === "leaf" && w.root.dbConnId === connId ? { ...w, label } : w
      ),
    }));
  },

  closeWorkspace: (id) => {
    const ws = get().workspaces.find((w) => w.id === id);
    if (ws) {
      collectLeaves(ws.root).forEach((leaf) => destroyPane(leaf.id));
    }
    set((s) => {
      const workspaces = s.workspaces.filter((w) => w.id !== id);
      let activeWorkspaceId = s.activeWorkspaceId;
      if (activeWorkspaceId === id) {
        // Prefer another workspace in the same worktree context
        const sameContext = workspaces.filter((w) => w.worktreeId === ws?.worktreeId);
        activeWorkspaceId = sameContext[0]?.id ?? null;
      }
      return { workspaces, activeWorkspaceId };
    });
  },

  closeWorktreeWorkspaces: (worktreeId) => {
    const toClose = get().workspaces.filter((w) => w.worktreeId === worktreeId);
    for (const ws of toClose) {
      collectLeaves(ws.root).forEach((leaf) => destroyPane(leaf.id));
    }
    set((s) => {
      const workspaces = s.workspaces.filter((w) => w.worktreeId !== worktreeId);
      let activeWorkspaceId = s.activeWorkspaceId;
      if (toClose.some((w) => w.id === activeWorkspaceId)) {
        activeWorkspaceId = workspaces[0]?.id ?? null;
      }
      return { workspaces, activeWorkspaceId };
    });
  },

  setActiveWorkspace: (id) => {
    set({ activeWorkspaceId: id });
  },

  renameWorkspace: (id, label) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === id ? { ...w, label } : w
      ),
    }));
  },

  moveWorkspace: (fromIndex, toIndex) => {
    set((s) => {
      const ws = [...s.workspaces];
      const [moved] = ws.splice(fromIndex, 1);
      ws.splice(toIndex, 0, moved);
      return { workspaces: ws };
    });
  },

  splitPane: (direction) => {
    const { workspaces, activeWorkspaceId } = get();
    const ws = workspaces.find((w) => w.id === activeWorkspaceId);
    if (!ws) return;

    const result = splitNode(ws.root, ws.activePaneId, direction);
    if (!result) return;

    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === activeWorkspaceId
          ? { ...w, root: result.root, activePaneId: result.newLeafId }
          : w
      ),
    }));
  },

  closePane: () => {
    const { workspaces, activeWorkspaceId } = get();
    const ws = workspaces.find((w) => w.id === activeWorkspaceId);
    if (!ws) return;

    const closedPaneId = ws.activePaneId;
    const newRoot = removeNode(ws.root, closedPaneId);

    if (newRoot === null) {
      get().closeWorkspace(ws.id);
      return;
    }

    destroyPane(closedPaneId);

    const leaves = collectLeaves(newRoot);
    const newActive = leaves[0]?.id ?? ws.activePaneId;

    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === activeWorkspaceId
          ? { ...w, root: newRoot, activePaneId: newActive }
          : w
      ),
    }));
  },

  resizePane: (splitId, ratio) => {
    const { activeWorkspaceId } = get();
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== activeWorkspaceId) return w;
        const newRoot = updateRatio(w.root, splitId, ratio);
        return newRoot ? { ...w, root: newRoot } : w;
      }),
    }));
  },

  setActivePane: (paneId) => {
    const { activeWorkspaceId } = get();
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === activeWorkspaceId ? { ...w, activePaneId: paneId } : w
      ),
    }));
  },

  focusNextPane: () => {
    const { workspaces, activeWorkspaceId } = get();
    const ws = workspaces.find((w) => w.id === activeWorkspaceId);
    if (!ws) return;
    const leaves = collectLeaves(ws.root);
    const idx = leaves.findIndex((l) => l.id === ws.activePaneId);
    const next = leaves[(idx + 1) % leaves.length];
    if (next) get().setActivePane(next.id);
  },

  focusPrevPane: () => {
    const { workspaces, activeWorkspaceId } = get();
    const ws = workspaces.find((w) => w.id === activeWorkspaceId);
    if (!ws) return;
    const leaves = collectLeaves(ws.root);
    const idx = leaves.findIndex((l) => l.id === ws.activePaneId);
    const prev = leaves[(idx - 1 + leaves.length) % leaves.length];
    if (prev) get().setActivePane(prev.id);
  },

  setPtyId: (paneId, ptyId) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        const newRoot = setPtyIdInTree(w.root, paneId, ptyId);
        return newRoot ? { ...w, root: newRoot } : w;
      }),
    }));
  },

  setPaneTitle: (paneId, title) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        const newRoot = setTitleInTree(w.root, paneId, title);
        return newRoot ? { ...w, root: newRoot } : w;
      }),
    }));
  },
}));

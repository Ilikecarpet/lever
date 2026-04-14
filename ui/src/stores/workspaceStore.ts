import { create } from "zustand";
import type { Workspace, PaneNode } from "../types/pane";
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

interface WorkspaceState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;

  addWorkspace: () => string;
  addWorkspaceForWorktree: (worktreeId: string) => string;
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

function createWorkspace(label: string, worktreeId: string | null = null): Workspace {
  const leaf = makeLeaf();
  return {
    id: nextId("ws"),
    label,
    root: leaf,
    activePaneId: leaf.id,
    worktreeId,
  };
}

function nextWorkspaceName(workspaces: Workspace[]): string {
  const numbers = workspaces
    .map((w) => w.label.match(/^Workspace (\d+)$/))
    .filter(Boolean)
    .map((m) => parseInt(m![1], 10));
  const max = numbers.length > 0 ? Math.max(...numbers) : 0;
  return `Workspace ${max + 1}`;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,

  addWorkspace: () => {
    const ws = createWorkspace(nextWorkspaceName(get().workspaces), null);
    set((s) => ({
      workspaces: [...s.workspaces, ws],
      activeWorkspaceId: ws.id,
    }));
    return ws.id;
  },

  addWorkspaceForWorktree: (worktreeId) => {
    const allWs = get().workspaces;
    const wtWorkspaces = allWs.filter((w) => w.worktreeId === worktreeId);
    const ws = createWorkspace(nextWorkspaceName(wtWorkspaces), worktreeId);
    set((s) => ({
      workspaces: [...s.workspaces, ws],
      activeWorkspaceId: ws.id,
    }));
    return ws.id;
  },

  closeWorkspace: (id) => {
    const ws = get().workspaces.find((w) => w.id === id);
    if (ws) {
      collectLeaves(ws.root).forEach((leaf) => destroyPty(leaf.id));
    }
    set((s) => {
      const workspaces = s.workspaces.filter((w) => w.id !== id);
      let activeWorkspaceId = s.activeWorkspaceId;
      if (activeWorkspaceId === id) {
        const idx = s.workspaces.findIndex((w) => w.id === id);
        activeWorkspaceId =
          workspaces[Math.min(idx, workspaces.length - 1)]?.id ?? null;
      }
      return { workspaces, activeWorkspaceId };
    });
  },

  closeWorktreeWorkspaces: (worktreeId) => {
    const toClose = get().workspaces.filter((w) => w.worktreeId === worktreeId);
    for (const ws of toClose) {
      collectLeaves(ws.root).forEach((leaf) => destroyPty(leaf.id));
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

    destroyPty(closedPaneId);

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

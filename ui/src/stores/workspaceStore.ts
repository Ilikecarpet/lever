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
} from "../lib/paneTree";

interface WorkspaceState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;

  addWorkspace: () => string;
  closeWorkspace: (id: string) => void;
  setActiveWorkspace: (id: string | null) => void;
  renameWorkspace: (id: string, label: string) => void;

  splitPane: (direction: "horizontal" | "vertical") => void;
  closePane: () => void;
  resizePane: (splitId: string, ratio: number) => void;
  setActivePane: (paneId: string) => void;
  focusNextPane: () => void;
  focusPrevPane: () => void;
  setPtyId: (paneId: string, ptyId: string) => void;
}

function createWorkspace(label: string): Workspace {
  const leaf = makeLeaf();
  return {
    id: nextId("ws"),
    label,
    root: leaf,
    activePaneId: leaf.id,
  };
}

let wsCounter = 0;

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,

  addWorkspace: () => {
    wsCounter++;
    const ws = createWorkspace(`Workspace ${wsCounter}`);
    set((s) => ({
      workspaces: [...s.workspaces, ws],
      activeWorkspaceId: ws.id,
    }));
    return ws.id;
  },

  closeWorkspace: (id) => {
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

    const newRoot = removeNode(ws.root, ws.activePaneId);

    if (newRoot === null) {
      get().closeWorkspace(ws.id);
      if (get().workspaces.length === 0) {
        get().addWorkspace();
      }
      return;
    }

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
      workspaces: s.workspaces.map((w) =>
        w.id === activeWorkspaceId
          ? { ...w, root: updateRatio(w.root, splitId, ratio) }
          : w
      ),
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
      workspaces: s.workspaces.map((w) => ({
        ...w,
        root: setPtyIdInTree(w.root, paneId, ptyId),
      })),
    }));
  },
}));

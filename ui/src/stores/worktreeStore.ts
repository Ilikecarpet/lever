import { create } from "zustand";
import type { WorktreeDef } from "../types";
import * as api from "../lib/tauri";

interface WorktreeState {
  worktrees: WorktreeDef[];
  activeWorktreeId: string | null;

  setWorktrees: (worktrees: WorktreeDef[]) => void;
  setActiveWorktree: (id: string | null) => void;
  addWorktree: (worktree: WorktreeDef) => void;
  removeWorktree: (id: string) => void;

  createWorktree: (branch: string, path: string) => Promise<WorktreeDef>;
  deleteWorktree: (worktreeId: string, cleanup: boolean) => Promise<void>;
}

export const useWorktreeStore = create<WorktreeState>((set, get) => ({
  worktrees: [],
  activeWorktreeId: null,

  setWorktrees: (worktrees) => set({ worktrees }),

  setActiveWorktree: (id) => set({ activeWorktreeId: id }),

  addWorktree: (worktree) =>
    set((s) => ({ worktrees: [...s.worktrees, worktree] })),

  removeWorktree: (id) =>
    set((s) => ({
      worktrees: s.worktrees.filter((w) => w.id !== id),
      activeWorktreeId: s.activeWorktreeId === id ? null : s.activeWorktreeId,
    })),

  createWorktree: async (branch, path) => {
    const projectId = api.getProjectId();
    if (!projectId) throw new Error("No project ID");
    const worktree = await api.createWorktree(projectId, branch, path);
    get().addWorktree(worktree);
    return worktree;
  },

  deleteWorktree: async (worktreeId, cleanup) => {
    const projectId = api.getProjectId();
    if (!projectId) throw new Error("No project ID");
    await api.removeWorktree(projectId, worktreeId, cleanup);
    get().removeWorktree(worktreeId);
  },
}));

import { create } from "zustand";
import type { GitRepoInfo } from "../types";
import * as api from "../lib/tauri";

interface GitState {
  repoPath: string;
  gitInfo: GitRepoInfo | null;
  worktreeGitInfo: Record<string, GitRepoInfo>;
  activeGitGroupId: string | null;
  statusMessage: string | null;

  setRepoPath: (path: string) => void;
  refreshGitInfo: () => Promise<void>;
  refreshWorktreeGitInfo: (worktreeId: string, worktreePath: string) => Promise<void>;
  fetch: () => Promise<void>;
  pull: () => Promise<void>;
  setActiveGitGroup: (groupId: string | null) => void;
  setStatusMessage: (msg: string | null) => void;
}

function autoClearStatus(set: (partial: Partial<GitState>) => void) {
  setTimeout(() => {
    set({ statusMessage: null });
  }, 3500);
}

export const useGitStore = create<GitState>((set, get) => ({
  repoPath: "",
  gitInfo: null,
  worktreeGitInfo: {},
  activeGitGroupId: null,
  statusMessage: null,

  setRepoPath: (path) => set({ repoPath: path }),

  refreshGitInfo: async () => {
    const { repoPath } = get();
    if (!repoPath) return;
    try {
      const info = await api.gitInfo(repoPath);
      set({ gitInfo: info });
    } catch (e) {
      console.error("Failed to get git info:", e);
    }
  },

  refreshWorktreeGitInfo: async (worktreeId, worktreePath) => {
    if (!worktreePath) return;
    try {
      const info = await api.gitInfo(worktreePath);
      set((s) => ({
        worktreeGitInfo: { ...s.worktreeGitInfo, [worktreeId]: info },
      }));
    } catch (e) {
      console.error(`Failed to get worktree git info for ${worktreeId}:`, e);
    }
  },

  fetch: async () => {
    const { repoPath } = get();
    if (!repoPath) return;
    try {
      set({ statusMessage: "Fetching..." });
      await api.gitFetch(repoPath);
      await get().refreshGitInfo();
      set({ statusMessage: "Fetch complete" });
      autoClearStatus(set);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ statusMessage: `Fetch failed: ${msg}` });
      autoClearStatus(set);
    }
  },

  pull: async () => {
    const { repoPath } = get();
    if (!repoPath) return;
    try {
      set({ statusMessage: "Pulling..." });
      const result = await api.gitPull(repoPath);
      await get().refreshGitInfo();
      const summary = result.trim().split("\n")[0] || "Pull complete";
      set({ statusMessage: summary });
      autoClearStatus(set);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ statusMessage: `Pull failed: ${msg}` });
      autoClearStatus(set);
    }
  },

  setActiveGitGroup: (groupId) => {
    set({ activeGitGroupId: groupId });
  },

  setStatusMessage: (msg) => {
    set({ statusMessage: msg });
    if (msg) autoClearStatus(set);
  },
}));

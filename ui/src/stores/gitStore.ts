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
  stage: (filePath: string) => Promise<void>;
  unstage: (filePath: string) => Promise<void>;
  stageMany: (filePaths: string[]) => Promise<void>;
  unstageMany: (filePaths: string[]) => Promise<void>;
  stageAll: () => Promise<void>;
  unstageAll: () => Promise<void>;
  discard: (filePath: string) => Promise<void>;
  setActiveGitGroup: (groupId: string | null) => void;
  setStatusMessage: (msg: string | null) => void;
}

function autoClearStatus(set: (partial: Partial<GitState>) => void) {
  setTimeout(() => {
    set({ statusMessage: null });
  }, 3500);
}

// Keep the same reference when nothing changed so the 5s git poll doesn't
// re-render subscribers needlessly.
function gitInfoEqual(a: GitRepoInfo | null | undefined, b: GitRepoInfo): boolean {
  if (!a) return false;
  if (a.current_branch !== b.current_branch || a.is_dirty !== b.is_dirty) return false;
  if (a.changed_files.length !== b.changed_files.length) return false;
  return a.changed_files.every((f, i) => {
    const g = b.changed_files[i];
    return (
      f.path === g.path &&
      f.status === g.status &&
      f.staged === g.staged &&
      f.is_dir === g.is_dir
    );
  });
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
      if (!gitInfoEqual(get().gitInfo, info)) {
        set({ gitInfo: info });
      }
    } catch (e) {
      console.error("Failed to get git info:", e);
    }
  },

  refreshWorktreeGitInfo: async (worktreeId, worktreePath) => {
    if (!worktreePath) return;
    try {
      const info = await api.gitInfo(worktreePath);
      if (!gitInfoEqual(get().worktreeGitInfo[worktreeId], info)) {
        set((s) => ({
          worktreeGitInfo: { ...s.worktreeGitInfo, [worktreeId]: info },
        }));
      }
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

  stage: async (filePath) => {
    const { repoPath } = get();
    if (!repoPath) return;
    try {
      await api.gitStage(repoPath, filePath);
      await get().refreshGitInfo();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ statusMessage: `Stage failed: ${msg}` });
      autoClearStatus(set);
    }
  },

  unstage: async (filePath) => {
    const { repoPath } = get();
    if (!repoPath) return;
    try {
      await api.gitUnstage(repoPath, filePath);
      await get().refreshGitInfo();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ statusMessage: `Unstage failed: ${msg}` });
      autoClearStatus(set);
    }
  },

  stageMany: async (filePaths) => {
    const { repoPath } = get();
    if (!repoPath || filePaths.length === 0) return;
    try {
      await api.gitStageMany(repoPath, filePaths);
      await get().refreshGitInfo();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ statusMessage: `Stage failed: ${msg}` });
      autoClearStatus(set);
    }
  },

  unstageMany: async (filePaths) => {
    const { repoPath } = get();
    if (!repoPath || filePaths.length === 0) return;
    try {
      await api.gitUnstageMany(repoPath, filePaths);
      await get().refreshGitInfo();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ statusMessage: `Unstage failed: ${msg}` });
      autoClearStatus(set);
    }
  },

  stageAll: async () => {
    const { repoPath } = get();
    if (!repoPath) return;
    try {
      await api.gitStageAll(repoPath);
      await get().refreshGitInfo();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ statusMessage: `Stage all failed: ${msg}` });
      autoClearStatus(set);
    }
  },

  unstageAll: async () => {
    const { repoPath } = get();
    if (!repoPath) return;
    try {
      await api.gitUnstageAll(repoPath);
      await get().refreshGitInfo();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ statusMessage: `Unstage all failed: ${msg}` });
      autoClearStatus(set);
    }
  },

  discard: async (filePath) => {
    const { repoPath } = get();
    if (!repoPath) return;
    try {
      await api.gitDiscard(repoPath, filePath);
      await get().refreshGitInfo();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ statusMessage: `Discard failed: ${msg}` });
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

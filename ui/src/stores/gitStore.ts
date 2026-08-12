import { create } from "zustand";
import type { GitRepoInfo } from "../types";
import * as api from "../lib/tauri";

export type StatusKind = "info" | "error";

/** The main repo, as opposed to one of its worktrees. */
export const MAIN_GIT_TARGET = "project";

interface GitState {
  repoPath: string;
  gitInfo: GitRepoInfo | null;
  worktreeGitInfo: Record<string, GitRepoInfo>;
  /**
   * What the git panel is pointed at: MAIN_GIT_TARGET for the main repo, or a
   * worktree id. Null when the panel is closed.
   */
  activeGitGroupId: string | null;
  /** The working tree that staging, diffing and pulling act on. */
  activeGitPath: string;
  statusMessage: string | null;
  statusKind: StatusKind;

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
  setActiveGitGroup: (groupId: string | null, path?: string) => void;
  setStatusMessage: (msg: string | null, kind?: StatusKind) => void;
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

/** The working tree the panel is acting on — a worktree's, or the main repo's. */
function activeGitPath(state: GitState): string {
  return state.activeGitPath || state.repoPath;
}

/** Re-read status for whichever tree was just mutated, not always the main one. */
function refreshActiveGitInfo(get: () => GitState): Promise<void> {
  const s = get();
  if (!s.activeGitGroupId || s.activeGitGroupId === MAIN_GIT_TARGET) {
    return s.refreshGitInfo();
  }
  return s.refreshWorktreeGitInfo(s.activeGitGroupId, activeGitPath(s));
}

export const useGitStore = create<GitState>((set, get) => ({
  repoPath: "",
  gitInfo: null,
  worktreeGitInfo: {},
  activeGitGroupId: null,
  activeGitPath: "",
  statusMessage: null,
  statusKind: "info",

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
    const path = activeGitPath(get());
    if (!path) return;
    try {
      set({ statusMessage: "Fetching...", statusKind: "info" });
      await api.gitFetch(path);
      await refreshActiveGitInfo(get);
      set({ statusMessage: "Fetch complete", statusKind: "info" });
      autoClearStatus(set);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ statusMessage: `Fetch failed: ${msg}`, statusKind: "error" });
      autoClearStatus(set);
    }
  },

  pull: async () => {
    const path = activeGitPath(get());
    if (!path) return;
    try {
      set({ statusMessage: "Pulling...", statusKind: "info" });
      const result = await api.gitPull(path);
      await refreshActiveGitInfo(get);
      const summary = result.trim().split("\n")[0] || "Pull complete";
      set({ statusMessage: summary, statusKind: "info" });
      autoClearStatus(set);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ statusMessage: `Pull failed: ${msg}`, statusKind: "error" });
      autoClearStatus(set);
    }
  },

  stage: async (filePath) => {
    const path = activeGitPath(get());
    if (!path) return;
    try {
      await api.gitStage(path, filePath);
      await refreshActiveGitInfo(get);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ statusMessage: `Stage failed: ${msg}`, statusKind: "error" });
      autoClearStatus(set);
    }
  },

  unstage: async (filePath) => {
    const path = activeGitPath(get());
    if (!path) return;
    try {
      await api.gitUnstage(path, filePath);
      await refreshActiveGitInfo(get);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ statusMessage: `Unstage failed: ${msg}`, statusKind: "error" });
      autoClearStatus(set);
    }
  },

  stageMany: async (filePaths) => {
    const path = activeGitPath(get());
    if (!path || filePaths.length === 0) return;
    try {
      await api.gitStageMany(path, filePaths);
      await refreshActiveGitInfo(get);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ statusMessage: `Stage failed: ${msg}`, statusKind: "error" });
      autoClearStatus(set);
    }
  },

  unstageMany: async (filePaths) => {
    const path = activeGitPath(get());
    if (!path || filePaths.length === 0) return;
    try {
      await api.gitUnstageMany(path, filePaths);
      await refreshActiveGitInfo(get);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ statusMessage: `Unstage failed: ${msg}`, statusKind: "error" });
      autoClearStatus(set);
    }
  },

  stageAll: async () => {
    const path = activeGitPath(get());
    if (!path) return;
    try {
      await api.gitStageAll(path);
      await refreshActiveGitInfo(get);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ statusMessage: `Stage all failed: ${msg}`, statusKind: "error" });
      autoClearStatus(set);
    }
  },

  unstageAll: async () => {
    const path = activeGitPath(get());
    if (!path) return;
    try {
      await api.gitUnstageAll(path);
      await refreshActiveGitInfo(get);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ statusMessage: `Unstage all failed: ${msg}`, statusKind: "error" });
      autoClearStatus(set);
    }
  },

  discard: async (filePath) => {
    const path = activeGitPath(get());
    if (!path) return;
    try {
      await api.gitDiscard(path, filePath);
      await refreshActiveGitInfo(get);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ statusMessage: `Discard failed: ${msg}`, statusKind: "error" });
      autoClearStatus(set);
    }
  },

  setActiveGitGroup: (groupId, path) => {
    if (groupId === null) {
      set({ activeGitGroupId: null });
      return;
    }
    // A worktree passes its own path; the main repo falls back to the project's.
    set({ activeGitGroupId: groupId, activeGitPath: path ?? get().repoPath });
  },

  setStatusMessage: (msg, kind = "info") => {
    set({ statusMessage: msg, statusKind: kind });
    if (msg) autoClearStatus(set);
  },
}));

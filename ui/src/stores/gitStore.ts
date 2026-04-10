import { create } from "zustand";
import type { GitRepoInfo } from "../types";
import * as api from "../lib/tauri";

interface GitState {
  gitInfo: Record<string, GitRepoInfo>;
  activeGitGroupId: string | null;
  statusMessage: string | null;

  refreshGitInfo: (groupId: string, repoPath: string) => Promise<void>;
  refreshAllGit: (groups: { id: string; repo_path: string }[]) => Promise<void>;
  fetch: (groupId: string, repoPath: string) => Promise<void>;
  pull: (groupId: string, repoPath: string) => Promise<void>;
  setActiveGitGroup: (groupId: string | null) => void;
  setStatusMessage: (msg: string | null) => void;
}

function autoClearStatus(set: (partial: Partial<GitState>) => void) {
  setTimeout(() => {
    set({ statusMessage: null });
  }, 3500);
}

export const useGitStore = create<GitState>((set, get) => ({
  gitInfo: {},
  activeGitGroupId: null,
  statusMessage: null,

  refreshGitInfo: async (groupId, repoPath) => {
    if (!repoPath) return;
    try {
      const info = await api.gitInfo(repoPath);
      set((s) => ({ gitInfo: { ...s.gitInfo, [groupId]: info } }));
    } catch (e) {
      console.error(`Failed to get git info for ${groupId}:`, e);
    }
  },

  refreshAllGit: async (groups) => {
    await Promise.all(
      groups
        .filter((g) => g.repo_path)
        .map((g) => get().refreshGitInfo(g.id, g.repo_path))
    );
  },

  fetch: async (groupId, repoPath) => {
    try {
      set({ statusMessage: "Fetching..." });
      await api.gitFetch(repoPath);
      await get().refreshGitInfo(groupId, repoPath);
      set({ statusMessage: "Fetch complete" });
      autoClearStatus(set);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ statusMessage: `Fetch failed: ${msg}` });
      autoClearStatus(set);
    }
  },

  pull: async (groupId, repoPath) => {
    try {
      set({ statusMessage: "Pulling..." });
      const result = await api.gitPull(repoPath);
      await get().refreshGitInfo(groupId, repoPath);
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

import { create } from "zustand";
import type { WorktreeDef, ServiceDef, ServiceGroup } from "../types";
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

  // Group/service CRUD within a worktree
  addWorktreeGroup: (worktreeId: string, group: ServiceGroup) => void;
  removeWorktreeGroup: (worktreeId: string, groupId: string) => void;
  updateWorktreeGroup: (worktreeId: string, groupId: string, patch: Partial<ServiceGroup>) => void;
  addWorktreeService: (worktreeId: string, groupId: string, service: ServiceDef) => void;
  updateWorktreeService: (worktreeId: string, groupId: string, serviceId: string, patch: Partial<ServiceDef>) => void;
  moveWorktreeService: (worktreeId: string, serviceId: string, fromGroupId: string, toGroupId: string) => void;
  removeWorktreeService: (worktreeId: string, groupId: string, serviceId: string) => void;
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

  addWorktreeGroup: (worktreeId, group) => {
    set((s) => ({
      worktrees: s.worktrees.map((wt) =>
        wt.id === worktreeId ? { ...wt, groups: [...wt.groups, group] } : wt
      ),
    }));
  },

  removeWorktreeGroup: (worktreeId, groupId) => {
    set((s) => ({
      worktrees: s.worktrees.map((wt) =>
        wt.id === worktreeId
          ? { ...wt, groups: wt.groups.filter((g) => g.id !== groupId) }
          : wt
      ),
    }));
  },

  updateWorktreeGroup: (worktreeId, groupId, patch) => {
    set((s) => ({
      worktrees: s.worktrees.map((wt) =>
        wt.id === worktreeId
          ? { ...wt, groups: wt.groups.map((g) => (g.id === groupId ? { ...g, ...patch } : g)) }
          : wt
      ),
    }));
  },

  addWorktreeService: (worktreeId, groupId, service) => {
    set((s) => ({
      worktrees: s.worktrees.map((wt) =>
        wt.id === worktreeId
          ? {
              ...wt,
              groups: wt.groups.map((g) =>
                g.id === groupId ? { ...g, services: [...g.services, service] } : g
              ),
            }
          : wt
      ),
    }));
  },

  updateWorktreeService: (worktreeId, groupId, serviceId, patch) => {
    set((s) => ({
      worktrees: s.worktrees.map((wt) =>
        wt.id === worktreeId
          ? {
              ...wt,
              groups: wt.groups.map((g) =>
                g.id === groupId
                  ? { ...g, services: g.services.map((svc) => (svc.id === serviceId ? { ...svc, ...patch } : svc)) }
                  : g
              ),
            }
          : wt
      ),
    }));
  },

  moveWorktreeService: (worktreeId, serviceId, fromGroupId, toGroupId) => {
    const wt = get().worktrees.find((w) => w.id === worktreeId);
    if (!wt) return;
    const fromGroup = wt.groups.find((g) => g.id === fromGroupId);
    if (!fromGroup) return;
    const service = fromGroup.services.find((s) => s.id === serviceId);
    if (!service) return;
    set((s) => ({
      worktrees: s.worktrees.map((w) =>
        w.id === worktreeId
          ? {
              ...w,
              groups: w.groups.map((g) => {
                if (g.id === fromGroupId) return { ...g, services: g.services.filter((svc) => svc.id !== serviceId) };
                if (g.id === toGroupId) return { ...g, services: [...g.services, service] };
                return g;
              }),
            }
          : w
      ),
    }));
  },

  removeWorktreeService: (worktreeId, groupId, serviceId) => {
    set((s) => ({
      worktrees: s.worktrees.map((wt) =>
        wt.id === worktreeId
          ? {
              ...wt,
              groups: wt.groups.map((g) =>
                g.id === groupId ? { ...g, services: g.services.filter((svc) => svc.id !== serviceId) } : g
              ),
            }
          : wt
      ),
    }));
  },
}));

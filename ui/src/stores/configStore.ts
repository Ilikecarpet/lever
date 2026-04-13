import { create } from "zustand";
import type { AppConfig, ServiceDef, ServiceGroup, WorktreeDef } from "../types";
import * as api from "../lib/tauri";
import { useWorktreeStore } from "./worktreeStore";

interface ConfigState {
  groups: ServiceGroup[];
  loaded: boolean;

  loadConfig: () => Promise<void>;
  saveConfig: () => Promise<void>;

  addGroup: (group: ServiceGroup) => void;
  removeGroup: (groupId: string) => void;
  updateGroup: (groupId: string, patch: Partial<ServiceGroup>) => void;

  addService: (groupId: string, service: ServiceDef) => void;
  updateService: (
    groupId: string,
    serviceId: string,
    patch: Partial<ServiceDef>
  ) => void;
  moveService: (serviceId: string, fromGroupId: string, toGroupId: string) => void;
  removeService: (groupId: string, serviceId: string) => void;
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  groups: [],
  loaded: false,

  loadConfig: async () => {
    try {
      const config = await api.getConfig();
      set({ groups: config.groups, loaded: true });
      useWorktreeStore.getState().setWorktrees(config.worktrees ?? []);
    } catch {
      set({ groups: [], loaded: true });
    }
  },

  saveConfig: async () => {
    const worktrees = useWorktreeStore.getState().worktrees;
    const config: AppConfig = { groups: get().groups, worktrees };
    await api.saveConfig(config);
  },

  addGroup: (group) => {
    set((s) => ({ groups: [...s.groups, group] }));
  },

  removeGroup: (groupId) => {
    set((s) => ({ groups: s.groups.filter((g) => g.id !== groupId) }));
  },

  updateGroup: (groupId, patch) => {
    set((s) => ({
      groups: s.groups.map((g) =>
        g.id === groupId ? { ...g, ...patch } : g
      ),
    }));
  },

  addService: (groupId, service) => {
    set((s) => ({
      groups: s.groups.map((g) =>
        g.id === groupId
          ? { ...g, services: [...g.services, service] }
          : g
      ),
    }));
  },

  updateService: (groupId, serviceId, patch) => {
    set((s) => ({
      groups: s.groups.map((g) =>
        g.id === groupId
          ? {
              ...g,
              services: g.services.map((svc) =>
                svc.id === serviceId ? { ...svc, ...patch } : svc
              ),
            }
          : g
      ),
    }));
  },

  moveService: (serviceId, fromGroupId, toGroupId) => {
    const groups = get().groups;
    const fromGroup = groups.find((g) => g.id === fromGroupId);
    if (!fromGroup) return;

    const service = fromGroup.services.find((s) => s.id === serviceId);
    if (!service) return;

    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.id === fromGroupId) {
          return { ...g, services: g.services.filter((svc) => svc.id !== serviceId) };
        }
        if (g.id === toGroupId) {
          return { ...g, services: [...g.services, service] };
        }
        return g;
      }),
    }));
  },

  removeService: (groupId, serviceId) => {
    set((s) => ({
      groups: s.groups.map((g) =>
        g.id === groupId
          ? { ...g, services: g.services.filter((svc) => svc.id !== serviceId) }
          : g
      ),
    }));
  },
}));

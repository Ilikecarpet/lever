import { create } from "zustand";
import * as api from "../lib/tauri";
import { tauriListen } from "../lib/tauri";
import type { SvcExitEvent } from "../types";

interface ServiceState {
  statuses: Record<string, "running" | "stopped">;
  ptyIds: Record<string, string>;
  activeServiceId: string | null;

  poll: () => Promise<void>;
  startService: (id: string) => Promise<void>;
  stopService: (id: string) => Promise<void>;
  setActiveService: (id: string | null) => void;
  initExitListener: () => Promise<() => void>;
}

export const useServiceStore = create<ServiceState>((set, get) => ({
  statuses: {},
  ptyIds: {},
  activeServiceId: null,

  poll: async () => {
    const result = await api.poll();
    const statuses: Record<string, "running" | "stopped"> = {};
    for (const s of result.statuses) {
      statuses[s.id] = s.status === "running" ? "running" : "stopped";
    }
    set((state) => {
      const ptyIds = { ...state.ptyIds };
      for (const [svcId] of Object.entries(ptyIds)) {
        if (statuses[svcId] !== "running") {
          delete ptyIds[svcId];
        }
      }
      return { statuses, ptyIds };
    });
  },

  startService: async (id) => {
    try {
      const result = await api.startService(id);
      set((state) => ({
        ptyIds: { ...state.ptyIds, [id]: result.pty_id },
        statuses: { ...state.statuses, [id]: "running" },
      }));
    } catch (e) {
      console.error("Failed to start service:", e);
    }
  },

  stopService: async (id) => {
    try {
      await api.stopService(id);
      set((state) => {
        const ptyIds = { ...state.ptyIds };
        delete ptyIds[id];
        return {
          ptyIds,
          statuses: { ...state.statuses, [id]: "stopped" },
          activeServiceId: state.activeServiceId === id ? null : state.activeServiceId,
        };
      });
    } catch (e) {
      console.error("Failed to stop service:", e);
    }
  },

  setActiveService: (id) => {
    set({ activeServiceId: id });
  },

  initExitListener: async () => {
    const unlisten = await tauriListen<SvcExitEvent>("svc-exit", (payload) => {
      set((state) => {
        const ptyIds = { ...state.ptyIds };
        for (const [svcId, ptyId] of Object.entries(ptyIds)) {
          if (ptyId === payload.pty_id) {
            delete ptyIds[svcId];
            break;
          }
        }
        return { ptyIds };
      });
    });
    return unlisten;
  },
}));

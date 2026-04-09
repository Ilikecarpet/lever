import { create } from "zustand";
import * as api from "../lib/tauri";

const MAX_LOG_LINES = 3000;

interface ServiceState {
  statuses: Record<string, "running" | "stopped">;
  logs: Record<string, string[]>;
  activeLogSvcId: string | null;

  poll: () => Promise<void>;
  startService: (id: string) => Promise<void>;
  stopService: (id: string) => Promise<void>;
  appendLog: (id: string, lines: string[]) => void;
  clearLog: (id: string) => void;
  setActiveLog: (id: string | null) => void;
}

export const useServiceStore = create<ServiceState>((set, get) => ({
  statuses: {},
  logs: {},
  activeLogSvcId: null,

  poll: async () => {
    const result = await api.poll();

    const statuses: Record<string, "running" | "stopped"> = {};
    for (const s of result.statuses) {
      statuses[s.id] = s.status === "running" ? "running" : "stopped";
    }

    set((state) => {
      const logs = { ...state.logs };
      for (const [id, newLines] of Object.entries(result.logs)) {
        const existing = logs[id] ?? [];
        const combined = [...existing, ...newLines];
        logs[id] =
          combined.length > MAX_LOG_LINES
            ? combined.slice(combined.length - MAX_LOG_LINES)
            : combined;
      }
      return { statuses, logs };
    });
  },

  startService: async (id) => {
    await api.startService(id);
  },

  stopService: async (id) => {
    await api.stopService(id);
  },

  appendLog: (id, lines) => {
    set((state) => {
      const existing = state.logs[id] ?? [];
      const combined = [...existing, ...lines];
      return {
        logs: {
          ...state.logs,
          [id]:
            combined.length > MAX_LOG_LINES
              ? combined.slice(combined.length - MAX_LOG_LINES)
              : combined,
        },
      };
    });
  },

  clearLog: (id) => {
    set((state) => ({
      logs: { ...state.logs, [id]: [] },
    }));
  },

  setActiveLog: (id) => {
    set({ activeLogSvcId: id });
  },
}));

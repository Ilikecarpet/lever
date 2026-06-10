import { create } from "zustand";
import * as api from "../lib/tauri";
import { tauriListen } from "../lib/tauri";
import type { AgentInfo, SvcExitEvent } from "../types";

interface ServiceState {
  statuses: Record<string, "running" | "stopped">;
  ptyIds: Record<string, string>;
  /** pty_id -> AI agent CLI (e.g. "claude") detected in that terminal */
  agents: Record<string, AgentInfo>;
  activeServiceId: string | null;

  poll: () => Promise<void>;
  startService: (id: string) => Promise<void>;
  stopService: (id: string) => Promise<void>;
  setActiveService: (id: string | null) => void;
  initExitListener: () => Promise<() => void>;
}

function agentsEqual(a: Record<string, AgentInfo>, b: Record<string, AgentInfo>): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every(
    (k) => b[k] !== undefined && a[k].name === b[k].name && a[k].active === b[k].active
  );
}

export const useServiceStore = create<ServiceState>((set, get) => ({
  statuses: {},
  ptyIds: {},
  agents: {},
  activeServiceId: null,

  poll: async () => {
    const result = await api.poll();
    const statuses: Record<string, "running" | "stopped"> = {};
    for (const s of result.statuses) {
      statuses[s.id] = s.status === "running" ? "running" : "stopped";
    }
    set((state) => ({
      statuses,
      // Keep the same reference when nothing changed so subscribers don't churn
      agents: agentsEqual(state.agents, result.agents ?? {})
        ? state.agents
        : result.agents ?? {},
    }));
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
    // svc-exit fires when a service PTY exits (task completed, process died).
    // Mark as stopped immediately so the UI shows the play button.
    // Keep ptyId so the terminal output stays visible until next run.
    const unlisten = await tauriListen<SvcExitEvent>("svc-exit", (payload) => {
      set((state) => {
        // Find which service had this pty_id
        for (const [svcId, ptyId] of Object.entries(state.ptyIds)) {
          if (ptyId === payload.pty_id) {
            return { statuses: { ...state.statuses, [svcId]: "stopped" } };
          }
        }
        return {};
      });
    });
    return unlisten;
  },
}));

import { create } from "zustand";
import * as api from "../lib/tauri";
import { tauriListen } from "../lib/tauri";
import { ensureSvcTerm } from "../lib/svcTerminals";
import type { AgentInfo, SvcExitEvent } from "../types";

interface ServiceState {
  statuses: Record<string, "running" | "stopped">;
  /** Services with a start/stop in flight. The sidebar's switch holds mid-throw
   *  while one of these is set, so it never claims a process is up before the
   *  spawn has actually come back. */
  pending: Record<string, "starting" | "stopping">;
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

function statusesEqual(
  a: Record<string, "running" | "stopped">,
  b: Record<string, "running" | "stopped">
): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((k) => a[k] === b[k]);
}

/** Drops one id from the pending map, keeping the same reference when the id
 *  was not pending so subscribers don't re-render for nothing. */
function clearPending(
  pending: Record<string, "starting" | "stopping">,
  id: string
): Record<string, "starting" | "stopping"> {
  if (!(id in pending)) return pending;
  const next = { ...pending };
  delete next[id];
  return next;
}

export const useServiceStore = create<ServiceState>((set, get) => ({
  statuses: {},
  pending: {},
  ptyIds: {},
  agents: {},
  activeServiceId: null,

  poll: async () => {
    const result = await api.poll();
    const statuses: Record<string, "running" | "stopped"> = {};
    for (const s of result.statuses) {
      statuses[s.id] = s.status === "running" ? "running" : "stopped";
    }
    // Adopt pty ids the backend still tracks (e.g. after a webview reload) so
    // terminals reattach to live sessions.
    const prevPtyIds = get().ptyIds;
    const adopted: Array<[string, string]> = [];
    for (const s of result.statuses) {
      if (s.status === "running" && s.pty_id && prevPtyIds[s.id] !== s.pty_id) {
        adopted.push([s.id, s.pty_id]);
      }
    }

    set((state) => {
      // Keep the same references when nothing changed so subscribers don't churn.
      let ptyIds = state.ptyIds;
      for (const [id, ptyId] of adopted) {
        if (ptyIds === state.ptyIds) ptyIds = { ...state.ptyIds };
        ptyIds[id] = ptyId;
      }
      return {
        statuses: statusesEqual(state.statuses, statuses) ? state.statuses : statuses,
        ptyIds,
        agents: agentsEqual(state.agents, result.agents ?? {})
          ? state.agents
          : result.agents ?? {},
      };
    });

    // Attach outside the updater — building a terminal is a side effect, and
    // the panel may never be opened for these services.
    for (const [id, ptyId] of adopted) {
      ensureSvcTerm(id, ptyId);
    }
  },

  startService: async (id) => {
    set((state) => ({ pending: { ...state.pending, [id]: "starting" } }));
    try {
      const result = await api.startService(id);
      set((state) => ({
        ptyIds: { ...state.ptyIds, [id]: result.pty_id },
        statuses: { ...state.statuses, [id]: "running" },
        pending: clearPending(state.pending, id),
      }));
      // Build the terminal now rather than when the log panel first opens, so
      // output is captured whether or not anyone is watching. This runs after
      // the state update on purpose: the process is already spawned and in the
      // backend's `tracked` map, so letting a DOM failure here fall into the
      // catch below would leave the UI calling a running service stopped, and
      // the retry would come back "already running".
      ensureSvcTerm(id, result.pty_id);
    } catch (e) {
      console.error("Failed to start service:", e);
      set((state) => ({ pending: clearPending(state.pending, id) }));
    }
  },

  stopService: async (id) => {
    set((state) => ({ pending: { ...state.pending, [id]: "stopping" } }));
    try {
      await api.stopService(id);
      set((state) => {
        const ptyIds = { ...state.ptyIds };
        delete ptyIds[id];
        return {
          ptyIds,
          statuses: { ...state.statuses, [id]: "stopped" },
          pending: clearPending(state.pending, id),
          activeServiceId: state.activeServiceId === id ? null : state.activeServiceId,
        };
      });
    } catch (e) {
      console.error("Failed to stop service:", e);
      set((state) => ({ pending: clearPending(state.pending, id) }));
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
            return {
              statuses: { ...state.statuses, [svcId]: "stopped" },
              pending: clearPending(state.pending, svcId),
            };
          }
        }
        return {};
      });
    });
    return unlisten;
  },
}));

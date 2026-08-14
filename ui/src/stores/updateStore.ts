import { create } from "zustand";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

// Auto-update against the GitHub releases feed. The manifest lives at
// releases/latest/download/latest.json (published by the release workflow) and
// the download is verified against the minisign public key baked into
// tauri.conf.json — Apple code signing is not involved anywhere in this path.

const POLL_MS = 60 * 60 * 1000;

/** The handle from check(): a live object with a download method, not state. */
let pending: Update | null = null;
let pollId: ReturnType<typeof setInterval> | null = null;

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "error";

interface UpdateState {
  phase: UpdatePhase;
  /** Version offered by the release feed, once one is known. */
  version: string | null;
  currentVersion: string | null;
  /** 0–1 while downloading, null when the server sends no content length. */
  progress: number | null;
  error: string | null;
  /** Set after a check that found nothing, so the UI can say so. */
  checkedAt: number | null;

  check: (manual?: boolean) => Promise<void>;
  install: () => Promise<void>;
  startPolling: () => () => void;
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  phase: "idle",
  version: null,
  currentVersion: null,
  progress: null,
  error: null,
  checkedAt: null,

  check: async (manual = false) => {
    const phase = get().phase;
    // A download in flight, or a staged update, outranks another look.
    if (phase === "checking" || phase === "downloading" || phase === "ready") return;

    set({ phase: "checking", error: null });
    try {
      const current = await getVersion().catch(() => null);
      const update = await check();
      pending = update;
      if (update) {
        set({
          phase: "available",
          version: update.version,
          currentVersion: current,
          checkedAt: Date.now(),
        });
      } else {
        set({ phase: "idle", version: null, currentVersion: current, checkedAt: Date.now() });
      }
    } catch (e) {
      pending = null;
      // Background checks fail silently — no network, or a dev build with no
      // bundle to replace. Only a check the user asked for reports it.
      if (manual) {
        set({ phase: "error", error: String(e), checkedAt: Date.now() });
      } else {
        set({ phase: "idle", checkedAt: Date.now() });
      }
    }
  },

  install: async () => {
    const update = pending;
    if (!update || get().phase === "downloading") return;

    set({ phase: "downloading", progress: null, error: null });
    let total = 0;
    let downloaded = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
          set({ progress: total > 0 ? 0 : null });
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (total > 0) set({ progress: Math.min(1, downloaded / total) });
        } else if (event.event === "Finished") {
          set({ progress: 1 });
        }
      });
      set({ phase: "ready" });
      // The new bundle is in place; only a restart picks it up. Services this
      // window started go down with it, same as any other quit.
      await relaunch();
    } catch (e) {
      set({ phase: "error", error: String(e) });
    }
  },

  startPolling: () => {
    get().check();
    if (pollId === null) {
      pollId = setInterval(() => get().check(), POLL_MS);
    }
    return () => {
      if (pollId !== null) {
        clearInterval(pollId);
        pollId = null;
      }
    };
  },
}));

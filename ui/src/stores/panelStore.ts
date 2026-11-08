import { create } from "zustand";

/**
 * Which flyout panel is open, and what it is pointed at. One at a time — the
 * sidebar is the navigation, and you open a panel *on* something from it.
 */
export type PanelTarget =
  | { kind: "service"; worktreeId: string | null; groupId: string; serviceId: string }
  | { kind: "new"; worktreeId: string | null; groupId: string }
  | { kind: "settings" }
  /** A database connection's editor; `connId` null is a new one. */
  | { kind: "db"; connId: string | null };

interface PanelState {
  target: PanelTarget | null;
  editService: (worktreeId: string | null, groupId: string, serviceId: string) => void;
  addService: (worktreeId: string | null, groupId: string) => void;
  openSettings: () => void;
  editDatabase: (connId: string | null) => void;
  close: () => void;
}

/** Opened from anywhere in the sidebar, rendered once at the app root. */
export const usePanelStore = create<PanelState>((set) => ({
  target: null,
  editService: (worktreeId, groupId, serviceId) =>
    set({ target: { kind: "service", worktreeId, groupId, serviceId } }),
  addService: (worktreeId, groupId) =>
    set({ target: { kind: "new", worktreeId, groupId } }),
  openSettings: () => set({ target: { kind: "settings" } }),
  editDatabase: (connId) => set({ target: { kind: "db", connId } }),
  close: () => set({ target: null }),
}));

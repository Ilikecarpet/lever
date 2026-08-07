import { create } from "zustand";

const COLLAPSED_KEY = "lever-sidebar-collapsed";
const WIDTH_KEY = "lever-sidebar-width";

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 360;

function getInitialCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function getInitialWidth(): number {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(v) && v >= SIDEBAR_MIN_WIDTH && v <= SIDEBAR_MAX_WIDTH) return v;
  } catch {}
  return 250;
}

interface UiState {
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  toggleSidebar: () => void;
  /** Live width updates during a drag; pass persist on the final one. */
  setSidebarWidth: (width: number, persist?: boolean) => void;
}

/** Cross-component window chrome state (shared by TopBar and Sidebar). */
export const useUiStore = create<UiState>((set, get) => ({
  sidebarCollapsed: getInitialCollapsed(),
  sidebarWidth: getInitialWidth(),

  toggleSidebar: () => {
    const next = !get().sidebarCollapsed;
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    } catch {}
    set({ sidebarCollapsed: next });
  },

  setSidebarWidth: (width, persist = false) => {
    const clamped = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
    if (persist) {
      try {
        localStorage.setItem(WIDTH_KEY, String(Math.round(clamped)));
      } catch {}
    }
    set({ sidebarWidth: clamped });
  },
}));

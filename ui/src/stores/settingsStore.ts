import { create } from "zustand";

// App-level preferences persisted to localStorage (mirrors themeStore's pattern).

const DEBUG_CONSOLE_KEY = "lever-debug-console";

function getInitialDebugConsole(): boolean {
  try {
    return localStorage.getItem(DEBUG_CONSOLE_KEY) === "true";
  } catch {
    return false;
  }
}

interface SettingsState {
  /** Show the live debug console of backend actions. Default off. */
  debugConsole: boolean;
  setDebugConsole: (v: boolean) => void;
  toggleDebugConsole: () => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  debugConsole: getInitialDebugConsole(),

  setDebugConsole: (v) => {
    try {
      localStorage.setItem(DEBUG_CONSOLE_KEY, String(v));
    } catch {}
    set({ debugConsole: v });
  },

  toggleDebugConsole: () => get().setDebugConsole(!get().debugConsole),
}));

import { create } from "zustand";
import * as api from "../lib/tauri";

// App-level preferences persisted to localStorage (mirrors themeStore's pattern).

const DEBUG_CONSOLE_KEY = "lever-debug-console";
const FONT_SIZE_KEY = "lever-terminal-font-size";
const SCROLLBACK_KEY = "lever-terminal-scrollback";
const STOP_ON_QUIT_KEY = "lever-stop-services-on-quit";

export const FONT_SIZE_MIN = 9;
export const FONT_SIZE_MAX = 22;
export const FONT_SIZE_DEFAULT = 13;

/** xterm's own default is 1000 lines, which truncates a long build. */
export const SCROLLBACK_DEFAULT = 5000;
export const SCROLLBACK_MIN = 500;
export const SCROLLBACK_MAX = 100000;

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    return v === "true";
  } catch {
    return fallback;
  }
}

function readNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    if (Number.isFinite(v) && v >= min && v <= max) return v;
  } catch {}
  return fallback;
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(v)));
}

interface SettingsState {
  /** Show the live debug console of backend actions. Default off. */
  debugConsole: boolean;
  setDebugConsole: (v: boolean) => void;
  toggleDebugConsole: () => void;

  /** Terminal type size, in px. Applied live to every open terminal. */
  terminalFontSize: number;
  setTerminalFontSize: (v: number) => void;

  /** Lines of history each terminal keeps. Only applies to terminals opened after. */
  terminalScrollback: number;
  setTerminalScrollback: (v: number) => void;

  /** Kill services this window started when it closes, instead of orphaning them. */
  stopServicesOnQuit: boolean;
  setStopServicesOnQuit: (v: boolean) => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  debugConsole: readBool(DEBUG_CONSOLE_KEY, false),
  terminalFontSize: readNumber(FONT_SIZE_KEY, FONT_SIZE_DEFAULT, FONT_SIZE_MIN, FONT_SIZE_MAX),
  terminalScrollback: readNumber(
    SCROLLBACK_KEY,
    SCROLLBACK_DEFAULT,
    SCROLLBACK_MIN,
    SCROLLBACK_MAX
  ),
  stopServicesOnQuit: readBool(STOP_ON_QUIT_KEY, true),

  setDebugConsole: (v) => {
    write(DEBUG_CONSOLE_KEY, String(v));
    set({ debugConsole: v });
  },
  toggleDebugConsole: () => get().setDebugConsole(!get().debugConsole),

  setTerminalFontSize: (v) => {
    const next = clamp(v, FONT_SIZE_MIN, FONT_SIZE_MAX);
    write(FONT_SIZE_KEY, String(next));
    set({ terminalFontSize: next });
  },

  setTerminalScrollback: (v) => {
    const next = clamp(v, SCROLLBACK_MIN, SCROLLBACK_MAX);
    write(SCROLLBACK_KEY, String(next));
    set({ terminalScrollback: next });
  },

  setStopServicesOnQuit: (v) => {
    write(STOP_ON_QUIT_KEY, String(v));
    set({ stopServicesOnQuit: v });
    // The backend acts on this during window close, when the web view is
    // already going away and cannot be asked.
    api.setStopServicesOnQuit(v).catch(() => {});
  },
}));

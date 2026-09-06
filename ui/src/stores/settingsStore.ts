import { create } from "zustand";
import * as api from "../lib/tauri";
import type { BridgeState } from "../types";

// App-level preferences persisted to localStorage (mirrors themeStore's pattern).

const DEBUG_CONSOLE_KEY = "lever-debug-console";
const FONT_SIZE_KEY = "lever-terminal-font-size";
const SCROLLBACK_KEY = "lever-terminal-scrollback";
const STOP_ON_QUIT_KEY = "lever-stop-services-on-quit";
const CONTEXT_WINDOW_KEY = "lever-agent-context-window";
const METER_COLLAPSED_KEY = "lever-agent-meter-collapsed";

export const FONT_SIZE_MIN = 9;
export const FONT_SIZE_MAX = 22;
export const FONT_SIZE_DEFAULT = 13;

/** xterm's own default is 1000 lines, which truncates a long build. */
export const SCROLLBACK_DEFAULT = 5000;
export const SCROLLBACK_MIN = 500;
export const SCROLLBACK_MAX = 100000;

/** Claude Code writes the model id to its transcript with the `[1m]` suffix
 *  stripped, so a 1M session is indistinguishable from a 200k one until it
 *  grows past 200k. "auto" assumes 200k and rescales the moment a turn proves
 *  otherwise; pick a size explicitly to skip the wait. */
export type ContextWindow = "auto" | 200_000 | 1_000_000;

function readContextWindow(): ContextWindow {
  try {
    const v = localStorage.getItem(CONTEXT_WINDOW_KEY);
    if (v === "200000") return 200_000;
    if (v === "1000000") return 1_000_000;
  } catch {}
  return "auto";
}

/** The agent meter's popover sections a user has folded away. */
export type MeterSection = "context" | "plan" | "session";

function readCollapsed(): MeterSection[] {
  try {
    const v = JSON.parse(localStorage.getItem(METER_COLLAPSED_KEY) ?? "[]");
    if (Array.isArray(v)) {
      return v.filter((x): x is MeterSection => x === "context" || x === "plan" || x === "session");
    }
  } catch {}
  return [];
}

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

  /** Context window the agent meter measures against. */
  agentContextWindow: ContextWindow;
  setAgentContextWindow: (v: ContextWindow) => void;

  /** Popover sections folded to their one-line summary. */
  agentMeterCollapsed: MeterSection[];
  toggleAgentMeterSection: (s: MeterSection) => void;

  /** Whether Lever's statusLine hook is in ~/.claude/settings.json. Lives in
   *  that file rather than localStorage, so it is read back from the backend
   *  instead of remembered here. null until first read. */
  agentBridge: BridgeState | null;
  agentBridgeBusy: boolean;
  agentBridgeError: string | null;
  loadAgentBridge: () => Promise<void>;
  setAgentBridge: (on: boolean) => Promise<void>;
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
  agentContextWindow: readContextWindow(),
  agentMeterCollapsed: readCollapsed(),
  agentBridge: null,
  agentBridgeBusy: false,
  agentBridgeError: null,

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

  setAgentContextWindow: (v) => {
    write(CONTEXT_WINDOW_KEY, String(v));
    set({ agentContextWindow: v });
  },

  toggleAgentMeterSection: (s) => {
    const cur = get().agentMeterCollapsed;
    const next = cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s];
    write(METER_COLLAPSED_KEY, JSON.stringify(next));
    set({ agentMeterCollapsed: next });
  },

  loadAgentBridge: async () => {
    try {
      set({ agentBridge: await api.agentBridgeState(), agentBridgeError: null });
    } catch (e) {
      set({ agentBridgeError: String(e) });
    }
  },

  setAgentBridge: async (on) => {
    set({ agentBridgeBusy: true, agentBridgeError: null });
    try {
      const next = on ? await api.installAgentBridge() : await api.uninstallAgentBridge();
      set({ agentBridge: next });
    } catch (e) {
      // The toggle stays where it was — the settings file was not changed.
      set({ agentBridgeError: String(e) });
    } finally {
      set({ agentBridgeBusy: false });
    }
  },

  setStopServicesOnQuit: (v) => {
    write(STOP_ON_QUIT_KEY, String(v));
    set({ stopServicesOnQuit: v });
    // The backend acts on this during window close, when the web view is
    // already going away and cannot be asked.
    api.setStopServicesOnQuit(v).catch(() => {});
  },
}));

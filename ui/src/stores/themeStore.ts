import { create } from "zustand";

export interface ThemeDef {
  id: string;
  label: string;
  /** Color shown in the theme picker swatch */
  swatch: string;
  // CSS variables
  bg: string;
  sidebarBg: string;
  surface: string;
  surfaceHover: string;
  surfaceRaised: string;
  terminalBg: string;
  border: string;
  borderHover: string;
  text: string;
  textDim: string;
  textMuted: string;
  accent: string;
  accentHover: string;
  accentDim: string;
  accentSubtle: string;
  green: string;
  greenDim: string;
  red: string;
  redDim: string;
  yellow: string;
  yellowDim: string;
  blue: string;
  blueDim: string;
  // Terminal-specific colors
  terminal: {
    background: string;
    foreground: string;
    cursor: string;
    selectionBackground: string;
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
  };
}

const obsidian: ThemeDef = {
  id: "obsidian",
  label: "Obsidian",
  swatch: "#a78bfa",
  bg: "#0c0c0e",
  sidebarBg: "#111113",
  surface: "#18181b",
  surfaceHover: "#222225",
  surfaceRaised: "#1e1e22",
  terminalBg: "#09090b",
  border: "#27272b",
  borderHover: "#3f3f46",
  text: "#e4e4e7",
  textDim: "#a1a1aa",
  textMuted: "#52525b",
  accent: "#a78bfa",
  accentHover: "#c4b5fd",
  accentDim: "rgba(167, 139, 250, 0.08)",
  accentSubtle: "rgba(167, 139, 250, 0.15)",
  green: "#4ade80",
  greenDim: "rgba(74, 222, 128, 0.1)",
  red: "#fb7185",
  redDim: "rgba(251, 113, 133, 0.1)",
  yellow: "#fbbf24",
  yellowDim: "rgba(251, 191, 36, 0.1)",
  blue: "#60a5fa",
  blueDim: "rgba(96, 165, 250, 0.1)",
  terminal: {
    background: "#09090b",
    foreground: "#e4e4e7",
    cursor: "#a78bfa",
    selectionBackground: "rgba(167,139,250,0.25)",
    black: "#18181b",
    red: "#fb7185",
    green: "#4ade80",
    yellow: "#fbbf24",
    blue: "#60a5fa",
    magenta: "#a78bfa",
    cyan: "#22d3ee",
    white: "#e4e4e7",
    brightBlack: "#71717a",
    brightRed: "#fda4af",
    brightGreen: "#86efac",
    brightYellow: "#fde68a",
    brightBlue: "#93c5fd",
    brightMagenta: "#c4b5fd",
    brightCyan: "#67e8f9",
    brightWhite: "#fafafa",
  },
};

const tokyoNight: ThemeDef = {
  id: "tokyo-night",
  label: "Tokyo Night",
  swatch: "#7aa2f7",
  bg: "#1a1b26",
  sidebarBg: "#16161e",
  surface: "#1f2335",
  surfaceHover: "#292e42",
  surfaceRaised: "#24283b",
  terminalBg: "#15161e",
  border: "#2f3549",
  borderHover: "#3b4261",
  text: "#c0caf5",
  textDim: "#9aa5ce",
  textMuted: "#565f89",
  accent: "#7aa2f7",
  accentHover: "#89b4fa",
  accentDim: "rgba(122, 162, 247, 0.08)",
  accentSubtle: "rgba(122, 162, 247, 0.15)",
  green: "#9ece6a",
  greenDim: "rgba(158, 206, 106, 0.1)",
  red: "#f7768e",
  redDim: "rgba(247, 118, 142, 0.1)",
  yellow: "#e0af68",
  yellowDim: "rgba(224, 175, 104, 0.1)",
  blue: "#7aa2f7",
  blueDim: "rgba(122, 162, 247, 0.1)",
  terminal: {
    background: "#15161e",
    foreground: "#c0caf5",
    cursor: "#7aa2f7",
    selectionBackground: "rgba(122,162,247,0.25)",
    black: "#1a1b26",
    red: "#f7768e",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
    white: "#c0caf5",
    brightBlack: "#565f89",
    brightRed: "#f7768e",
    brightGreen: "#9ece6a",
    brightYellow: "#e0af68",
    brightBlue: "#7aa2f7",
    brightMagenta: "#bb9af7",
    brightCyan: "#7dcfff",
    brightWhite: "#c0caf5",
  },
};

const rosePine: ThemeDef = {
  id: "rose-pine",
  label: "Rose Pine",
  swatch: "#eb6f92",
  bg: "#191724",
  sidebarBg: "#1f1d2e",
  surface: "#26233a",
  surfaceHover: "#2a2740",
  surfaceRaised: "#2a283e",
  terminalBg: "#191724",
  border: "#312e47",
  borderHover: "#3e3a56",
  text: "#e0def4",
  textDim: "#908caa",
  textMuted: "#6e6a86",
  accent: "#eb6f92",
  accentHover: "#f0869d",
  accentDim: "rgba(235, 111, 146, 0.08)",
  accentSubtle: "rgba(235, 111, 146, 0.15)",
  green: "#31748f",
  greenDim: "rgba(49, 116, 143, 0.12)",
  red: "#eb6f92",
  redDim: "rgba(235, 111, 146, 0.1)",
  yellow: "#f6c177",
  yellowDim: "rgba(246, 193, 119, 0.1)",
  blue: "#9ccfd8",
  blueDim: "rgba(156, 207, 216, 0.1)",
  terminal: {
    background: "#191724",
    foreground: "#e0def4",
    cursor: "#eb6f92",
    selectionBackground: "rgba(235,111,146,0.2)",
    black: "#26233a",
    red: "#eb6f92",
    green: "#31748f",
    yellow: "#f6c177",
    blue: "#9ccfd8",
    magenta: "#c4a7e7",
    cyan: "#ebbcba",
    white: "#e0def4",
    brightBlack: "#6e6a86",
    brightRed: "#eb6f92",
    brightGreen: "#31748f",
    brightYellow: "#f6c177",
    brightBlue: "#9ccfd8",
    brightMagenta: "#c4a7e7",
    brightCyan: "#ebbcba",
    brightWhite: "#e0def4",
  },
};

const nord: ThemeDef = {
  id: "nord",
  label: "Nord",
  swatch: "#88c0d0",
  bg: "#2e3440",
  sidebarBg: "#2b303b",
  surface: "#3b4252",
  surfaceHover: "#434c5e",
  surfaceRaised: "#3b4252",
  terminalBg: "#2e3440",
  border: "#434c5e",
  borderHover: "#4c566a",
  text: "#eceff4",
  textDim: "#d8dee9",
  textMuted: "#7b88a1",
  accent: "#88c0d0",
  accentHover: "#8fbcbb",
  accentDim: "rgba(136, 192, 208, 0.1)",
  accentSubtle: "rgba(136, 192, 208, 0.15)",
  green: "#a3be8c",
  greenDim: "rgba(163, 190, 140, 0.1)",
  red: "#bf616a",
  redDim: "rgba(191, 97, 106, 0.1)",
  yellow: "#ebcb8b",
  yellowDim: "rgba(235, 203, 139, 0.1)",
  blue: "#81a1c1",
  blueDim: "rgba(129, 161, 193, 0.1)",
  terminal: {
    background: "#2e3440",
    foreground: "#eceff4",
    cursor: "#88c0d0",
    selectionBackground: "rgba(136,192,208,0.25)",
    black: "#3b4252",
    red: "#bf616a",
    green: "#a3be8c",
    yellow: "#ebcb8b",
    blue: "#81a1c1",
    magenta: "#b48ead",
    cyan: "#88c0d0",
    white: "#eceff4",
    brightBlack: "#4c566a",
    brightRed: "#bf616a",
    brightGreen: "#a3be8c",
    brightYellow: "#ebcb8b",
    brightBlue: "#81a1c1",
    brightMagenta: "#b48ead",
    brightCyan: "#8fbcbb",
    brightWhite: "#eceff4",
  },
};

const ember: ThemeDef = {
  id: "ember",
  label: "Ember",
  swatch: "#f59e0b",
  bg: "#0f0e0c",
  sidebarBg: "#141311",
  surface: "#1c1a17",
  surfaceHover: "#252320",
  surfaceRaised: "#201e1b",
  terminalBg: "#0b0a09",
  border: "#2c2924",
  borderHover: "#3d3830",
  text: "#e8e2d8",
  textDim: "#a8a090",
  textMuted: "#5c5647",
  accent: "#f59e0b",
  accentHover: "#fbbf24",
  accentDim: "rgba(245, 158, 11, 0.08)",
  accentSubtle: "rgba(245, 158, 11, 0.15)",
  green: "#84cc16",
  greenDim: "rgba(132, 204, 22, 0.1)",
  red: "#ef4444",
  redDim: "rgba(239, 68, 68, 0.1)",
  yellow: "#f59e0b",
  yellowDim: "rgba(245, 158, 11, 0.1)",
  blue: "#60a5fa",
  blueDim: "rgba(96, 165, 250, 0.1)",
  terminal: {
    background: "#0b0a09",
    foreground: "#e8e2d8",
    cursor: "#f59e0b",
    selectionBackground: "rgba(245,158,11,0.25)",
    black: "#1c1a17",
    red: "#ef4444",
    green: "#84cc16",
    yellow: "#f59e0b",
    blue: "#60a5fa",
    magenta: "#c084fc",
    cyan: "#22d3ee",
    white: "#e8e2d8",
    brightBlack: "#5c5647",
    brightRed: "#f87171",
    brightGreen: "#a3e635",
    brightYellow: "#fbbf24",
    brightBlue: "#93c5fd",
    brightMagenta: "#d8b4fe",
    brightCyan: "#67e8f9",
    brightWhite: "#fafaf5",
  },
};

const paper: ThemeDef = {
  id: "paper",
  label: "Paper",
  swatch: "#fafaf9",
  bg: "#fafaf9",
  sidebarBg: "#f5f5f4",
  surface: "#e7e5e4",
  surfaceHover: "#d6d3d1",
  surfaceRaised: "#eeeceb",
  terminalBg: "#fafaf9",
  border: "#d6d3d1",
  borderHover: "#a8a29e",
  text: "#1c1917",
  textDim: "#57534e",
  textMuted: "#a8a29e",
  accent: "#78716c",
  accentHover: "#57534e",
  accentDim: "rgba(120, 113, 108, 0.08)",
  accentSubtle: "rgba(120, 113, 108, 0.14)",
  green: "#16a34a",
  greenDim: "rgba(22, 163, 74, 0.08)",
  red: "#dc2626",
  redDim: "rgba(220, 38, 38, 0.08)",
  yellow: "#ca8a04",
  yellowDim: "rgba(202, 138, 4, 0.08)",
  blue: "#2563eb",
  blueDim: "rgba(37, 99, 235, 0.08)",
  terminal: {
    background: "#fafaf9",
    foreground: "#1c1917",
    cursor: "#57534e",
    selectionBackground: "rgba(120,113,108,0.15)",
    black: "#1c1917",
    red: "#dc2626",
    green: "#16a34a",
    yellow: "#ca8a04",
    blue: "#2563eb",
    magenta: "#a855f7",
    cyan: "#0891b2",
    white: "#f5f5f4",
    brightBlack: "#78716c",
    brightRed: "#ef4444",
    brightGreen: "#22c55e",
    brightYellow: "#eab308",
    brightBlue: "#3b82f6",
    brightMagenta: "#a855f7",
    brightCyan: "#06b6d4",
    brightWhite: "#fafaf9",
  },
};

const abyss: ThemeDef = {
  id: "abyss",
  label: "Abyss",
  swatch: "#000000",
  bg: "#000000",
  sidebarBg: "#050505",
  surface: "#0a0a0a",
  surfaceHover: "#111111",
  surfaceRaised: "#0d0d0d",
  terminalBg: "#000000",
  border: "#161616",
  borderHover: "#222222",
  text: "#d4d4d4",
  textDim: "#737373",
  textMuted: "#404040",
  accent: "#e5e5e5",
  accentHover: "#ffffff",
  accentDim: "rgba(229, 229, 229, 0.06)",
  accentSubtle: "rgba(229, 229, 229, 0.1)",
  green: "#4ade80",
  greenDim: "rgba(74, 222, 128, 0.08)",
  red: "#f87171",
  redDim: "rgba(248, 113, 113, 0.08)",
  yellow: "#facc15",
  yellowDim: "rgba(250, 204, 21, 0.08)",
  blue: "#60a5fa",
  blueDim: "rgba(96, 165, 250, 0.08)",
  terminal: {
    background: "#000000",
    foreground: "#d4d4d4",
    cursor: "#e5e5e5",
    selectionBackground: "rgba(229,229,229,0.15)",
    black: "#0a0a0a",
    red: "#f87171",
    green: "#4ade80",
    yellow: "#facc15",
    blue: "#60a5fa",
    magenta: "#c084fc",
    cyan: "#22d3ee",
    white: "#d4d4d4",
    brightBlack: "#525252",
    brightRed: "#fca5a5",
    brightGreen: "#86efac",
    brightYellow: "#fde68a",
    brightBlue: "#93c5fd",
    brightMagenta: "#d8b4fe",
    brightCyan: "#67e8f9",
    brightWhite: "#fafafa",
  },
};

const dawn: ThemeDef = {
  id: "dawn",
  label: "Dawn",
  swatch: "#f0e6d3",
  bg: "#faf4ed",
  sidebarBg: "#f2e9de",
  surface: "#e8ddd0",
  surfaceHover: "#ddd1c1",
  surfaceRaised: "#ede3d6",
  terminalBg: "#faf4ed",
  border: "#ddd1c1",
  borderHover: "#c5b9a8",
  text: "#575279",
  textDim: "#797593",
  textMuted: "#9893a5",
  accent: "#d7827e",
  accentHover: "#c4635f",
  accentDim: "rgba(215, 130, 126, 0.08)",
  accentSubtle: "rgba(215, 130, 126, 0.14)",
  green: "#286983",
  greenDim: "rgba(40, 105, 131, 0.08)",
  red: "#b4637a",
  redDim: "rgba(180, 99, 122, 0.08)",
  yellow: "#ea9d34",
  yellowDim: "rgba(234, 157, 52, 0.08)",
  blue: "#56949f",
  blueDim: "rgba(86, 148, 159, 0.08)",
  terminal: {
    background: "#faf4ed",
    foreground: "#575279",
    cursor: "#d7827e",
    selectionBackground: "rgba(215,130,126,0.18)",
    black: "#575279",
    red: "#b4637a",
    green: "#286983",
    yellow: "#ea9d34",
    blue: "#56949f",
    magenta: "#907aa9",
    cyan: "#d7827e",
    white: "#f2e9de",
    brightBlack: "#797593",
    brightRed: "#b4637a",
    brightGreen: "#286983",
    brightYellow: "#ea9d34",
    brightBlue: "#56949f",
    brightMagenta: "#907aa9",
    brightCyan: "#d7827e",
    brightWhite: "#faf4ed",
  },
};

const graphite: ThemeDef = {
  id: "graphite",
  label: "Graphite",
  swatch: "#5c5c5c",
  bg: "#2b2b2b",
  sidebarBg: "#313335",
  surface: "#3c3f41",
  surfaceHover: "#4e5254",
  surfaceRaised: "#45484a",
  terminalBg: "#1e1e1e",
  border: "#515151",
  borderHover: "#626262",
  text: "#bbbbbb",
  textDim: "#999999",
  textMuted: "#6a6a6a",
  accent: "#589df6",
  accentHover: "#79b8ff",
  accentDim: "rgba(88, 157, 246, 0.1)",
  accentSubtle: "rgba(88, 157, 246, 0.16)",
  green: "#6a8759",
  greenDim: "rgba(106, 135, 89, 0.15)",
  red: "#cc7832",
  redDim: "rgba(204, 120, 50, 0.12)",
  yellow: "#bbb529",
  yellowDim: "rgba(187, 181, 41, 0.1)",
  blue: "#6897bb",
  blueDim: "rgba(104, 151, 187, 0.1)",
  terminal: {
    background: "#1e1e1e",
    foreground: "#bbbbbb",
    cursor: "#589df6",
    selectionBackground: "rgba(88,157,246,0.2)",
    black: "#2b2b2b",
    red: "#cc7832",
    green: "#6a8759",
    yellow: "#bbb529",
    blue: "#6897bb",
    magenta: "#9876aa",
    cyan: "#629755",
    white: "#bbbbbb",
    brightBlack: "#6a6a6a",
    brightRed: "#ffc66d",
    brightGreen: "#a5c261",
    brightYellow: "#e8bf6a",
    brightBlue: "#79b8ff",
    brightMagenta: "#b39ddb",
    brightCyan: "#6a8759",
    brightWhite: "#e0e0e0",
  },
};

export const themes: ThemeDef[] = [
  obsidian,
  tokyoNight,
  rosePine,
  nord,
  graphite,
  ember,
  paper,
  dawn,
  abyss,
];

const STORAGE_KEY = "lever-theme";

function applyTheme(theme: ThemeDef) {
  const root = document.documentElement;
  root.style.setProperty("--bg", theme.bg);
  root.style.setProperty("--sidebar-bg", theme.sidebarBg);
  root.style.setProperty("--surface", theme.surface);
  root.style.setProperty("--surface-hover", theme.surfaceHover);
  root.style.setProperty("--surface-raised", theme.surfaceRaised);
  root.style.setProperty("--terminal-bg", theme.terminalBg);
  root.style.setProperty("--border", theme.border);
  root.style.setProperty("--border-hover", theme.borderHover);
  root.style.setProperty("--text", theme.text);
  root.style.setProperty("--text-dim", theme.textDim);
  root.style.setProperty("--text-muted", theme.textMuted);
  root.style.setProperty("--accent", theme.accent);
  root.style.setProperty("--accent-hover", theme.accentHover);
  root.style.setProperty("--accent-dim", theme.accentDim);
  root.style.setProperty("--accent-subtle", theme.accentSubtle);
  root.style.setProperty("--green", theme.green);
  root.style.setProperty("--green-dim", theme.greenDim);
  root.style.setProperty("--red", theme.red);
  root.style.setProperty("--red-dim", theme.redDim);
  root.style.setProperty("--yellow", theme.yellow);
  root.style.setProperty("--yellow-dim", theme.yellowDim);
  root.style.setProperty("--blue", theme.blue);
  root.style.setProperty("--blue-dim", theme.blueDim);
}

// Callbacks that get notified when the terminal theme changes
const terminalListeners = new Set<(t: ThemeDef["terminal"]) => void>();

export function onTerminalThemeChange(cb: (t: ThemeDef["terminal"]) => void) {
  terminalListeners.add(cb);
  return () => { terminalListeners.delete(cb); };
}

interface ThemeState {
  activeThemeId: string;
  setTheme: (id: string) => void;
  getTerminalTheme: () => ThemeDef["terminal"];
}

function getInitialThemeId(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && themes.find((t) => t.id === stored)) return stored;
  } catch {}
  return "obsidian";
}

function findTheme(id: string): ThemeDef {
  return themes.find((t) => t.id === id) ?? themes[0];
}

// Apply on load
const initialTheme = findTheme(getInitialThemeId());
applyTheme(initialTheme);

export const useThemeStore = create<ThemeState>((set, get) => ({
  activeThemeId: initialTheme.id,

  setTheme: (id: string) => {
    const theme = findTheme(id);
    applyTheme(theme);
    try { localStorage.setItem(STORAGE_KEY, id); } catch {}
    // Notify terminal listeners
    for (const cb of terminalListeners) cb(theme.terminal);
    set({ activeThemeId: theme.id });
  },

  getTerminalTheme: () => findTheme(get().activeThemeId).terminal,
}));

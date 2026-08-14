import { create } from "zustand";

export interface ThemeDef {
  id: string;
  label: string;
  /** Base of the theme picker swatch — the background you'll be looking at.
   *  The picker pairs it with `accent` as a split disc. */
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
  /** Foreground color paired with `accent` backgrounds (primary buttons, etc.) */
  accentForeground: string;
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

// Themes are published base16/base24 schemes from tinted-theming/schemes, not
// palettes invented here. Each value is a scheme slot verbatim or a blend of two
// slots of that same scheme.
//
// Two things base16 does not supply, derived per scheme:
//   - a three-step text ramp. base03/base04 mean different things in different
//     schemes (Nord's base04 is near-white, others put a dark surface there), so
//     --text-dim and --text-muted fade the scheme's own base05 toward its base00
//     to a target that scales with the theme's own contrast. Low-contrast themes
//     stay low-contrast on purpose.
//   - UI semantics that read on the sidebar. Where a scheme carries both a
//     normal and a bright variant, the more legible one wins.
//   - a chrome ladder. base01/base02 are editor surfaces (line highlight,
//     selection), not app chrome. Most schemes keep them near base00 and map
//     straight across, but a coarse ramp lands mid-grey: da-one-black steps
//     #000000 -> #282828 -> #585858, which gave a "black" theme a grey sidebar.
//     Rungs past a contrast cap fade back toward the background; of the five
//     themes here only Black binds, so the rest are published values verbatim.
//
// Regenerate with scratchpad/build.mjs, which also validates that a port puts a
// red in base08 and a green in base0B. Several popular ports do not: every Tokyo
// Night scheme in that repo has the foreground colour #C0CAF5 in the red slot,
// which would have made Lever's error state pale blue.

/** Black — NNB (https://github.com/NNBnh) (base16). */
const black: ThemeDef = {
  id: "black",
  label: "Black",
  swatch: "#000000",
  bg: "#000000",
  sidebarBg: "#0f0f0f",
  surface: "#1b1b1b",
  surfaceHover: "#262626",
  surfaceRaised: "#151515",
  terminalBg: "#000000",
  border: "#232323",
  borderHover: "#3f3f3f",
  text: "#ffffff",
  textDim: "#cccccc",
  textMuted: "#979797",
  accent: "#6bb8ff",
  accentHover: "#aad1ff",
  accentDim: "rgba(107, 184, 255, 0.09)",
  accentSubtle: "rgba(107, 184, 255, 0.16)",
  accentForeground: "#000000",
  green: "#98c379",
  greenDim: "rgba(152, 195, 121, 0.1)",
  red: "#fa7883",
  redDim: "rgba(250, 120, 131, 0.1)",
  yellow: "#ffc387",
  yellowDim: "rgba(255, 195, 135, 0.1)",
  blue: "#6bb8ff",
  blueDim: "rgba(107, 184, 255, 0.1)",
  terminal: {
    background: "#000000",
    foreground: "#ffffff",
    cursor: "#6bb8ff",
    selectionBackground: "rgba(107, 184, 255, 0.25)",
    black: "#282828",
    red: "#fa7883",
    green: "#98c379",
    yellow: "#ff9470",
    blue: "#6bb8ff",
    magenta: "#e799ff",
    cyan: "#8af5ff",
    white: "#ffffff",
    brightBlack: "#888888",
    brightRed: "#fba8ad",
    brightGreen: "#b9d4a8",
    brightYellow: "#ffb7a4",
    brightBlue: "#a2cdff",
    brightMagenta: "#edbaff",
    brightCyan: "#b1f8ff",
    brightWhite: "#ffffff",
  },
};

/** Charcoal — Steph Ango (https://github.com/kepano/flexoki) (base24). */
const charcoal: ThemeDef = {
  id: "charcoal",
  label: "Charcoal",
  swatch: "#100f0f",
  bg: "#100f0f",
  sidebarBg: "#1c1b1a",
  surface: "#282726",
  surfaceHover: "#403f3d",
  surfaceRaised: "#232221",
  terminalBg: "#100f0f",
  border: "#282726",
  borderHover: "#575653",
  text: "#cecdc3",
  textDim: "#a2a29a",
  textMuted: "#75746e",
  accent: "#da702c",
  accentHover: "#e6ab90",
  accentDim: "rgba(218, 112, 44, 0.09)",
  accentSubtle: "rgba(218, 112, 44, 0.16)",
  accentForeground: "#100f0f",
  green: "#879a39",
  greenDim: "rgba(135, 154, 57, 0.1)",
  red: "#d14d41",
  redDim: "rgba(209, 77, 65, 0.1)",
  yellow: "#d0a215",
  yellowDim: "rgba(208, 162, 21, 0.1)",
  blue: "#4385be",
  blueDim: "rgba(67, 133, 190, 0.1)",
  terminal: {
    background: "#100f0f",
    foreground: "#cecdc3",
    cursor: "#da702c",
    selectionBackground: "rgba(218, 112, 44, 0.25)",
    black: "#1c1b1a",
    red: "#d14d41",
    green: "#879a39",
    yellow: "#d0a215",
    blue: "#4385be",
    magenta: "#8b7ec8",
    cyan: "#3aa99f",
    white: "#cecdc3",
    brightBlack: "#575653",
    brightRed: "#af3029",
    brightGreen: "#ad8301",
    brightYellow: "#bc5215",
    brightBlue: "#24837b",
    brightMagenta: "#205ea6",
    brightCyan: "#66800b",
    brightWhite: "#fffcf0",
  },
};

/** Material — Nate Peterson (base16). */
const material: ThemeDef = {
  id: "material",
  label: "Material",
  swatch: "#263238",
  bg: "#263238",
  sidebarBg: "#2e3c43",
  surface: "#314549",
  surfaceHover: "#425860",
  surfaceRaised: "#304146",
  terminalBg: "#263238",
  border: "#314549",
  borderHover: "#546e7a",
  text: "#eeffff",
  textDim: "#bdcccc",
  textMuted: "#8b9798",
  accent: "#82aaff",
  accentHover: "#b4c9ff",
  accentDim: "rgba(130, 170, 255, 0.09)",
  accentSubtle: "rgba(130, 170, 255, 0.16)",
  accentForeground: "#263238",
  green: "#c3e88d",
  greenDim: "rgba(195, 232, 141, 0.1)",
  red: "#f07178",
  redDim: "rgba(240, 113, 120, 0.1)",
  yellow: "#ffcb6b",
  yellowDim: "rgba(255, 203, 107, 0.1)",
  blue: "#82aaff",
  blueDim: "rgba(130, 170, 255, 0.1)",
  terminal: {
    background: "#263238",
    foreground: "#eeffff",
    cursor: "#82aaff",
    selectionBackground: "rgba(130, 170, 255, 0.25)",
    black: "#2e3c43",
    red: "#f07178",
    green: "#c3e88d",
    yellow: "#ffcb6b",
    blue: "#82aaff",
    magenta: "#c792ea",
    cyan: "#89ddff",
    white: "#eeffff",
    brightBlack: "#546e7a",
    brightRed: "#f0a5a8",
    brightGreen: "#cfeeb3",
    brightYellow: "#fbdaa2",
    brightBlue: "#a6c4ff",
    brightMagenta: "#d2b6ef",
    brightCyan: "#aae6ff",
    brightWhite: "#ffffff",
  },
};

/** Dracula — clach04 (https://github.com/clach04) (base24). */
const dracula: ThemeDef = {
  id: "dracula",
  label: "Dracula",
  swatch: "#282a36",
  bg: "#282a36",
  sidebarBg: "#1e2029",
  surface: "#44475a",
  surfaceHover: "#525b7e",
  surfaceRaised: "#363847",
  terminalBg: "#282a36",
  border: "#44475a",
  borderHover: "#6272a4",
  text: "#f8f8f2",
  textDim: "#c5c6c2",
  textMuted: "#919290",
  accent: "#bd93f9",
  accentHover: "#d4bcfb",
  accentDim: "rgba(189, 147, 249, 0.09)",
  accentSubtle: "rgba(189, 147, 249, 0.16)",
  accentForeground: "#282a36",
  green: "#69ff94",
  greenDim: "rgba(105, 255, 148, 0.1)",
  red: "#ff6e6e",
  redDim: "rgba(255, 110, 110, 0.1)",
  yellow: "#ffffa5",
  yellowDim: "rgba(255, 255, 165, 0.1)",
  blue: "#d6acff",
  blueDim: "rgba(214, 172, 255, 0.1)",
  terminal: {
    background: "#282a36",
    foreground: "#f8f8f2",
    cursor: "#bd93f9",
    selectionBackground: "rgba(189, 147, 249, 0.25)",
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    brightBlack: "#6272a4",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff",
  },
};

/** Daylight — Steph Ango (https://github.com/kepano/flexoki) (base24). */
const daylight: ThemeDef = {
  id: "daylight",
  label: "Daylight",
  swatch: "#fffcf0",
  bg: "#fffcf0",
  sidebarBg: "#f2f0e5",
  surface: "#e6e4d9",
  surfaceHover: "#dddbd1",
  surfaceRaised: "#eceadf",
  terminalBg: "#fffcf0",
  border: "#e6e4d9",
  borderHover: "#cecdc3",
  text: "#403e3c",
  textDim: "#5e5c59",
  textMuted: "#898680",
  accent: "#205ea6",
  accentHover: "#1c508d",
  accentDim: "rgba(32, 94, 166, 0.09)",
  accentSubtle: "rgba(32, 94, 166, 0.16)",
  accentForeground: "#fffcf0",
  green: "#66800b",
  greenDim: "rgba(102, 128, 11, 0.1)",
  red: "#af3029",
  redDim: "rgba(175, 48, 41, 0.1)",
  yellow: "#ad8301",
  yellowDim: "rgba(173, 131, 1, 0.1)",
  blue: "#3aa99f",
  blueDim: "rgba(58, 169, 159, 0.1)",
  terminal: {
    background: "#fffcf0",
    foreground: "#403e3c",
    cursor: "#205ea6",
    selectionBackground: "rgba(32, 94, 166, 0.25)",
    black: "#f2f0e5",
    red: "#af3029",
    green: "#66800b",
    yellow: "#ad8301",
    blue: "#205ea6",
    magenta: "#5e409d",
    cyan: "#24837b",
    white: "#403e3c",
    brightBlack: "#cecdc3",
    brightRed: "#d14d41",
    brightGreen: "#d0a215",
    brightYellow: "#da702c",
    brightBlue: "#3aa99f",
    brightMagenta: "#4385be",
    brightCyan: "#879a39",
    brightWhite: "#100f0f",
  },
};

export const themes: ThemeDef[] = [
  black,
  charcoal,
  material,
  dracula,
  daylight,
];

const STORAGE_KEY = "lever-theme";

/** Key holding the active theme's CSS variables, applied pre-paint by the
 *  boot script in index.html so switching windows/reloads never flash the
 *  default theme. */
const VARS_STORAGE_KEY = "lever-theme-vars";

function themeVars(theme: ThemeDef): Record<string, string> {
  return {
    "--bg": theme.bg,
    "--sidebar-bg": theme.sidebarBg,
    "--surface": theme.surface,
    "--surface-hover": theme.surfaceHover,
    "--surface-raised": theme.surfaceRaised,
    "--terminal-bg": theme.terminalBg,
    "--border": theme.border,
    "--border-hover": theme.borderHover,
    "--text": theme.text,
    "--text-dim": theme.textDim,
    "--text-muted": theme.textMuted,
    "--accent": theme.accent,
    "--accent-hover": theme.accentHover,
    "--accent-dim": theme.accentDim,
    "--accent-subtle": theme.accentSubtle,
    "--accent-fg": theme.accentForeground,
    "--green": theme.green,
    "--green-dim": theme.greenDim,
    "--red": theme.red,
    "--red-dim": theme.redDim,
    "--yellow": theme.yellow,
    "--yellow-dim": theme.yellowDim,
    "--blue": theme.blue,
    "--blue-dim": theme.blueDim,
  };
}

function applyTheme(theme: ThemeDef) {
  const root = document.documentElement;
  const vars = themeVars(theme);
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value);
  }
  try {
    localStorage.setItem(VARS_STORAGE_KEY, JSON.stringify(vars));
  } catch {}
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

/** Themes the rebuild retired, each pointing at whichever survivor sits closest
 *  in background lightness and accent hue. Without this everyone on a retired
 *  theme silently lands on the list head instead of something they'd recognise. */
const RETIRED_THEMES: Record<string, string> = {
  foundry: "charcoal",
  ember: "charcoal",
  abyss: "black",
  obsidian: "dracula",
  "rose-pine": "dracula",
  "tokyo-night": "material",
  nord: "material",
  graphite: "material",
  paper: "daylight",
  dawn: "daylight",
};

function getInitialThemeId(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return "charcoal";
    if (themes.find((t) => t.id === stored)) return stored;
    const moved = RETIRED_THEMES[stored];
    if (moved) {
      // Rewrite the stored id so the migration only happens once.
      try { localStorage.setItem(STORAGE_KEY, moved); } catch {}
      return moved;
    }
  } catch {}
  return "charcoal";
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

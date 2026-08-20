import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import * as api from "./tauri";
import { tauriListen } from "./tauri";
import { useThemeStore, onTerminalThemeChange } from "../stores/themeStore";
import { useSettingsStore } from "../stores/settingsStore";
import type { PtyDataEvent } from "../types";

// ---------------------------------------------------------------------------
// Service log terminals
//
// These live outside React so a terminal keeps consuming its PTY's output while
// the log panel is closed — or was never opened. A terminal is built as soon as
// its service starts and stays subscribed for the life of the PTY; the panel
// only borrows `termDiv` and moves it into view.
// ---------------------------------------------------------------------------

export interface SvcTermEntry {
  term: Terminal;
  fitAddon: FitAddon;
  /** The div xterm.js was opened into — detached until the panel mounts it. */
  termDiv: HTMLDivElement;
  ptyId: string;
  /** Whether the log panel has ever mounted this terminal. Gates the focus
   *  reset on attach, which is only needed for a terminal that really held
   *  focus at some point. */
  attached: boolean;
  unlisten: (() => void) | null;
  disposables: { dispose: () => void }[];
  disposed: boolean;
}

const svcTermStore = new Map<string, SvcTermEntry>();

/** Off-screen parking spot for terminals whose log panel isn't open.
 *
 * `display: none` is deliberate, and is what makes buffering-while-closed
 * cheap: xterm's RenderService watches the screen element with an
 * IntersectionObserver and pauses rendering whenever it isn't intersecting, so
 * a parked terminal only pays for parsing writes into its buffer. A host that
 * is merely transparent or off-viewport would not do — IntersectionObserver
 * ignores `visibility` and `opacity`, so the renderer would keep drawing rows
 * nobody can see. Parking in the document (rather than leaving termDiv fully
 * detached) is what guarantees the observer reports on it at all. */
let termHost: HTMLDivElement | null = null;

function getTermHost(): HTMLDivElement {
  if (!termHost) {
    termHost = document.createElement("div");
    termHost.id = "lever-svc-term-host";
    termHost.style.display = "none";
    document.body.appendChild(termHost);
  }
  return termHost;
}

/** Park a terminal back off-screen when its panel unmounts. */
export function parkSvcTerm(entry: SvcTermEntry) {
  if (entry.disposed) return;
  getTermHost().appendChild(entry.termDiv);
}

// Update all service terminals when the theme changes
onTerminalThemeChange((termTheme) => {
  for (const [, entry] of svcTermStore) {
    if (!entry.disposed) {
      entry.term.options.theme = termTheme;
    }
  }
});

// Type size applies to every service terminal immediately, matching the
// workspace terminals in usePty. This matters more now that terminals are built
// when a service starts rather than when its panel first opens: without it, a
// long-running service would keep whatever size was set at spawn time for its
// whole life. Each one is refitted afterwards because the cell size changed —
// a parked terminal has no size to fit to and refits on its next reveal.
useSettingsStore.subscribe((state, prev) => {
  if (state.terminalFontSize === prev.terminalFontSize) return;
  for (const [, entry] of svcTermStore) {
    if (entry.disposed) continue;
    entry.term.options.fontSize = state.terminalFontSize;
    try {
      entry.fitAddon.fit();
    } catch {
      // Parked or detached — no size to fit to yet.
    }
  }
});

/** Destroy a service terminal entry. */
export function destroySvcTerm(serviceId: string) {
  const entry = svcTermStore.get(serviceId);
  if (!entry) return;
  entry.disposed = true;
  entry.unlisten?.();
  for (const d of entry.disposables) d.dispose();
  entry.term.dispose();
  entry.termDiv.remove();
  svcTermStore.delete(serviceId);
}

/** Get (or build) the terminal for a service's PTY.
 *
 * Called on service start so output is captured from the first byte, and again
 * when the log panel mounts — for a session adopted after a webview reload,
 * that mount is where the terminal first gets built. */
export function ensureSvcTerm(serviceId: string, ptyId: string): SvcTermEntry {
  const existing = svcTermStore.get(serviceId);
  if (existing) {
    if (!existing.disposed && existing.ptyId === ptyId) return existing;
    // Either a stale entry, or the service was restarted onto a new PTY — the
    // old buffer belongs to a process that is gone.
    destroySvcTerm(serviceId);
  }

  const termDiv = document.createElement("div");
  termDiv.style.width = "100%";
  termDiv.style.height = "100%";
  getTermHost().appendChild(termDiv);

  const term = new Terminal({
    theme: useThemeStore.getState().getTerminalTheme(),
    fontFamily: '"SF Mono", "JetBrains Mono", "Fira Code", monospace',
    fontSize: useSettingsStore.getState().terminalFontSize,
    lineHeight: 1.4,
    scrollback: useSettingsStore.getState().terminalScrollback,
    cursorBlink: false,
    cursorInactiveStyle: "outline",
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);

  // Opened while parked in the hidden host, which xterm supports directly: it
  // measures character size the first time the terminal actually becomes
  // visible (RenderService's "Terminal was hidden on open" path).
  //
  // Service logs use xterm's DOM renderer (no WebGL): a high-volume dev-server
  // stream into a GPU terminal reliably crashes WKWebView's WebGL context,
  // blanking the whole app. Log output doesn't need GPU acceleration.
  term.open(termDiv);
  // No fit() here — the hidden host has no size for FitAddon to measure. The
  // terminal stays at 80x24, which is the size the PTY was opened at, and gets
  // its first real fit when the panel reveals it.

  const entry: SvcTermEntry = {
    term,
    fitAddon,
    termDiv,
    ptyId,
    attached: false,
    unlisten: null,
    disposables: [],
    disposed: false,
  };
  svcTermStore.set(serviceId, entry);

  // PTY output -> terminal (per-session event)
  tauriListen<PtyDataEvent>(`pty-data-${ptyId}`, (payload) => {
    if (payload.id === ptyId && !entry.disposed) {
      term.write(payload.data);
    }
  }).then((unlisten) => {
    if (entry.disposed) { unlisten(); return; }
    entry.unlisten = unlisten;
  });

  // Terminal input -> PTY
  entry.disposables.push(term.onData((data) => {
    api.writePty(ptyId, data);
  }));

  // Terminal resize -> PTY
  entry.disposables.push(term.onResize(({ cols, rows }) => {
    api.resizePty(ptyId, cols, rows);
  }));

  return entry;
}

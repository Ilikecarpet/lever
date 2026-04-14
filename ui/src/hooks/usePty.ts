import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import * as api from "../lib/tauri";
import { tauriListen } from "../lib/tauri";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useThemeStore, onTerminalThemeChange } from "../stores/themeStore";
import type { PtyDataEvent, PtyExitEvent } from "../types";

// ---------------------------------------------------------------------------
// Module-level terminal store — survives React remounts
// ---------------------------------------------------------------------------

interface PtyEntry {
  term: Terminal;
  fitAddon: FitAddon;
  ptyId: string | null;
  /** The div that xterm.js was opened into — we move this between mount points */
  termDiv: HTMLDivElement;
  unlisten: (() => void) | null;
  unlistenExit: (() => void) | null;
  cwd: string | undefined;
  disposed: boolean;
}

const ptyStore = new Map<string, PtyEntry>();

// Update all terminals when the theme changes
onTerminalThemeChange((termTheme) => {
  for (const [, entry] of ptyStore) {
    if (!entry.disposed) {
      entry.term.options.theme = termTheme;
    }
  }
});

/** Focus a terminal by pane ID. */
export function focusPty(paneId: string) {
  for (const [id, entry] of ptyStore) {
    if (entry.disposed) continue;
    if (id === paneId) {
      entry.term.options.cursorBlink = true;
      entry.term.focus();
    } else {
      entry.term.options.cursorBlink = false;
      entry.term.blur();
    }
  }
}

/** Destroy a terminal and close its PTY. Called only when a pane is truly removed. */
export function destroyPty(paneId: string) {
  const entry = ptyStore.get(paneId);
  if (!entry) return;
  entry.disposed = true;
  entry.unlisten?.();
  entry.unlistenExit?.();
  if (entry.ptyId) api.closePty(entry.ptyId);
  entry.term.dispose();
  entry.termDiv.remove();
  ptyStore.delete(paneId);
}

/** Spawn (or respawn) a PTY backend for an existing terminal entry. */
async function spawnPty(paneId: string, entry: PtyEntry) {
  const { term, cwd } = entry;
  const setPtyId = useWorkspaceStore.getState().setPtyId;

  // Clean up previous listeners if respawning
  entry.unlisten?.();
  entry.unlistenExit?.();
  entry.unlisten = null;
  entry.unlistenExit = null;

  try {
    const info = await api.createPty(term.cols, term.rows, cwd);
    if (entry.disposed) {
      api.closePty(info.id);
      return;
    }

    entry.ptyId = info.id;
    setPtyId(paneId, entry.ptyId);

    // PTY output -> terminal
    const unlisten = await tauriListen<PtyDataEvent>(
      "pty-data",
      (payload) => {
        if (payload.id === entry.ptyId) {
          term.write(payload.data);
        }
      }
    );
    entry.unlisten = unlisten;

    // PTY exit -> respawn
    const unlistenExit = await tauriListen<PtyExitEvent>(
      "pty-exit",
      (payload) => {
        if (payload.id !== entry.ptyId || entry.disposed) return;
        entry.unlisten?.();
        entry.unlisten = null;
        entry.unlistenExit?.();
        entry.unlistenExit = null;
        entry.ptyId = null;
        spawnPty(paneId, entry);
      }
    );
    entry.unlistenExit = unlistenExit;

    if (entry.disposed) {
      unlisten();
      unlistenExit();
      api.closePty(info.id);
    }
  } catch (err) {
    console.error("Failed to create PTY:", err);
    term.write(`\r\nFailed to create PTY: ${err}\r\n`);
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePty(
  paneId: string,
  containerRef: React.RefObject<HTMLDivElement | null>,
  cwd?: string
) {
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const fit = useCallback(() => {
    fitAddonRef.current?.fit();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const existing = ptyStore.get(paneId);

    if (existing && !existing.disposed) {
      // Reattach existing terminal to new mount point
      container.appendChild(existing.termDiv);
      // Reset xterm's internal _isFocused flag: it stays true from before
      // detach, and blur() on a textarea without real DOM focus is a no-op.
      // focus() gives it real DOM focus, then blur() properly fires the
      // event chain so the cursor renders as inactive (outline).
      existing.term.focus();
      existing.term.blur();
      termRef.current = existing.term;
      fitAddonRef.current = existing.fitAddon;
      existing.fitAddon.fit();

      // ResizeObserver with debounced fit
      let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
      const observer = new ResizeObserver(() => {
        if (resizeTimeout) clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
          if (!existing.disposed) {
            existing.fitAddon.fit();
          }
        }, 50);
      });
      observer.observe(container);

      return () => {
        // Detach but don't destroy — terminal survives in ptyStore
        if (resizeTimeout) clearTimeout(resizeTimeout);
        observer.disconnect();
        if (existing.termDiv.parentNode === container) {
          container.removeChild(existing.termDiv);
        }
        termRef.current = null;
        fitAddonRef.current = null;
      };
    }

    // --- First mount: create terminal + PTY ---

    const termDiv = document.createElement("div");
    termDiv.style.width = "100%";
    termDiv.style.height = "100%";
    container.appendChild(termDiv);

    const term = new Terminal({
      theme: useThemeStore.getState().getTerminalTheme(),
      fontFamily: '"SF Mono", "JetBrains Mono", "Fira Code", monospace',
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: false,
      cursorInactiveStyle: "outline",
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termDiv);
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    const entry: PtyEntry = {
      term,
      fitAddon,
      ptyId: null,
      termDiv,
      unlisten: null,
      unlistenExit: null,
      cwd,
      disposed: false,
    };
    ptyStore.set(paneId, entry);

    // Create PTY and wire everything up
    spawnPty(paneId, entry);

    // Terminal title change -> store
    const onTitleDisposable = term.onTitleChange((title) => {
      useWorkspaceStore.getState().setPaneTitle(paneId, title);
    });

    // Terminal input -> PTY
    const onDataDisposable = term.onData((data) => {
      if (entry.ptyId) {
        api.writePty(entry.ptyId, data);
      }
    });

    // Terminal resize -> PTY
    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      if (entry.ptyId) {
        api.resizePty(entry.ptyId, cols, rows);
      }
    });

    // ResizeObserver with debounced fit
    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        if (!entry.disposed) {
          fitAddon.fit();
        }
      }, 50);
    });
    observer.observe(container);

    // Cleanup on unmount: detach from DOM but keep terminal alive
    return () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      observer.disconnect();

      if (termDiv.parentNode === container) {
        container.removeChild(termDiv);
      }
      termRef.current = null;
      fitAddonRef.current = null;

      // NOTE: we do NOT dispose the terminal or close the PTY here.
      // That only happens via destroyPty() when the pane is truly closed.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId]);

  return { fit };
}

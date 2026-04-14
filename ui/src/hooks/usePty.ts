import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import * as api from "../lib/tauri";
import { tauriListen } from "../lib/tauri";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { PtyDataEvent } from "../types";

const THEME = {
  background: "#0a0c12",
  foreground: "#e2e5f0",
  cursor: "#60a5fa",
  selectionBackground: "rgba(96,165,250,0.3)",
  black: "#1a1d27",
  red: "#f87171",
  green: "#34d399",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#a78bfa",
  cyan: "#22d3ee",
  white: "#e2e5f0",
  brightBlack: "#6c7294",
  brightRed: "#fca5a5",
  brightGreen: "#6ee7b7",
  brightYellow: "#fde68a",
  brightBlue: "#93c5fd",
  brightMagenta: "#c4b5fd",
  brightCyan: "#67e8f9",
  brightWhite: "#f8fafc",
};

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
  disposed: boolean;
}

const ptyStore = new Map<string, PtyEntry>();

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
  if (entry.ptyId) api.closePty(entry.ptyId);
  entry.term.dispose();
  entry.termDiv.remove();
  ptyStore.delete(paneId);
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
      theme: THEME,
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
      disposed: false,
    };
    ptyStore.set(paneId, entry);

    const setPtyId = useWorkspaceStore.getState().setPtyId;

    // Create PTY and wire everything up
    api
      .createPty(term.cols, term.rows, cwd)
      .then(async (info) => {
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

        if (entry.disposed) {
          unlisten();
          api.closePty(info.id);
          return;
        }
      })
      .catch((err) => {
        console.error("Failed to create PTY:", err);
        term.write(`\r\nFailed to create PTY: ${err}\r\n`);
      });

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

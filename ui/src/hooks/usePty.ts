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

export function usePty(
  paneId: string,
  containerRef: React.RefObject<HTMLDivElement | null>
) {
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const focus = useCallback(() => {
    termRef.current?.focus();
  }, []);

  const fit = useCallback(() => {
    fitAddonRef.current?.fit();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      theme: THEME,
      fontFamily: '"SF Mono", "JetBrains Mono", "Fira Code", monospace',
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    let ptyId: string | null = null;
    let unlistenPtyData: (() => void) | null = null;
    let disposed = false;

    const setPtyId = useWorkspaceStore.getState().setPtyId;

    // Create PTY and wire everything up
    api
      .createPty(term.cols, term.rows)
      .then(async (info) => {
        if (disposed) {
          api.closePty(info.id);
          return;
        }

        ptyId = info.id;
        setPtyId(paneId, ptyId);

        // PTY output -> terminal
        unlistenPtyData = await tauriListen<PtyDataEvent>(
          "pty-data",
          (payload) => {
            if (payload.id === ptyId) {
              term.write(payload.data);
            }
          }
        );

        if (disposed) {
          unlistenPtyData();
          api.closePty(info.id);
          return;
        }
      })
      .catch((err) => {
        console.error("Failed to create PTY:", err);
        term.write(`\r\nFailed to create PTY: ${err}\r\n`);
      });

    // Terminal input -> PTY
    const onDataDisposable = term.onData((data) => {
      if (ptyId) {
        api.writePty(ptyId, data);
      }
    });

    // Terminal resize -> PTY
    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      if (ptyId) {
        api.resizePty(ptyId, cols, rows);
      }
    });

    // ResizeObserver with debounced fit
    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        if (!disposed) {
          fitAddon.fit();
        }
      }, 50);
    });
    observer.observe(container);

    // Cleanup
    return () => {
      disposed = true;

      if (resizeTimeout) clearTimeout(resizeTimeout);
      observer.disconnect();

      onDataDisposable.dispose();
      onResizeDisposable.dispose();

      unlistenPtyData?.();

      if (ptyId) {
        api.closePty(ptyId);
      }

      term.dispose();

      termRef.current = null;
      fitAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId]);

  return { focus, fit };
}

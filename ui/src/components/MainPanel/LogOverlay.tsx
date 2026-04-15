import { useRef, useEffect, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useServiceStore } from "../../stores/serviceStore";
import { useConfigStore } from "../../stores/configStore";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { useThemeStore, onTerminalThemeChange } from "../../stores/themeStore";
import * as api from "../../lib/tauri";
import { tauriListen } from "../../lib/tauri";
import { IconClose } from "../Icons";
import type { PtyDataEvent } from "../../types";
import "@xterm/xterm/css/xterm.css";
import styles from "./LogOverlay.module.css";

// Module-level store for service terminals — survives React remounts
interface SvcTermEntry {
  term: Terminal;
  fitAddon: FitAddon;
  termDiv: HTMLDivElement;
  ptyId: string;
  unlisten: (() => void) | null;
  onDataDisposable: { dispose: () => void } | null;
  disposed: boolean;
}

const svcTermStore = new Map<string, SvcTermEntry>();

// Update all service terminals when theme changes
onTerminalThemeChange((termTheme) => {
  for (const [, entry] of svcTermStore) {
    if (!entry.disposed) {
      entry.term.options.theme = termTheme;
    }
  }
});

/** Destroy a service terminal entry. */
export function destroySvcTerm(serviceId: string) {
  const entry = svcTermStore.get(serviceId);
  if (!entry) return;
  entry.disposed = true;
  entry.unlisten?.();
  entry.onDataDisposable?.dispose();
  entry.term.dispose();
  entry.termDiv.remove();
  svcTermStore.delete(serviceId);
}

function ServiceTerminalView({ serviceId, ptyId }: { serviceId: string; ptyId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const fit = useCallback(() => {
    fitAddonRef.current?.fit();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const existing = svcTermStore.get(serviceId);

    // Reattach existing terminal for same ptyId
    if (existing && !existing.disposed && existing.ptyId === ptyId) {
      container.appendChild(existing.termDiv);
      existing.term.focus();
      existing.term.blur();
      fitAddonRef.current = existing.fitAddon;
      existing.fitAddon.fit();

      let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
      const observer = new ResizeObserver(() => {
        if (resizeTimeout) clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
          if (!existing.disposed) existing.fitAddon.fit();
        }, 50);
      });
      observer.observe(container);

      return () => {
        if (resizeTimeout) clearTimeout(resizeTimeout);
        observer.disconnect();
        if (existing.termDiv.parentNode === container) {
          container.removeChild(existing.termDiv);
        }
        fitAddonRef.current = null;
      };
    }

    // Destroy old terminal if ptyId changed
    if (existing) {
      destroySvcTerm(serviceId);
    }

    // Create new terminal
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
    fitAddonRef.current = fitAddon;

    const entry: SvcTermEntry = {
      term,
      fitAddon,
      termDiv,
      ptyId,
      unlisten: null,
      onDataDisposable: null,
      disposed: false,
    };
    svcTermStore.set(serviceId, entry);

    // PTY output -> terminal
    tauriListen<PtyDataEvent>("pty-data", (payload) => {
      if (payload.id === ptyId && !entry.disposed) {
        term.write(payload.data);
      }
    }).then((unlisten) => {
      if (entry.disposed) { unlisten(); return; }
      entry.unlisten = unlisten;
    });

    // Terminal input -> PTY
    const onDataDisposable = term.onData((data) => {
      api.writePty(ptyId, data);
    });
    entry.onDataDisposable = onDataDisposable;

    // Terminal resize -> PTY
    term.onResize(({ cols, rows }) => {
      api.resizePty(ptyId, cols, rows);
    });

    // ResizeObserver
    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        if (!entry.disposed) fitAddon.fit();
      }, 50);
    });
    observer.observe(container);

    return () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      observer.disconnect();
      if (termDiv.parentNode === container) {
        container.removeChild(termDiv);
      }
      fitAddonRef.current = null;
    };
  }, [serviceId, ptyId]);

  useEffect(() => {
    fit();
  }, [fit]);

  return <div className={styles.termContainer} ref={containerRef} />;
}

export default function ServiceTerminal() {
  const activeServiceId = useServiceStore((s) => s.activeServiceId);
  const ptyIds = useServiceStore((s) => s.ptyIds);
  const statuses = useServiceStore((s) => s.statuses);
  const setActiveService = useServiceStore((s) => s.setActiveService);

  const groups = useConfigStore((s) => s.groups);
  const worktrees = useWorktreeStore((s) => s.worktrees);

  if (!activeServiceId) return null;

  const ptyId = ptyIds[activeServiceId];
  const isRunning = statuses[activeServiceId] === "running";

  // Find service label across groups and worktrees
  let serviceLabel = activeServiceId;
  for (const g of groups) {
    const svc = g.services.find((s) => s.id === activeServiceId);
    if (svc) { serviceLabel = svc.label; break; }
  }
  if (serviceLabel === activeServiceId) {
    for (const wt of worktrees) {
      for (const g of wt.groups) {
        const svc = g.services.find((s) => s.id === activeServiceId);
        if (svc) { serviceLabel = svc.label; break; }
      }
      if (serviceLabel !== activeServiceId) break;
    }
  }

  return (
    <div className={styles.logPanel}>
      <div className={styles.logHeader}>
        <span className={styles.logLabel}>
          {isRunning && <span className={styles.logDot} />}
          {serviceLabel}
        </span>
        <div className={styles.logHeaderActions}>
          <button
            className={styles.logClose}
            onClick={() => setActiveService(null)}
            title="Close"
          >
            <IconClose size={12} />
          </button>
        </div>
      </div>
      {ptyId ? (
        <ServiceTerminalView serviceId={activeServiceId} ptyId={ptyId} />
      ) : (
        <div className={styles.logOutput}>
          {isRunning
            ? "Service is running (recovered session — no terminal attached)"
            : "Service is not running"}
        </div>
      )}
    </div>
  );
}

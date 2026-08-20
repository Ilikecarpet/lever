import { useRef, useEffect, useCallback, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { useServiceStore } from "../../stores/serviceStore";
import { useConfigStore } from "../../stores/configStore";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { ensureSvcTerm, parkSvcTerm } from "../../lib/svcTerminals";
import { IconClose } from "../Icons";
import "@xterm/xterm/css/xterm.css";
import styles from "./LogOverlay.module.css";

function ServiceTerminalView({ serviceId, ptyId }: { serviceId: string; ptyId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const fit = useCallback(() => {
    fitAddonRef.current?.fit();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Normally this terminal already exists and has been buffering since the
    // service started; ensureSvcTerm only builds one when we are the first to
    // reach this PTY, e.g. a session adopted back after a webview reload.
    const entry = ensureSvcTerm(serviceId, ptyId);

    container.appendChild(entry.termDiv);
    // Reset xterm's internal _isFocused flag: it stays true from before detach,
    // and blur() on a textarea without real DOM focus is a no-op. focus() gives
    // it real DOM focus, then blur() properly fires the event chain so the
    // cursor renders as inactive (outline).
    //
    // Only for a terminal that has been shown before — that's the only way the
    // flag goes stale. Doing it on a first reveal would steal DOM focus from
    // whatever the user was typing in, since clicking a sidebar service row
    // doesn't move focus on its own.
    if (entry.attached) {
      entry.term.focus();
      entry.term.blur();
    }
    entry.attached = true;
    fitAddonRef.current = entry.fitAddon;

    // Defer fit until the browser has laid out the new container. For a
    // terminal that buffered output while detached this is also its first fit
    // ever: it was parked at 80x24, so revealing it reflows the buffer and
    // resizes the PTY to the panel's real geometry.
    requestAnimationFrame(() => {
      if (!entry.disposed) {
        entry.fitAddon.fit();
        entry.term.scrollToBottom();
      }
    });

    // ResizeObserver with debounced fit
    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        if (!entry.disposed) {
          entry.fitAddon.fit();
          entry.term.scrollToBottom();
        }
      }, 50);
    });
    observer.observe(container);

    return () => {
      // Park it, don't destroy it — the terminal stays in svcTermStore and
      // keeps consuming PTY output while the panel is closed.
      if (resizeTimeout) clearTimeout(resizeTimeout);
      observer.disconnect();
      if (entry.termDiv.parentNode === container) {
        parkSvcTerm(entry);
      }
      fitAddonRef.current = null;
    };
  }, [serviceId, ptyId]);

  useEffect(() => {
    fit();
  }, [fit]);

  return (
    <div className={styles.termWrapper}>
      <div className={styles.termContainer} ref={containerRef} />
    </div>
  );
}

const LOG_HEIGHT_KEY = "lever-log-height";

function getInitialLogHeight(): number | null {
  try {
    const v = Number(localStorage.getItem(LOG_HEIGHT_KEY));
    return Number.isFinite(v) && v >= 120 ? v : null;
  } catch {
    return null;
  }
}

export default function ServiceTerminal() {
  const activeServiceId = useServiceStore((s) => s.activeServiceId);
  const ptyIds = useServiceStore((s) => s.ptyIds);
  const statuses = useServiceStore((s) => s.statuses);
  const setActiveService = useServiceStore((s) => s.setActiveService);

  const groups = useConfigStore((s) => s.groups);
  const worktrees = useWorktreeStore((s) => s.worktrees);

  const panelRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(getInitialLogHeight);
  const [resizing, setResizing] = useState(false);

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const panel = panelRef.current;
    if (!panel) return;
    const startY = e.clientY;
    const startHeight = panel.getBoundingClientRect().height;
    const parent = panel.parentElement;
    const maxH = parent
      ? Math.max(160, parent.getBoundingClientRect().height * 0.75)
      : window.innerHeight * 0.6;
    const clamp = (clientY: number) =>
      Math.min(maxH, Math.max(120, startHeight + (startY - clientY)));

    setResizing(true);
    const onMove = (ev: MouseEvent) => setHeight(clamp(ev.clientY));
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setResizing(false);
      try {
        localStorage.setItem(LOG_HEIGHT_KEY, String(Math.round(clamp(ev.clientY))));
      } catch {}
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

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
    <div
      ref={panelRef}
      className={styles.logPanel}
      style={height != null ? { flex: "0 0 auto", height } : undefined}
    >
      <div
        className={styles.resizeHandle}
        onMouseDown={handleResizeStart}
        title="Drag to resize"
      />
      {resizing && <div className={styles.resizeOverlay} />}
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

import { useState, useEffect, useRef } from "react";
import type { ServiceDef } from "../../types";
import { useServiceStore } from "../../stores/serviceStore";
import { useConfigStore } from "../../stores/configStore";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { useClampToViewport } from "../../hooks/useClampToViewport";
import styles from "./ServiceItem.module.css";

/** A task can start and finish faster than the eye can register, so its ring
 *  spins for at least this long before it is allowed to resolve. */
const MIN_SPIN_MS = 700;
/** How long the completion mark lingers after a task ends. */
const DONE_MS = 700;

interface Props {
  service: ServiceDef;
  groupId: string;
  onOpenSettings?: () => void;
  worktreeId?: string | null;
}

export default function ServiceItem({ service, groupId, onOpenSettings, worktreeId }: Props) {
  const status = useServiceStore((s) => s.statuses[service.id] ?? "stopped");
  const pending = useServiceStore((s) => s.pending[service.id]);
  const startService = useServiceStore((s) => s.startService);
  const stopService = useServiceStore((s) => s.stopService);
  const activeServiceId = useServiceStore((s) => s.activeServiceId);
  const setActiveService = useServiceStore((s) => s.setActiveService);
  const removeService = useConfigStore((s) => s.removeService);
  const removeWorktreeService = useWorktreeStore((s) => s.removeWorktreeService);
  const saveConfig = useConfigStore((s) => s.saveConfig);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  useClampToViewport(contextMenuRef, contextMenu?.x ?? 0, contextMenu?.y ?? 0);

  const isRunning = status === "running";
  const isActive = activeServiceId === service.id;
  const isTask = service.service_type === "task";
  const inFlight = pending !== undefined;

  // --- Task motion: fire → spin → settle -----------------------------------
  // The ring is driven from the click rather than from polled status, because a
  // task can begin and exit inside a single poll window and would otherwise
  // never be seen running at all.
  const [floor, setFloor] = useState(false);
  const [done, setDone] = useState(false);
  const floorTimer = useRef<number | undefined>(undefined);
  const wasSpinning = useRef(false);
  const spinning = isTask && (isRunning || inFlight || floor);

  useEffect(() => {
    if (spinning) {
      wasSpinning.current = true;
      return;
    }
    if (!wasSpinning.current) return;
    wasSpinning.current = false;
    setDone(true);
    const t = window.setTimeout(() => setDone(false), DONE_MS);
    return () => window.clearTimeout(t);
  }, [spinning]);

  useEffect(() => () => window.clearTimeout(floorTimer.current), []);

  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      const menu = document.querySelector(`[data-ctx-svc="${service.id}"]`);
      if (menu && menu.contains(e.target as Node)) return;
      setContextMenu(null);
      setConfirmDelete(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [contextMenu, service.id]);

  const handleClick = () => {
    setActiveService(isActive ? null : service.id);
  };

  /** The lever (services) and the ring (tasks) both toggle; the row itself
   *  still just focuses the terminal. */
  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (inFlight) return;
    if (isRunning) {
      stopService(service.id);
      return;
    }
    if (isTask) {
      setFloor(true);
      window.clearTimeout(floorTimer.current);
      floorTimer.current = window.setTimeout(() => setFloor(false), MIN_SPIN_MS);
    }
    startService(service.id);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (!onOpenSettings) return;
    e.preventDefault();
    e.stopPropagation();
    setConfirmDelete(false);
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleEdit = () => {
    setContextMenu(null);
    onOpenSettings?.();
  };

  const handleDeleteConfirm = () => {
    setContextMenu(null);
    setConfirmDelete(false);
    if (isRunning) {
      stopService(service.id);
    }
    if (worktreeId) {
      removeWorktreeService(worktreeId, groupId, service.id);
    } else {
      removeService(groupId, service.id);
    }
    saveConfig();
  };

  return (
    <>
      <div
        className={`${styles.svcItem}${isActive ? ` ${styles.svcItemActive}` : ""}${isRunning ? ` ${styles.svcItemRunning}` : ""}`}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      >
        <span className={styles.svcName} title={service.label}>
          {service.label}
        </span>
        {isTask && <span className={styles.svcKind}>task</span>}

        {isTask ? (
          <button
            className={`${styles.ringWrap}${spinning ? ` ${styles.spinning}` : ""}${done ? ` ${styles.done}` : ""}`}
            onClick={handleToggle}
            title={spinning ? "Stop task" : "Run task"}
            aria-label={spinning ? `Stop ${service.label}` : `Run ${service.label}`}
          >
            <span className={styles.fire}>▶</span>
            <span className={styles.ring} />
          </button>
        ) : (
          <button
            className={`${styles.lever}${isRunning ? ` ${styles.leverOn}` : ""}${inFlight ? ` ${styles.leverMid}` : ""}`}
            onClick={handleToggle}
            role="switch"
            aria-checked={isRunning}
            title={inFlight ? (pending === "starting" ? "Starting…" : "Stopping…") : isRunning ? "Stop" : "Start"}
            aria-label={`${isRunning ? "Stop" : "Start"} ${service.label}`}
          >
            <span className={styles.leverKnob} />
          </button>
        )}
      </div>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className={styles.ctxMenu}
          data-ctx-svc={service.id}
        >
          <button className={styles.ctxItem} onClick={handleEdit}>
            Edit
          </button>
          <button
            className={`${styles.ctxItem} ${styles.ctxItemDanger}`}
            onClick={() => setConfirmDelete((v) => !v)}
          >
            Delete
          </button>
          <div className={`${styles.confirmAccordion}${confirmDelete ? ` ${styles.confirmOpen}` : ""}`}>
            <div className={styles.confirmInner}>
              <div className={styles.confirmWarning}>
                This will permanently remove this service.
              </div>
              <div className={styles.confirmActions}>
                <button
                  className={styles.confirmCancel}
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </button>
                <button
                  className={styles.confirmYes}
                  onClick={handleDeleteConfirm}
                >
                  Yes, delete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

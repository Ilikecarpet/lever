import { useState, useEffect } from "react";
import type { ServiceDef } from "../../types";
import { useServiceStore } from "../../stores/serviceStore";
import { useConfigStore } from "../../stores/configStore";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { IconPlay, IconStop } from "../Icons";
import styles from "./ServiceItem.module.css";

interface Props {
  service: ServiceDef;
  groupId: string;
  onOpenSettings?: () => void;
  worktreeId?: string | null;
}

export default function ServiceItem({ service, groupId, onOpenSettings, worktreeId }: Props) {
  const status = useServiceStore((s) => s.statuses[service.id] ?? "stopped");
  const startService = useServiceStore((s) => s.startService);
  const stopService = useServiceStore((s) => s.stopService);
  const activeServiceId = useServiceStore((s) => s.activeServiceId);
  const setActiveService = useServiceStore((s) => s.setActiveService);
  const removeService = useConfigStore((s) => s.removeService);
  const removeWorktreeService = useWorktreeStore((s) => s.removeWorktreeService);
  const saveConfig = useConfigStore((s) => s.saveConfig);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isRunning = status === "running";
  const isActive = activeServiceId === service.id;

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
        className={`${styles.svcItem}${isActive ? ` ${styles.svcItemActive}` : ""}`}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title="Toggle terminal"
      >
        <div
          className={`${styles.svcDot}${isRunning ? ` ${styles.svcDotRunning}` : ""}`}
        />
        <span className={styles.svcName}>{service.label}</span>
        {service.service_type === "task" && (
          <span className={styles.svcBadge}>Task</span>
        )}
        <div className={styles.svcActions}>
          <button
            className={`${styles.svcBtn} ${styles.svcBtnPlay}`}
            onClick={(e) => {
              e.stopPropagation();
              startService(service.id);
            }}
            disabled={isRunning}
            title="Start"
          >
            <IconPlay size={12} />
          </button>
          <button
            className={`${styles.svcBtn} ${styles.svcBtnKill}`}
            onClick={(e) => {
              e.stopPropagation();
              stopService(service.id);
            }}
            disabled={!isRunning}
            title="Stop"
          >
            <IconStop size={12} />
          </button>
        </div>
      </div>

      {contextMenu && (
        <div
          className={styles.ctxMenu}
          style={{ left: contextMenu.x, top: contextMenu.y }}
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
      )}
    </>
  );
}

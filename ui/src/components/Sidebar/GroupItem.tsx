import { useState, useEffect } from "react";
import type { ServiceGroup } from "../../types";
import { useServiceStore } from "../../stores/serviceStore";
import { useConfigStore } from "../../stores/configStore";
import { IconPlay, IconStop, IconChevron } from "../Icons";
import ServiceItem from "./ServiceItem";
import styles from "./GroupItem.module.css";

interface Props {
  group: ServiceGroup;
  onOpenSettings?: () => void;
}

export default function GroupItem({ group, onOpenSettings }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const statuses = useServiceStore((s) => s.statuses);
  const startService = useServiceStore((s) => s.startService);
  const stopService = useServiceStore((s) => s.stopService);
  const removeGroup = useConfigStore((s) => s.removeGroup);
  const saveConfig = useConfigStore((s) => s.saveConfig);

  const runningCount = group.services.filter(
    (svc) => (statuses[svc.id] ?? "stopped") === "running"
  ).length;

  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      const menu = document.querySelector(`[data-ctx-grp="${group.id}"]`);
      if (menu && menu.contains(e.target as Node)) return;
      setContextMenu(null);
      setConfirmDelete(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [contextMenu, group.id]);

  const handleStartAll = async (e: React.MouseEvent) => {
    e.stopPropagation();
    for (const svc of group.services) {
      if (svc.service_type === "task") continue;
      if ((statuses[svc.id] ?? "stopped") === "running") continue;
      await startService(svc.id);
    }
  };

  const handleStopAll = async (e: React.MouseEvent) => {
    e.stopPropagation();
    for (const svc of [...group.services].reverse()) {
      if ((statuses[svc.id] ?? "stopped") === "running") {
        await stopService(svc.id);
      }
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (!onOpenSettings) return;
    e.preventDefault();
    e.stopPropagation();
    setConfirmDelete(false);
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleManageServices = () => {
    setContextMenu(null);
    onOpenSettings?.();
  };

  const handleDeleteConfirm = () => {
    setContextMenu(null);
    setConfirmDelete(false);
    // Stop all running services in this group first
    for (const svc of group.services) {
      if ((statuses[svc.id] ?? "stopped") === "running") {
        stopService(svc.id);
      }
    }
    removeGroup(group.id);
    saveConfig();
  };

  return (
    <div className={styles.group}>
      <div
        className={styles.groupHeader}
        onClick={() => setCollapsed((c) => !c)}
        onContextMenu={handleContextMenu}
      >
        <span className={styles.groupLabel}>
          <span
            className={`${styles.groupChevron}${collapsed ? ` ${styles.groupChevronCollapsed}` : ""}`}
          >
            <IconChevron size={10} />
          </span>
          {group.label}
          <span className={styles.groupCount}>
            {runningCount}/{group.services.length}
          </span>
        </span>
        <div className={styles.groupActions}>
          <button
            className={`${styles.groupBtn} ${styles.groupBtnStart}`}
            onClick={handleStartAll}
            title="Start all"
          >
            <IconPlay size={12} />
          </button>
          <button
            className={`${styles.groupBtn} ${styles.groupBtnStop}`}
            onClick={handleStopAll}
            title="Stop all"
          >
            <IconStop size={12} />
          </button>
        </div>
      </div>

      <div
        className={`${styles.groupServices}${collapsed ? ` ${styles.groupServicesCollapsed}` : ""}`}
      >
        {group.services.map((svc) => (
          <ServiceItem key={svc.id} service={svc} groupId={group.id} onOpenSettings={onOpenSettings} />
        ))}
      </div>

      {contextMenu && (
        <div
          className={styles.ctxMenu}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          data-ctx-grp={group.id}
        >
          <button className={styles.ctxItem} onClick={handleManageServices}>
            Manage Services
          </button>
          <button
            className={`${styles.ctxItem} ${styles.ctxItemDanger}`}
            onClick={() => setConfirmDelete((v) => !v)}
          >
            Delete Group
          </button>
          <div className={`${styles.confirmAccordion}${confirmDelete ? ` ${styles.confirmOpen}` : ""}`}>
            <div className={styles.confirmWarning}>
              {group.services.length > 0
                ? `This will delete the group and its ${group.services.length} service${group.services.length !== 1 ? "s" : ""}.`
                : "This will delete this empty group."}
            </div>
            <div className={styles.confirmActions}>
              <button className={styles.confirmCancel} onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button className={styles.confirmYes} onClick={handleDeleteConfirm}>
                Yes, delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

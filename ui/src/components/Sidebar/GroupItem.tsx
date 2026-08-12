import { useState, useEffect, useRef } from "react";
import type { ServiceGroup } from "../../types";
import { useServiceStore } from "../../stores/serviceStore";
import { useConfigStore } from "../../stores/configStore";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { usePanelStore } from "../../stores/panelStore";
import { useClampToViewport } from "../../hooks/useClampToViewport";
import { IconChevron } from "../Icons";
import ServiceItem from "./ServiceItem";
import styles from "./GroupItem.module.css";

interface Props {
  group: ServiceGroup;
  worktreeId?: string | null;
}

export default function GroupItem({ group, worktreeId }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const renameRef = useRef<HTMLInputElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  useClampToViewport(contextMenuRef, contextMenu?.x ?? 0, contextMenu?.y ?? 0);

  const statuses = useServiceStore((s) => s.statuses);
  const startService = useServiceStore((s) => s.startService);
  const stopService = useServiceStore((s) => s.stopService);
  const removeGroup = useConfigStore((s) => s.removeGroup);
  const updateGroup = useConfigStore((s) => s.updateGroup);
  const removeWorktreeGroup = useWorktreeStore((s) => s.removeWorktreeGroup);
  const updateWorktreeGroup = useWorktreeStore((s) => s.updateWorktreeGroup);
  const saveConfig = useConfigStore((s) => s.saveConfig);
  const addInInspector = usePanelStore((s) => s.addService);

  const runningCount = group.services.filter(
    (svc) => (statuses[svc.id] ?? "stopped") === "running"
  ).length;

  // A group of nothing but tasks gets no master: there is no sustained state to
  // latch, and tasks are fired individually from their own rows.
  const startable = group.services.filter((svc) => svc.service_type !== "task");
  const hasStartable = startable.length > 0;

  // The master rides the fraction of the group that is actually up, so 1-of-4
  // and 3-of-4 are distinguishable at a glance rather than both reading as
  // "some". Tasks are excluded — they are never part of the latched state.
  const startableRunning = startable.filter(
    (svc) => (statuses[svc.id] ?? "stopped") === "running"
  ).length;
  const fraction = hasStartable ? startableRunning / startable.length : 0;

  useEffect(() => {
    if (renaming) renameRef.current?.select();
  }, [renaming]);

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

  // Throwing the master to a side always means that side, whatever the current
  // position — no toggling and hoping. Start walks the group top-down and stop
  // walks it bottom-up, so the levers ripple in the order things really happen.
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
    e.preventDefault();
    e.stopPropagation();
    setConfirmDelete(false);
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleAddService = () => {
    setContextMenu(null);
    addInInspector(worktreeId ?? null, group.id);
  };

  const handleStartRename = () => {
    setContextMenu(null);
    setRenaming(true);
  };

  /** Renaming lives here rather than in the inspector: the group heading is
   *  the thing being renamed, so you edit it where you can see it. */
  const handleRenameConfirm = (value: string) => {
    const name = value.trim();
    if (name && name !== group.label) {
      if (worktreeId) updateWorktreeGroup(worktreeId, group.id, { label: name });
      else updateGroup(group.id, { label: name });
      saveConfig();
    }
    setRenaming(false);
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
    if (worktreeId) {
      removeWorktreeGroup(worktreeId, group.id);
    } else {
      removeGroup(group.id);
    }
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
          {renaming ? (
            <input
              ref={renameRef}
              className={styles.renameInput}
              defaultValue={group.label}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") handleRenameConfirm(e.currentTarget.value);
                if (e.key === "Escape") setRenaming(false);
              }}
              onBlur={(e) => handleRenameConfirm(e.currentTarget.value)}
            />
          ) : (
            group.label
          )}
          {/* The count is only load-bearing while the levers are hidden. */}
          {!renaming && collapsed && (
            <span className={styles.groupCount}>
              {runningCount}/{group.services.length}
            </span>
          )}
        </span>
        <span className={styles.groupRule} />
        {hasStartable && (
          <div
            className={styles.master}
            data-any={startableRunning > 0 ? "1" : "0"}
            data-all={startableRunning === startable.length ? "1" : "0"}
            style={{ ["--pct" as string]: String(fraction) }}
            onClick={(e) => e.stopPropagation()}
          >
            <span className={styles.masterFill} />
            <span className={styles.masterKnob} />
            <button
              className={`${styles.masterZone} ${styles.masterZoneOff}`}
              onClick={handleStopAll}
              title="Stop all"
              aria-label={`Stop all in ${group.label}`}
            >
              <span className={styles.masterLabel}>Off</span>
            </button>
            <button
              className={`${styles.masterZone} ${styles.masterZoneOn}`}
              onClick={handleStartAll}
              title="Start all"
              aria-label={`Start all in ${group.label}`}
            >
              <span className={styles.masterLabel}>On</span>
            </button>
          </div>
        )}
      </div>

      <div
        className={`${styles.groupServices}${collapsed ? ` ${styles.groupServicesCollapsed}` : ""}`}
      >
        <div className={styles.groupServicesInner}>
          {group.services.map((svc) => (
            <ServiceItem key={svc.id} service={svc} groupId={group.id} worktreeId={worktreeId} />
          ))}
        </div>
      </div>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className={styles.ctxMenu}
          data-ctx-grp={group.id}
        >
          <button className={styles.ctxItem} onClick={handleAddService}>
            Add service
          </button>
          <button className={styles.ctxItem} onClick={handleStartRename}>
            Rename group
          </button>
          <button
            className={`${styles.ctxItem} ${styles.ctxItemDanger}`}
            onClick={() => setConfirmDelete((v) => !v)}
          >
            Delete group
          </button>
          <div className={`${styles.confirmAccordion}${confirmDelete ? ` ${styles.confirmOpen}` : ""}`}>
            <div className={styles.confirmInner}>
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
        </div>
      )}
    </div>
  );
}

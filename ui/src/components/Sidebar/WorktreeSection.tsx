import { useState, useEffect, useRef } from "react";
import type { WorktreeDef } from "../../types";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useGitStore } from "../../stores/gitStore";
import { useServiceStore } from "../../stores/serviceStore";
import { useWorktreeAgent } from "../../hooks/useAgentActivity";
import { useClampToViewport } from "../../hooks/useClampToViewport";
import { switchContext } from "../../lib/switchContext";
import { afterFold } from "../../lib/revealOnSwitch";
import { useConfigStore } from "../../stores/configStore";
import { IconBranch, IconChevron, IconPlus } from "../Icons";
import GroupItem from "./GroupItem";
import styles from "./WorktreeSection.module.css";

interface Props {
  worktree: WorktreeDef;
}

interface ContextMenu {
  x: number;
  y: number;
}

export default function WorktreeSection({ worktree }: Props) {
  const activeWorktreeId = useWorktreeStore((s) => s.activeWorktreeId);
  const deleteWorktree = useWorktreeStore((s) => s.deleteWorktree);
  const closeWorktreeWorkspaces = useWorkspaceStore(
    (s) => s.closeWorktreeWorkspaces
  );
  const agent = useWorktreeAgent(worktree.id);
  const statuses = useServiceStore((s) => s.statuses);
  const activeGitGroupId = useGitStore((s) => s.activeGitGroupId);
  const setActiveGitGroup = useGitStore((s) => s.setActiveGitGroup);
  const gitInfo = useGitStore((s) => s.worktreeGitInfo[worktree.id]);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<"remove" | "disk" | null>(null);
  const [adding, setAdding] = useState(false);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const addWorktreeGroup = useWorktreeStore((s) => s.addWorktreeGroup);
  const saveConfig = useConfigStore((s) => s.saveConfig);
  const rowRef = useRef<HTMLDivElement>(null);
  useClampToViewport(contextMenuRef, contextMenu?.x ?? 0, contextMenu?.y ?? 0);

  const isActive = activeWorktreeId === worktree.id;

  // Collapsing hides the services themselves, so the row carries the count —
  // otherwise a worktree can be running things with nothing on screen saying so.
  const runningCount = worktree.groups
    .flatMap((g) => g.services)
    .filter((svc) => (statuses[svc.id] ?? "stopped") === "running").length;

  // Everything above just folded shut, so bring the newly-opened section into
  // view rather than leaving it pinned wherever the old layout left it.
  useEffect(() => {
    if (!isActive) return;
    return afterFold((behavior) =>
      rowRef.current?.scrollIntoView({ block: "nearest", behavior })
    );
  }, [isActive]);

  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      const menu = document.querySelector(`[data-ctx-wt="${worktree.id}"]`);
      if (menu && menu.contains(e.target as Node)) return;
      setContextMenu(null);
      setConfirmDelete(null);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [contextMenu, worktree.id]);

  const handleClick = () => {
    if (isActive) return;
    switchContext(worktree.id);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setConfirmDelete(null);
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  // Staging and diffing run against this worktree's own working tree, so the
  // panel is opened on it rather than on the main repo.
  const gitOpen = activeGitGroupId === worktree.id;
  const handleOpenGitPanel = (e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveGitGroup(gitOpen ? null : worktree.id, worktree.path);
  };

  /** Mirrors the main repo's add-group row, so a worktree gets groups the same
   *  way the repo does rather than only through a settings dialog. */
  const handleAddGroupConfirm = (value: string) => {
    setAdding(false);
    const name = value.trim();
    if (!name) return;
    const gid = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    if (worktree.groups.find((g) => g.id === gid)) return;
    addWorktreeGroup(worktree.id, { id: gid, label: name, services: [] });
    saveConfig();
  };

  const handleRemove = async (cleanup: boolean) => {
    setContextMenu(null);
    setConfirmDelete(null);
    // Otherwise the panel is left staging against a directory that is going away.
    if (useGitStore.getState().activeGitGroupId === worktree.id) {
      setActiveGitGroup(null);
    }
    // Tearing down terminal panes is best-effort: a failure here must never
    // block the actual worktree removal (it previously did, requiring a 2nd try).
    try {
      closeWorktreeWorkspaces(worktree.id);
    } catch (e) {
      console.error("Failed to close worktree workspaces:", e);
    }
    try {
      await deleteWorktree(worktree.id, cleanup);
    } catch (e) {
      console.error("Failed to remove worktree:", e);
      const msg = e instanceof Error ? e.message : String(e);
      useGitStore
        .getState()
        .setStatusMessage(`Failed to remove worktree: ${msg}`, "error");
    }
  };

  const shortPath = worktree.path.replace(/^\/Users\/[^/]+/, "~");

  return (
    <>
      <div
        ref={rowRef}
        className={`${styles.sectionDivider}${isActive ? ` ${styles.sectionDividerActive}` : ` ${styles.sectionDividerInactive}`}`}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      >
        <span
          className={`${styles.contextChevron}${isActive ? "" : ` ${styles.contextChevronCollapsed}`}`}
        >
          <IconChevron size={10} />
        </span>
        <span className={styles.branchIcon}><IconBranch size={13} /></span>
        <span className={styles.worktreeText}>
          <span
            className={`${styles.branchName}${agent?.active ? ` ${styles.agentBarActive}` : ""}`}
            title={agent ? `${agent.name} is ${agent.active ? "working" : "idle"}` : undefined}
          >{worktree.branch}</span>
          <span className={styles.worktreePath} title={worktree.path}>{shortPath}</span>
        </span>
        {!isActive && runningCount > 0 && (
          <span
            className={styles.runningBadge}
            title={`${runningCount} service${runningCount !== 1 ? "s" : ""} running`}
          >
            <span className={styles.runningDot} />
            {runningCount}
          </span>
        )}
        {gitInfo?.is_dirty && (
          <span className={styles.worktreeDirty} title="Uncommitted changes" />
        )}
        <span
          className={`${styles.worktreeGitBtn}${gitOpen ? ` ${styles.worktreeGitBtnActive}` : ""}`}
          onClick={handleOpenGitPanel}
          title={gitOpen ? "Close git panel" : "Open git panel"}
        >
          <IconBranch size={12} />
        </span>
      </div>

      {/* Groups collapse away unless this worktree is the selected context. */}
      <div
        className={`${styles.worktreeGroups}${isActive ? "" : ` ${styles.worktreeGroupsCollapsed}`}`}
      >
        <div className={styles.worktreeGroupsInner}>
          {worktree.groups.map((group) => (
            <GroupItem
              key={group.id}
              group={group}
              worktreeId={worktree.id}
            />
          ))}

          {adding ? (
            <div className={styles.addGroupInput}>
              <input
                autoFocus
                placeholder="Group name..."
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddGroupConfirm(e.currentTarget.value);
                  if (e.key === "Escape") setAdding(false);
                }}
                onBlur={(e) => handleAddGroupConfirm(e.currentTarget.value)}
              />
            </div>
          ) : (
            <button className={styles.addRow} onClick={() => setAdding(true)}>
              <IconPlus size={10} /> Add group
            </button>
          )}
        </div>
      </div>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className={styles.contextMenu}
          data-ctx-wt={worktree.id}
        >
          <button
            className={styles.contextMenuItem}
            onClick={() => {
              setContextMenu(null);
              setAdding(true);
            }}
          >
            Add group
          </button>
          <div className={styles.contextMenuDivider} />
          <button
            className={styles.contextMenuItem}
            onClick={() => setConfirmDelete((v) => v === "remove" ? null : "remove")}
          >
            Remove from sidebar
          </button>
          <div className={`${styles.confirmAccordion}${confirmDelete === "remove" ? ` ${styles.confirmOpen}` : ""}`}>
            <div className={styles.confirmInner}>
              <div className={styles.confirmWarning}>
                This will remove the worktree from the sidebar only.
              </div>
              <div className={styles.confirmActions}>
                <button className={styles.confirmCancel} onClick={() => setConfirmDelete(null)}>
                  Cancel
                </button>
                <button className={styles.confirmYes} onClick={() => handleRemove(false)}>
                  Yes, remove
                </button>
              </div>
            </div>
          </div>

          <button
            className={`${styles.contextMenuItem} ${styles.contextMenuDanger}`}
            onClick={() => setConfirmDelete((v) => v === "disk" ? null : "disk")}
          >
            Remove + delete from disk
          </button>
          <div className={`${styles.confirmAccordion}${confirmDelete === "disk" ? ` ${styles.confirmOpen}` : ""}`}>
            <div className={styles.confirmInner}>
              <div className={styles.confirmWarning}>
                This will permanently delete the worktree files from disk.
              </div>
              <div className={styles.confirmActions}>
                <button className={styles.confirmCancel} onClick={() => setConfirmDelete(null)}>
                  Cancel
                </button>
                <button className={styles.confirmYesDanger} onClick={() => handleRemove(true)}>
                  Yes, delete from disk
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    </>
  );
}

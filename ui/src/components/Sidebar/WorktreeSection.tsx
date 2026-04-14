import { useState, useEffect } from "react";
import type { WorktreeDef } from "../../types";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { IconBranch } from "../Icons";
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
  const setActiveWorktree = useWorktreeStore((s) => s.setActiveWorktree);
  const deleteWorktree = useWorktreeStore((s) => s.deleteWorktree);
  const closeWorktreeWorkspaces = useWorkspaceStore(
    (s) => s.closeWorktreeWorkspaces
  );
  const addWorkspaceForWorktree = useWorkspaceStore(
    (s) => s.addWorkspaceForWorktree
  );
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<"remove" | "disk" | null>(null);

  const isActive = activeWorktreeId === worktree.id;

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
    setActiveWorktree(worktree.id);
    const workspaces = useWorkspaceStore.getState().workspaces;
    const hasWtWorkspace = workspaces.some(
      (w) => w.worktreeId === worktree.id
    );
    if (!hasWtWorkspace) {
      addWorkspaceForWorktree(worktree.id);
    } else {
      const first = workspaces.find((w) => w.worktreeId === worktree.id);
      if (first) {
        useWorkspaceStore.getState().setActiveWorkspace(first.id);
      }
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setConfirmDelete(null);
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleRemove = async (cleanup: boolean) => {
    setContextMenu(null);
    setConfirmDelete(null);
    closeWorktreeWorkspaces(worktree.id);
    try {
      await deleteWorktree(worktree.id, cleanup);
    } catch (e) {
      console.error("Failed to remove worktree:", e);
    }
  };

  const shortPath = worktree.path.replace(/^\/Users\/[^/]+/, "~");

  return (
    <>
      <div
        className={`${styles.sectionDivider}${isActive ? ` ${styles.sectionDividerActive}` : ` ${styles.sectionDividerInactive}`}`}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      >
        <span className={styles.branchIcon}><IconBranch size={13} /></span>
        <span className={styles.branchName}>{worktree.branch}</span>
        <span className={styles.worktreePath} title={worktree.path}>{shortPath}</span>
      </div>

      {worktree.groups.map((group) => (
        <div key={group.id} className={styles.worktreeGroup}>
          <GroupItem group={group} />
        </div>
      ))}

      {contextMenu && (
        <div
          className={styles.contextMenu}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          data-ctx-wt={worktree.id}
        >
          <button
            className={styles.contextMenuItem}
            onClick={() => setConfirmDelete((v) => v === "remove" ? null : "remove")}
          >
            Remove from sidebar
          </button>
          <div className={`${styles.confirmAccordion}${confirmDelete === "remove" ? ` ${styles.confirmOpen}` : ""}`}>
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

          <button
            className={`${styles.contextMenuItem} ${styles.contextMenuDanger}`}
            onClick={() => setConfirmDelete((v) => v === "disk" ? null : "disk")}
          >
            Remove + delete from disk
          </button>
          <div className={`${styles.confirmAccordion}${confirmDelete === "disk" ? ` ${styles.confirmOpen}` : ""}`}>
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
      )}
    </>
  );
}

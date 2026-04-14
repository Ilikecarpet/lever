import { useState } from "react";
import type { WorktreeDef } from "../../types";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
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

  const isActive = activeWorktreeId === worktree.id;

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
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleRemove = async (cleanup: boolean) => {
    setContextMenu(null);
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
        className={styles.sectionDivider}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        style={{ opacity: isActive ? 1 : 0.7 }}
      >
        <span className={styles.branchIcon}>&#9579;</span>
        <span className={styles.branchName}>{worktree.branch}</span>
        <span className={styles.worktreePath}>{shortPath}</span>
      </div>

      {worktree.groups.map((group) => (
        <div key={group.id} className={styles.worktreeGroup}>
          <GroupItem group={group} />
        </div>
      ))}

      {contextMenu && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 999 }}
            onClick={() => setContextMenu(null)}
          />
          <div
            className={styles.contextMenu}
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              className={styles.contextMenuItem}
              onClick={() => handleRemove(false)}
            >
              Remove from sidebar
            </button>
            <button
              className={`${styles.contextMenuItem} ${styles.contextMenuDanger}`}
              onClick={() => handleRemove(true)}
            >
              Remove + delete from disk
            </button>
          </div>
        </>
      )}
    </>
  );
}

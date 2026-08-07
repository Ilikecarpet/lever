import { useState, useRef, useEffect, useCallback } from "react";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { useServiceStore } from "../../stores/serviceStore";
import { findNode } from "../../lib/paneTree";
import type { PaneLeaf } from "../../types/pane";
import { IconClose, IconPlus } from "../Icons";
import { useClampToViewport } from "../../hooks/useClampToViewport";
import styles from "./WorkspaceBar.module.css";

interface ContextMenu {
  wsId: string;
  x: number;
  y: number;
}

export default function WorkspaceBar() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);
  const closeWorkspace = useWorkspaceStore((s) => s.closeWorkspace);
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);
  const moveWorkspace = useWorkspaceStore((s) => s.moveWorkspace);

  const activeWorktreeId = useWorktreeStore((s) => s.activeWorktreeId);
  const addWorkspaceForWorktree = useWorkspaceStore((s) => s.addWorkspaceForWorktree);

  const setActiveService = useServiceStore((s) => s.setActiveService);

  const filteredWorkspaces = workspaces.filter(
    (w) => w.worktreeId === activeWorktreeId
  );

  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  useClampToViewport(contextMenuRef, contextMenu?.x ?? 0, contextMenu?.y ?? 0);

  // Drag state
  const dragState = useRef<{
    active: boolean;
    wsId: string;
    currentIndex: number;
    startX: number;
  } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const tabRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Focus the rename input when it appears
  useEffect(() => {
    if (editingId) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editingId]);

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [contextMenu]);

  const handleClick = (id: string) => {
    if (editingId) return;
    setActiveWorkspace(id);
    setActiveService(null);
  };

  const handleNew = () => {
    const currentWs = workspaces.find((w) => w.id === activeWorkspaceId);
    const wtId = currentWs?.worktreeId ?? activeWorktreeId;
    if (wtId) {
      addWorkspaceForWorktree(wtId);
    } else {
      addWorkspace();
    }
    setActiveService(null);
  };

  const handleClose = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    closeWorkspace(id);
  };

  const handleContextMenu = (e: React.MouseEvent, wsId: string) => {
    e.preventDefault();
    setContextMenu({ wsId, x: e.clientX, y: e.clientY });
  };

  const startRename = (wsId: string) => {
    const ws = workspaces.find((w) => w.id === wsId);
    if (!ws) return;
    setEditValue(ws.label);
    setEditingId(wsId);
    setContextMenu(null);
  };

  const commitRename = () => {
    if (editingId && editValue.trim()) {
      renameWorkspace(editingId, editValue.trim());
    }
    setEditingId(null);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      commitRename();
    } else if (e.key === "Escape") {
      setEditingId(null);
    }
  };

  const handleTabMouseDown = useCallback(
    (e: React.MouseEvent, index: number, wsId: string) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest("button, input")) return;

      e.preventDefault();
      dragState.current = {
        active: false,
        wsId,
        currentIndex: index,
        startX: e.clientX,
      };
    },
    []
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragState.current) return;

      if (!dragState.current.active) {
        if (Math.abs(e.clientX - dragState.current.startX) < 5) return;
        dragState.current.active = true;
        setDraggingId(dragState.current.wsId);
      }

      e.preventDefault();

      // Find which tab we're over and move live
      for (let i = 0; i < tabRefs.current.length; i++) {
        const el = tabRefs.current[i];
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        const midX = rect.left + rect.width / 2;
        if (e.clientX >= rect.left && e.clientX <= rect.right) {
          const from = dragState.current.currentIndex;
          // Move when cursor crosses the midpoint of the target tab
          const shouldSwap =
            (i > from && e.clientX > midX) ||
            (i < from && e.clientX < midX);
          if (i !== from && shouldSwap) {
            useWorkspaceStore.getState().moveWorkspace(from, i);
            dragState.current.currentIndex = i;
          }
          break;
        }
      }
    };

    const handleMouseUp = () => {
      dragState.current = null;
      setDraggingId(null);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  return (
    <div className={styles.bar}>
      <div className={styles.tabScroll}>
      {filteredWorkspaces.map((ws, i) => (
        <div
          key={ws.id}
          ref={(el) => { tabRefs.current[i] = el; }}
          className={`${styles.tab}${activeWorkspaceId === ws.id ? ` ${styles.tabActive}` : ""}${draggingId === ws.id ? ` ${styles.tabDragging}` : ""}`}
          onClick={() => handleClick(ws.id)}
          onContextMenu={(e) => handleContextMenu(e, ws.id)}
          onMouseDown={(e) => handleTabMouseDown(e, i, ws.id)}
          title={i < 9 ? `⌘${i + 1}` : undefined}
        >
          {i < 9 && <span className={styles.tabIndex}>{i + 1}</span>}
          {editingId === ws.id ? (
            <input
              ref={inputRef}
              className={styles.renameInput}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={commitRename}
              onKeyDown={handleRenameKeyDown}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span>
              {ws.label}
              {(() => {
                const leaf = findNode(ws.root, ws.activePaneId);
                const title = leaf?.type === "leaf" ? (leaf as PaneLeaf).title : null;
                return title ? <span className={styles.paneTitle}> — {title}</span> : null;
              })()}
            </span>
          )}
          <button
            className={styles.close}
            onClick={(e) => handleClose(e, ws.id)}
            title="Close workspace"
          >
            <IconClose size={10} />
          </button>
        </div>
      ))}
      <button
        className={styles.newBtn}
        onClick={handleNew}
        title="New workspace (⌘T)"
      >
        <IconPlus size={14} />
      </button>
      </div>

      {contextMenu && (
        <div ref={contextMenuRef} className={styles.contextMenu}>
          <button
            className={styles.contextMenuItem}
            onClick={() => startRename(contextMenu.wsId)}
          >
            Rename
          </button>
          <button
            className={styles.contextMenuItem}
            onClick={() => {
              closeWorkspace(contextMenu.wsId);
              setContextMenu(null);
            }}
          >
            Close
          </button>
        </div>
      )}
    </div>
  );
}

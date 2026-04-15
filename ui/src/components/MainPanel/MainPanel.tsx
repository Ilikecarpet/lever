import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { useGitStore } from "../../stores/gitStore";
import { useServiceStore } from "../../stores/serviceStore";
import { IconTerminal } from "../Icons";
import WorkspaceBar from "./WorkspaceBar";
import PaneView from "./PaneView";
import ServiceTerminal from "./LogOverlay";
import GitPanel from "./GitPanel";
import styles from "./MainPanel.module.css";

export default function MainPanel() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const activeWorktreeId = useWorktreeStore((s) => s.activeWorktreeId);
  const activeGitGroupId = useGitStore((s) => s.activeGitGroupId);
  const activeServiceId = useServiceStore((s) => s.activeServiceId);

  const contextWorkspaces = workspaces.filter((w) => w.worktreeId === activeWorktreeId);
  const showEmpty =
    contextWorkspaces.length === 0 && !activeGitGroupId && !activeServiceId;
  const showGitPanel = activeGitGroupId && !activeWorkspaceId;

  return (
    <div className={styles.main}>
      <WorkspaceBar />
      <div className={styles.termArea}>
        <div className={styles.paneArea}>
          {showEmpty && (
            <div className={styles.emptyState}>
              <span className={styles.emptyIcon}>
                <IconTerminal size={32} />
              </span>
              <span className={styles.emptyTitle}>No workspaces open</span>
              <span className={styles.emptyHint}>
                Press <kbd className={styles.emptyKbd}>⌘T</kbd> or click{" "}
                <kbd className={styles.emptyKbd}>+</kbd> to open a terminal workspace
              </span>
            </div>
          )}

          {workspaces.map((ws) => (
            <div
              key={ws.id}
              style={{
                position: "absolute",
                inset: 0,
                visibility: ws.id === activeWorkspaceId ? "visible" : "hidden",
                pointerEvents: ws.id === activeWorkspaceId ? "auto" : "none",
              }}
            >
              <PaneView
                node={ws.root}
                activePaneId={ws.activePaneId}
                visible={ws.id === activeWorkspaceId}
                worktreeId={ws.worktreeId}
              />
            </div>
          ))}

          {showGitPanel && <GitPanel />}
        </div>

        {activeServiceId && <ServiceTerminal />}
      </div>
    </div>
  );
}

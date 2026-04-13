import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useGitStore } from "../../stores/gitStore";
import { useServiceStore } from "../../stores/serviceStore";
import WorkspaceBar from "./WorkspaceBar";
import PaneView from "./PaneView";
import LogOverlay from "./LogOverlay";
import GitPanel from "./GitPanel";
import styles from "./MainPanel.module.css";

export default function MainPanel() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const activeGitGroupId = useGitStore((s) => s.activeGitGroupId);
  const activeLogSvcId = useServiceStore((s) => s.activeLogSvcId);

  const showEmpty =
    workspaces.length === 0 && !activeGitGroupId && !activeLogSvcId;
  const showGitPanel = activeGitGroupId && !activeWorkspaceId;

  return (
    <div className={styles.main}>
      <WorkspaceBar />
      <div className={styles.termArea}>
        {showEmpty && (
          <div className={styles.emptyState}>
            Press + to open a workspace
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
            />
          </div>
        ))}

        {showGitPanel && <GitPanel />}

        {activeLogSvcId && <LogOverlay />}
      </div>
    </div>
  );
}

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

  const activeWs = workspaces.find((w) => w.id === activeWorkspaceId);
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

        {activeWs && (
          <div style={{ position: "absolute", inset: 0 }}>
            <PaneView
              node={activeWs.root}
              activePaneId={activeWs.activePaneId}
            />
          </div>
        )}

        {showGitPanel && <GitPanel />}

        {activeLogSvcId && <LogOverlay />}
      </div>
    </div>
  );
}

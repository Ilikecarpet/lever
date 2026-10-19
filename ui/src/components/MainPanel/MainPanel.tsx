import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { useGitStore } from "../../stores/gitStore";
import { useServiceStore } from "../../stores/serviceStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { IconTerminal } from "../Icons";
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
  const defaultKind = useSettingsStore((s) => s.defaultPaneKind);

  const contextWorkspaces = workspaces.filter((w) => w.worktreeId === activeWorktreeId);
  const showEmpty = contextWorkspaces.length === 0 && !activeServiceId;
  const showGitPanel = !!activeGitGroupId;

  return (
    <div className={styles.main}>
      <div className={styles.termArea}>
        <div className={styles.workRow}>
          <div className={styles.paneArea}>
            {showEmpty && (
              <div className={styles.emptyState}>
                <span className={`${styles.emptyIcon} lv-rise`} style={{ "--i": 0 } as React.CSSProperties}>
                  <IconTerminal size={32} />
                </span>
                <span className={`${styles.emptyTitle} lv-rise`} style={{ "--i": 1 } as React.CSSProperties}>
                  No workspaces open
                </span>
                <span className={`${styles.emptyHint} lv-rise`} style={{ "--i": 2 } as React.CSSProperties}>
                  Press <kbd className={styles.emptyKbd}>⌘T</kbd> or click{" "}
                  <kbd className={styles.emptyKbd}>+</kbd> to open a {defaultKind === "chat" ? "chat" : "terminal"},{" "}
                  <kbd className={styles.emptyKbd}>⌘⇧T</kbd> for a {defaultKind === "chat" ? "terminal" : "chat"}
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
          </div>

          {showGitPanel && <GitPanel />}
        </div>

        {/* Always rendered: it decides for itself when to show, so it can
            stay up for its exit animation after the service is deselected. */}
        <ServiceTerminal />
      </div>
    </div>
  );
}

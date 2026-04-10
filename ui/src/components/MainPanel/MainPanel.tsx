import { useTerminalStore } from "../../stores/terminalStore";
import { useGitStore } from "../../stores/gitStore";
import { useServiceStore } from "../../stores/serviceStore";
import TabBar from "./TabBar";
import TerminalView from "./TerminalView";
import LogOverlay from "./LogOverlay";
import GitPanel from "./GitPanel";
import styles from "./MainPanel.module.css";

export default function MainPanel() {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const activeGitGroupId = useGitStore((s) => s.activeGitGroupId);
  const activeLogSvcId = useServiceStore((s) => s.activeLogSvcId);

  const showEmpty =
    tabs.length === 0 && !activeGitGroupId && !activeLogSvcId;
  const showGitPanel = activeGitGroupId && !activeTabId;

  return (
    <div className={styles.main}>
      <TabBar />
      <div className={styles.termArea}>
        {showEmpty && (
          <div className={styles.emptyState}>
            Press + to open a terminal
          </div>
        )}

        {tabs.map((tab) => (
          <TerminalView key={tab.id} tabId={tab.id} />
        ))}

        {showGitPanel && <GitPanel />}

        {activeLogSvcId && <LogOverlay />}
      </div>
    </div>
  );
}

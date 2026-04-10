import { useTerminalStore } from "../../stores/terminalStore";
import { useGitStore } from "../../stores/gitStore";
import { useServiceStore } from "../../stores/serviceStore";
import styles from "./TabBar.module.css";

export default function TabBar() {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);
  const addTab = useTerminalStore((s) => s.addTab);
  const closeTab = useTerminalStore((s) => s.closeTab);

  const setActiveGitGroup = useGitStore((s) => s.setActiveGitGroup);
  const setActiveLog = useServiceStore((s) => s.setActiveLog);

  const handleClickTab = (id: string) => {
    setActiveTab(id);
    setActiveGitGroup(null);
    setActiveLog(null);
  };

  const handleNewTab = () => {
    addTab();
    setActiveGitGroup(null);
    setActiveLog(null);
  };

  const handleCloseTab = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    closeTab(id);
  };

  return (
    <div className={styles.tabBar}>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`${styles.tab}${activeTabId === tab.id ? ` ${styles.tabActive}` : ""}`}
          onClick={() => handleClickTab(tab.id)}
        >
          <span
            className={`${styles.tdot}${tab.ptyId ? ` ${styles.tdotRunning}` : ""}`}
          />
          <span>{tab.label}</span>
          <button
            className={styles.tclose}
            onClick={(e) => handleCloseTab(e, tab.id)}
          >
            &times;
          </button>
        </div>
      ))}
      <button
        className={styles.tabNew}
        onClick={handleNewTab}
        title="New terminal"
      >
        +
      </button>
    </div>
  );
}

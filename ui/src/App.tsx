import { useEffect, useRef, useState } from "react";
import { useConfigStore } from "./stores/configStore";
import { useServiceStore } from "./stores/serviceStore";
import { useGitStore } from "./stores/gitStore";
import { useTerminalStore } from "./stores/terminalStore";
import Sidebar from "./components/Sidebar/Sidebar";
import MainPanel from "./components/MainPanel/MainPanel";
import StatusBar from "./components/StatusBar/StatusBar";
import ConfigModal from "./components/Modals/ConfigModal";
import styles from "./App.module.css";

export default function App() {
  const loaded = useConfigStore((s) => s.loaded);
  const loadConfig = useConfigStore((s) => s.loadConfig);
  const groups = useConfigStore((s) => s.groups);
  const poll = useServiceStore((s) => s.poll);
  const refreshAllGit = useGitStore((s) => s.refreshAllGit);
  const addTab = useTerminalStore((s) => s.addTab);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const initialized = useRef(false);

  // Load config on mount
  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // After config loads: open first terminal, start polling loops
  useEffect(() => {
    if (!loaded || initialized.current) return;
    initialized.current = true;

    // Open first terminal tab
    addTab();

    // Initial git refresh
    const gitGroups = groups
      .filter((g) => g.repo_path)
      .map((g) => ({ id: g.id, repo_path: g.repo_path }));
    refreshAllGit(gitGroups);

    // Service poll loop (300ms)
    const servicePollId = setInterval(poll, 300);

    // Git poll loop (5000ms)
    const gitPollId = setInterval(() => {
      const currentGroups = useConfigStore.getState().groups;
      const gitGrps = currentGroups
        .filter((g) => g.repo_path)
        .map((g) => ({ id: g.id, repo_path: g.repo_path }));
      refreshAllGit(gitGrps);
    }, 5000);

    return () => {
      clearInterval(servicePollId);
      clearInterval(gitPollId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  return (
    <>
      <div className={styles.layout}>
        <Sidebar onOpenSettings={() => setSettingsOpen(true)} />
        <MainPanel />
      </div>
      <StatusBar />
      {settingsOpen && (
        <ConfigModal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </>
  );
}

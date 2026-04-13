import { useEffect, useRef, useState } from "react";
import { initProjectId } from "./lib/tauri";
import { useConfigStore } from "./stores/configStore";
import { useServiceStore } from "./stores/serviceStore";
import { useGitStore } from "./stores/gitStore";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import Sidebar from "./components/Sidebar/Sidebar";
import MainPanel from "./components/MainPanel/MainPanel";
import StatusBar from "./components/StatusBar/StatusBar";
import ConfigModal from "./components/Modals/ConfigModal";
import StartPage from "./components/StartPage/StartPage";
import styles from "./App.module.css";

const projectId = initProjectId();

function ProjectApp() {
  const loaded = useConfigStore((s) => s.loaded);
  const loadConfig = useConfigStore((s) => s.loadConfig);
  const groups = useConfigStore((s) => s.groups);
  const poll = useServiceStore((s) => s.poll);
  const refreshAllGit = useGitStore((s) => s.refreshAllGit);
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const initialized = useRef(false);

  useKeyboardShortcuts();

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    if (!loaded || initialized.current) return;
    initialized.current = true;

    addWorkspace();

    const gitGroups = groups
      .filter((g) => g.repo_path)
      .map((g) => ({ id: g.id, repo_path: g.repo_path }));
    refreshAllGit(gitGroups);

    const servicePollId = setInterval(poll, 300);

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

export default function App() {
  if (projectId) {
    return <ProjectApp />;
  }
  return <StartPage />;
}

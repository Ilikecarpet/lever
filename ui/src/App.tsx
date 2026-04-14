import { useEffect, useRef, useState } from "react";
import { initProjectId, getProjectId } from "./lib/tauri";
import * as api from "./lib/tauri";
import { useConfigStore } from "./stores/configStore";
import { useServiceStore } from "./stores/serviceStore";
import { useGitStore } from "./stores/gitStore";
import { useWorktreeStore } from "./stores/worktreeStore";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import Sidebar from "./components/Sidebar/Sidebar";
import MainPanel from "./components/MainPanel/MainPanel";
import StatusBar from "./components/StatusBar/StatusBar";
import ConfigModal from "./components/Modals/ConfigModal";
import StartPage from "./components/StartPage/StartPage";
import "./stores/themeStore"; // initialize theme on load
import styles from "./App.module.css";

const projectId = initProjectId();

function ProjectApp() {
  const loaded = useConfigStore((s) => s.loaded);
  const loadConfig = useConfigStore((s) => s.loadConfig);
  const poll = useServiceStore((s) => s.poll);
  const setRepoPath = useGitStore((s) => s.setRepoPath);
  const refreshGitInfo = useGitStore((s) => s.refreshGitInfo);
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

    // Load project repo path and init git
    const pid = getProjectId();
    if (pid) {
      api.getRepoPath(pid).then((rp) => {
        if (rp) {
          setRepoPath(rp);
          refreshGitInfo();
        }
      });
    }

    const servicePollId = setInterval(poll, 300);

    const gitPollId = setInterval(() => {
      const repoPath = useGitStore.getState().repoPath;
      if (repoPath) {
        useGitStore.getState().refreshGitInfo();
        const worktrees = useWorktreeStore.getState().worktrees;
        for (const wt of worktrees) {
          useGitStore.getState().refreshWorktreeGitInfo(wt.id, wt.path);
        }
      }
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

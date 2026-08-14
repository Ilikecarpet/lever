import { useEffect, useRef, useState } from "react";
import { initProjectId, getProjectId } from "./lib/tauri";
import * as api from "./lib/tauri";
import { useConfigStore } from "./stores/configStore";
import { useServiceStore } from "./stores/serviceStore";
import { useGitStore } from "./stores/gitStore";
import { useWorktreeStore } from "./stores/worktreeStore";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { useSettingsStore } from "./stores/settingsStore";
import { useUpdateStore } from "./stores/updateStore";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useDisableTextAssist } from "./hooks/useDisableTextAssist";
import Sidebar from "./components/Sidebar/Sidebar";
import TopBar from "./components/TopBar/TopBar";
import MainPanel from "./components/MainPanel/MainPanel";
import StatusBar from "./components/StatusBar/StatusBar";
import ServiceInspector from "./components/Modals/ServiceInspector";
import SettingsPanel from "./components/Modals/SettingsPanel";
import StartPage from "./components/StartPage/StartPage";
import ScratchApp from "./components/ScratchApp/ScratchApp";
import DebugConsole from "./components/DebugConsole/DebugConsole";
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

  const initialized = useRef(false);

  useKeyboardShortcuts();

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    if (!loaded || initialized.current) return;
    initialized.current = true;

    // Load repo path BEFORE the first workspace mounts, so the initial
    // terminal's PTY spawns with the project dir as its cwd. usePty only
    // reads cwd once (on pane mount), so a late setRepoPath can't fix it.
    const pid = getProjectId();
    const bootstrap = async () => {
      // Mirror the close-behaviour preference down before anything can be
      // started, so a quit right after launch still honours it.
      api
        .setStopServicesOnQuit(useSettingsStore.getState().stopServicesOnQuit)
        .catch(() => {});
      if (pid) {
        try {
          const rp = await api.getRepoPath(pid);
          if (rp) {
            setRepoPath(rp);
            refreshGitInfo();
          }
        } catch (e) {
          console.error("Failed to load repo path:", e);
        }
      }
      addWorkspace();
    };
    bootstrap();

    const servicePollId = setInterval(poll, 300);
    const unlistenSvcExit = useServiceStore.getState().initExitListener();

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

    const stopUpdatePolling = useUpdateStore.getState().startPolling();

    return () => {
      clearInterval(servicePollId);
      clearInterval(gitPollId);
      stopUpdatePolling();
      unlistenSvcExit.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  return (
    <>
      <TopBar />
      <div className={styles.layout}>
        <Sidebar />
        <MainPanel />
      </div>
      <StatusBar />
      {/* One instance each for the whole app — the sidebar points them at
          things, and panelStore guarantees only one is open. */}
      <ServiceInspector />
      <SettingsPanel />
      <DebugConsole />
    </>
  );
}

export default function App() {
  useDisableTextAssist();
  if (projectId) {
    if (api.isScratch()) return <ScratchApp />;
    return <ProjectApp />;
  }
  return <StartPage />;
}

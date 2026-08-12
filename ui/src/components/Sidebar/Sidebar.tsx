import { useState, useRef, useEffect } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import * as api from "../../lib/tauri";
import { useConfigStore } from "../../stores/configStore";
import { useGitStore, MAIN_GIT_TARGET } from "../../stores/gitStore";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useServiceStore } from "../../stores/serviceStore";
import { useUiStore, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from "../../stores/uiStore";
import { useThemeStore, themes } from "../../stores/themeStore";
import { usePanelStore } from "../../stores/panelStore";
import { useWorktreeAgent } from "../../hooks/useAgentActivity";
import { useClampToViewport } from "../../hooks/useClampToViewport";
import { switchContext } from "../../lib/switchContext";
import { afterFold } from "../../lib/revealOnSwitch";
import type { ProjectExport } from "../../types";
import { IconBranch, IconPlus, IconChevron, IconFolder, IconExport, IconGear } from "../Icons";
import GroupItem from "./GroupItem";
import WorktreeSection from "./WorktreeSection";
import NewWorktreeModal from "../Modals/NewWorktreeModal";
import styles from "./Sidebar.module.css";

export default function Sidebar() {
  const groups = useConfigStore((s) => s.groups);
  const addGroup = useConfigStore((s) => s.addGroup);
  const saveConfig = useConfigStore((s) => s.saveConfig);

  const gitInfo = useGitStore((s) => s.gitInfo);
  const repoPath = useGitStore((s) => s.repoPath);
  const activeGitGroupId = useGitStore((s) => s.activeGitGroupId);
  const setActiveGitGroup = useGitStore((s) => s.setActiveGitGroup);

  const worktrees = useWorktreeStore((s) => s.worktrees);
  const activeWorktreeId = useWorktreeStore((s) => s.activeWorktreeId);
  const setActiveWorktree = useWorktreeStore((s) => s.setActiveWorktree);
  const createWorktree = useWorktreeStore((s) => s.createWorktree);

  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const width = useUiStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);

  const activeThemeId = useThemeStore((s) => s.activeThemeId);
  const setTheme = useThemeStore((s) => s.setTheme);
  const openSettings = usePanelStore((s) => s.openSettings);

  const statuses = useServiceStore((s) => s.statuses);

  const mainAgent = useWorktreeAgent(null);

  const isMainActive = activeWorktreeId === null;

  // Collapsing hides the services themselves, so the row carries the count —
  // otherwise the main repo can be running things with nothing on screen
  // saying so.
  const mainRunningCount = groups
    .flatMap((g) => g.services)
    .filter((svc) => (statuses[svc.id] ?? "stopped") === "running").length;

  const [adding, setAdding] = useState(false);
  const [worktreeModalOpen, setWorktreeModalOpen] = useState(false);
  const [mainCtxMenu, setMainCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [themeExpanded, setThemeExpanded] = useState(false);
  const [projectName, setProjectName] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const pid = api.getProjectId();
    if (!pid) return;
    api
      .listProjects()
      .then((list) => {
        const p = list.find((x) => x.id === pid);
        if (p) setProjectName(p.name);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const handleHome = async () => {
    setMenuOpen(false);
    await api.showStartPage();
  };

  const handleExport = async () => {
    setMenuOpen(false);
    const projectId = api.getProjectId() ?? "project";
    const projects = await api.listProjects();
    const project = projects.find((p) => p.id === projectId);
    const name = project?.name ?? projectId;
    const repoPathForExport = project?.repo_path ?? "";

    const filePath = await save({
      title: "Export Config",
      defaultPath: `${projectId}-config.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!filePath) return;

    const config = await api.getConfig();
    const exportDoc: ProjectExport = {
      version: 1,
      name,
      repo_path: repoPathForExport,
      config,
    };
    const json = JSON.stringify(exportDoc, null, 2);
    await api.writeTextFile(filePath, json);
  };

  const handleSettings = () => {
    setMenuOpen(false);
    openSettings();
  };

  const handleResizeStart = (e: React.MouseEvent) => {
    if (collapsed) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    setResizing(true);
    const onMove = (ev: MouseEvent) => setSidebarWidth(startW + (ev.clientX - startX));
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setResizing(false);
      setSidebarWidth(startW + (ev.clientX - startX), true);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const mainCtxMenuRef = useRef<HTMLDivElement>(null);
  useClampToViewport(mainCtxMenuRef, mainCtxMenu?.x ?? 0, mainCtxMenu?.y ?? 0);

  // Switching away collapses the main groups, so drop any half-typed new group
  // rather than leaving a focused input hidden inside the collapsed section.
  useEffect(() => {
    if (activeWorktreeId !== null) setAdding(false);
  }, [activeWorktreeId]);

  // The main repo's groups sit at the top of the scroll area, so returning to
  // it means scrolling back up — otherwise the view stays down where whatever
  // worktree was selected used to be.
  useEffect(() => {
    if (!isMainActive) return;
    return afterFold((behavior) => scrollRef.current?.scrollTo({ top: 0, behavior }));
  }, [isMainActive]);

  useEffect(() => {
    if (adding && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [adding]);

  useEffect(() => {
    if (!mainCtxMenu) return;
    const handler = (e: MouseEvent) => {
      const menu = document.querySelector("[data-ctx-main-repo]");
      if (menu && menu.contains(e.target as Node)) return;
      setMainCtxMenu(null);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [mainCtxMenu]);

  const handleAddConfirm = (value: string) => {
    setAdding(false);
    const name = value.trim();
    if (!name) return;
    const gid = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    if (groups.find((g) => g.id === gid)) return;
    addGroup({ id: gid, label: name, services: [] });
    saveConfig();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      handleAddConfirm(e.currentTarget.value);
    } else if (e.key === "Escape") {
      setAdding(false);
    }
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    handleAddConfirm(e.currentTarget.value);
  };

  const handleMainContextClick = () => {
    switchContext(null);
  };

  // Toggles the docked git panel; terminals stay where they are.
  const handleOpenGitPanel = (e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveGitGroup(
      activeGitGroupId === MAIN_GIT_TARGET ? null : MAIN_GIT_TARGET,
      repoPath
    );
  };

  const handleCreateWorktree = async (branch: string, path: string, baseBranch?: string, replaceStale?: boolean) => {
    const wt = await createWorktree(branch, path, baseBranch, replaceStale);
    await saveConfig();
    setActiveWorktree(wt.id);
    useWorkspaceStore.getState().addWorkspaceForWorktree(wt.id);
  };

  return (
    <div
      className={`${styles.sidebar}${collapsed ? ` ${styles.sidebarCollapsed}` : ""}${resizing ? ` ${styles.sidebarResizing}` : ""}`}
      style={collapsed ? undefined : { width, minWidth: width }}
    >
      {!collapsed && (
        <div
          className={styles.resizeHandle}
          onMouseDown={handleResizeStart}
          title="Drag to resize"
        />
      )}
      {resizing && <div className={styles.resizeOverlay} />}
      <div
        className={`${styles.sidebarInner}${collapsed ? ` ${styles.sidebarInnerCollapsed}` : ""}`}
        style={collapsed ? undefined : { width, minWidth: width }}
        aria-hidden={collapsed}
      >
      <div className={styles.sidebarTop} ref={menuRef}>
        <button
          className={styles.projectBtn}
          onClick={() => setMenuOpen((o) => !o)}
          title={projectName || "Project menu"}
        >
          <span className={styles.projectName}>{projectName || "lever"}</span>
          <span className={styles.projectChevron}>
            <IconChevron size={10} />
          </span>
        </button>

        {menuOpen && (
          <div className={styles.menu}>
            <button className={styles.menuItem} onClick={handleHome}>
              <IconFolder size={13} /> Projects
            </button>
            <button className={styles.menuItem} onClick={handleExport}>
              <IconExport size={13} /> Export Config
            </button>
            <div className={styles.menuDivider} />
            <button className={styles.menuItem} onClick={handleSettings}>
              <IconGear size={13} /> Settings
            </button>
            <div className={styles.menuDivider} />
            <button
              className={styles.themeToggle}
              onClick={(e) => { e.stopPropagation(); setThemeExpanded((v) => !v); }}
            >
              <span className={styles.themeToggleLeft}>
                <span className={styles.themeSwatch} style={{ background: themes.find((t) => t.id === activeThemeId)?.swatch }} />
                Theme
              </span>
              <span className={`${styles.themeChevron}${themeExpanded ? ` ${styles.themeChevronOpen}` : ""}`}>
                <IconChevron size={10} />
              </span>
            </button>
            <div className={`${styles.themeList}${themeExpanded ? ` ${styles.themeListOpen}` : ""}`}>
              <div className={styles.themeListInner}>
                {themes.map((t) => (
                  <button
                    key={t.id}
                    className={`${styles.themeOption}${activeThemeId === t.id ? ` ${styles.themeOptionActive}` : ""}`}
                    onClick={() => setTheme(t.id)}
                  >
                    <span className={styles.themeSwatch} style={{ background: t.swatch }} />
                    {t.label}
                    {activeThemeId === t.id && <span className={styles.themeCheck}>✓</span>}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {repoPath && (
        <>
          <div
            className={`${styles.mainContext}${isMainActive ? ` ${styles.mainContextActive}` : ` ${styles.mainContextInactive}`}`}
            onClick={handleMainContextClick}
            onContextMenu={(e) => {
              e.preventDefault();
              setMainCtxMenu({ x: e.clientX, y: e.clientY });
            }}
          >
            <span
              className={`${styles.contextChevron}${isMainActive ? "" : ` ${styles.contextChevronCollapsed}`}`}
            >
              <IconChevron size={10} />
            </span>
            <span className={styles.branchIcon}>
              <IconBranch size={13} />
            </span>
            <span className={styles.mainContextText}>
              <span
                className={`${styles.mainContextBranch}${mainAgent?.active ? ` ${styles.agentBarActive}` : ""}`}
                title={mainAgent ? `${mainAgent.name} is ${mainAgent.active ? "working" : "idle"}` : undefined}
              >
                {gitInfo?.current_branch ?? "..."}
              </span>
              <span className={styles.mainContextPath} title={repoPath}>
                {repoPath.replace(/^\/Users\/[^/]+/, "~")}
              </span>
            </span>
            {!isMainActive && mainRunningCount > 0 && (
              <span
                className={styles.runningBadge}
                title={`${mainRunningCount} service${mainRunningCount !== 1 ? "s" : ""} running`}
              >
                <span className={styles.runningDot} />
                {mainRunningCount}
              </span>
            )}
            {gitInfo?.is_dirty && (
              <span className={styles.mainContextDirty} title="Uncommitted changes" />
            )}
            <span
              className={`${styles.mainContextGitBtn}${activeGitGroupId === MAIN_GIT_TARGET ? ` ${styles.mainContextGitBtnActive}` : ""}`}
              onClick={handleOpenGitPanel}
              title={activeGitGroupId === MAIN_GIT_TARGET ? "Close git panel (⌘G)" : "Open git panel (⌘G)"}
            >
              <IconBranch size={12} />
            </span>
          </div>
          {mainCtxMenu && (
            <div
              ref={mainCtxMenuRef}
              className={styles.mainCtxMenu}
              data-ctx-main-repo
            >
              <button
                className={styles.mainCtxItem}
                onClick={() => {
                  setMainCtxMenu(null);
                  setAdding(true);
                }}
              >
                Add group
              </button>
            </div>
          )}
        </>
      )}

      <div className={styles.sidebarScroll} ref={scrollRef}>
        {/* Only the selected context shows its groups; the rest stay collapsed
            behind their branch row so the sidebar tracks one branch at a time. */}
        <div
          className={`${styles.contextGroups}${isMainActive ? "" : ` ${styles.contextGroupsCollapsed}`}`}
        >
          <div className={styles.contextGroupsInner}>
            {groups.map((group) => (
              <GroupItem key={group.id} group={group} />
            ))}

            {adding ? (
              <div className={styles.addGroupInput}>
                <input
                  ref={inputRef}
                  placeholder="Group name..."
                  onKeyDown={handleKeyDown}
                  onBlur={handleBlur}
                />
              </div>
            ) : (
              <button className={styles.addRow} onClick={() => setAdding(true)}>
                <IconPlus size={10} /> Add group
              </button>
            )}
          </div>
        </div>

        {repoPath && (
          <>
            <div className={styles.sectionEyebrow}>
              <span>Worktrees</span>
              <button
                className={styles.eyebrowAction}
                onClick={() => setWorktreeModalOpen(true)}
                title="New worktree"
                aria-label="New worktree"
              >
                <IconPlus size={11} />
              </button>
            </div>
            {worktrees.length === 0 && (
              <div className={styles.eyebrowHint}>None yet</div>
            )}
            {worktrees.map((wt) => (
              <WorktreeSection key={wt.id} worktree={wt} />
            ))}
          </>
        )}
      </div>
      </div>

      <NewWorktreeModal
        open={worktreeModalOpen}
        onClose={() => setWorktreeModalOpen(false)}
        onCreate={handleCreateWorktree}
      />
    </div>
  );
}

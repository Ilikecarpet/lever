import { useState, useRef, useEffect } from "react";
import { useConfigStore } from "../../stores/configStore";
import { useGitStore } from "../../stores/gitStore";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import * as api from "../../lib/tauri";
import { useThemeStore, themes } from "../../stores/themeStore";
import { IconChevron, IconFolder, IconExport, IconGear, IconBranch } from "../Icons";
import GroupItem from "./GroupItem";
import WorktreeSection from "./WorktreeSection";
import NewWorktreeModal from "../Modals/NewWorktreeModal";
import styles from "./Sidebar.module.css";

interface Props {
  onOpenSettings: () => void;
}

export default function Sidebar({ onOpenSettings }: Props) {
  const groups = useConfigStore((s) => s.groups);
  const addGroup = useConfigStore((s) => s.addGroup);
  const saveConfig = useConfigStore((s) => s.saveConfig);

  const gitInfo = useGitStore((s) => s.gitInfo);
  const repoPath = useGitStore((s) => s.repoPath);
  const setActiveGitGroup = useGitStore((s) => s.setActiveGitGroup);

  const worktrees = useWorktreeStore((s) => s.worktrees);
  const activeWorktreeId = useWorktreeStore((s) => s.activeWorktreeId);
  const setActiveWorktree = useWorktreeStore((s) => s.setActiveWorktree);
  const createWorktree = useWorktreeStore((s) => s.createWorktree);

  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);

  const activeThemeId = useThemeStore((s) => s.activeThemeId);
  const setTheme = useThemeStore((s) => s.setTheme);

  const [adding, setAdding] = useState(false);
  const [worktreeModalOpen, setWorktreeModalOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [themeExpanded, setThemeExpanded] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (adding && inputRef.current) {
      inputRef.current.focus();
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    }
  }, [adding]);

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

  const handleHome = async () => {
    setMenuOpen(false);
    await api.showStartPage();
  };

  const handleExport = async () => {
    setMenuOpen(false);
    const config = await api.getConfig();
    const json = JSON.stringify(config, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const projectId = api.getProjectId() ?? "project";
    a.download = `${projectId}-config.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSettings = () => {
    setMenuOpen(false);
    onOpenSettings();
  };

  const handleMainContextClick = () => {
    setActiveWorktree(null);
    setActiveGitGroup(null);
    const workspaces = useWorkspaceStore.getState().workspaces;
    const mainWs = workspaces.find((w) => w.worktreeId === null);
    if (mainWs) {
      setActiveWorkspace(mainWs.id);
    }
  };

  const handleOpenGitPanel = (e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveWorktree(null);
    setActiveWorkspace(null);
    setActiveGitGroup("project");
  };

  const handleCreateWorktree = async (branch: string, path: string) => {
    const wt = await createWorktree(branch, path);
    await saveConfig();
    setActiveWorktree(wt.id);
    useWorkspaceStore.getState().addWorkspaceForWorktree(wt.id);
  };

  const isMainActive = activeWorktreeId === null;

  return (
    <div className={styles.sidebar}>
      <div className={styles.sidebarTop} ref={menuRef}>
        <button
          className={styles.titleBtn}
          onClick={() => setMenuOpen((o) => !o)}
        >
          Lever
          <span className={styles.chevron}><IconChevron size={10} /></span>
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
        )}
      </div>

      {repoPath && (
        <div
          className={`${styles.mainContext}${isMainActive ? ` ${styles.mainContextActive}` : ""}`}
          onClick={handleMainContextClick}
        >
          <IconBranch size={13} />
          <span className={styles.mainContextBranch}>
            {gitInfo?.current_branch ?? "..."}
          </span>
          {gitInfo?.is_dirty && (
            <span className={styles.mainContextDirty}>●</span>
          )}
          <span
            className={styles.mainContextGitBtn}
            onClick={handleOpenGitPanel}
            title="Git panel"
          >
            <IconBranch size={12} />
          </span>
        </div>
      )}

      <div className={styles.sidebarScroll} ref={scrollRef}>
        {groups.map((group) => (
          <GroupItem key={group.id} group={group} />
        ))}

        {worktrees.map((wt) => (
          <WorktreeSection key={wt.id} worktree={wt} />
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
          <div className={styles.bottomBar}>
            <button
              className={styles.addGroupBtn}
              onClick={() => setAdding(true)}
            >
              + Add Group
            </button>
            {repoPath && (
              <button
                className={styles.newWorktreeBtn}
                onClick={() => setWorktreeModalOpen(true)}
              >
                + New Worktree
              </button>
            )}
          </div>
        )}
      </div>

      <NewWorktreeModal
        open={worktreeModalOpen}
        onClose={() => setWorktreeModalOpen(false)}
        onCreate={handleCreateWorktree}
      />
    </div>
  );
}

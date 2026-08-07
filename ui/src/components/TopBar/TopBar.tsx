import { useState, useRef, useEffect } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import * as api from "../../lib/tauri";
import { useThemeStore, themes } from "../../stores/themeStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useUiStore } from "../../stores/uiStore";
import type { ProjectExport } from "../../types";
import {
  IconChevron,
  IconFolder,
  IconExport,
  IconGear,
  IconSidebarCollapse,
  IconSidebarExpand,
} from "../Icons";
import WorkspaceBar from "../MainPanel/WorkspaceBar";
import styles from "./TopBar.module.css";

interface Props {
  onOpenSettings: () => void;
}

/**
 * Unified window header: traffic lights, project menu, sidebar toggle and
 * the workspace tabs share one bar drawn into the (hidden) title bar area.
 */
export default function TopBar({ onOpenSettings }: Props) {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);

  const activeThemeId = useThemeStore((s) => s.activeThemeId);
  const setTheme = useThemeStore((s) => s.setTheme);
  const debugConsole = useSettingsStore((s) => s.debugConsole);
  const toggleDebugConsole = useSettingsStore((s) => s.toggleDebugConsole);

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
    onOpenSettings();
  };

  return (
    <div className={styles.topbar} data-tauri-drag-region>
      <div
        className={styles.left}
        style={collapsed ? undefined : { width: sidebarWidth }}
        data-tauri-drag-region
      >
        <div className={styles.lightsSpacer} data-tauri-drag-region />
        <div className={styles.menuWrap} ref={menuRef}>
          <button
            className={styles.projectBtn}
            onClick={() => setMenuOpen((o) => !o)}
            title={projectName || "Project menu"}
          >
            <span className={styles.projectName}>{projectName || "lever"}</span>
            <span className={styles.chevron}>
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
              <button
                className={styles.menuItem}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleDebugConsole();
                }}
              >
                <IconGear size={13} /> Debug console
                {debugConsole && <span className={styles.themeCheck}>✓</span>}
              </button>
              <div className={styles.menuDivider} />
              <button
                className={styles.themeToggle}
                onClick={(e) => {
                  e.stopPropagation();
                  setThemeExpanded((v) => !v);
                }}
              >
                <span className={styles.themeToggleLeft}>
                  <span
                    className={styles.themeSwatch}
                    style={{ background: themes.find((t) => t.id === activeThemeId)?.swatch }}
                  />
                  Theme
                </span>
                <span
                  className={`${styles.themeChevron}${themeExpanded ? ` ${styles.themeChevronOpen}` : ""}`}
                >
                  <IconChevron size={10} />
                </span>
              </button>
              <div
                className={`${styles.themeList}${themeExpanded ? ` ${styles.themeListOpen}` : ""}`}
              >
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
        <span className={styles.leftSpacer} data-tauri-drag-region />
        <button
          className={styles.toggleBtn}
          onClick={toggleSidebar}
          title={collapsed ? "Show sidebar (⌘B)" : "Hide sidebar (⌘B)"}
          aria-label={collapsed ? "Show sidebar" : "Hide sidebar"}
        >
          {collapsed ? <IconSidebarExpand size={14} /> : <IconSidebarCollapse size={14} />}
        </button>
      </div>
      <WorkspaceBar />
    </div>
  );
}

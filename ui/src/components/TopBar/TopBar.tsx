import { getCurrentWindow } from "@tauri-apps/api/window";
import { useUiStore } from "../../stores/uiStore";
import { IconSidebarCollapse, IconSidebarExpand } from "../Icons";
import WorkspaceBar from "../MainPanel/WorkspaceBar";
import styles from "./TopBar.module.css";

/**
 * Unified window header: traffic lights, sidebar toggle and the workspace
 * tabs share one bar drawn into the (hidden) title bar area.
 */
export default function TopBar() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);

  // Explicit window drag: any empty header surface (marked data-app-drag)
  // moves the window; double-click toggles maximize, matching a native
  // title bar. Handled ourselves rather than via data-tauri-drag-region so
  // it can't silently break.
  const handleHeaderMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (!target.hasAttribute("data-app-drag")) return;
    e.preventDefault();
    const win = getCurrentWindow();
    if (e.detail === 2) {
      void win.toggleMaximize();
    } else {
      void win.startDragging();
    }
  };

  return (
    <div className={styles.topbar} data-app-drag onMouseDown={handleHeaderMouseDown}>
      <div
        className={styles.left}
        style={collapsed ? undefined : { width: sidebarWidth }}
        data-app-drag
      >
        <div className={styles.lightsSpacer} data-app-drag />
        <span className={styles.leftSpacer} data-app-drag />
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

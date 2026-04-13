import { useState, useRef, useEffect } from "react";
import { useConfigStore } from "../../stores/configStore";
import * as api from "../../lib/tauri";
import GroupItem from "./GroupItem";
import styles from "./Sidebar.module.css";

interface Props {
  onOpenSettings: () => void;
}

export default function Sidebar({ onOpenSettings }: Props) {
  const groups = useConfigStore((s) => s.groups);
  const addGroup = useConfigStore((s) => s.addGroup);
  const saveConfig = useConfigStore((s) => s.saveConfig);

  const [adding, setAdding] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
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

  // Close menu on click outside
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
    addGroup({ id: gid, label: name, services: [], repo_path: "" });
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

  return (
    <div className={styles.sidebar}>
      <div className={styles.sidebarTop} ref={menuRef}>
        <button
          className={styles.titleBtn}
          onClick={() => setMenuOpen((o) => !o)}
        >
          Lever
          <span className={styles.chevron}>{menuOpen ? "▴" : "▾"}</span>
        </button>

        {menuOpen && (
          <div className={styles.menu}>
            <button className={styles.menuItem} onClick={handleHome}>
              Projects
            </button>
            <button className={styles.menuItem} onClick={handleExport}>
              Export Config
            </button>
            <div className={styles.menuDivider} />
            <button className={styles.menuItem} onClick={handleSettings}>
              Settings
            </button>
          </div>
        )}
      </div>

      <div className={styles.sidebarScroll} ref={scrollRef}>
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
          <button
            className={styles.addGroupBtn}
            onClick={() => setAdding(true)}
          >
            + Add Group
          </button>
        )}
      </div>
    </div>
  );
}

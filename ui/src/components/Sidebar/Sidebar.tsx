import { useState, useRef, useEffect } from "react";
import { useConfigStore } from "../../stores/configStore";
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

  return (
    <div className={styles.sidebar}>
      <div className={styles.sidebarTop}>
        <h1>Lever</h1>
        <button
          className={styles.iconBtn}
          onClick={onOpenSettings}
          title="Settings"
        >
          &#9881;
        </button>
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

import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useGitStore } from "../../stores/gitStore";
import { useServiceStore } from "../../stores/serviceStore";
import styles from "./WorkspaceBar.module.css";

export default function WorkspaceBar() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);
  const closeWorkspace = useWorkspaceStore((s) => s.closeWorkspace);

  const setActiveGitGroup = useGitStore((s) => s.setActiveGitGroup);
  const setActiveLog = useServiceStore((s) => s.setActiveLog);

  const handleClick = (id: string) => {
    setActiveWorkspace(id);
    setActiveGitGroup(null);
    setActiveLog(null);
  };

  const handleNew = () => {
    addWorkspace();
    setActiveGitGroup(null);
    setActiveLog(null);
  };

  const handleClose = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    closeWorkspace(id);
  };

  return (
    <div className={styles.bar}>
      {workspaces.map((ws) => (
        <div
          key={ws.id}
          className={`${styles.tab}${activeWorkspaceId === ws.id ? ` ${styles.tabActive}` : ""}`}
          onClick={() => handleClick(ws.id)}
        >
          <span>{ws.label}</span>
          <button
            className={styles.close}
            onClick={(e) => handleClose(e, ws.id)}
          >
            &times;
          </button>
        </div>
      ))}
      <button
        className={styles.newBtn}
        onClick={handleNew}
        title="New workspace (⌘T)"
      >
        +
      </button>
    </div>
  );
}

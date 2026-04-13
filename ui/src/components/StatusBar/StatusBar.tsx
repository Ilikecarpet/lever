import { useConfigStore } from "../../stores/configStore";
import { useServiceStore } from "../../stores/serviceStore";
import { useGitStore } from "../../stores/gitStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import * as api from "../../lib/tauri";
import styles from "./StatusBar.module.css";

export default function StatusBar() {
  const groups = useConfigStore((s) => s.groups);
  const statuses = useServiceStore((s) => s.statuses);
  const statusMessage = useGitStore((s) => s.statusMessage);
  const splitPane = useWorkspaceStore((s) => s.splitPane);
  const closePane = useWorkspaceStore((s) => s.closePane);

  const allServices = groups.flatMap((g) => g.services);
  const total = allServices.length;
  const running = allServices.filter(
    (svc) => statuses[svc.id] === "running"
  ).length;

  const handleHome = async () => {
    await api.showStartPage();
  };

  const handleExport = async () => {
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

  return (
    <div className={styles.statusbar}>
      <div className={styles.projectControls}>
        <button
          className={styles.paneBtn}
          onClick={handleHome}
          title="Back to projects"
        >
          Home
        </button>
        <button
          className={styles.paneBtn}
          onClick={handleExport}
          title="Export config as JSON"
        >
          Export
        </button>
      </div>
      <span>
        {running}/{total} running
      </span>
      <span className={styles.info}>{statusMessage ?? ""}</span>
      <div className={styles.paneControls}>
        <button
          className={styles.paneBtn}
          onClick={() => splitPane("vertical")}
          title="Split vertical (⌘D)"
        >
          ⎸⎸
        </button>
        <button
          className={styles.paneBtn}
          onClick={() => splitPane("horizontal")}
          title="Split horizontal (⌘⇧D)"
        >
          ⎯⎯
        </button>
        <button
          className={styles.paneBtn}
          onClick={closePane}
          title="Close pane (⌘W)"
        >
          ×
        </button>
      </div>
    </div>
  );
}

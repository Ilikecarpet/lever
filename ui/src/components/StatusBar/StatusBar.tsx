import { useConfigStore } from "../../stores/configStore";
import { useServiceStore } from "../../stores/serviceStore";
import { useGitStore } from "../../stores/gitStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { IconSplitV, IconSplitH, IconClose } from "../Icons";
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

  return (
    <div className={styles.statusbar}>
      <span className={styles.serviceCount}>
        <span className={`${styles.countDot}${running > 0 ? ` ${styles.countDotActive}` : ""}`} />
        {running}/{total} running
      </span>
      <span className={styles.info}>{statusMessage ?? ""}</span>
      <div className={styles.paneControls}>
        <button
          className={styles.paneBtn}
          onClick={() => splitPane("vertical")}
          title="Split vertical (⌘D)"
        >
          <IconSplitV size={13} />
        </button>
        <button
          className={styles.paneBtn}
          onClick={() => splitPane("horizontal")}
          title="Split horizontal (⌘⇧D)"
        >
          <IconSplitH size={13} />
        </button>
        <button
          className={styles.paneBtn}
          onClick={closePane}
          title="Close pane (⌘W)"
        >
          <IconClose size={11} />
        </button>
      </div>
    </div>
  );
}

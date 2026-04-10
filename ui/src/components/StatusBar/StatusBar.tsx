import { useConfigStore } from "../../stores/configStore";
import { useServiceStore } from "../../stores/serviceStore";
import { useGitStore } from "../../stores/gitStore";
import styles from "./StatusBar.module.css";

export default function StatusBar() {
  const groups = useConfigStore((s) => s.groups);
  const statuses = useServiceStore((s) => s.statuses);
  const statusMessage = useGitStore((s) => s.statusMessage);

  const allServices = groups.flatMap((g) => g.services);
  const total = allServices.length;
  const running = allServices.filter(
    (svc) => statuses[svc.id] === "running"
  ).length;

  return (
    <div className={styles.statusbar}>
      <span>
        {running}/{total} running
      </span>
      <span className={styles.info}>{statusMessage ?? ""}</span>
    </div>
  );
}

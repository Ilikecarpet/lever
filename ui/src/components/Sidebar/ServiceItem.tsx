import type { ServiceDef } from "../../types";
import { useServiceStore } from "../../stores/serviceStore";
import styles from "./ServiceItem.module.css";

interface Props {
  service: ServiceDef;
}

export default function ServiceItem({ service }: Props) {
  const status = useServiceStore((s) => s.statuses[service.id] ?? "stopped");
  const startService = useServiceStore((s) => s.startService);
  const stopService = useServiceStore((s) => s.stopService);
  const setActiveLog = useServiceStore((s) => s.setActiveLog);

  const isRunning = status === "running";

  return (
    <div className={styles.svcItem} onClick={() => setActiveLog(service.id)}>
      <div
        className={`${styles.svcDot}${isRunning ? ` ${styles.svcDotRunning}` : ""}`}
      />
      <span className={styles.svcName}>{service.label}</span>
      {service.service_type === "task" && (
        <span className={styles.svcBadge}>Task</span>
      )}
      <div className={styles.svcHoverActions}>
        <button
          className={`${styles.svcBtn} ${styles.svcBtnPlay}`}
          onClick={(e) => {
            e.stopPropagation();
            startService(service.id);
          }}
          disabled={isRunning}
          title="Start"
        >
          &#9654;
        </button>
        <button
          className={`${styles.svcBtn} ${styles.svcBtnKill}`}
          onClick={(e) => {
            e.stopPropagation();
            stopService(service.id);
          }}
          disabled={!isRunning}
          title="Stop"
        >
          &#9724;
        </button>
      </div>
    </div>
  );
}

import type { ServiceDef } from "../../types";
import { useServiceStore } from "../../stores/serviceStore";
import { IconPlay, IconStop } from "../Icons";
import styles from "./ServiceItem.module.css";

interface Props {
  service: ServiceDef;
}

export default function ServiceItem({ service }: Props) {
  const status = useServiceStore((s) => s.statuses[service.id] ?? "stopped");
  const startService = useServiceStore((s) => s.startService);
  const stopService = useServiceStore((s) => s.stopService);
  const activeLogSvcId = useServiceStore((s) => s.activeLogSvcId);
  const setActiveLog = useServiceStore((s) => s.setActiveLog);

  const isRunning = status === "running";
  const isLogOpen = activeLogSvcId === service.id;

  const handleClick = () => {
    setActiveLog(isLogOpen ? null : service.id);
  };

  return (
    <div className={`${styles.svcItem}${isLogOpen ? ` ${styles.svcItemActive}` : ""}`} onClick={handleClick} title="Toggle logs">
      <div
        className={`${styles.svcDot}${isRunning ? ` ${styles.svcDotRunning}` : ""}`}
      />
      <span className={styles.svcName}>{service.label}</span>
      {service.service_type === "task" && (
        <span className={styles.svcBadge}>Task</span>
      )}
      <div className={styles.svcActions}>
        <button
          className={`${styles.svcBtn} ${styles.svcBtnPlay}`}
          onClick={(e) => {
            e.stopPropagation();
            startService(service.id);
          }}
          disabled={isRunning}
          title="Start"
        >
          <IconPlay size={12} />
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
          <IconStop size={12} />
        </button>
      </div>
    </div>
  );
}

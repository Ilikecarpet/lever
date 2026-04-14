import { useRef, useEffect } from "react";
import { useServiceStore } from "../../stores/serviceStore";
import { useConfigStore } from "../../stores/configStore";
import { IconClose } from "../Icons";
import styles from "./LogOverlay.module.css";

export default function LogPanel() {
  const activeLogSvcId = useServiceStore((s) => s.activeLogSvcId);
  const logs = useServiceStore((s) => s.logs);
  const statuses = useServiceStore((s) => s.statuses);
  const clearLog = useServiceStore((s) => s.clearLog);
  const setActiveLog = useServiceStore((s) => s.setActiveLog);
  const groups = useConfigStore((s) => s.groups);

  const outputRef = useRef<HTMLDivElement>(null);

  // Find the service label
  let serviceLabel = activeLogSvcId ?? "";
  if (activeLogSvcId) {
    for (const g of groups) {
      const svc = g.services.find((s) => s.id === activeLogSvcId);
      if (svc) {
        serviceLabel = svc.label;
        break;
      }
    }
  }

  const lines = activeLogSvcId ? logs[activeLogSvcId] ?? [] : [];
  const isRunning = activeLogSvcId ? statuses[activeLogSvcId] === "running" : false;

  // Auto-scroll to bottom on new logs
  useEffect(() => {
    const el = outputRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines.length]);

  if (!activeLogSvcId) return null;

  return (
    <div className={styles.logPanel}>
      <div className={styles.logHeader}>
        <span className={styles.logLabel}>
          {isRunning && <span className={styles.logDot} />}
          {serviceLabel}
        </span>
        <div className={styles.logHeaderActions}>
          <button
            className={styles.clearBtn}
            onClick={() => clearLog(activeLogSvcId)}
          >
            Clear
          </button>
          <button
            className={styles.logClose}
            onClick={() => setActiveLog(null)}
            title="Close logs"
          >
            <IconClose size={12} />
          </button>
        </div>
      </div>
      <div className={styles.logOutput} ref={outputRef}>
        {lines.map((line, i) => (
          <span
            key={i}
            className={line.startsWith("[stderr]") ? styles.stderr : undefined}
          >
            {line}
            {"\n"}
          </span>
        ))}
      </div>
    </div>
  );
}

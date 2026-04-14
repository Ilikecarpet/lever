import { useState } from "react";
import type { ServiceGroup } from "../../types";
import { useServiceStore } from "../../stores/serviceStore";
import { IconPlay, IconStop, IconChevron } from "../Icons";
import ServiceItem from "./ServiceItem";
import styles from "./GroupItem.module.css";

interface Props {
  group: ServiceGroup;
}

export default function GroupItem({ group }: Props) {
  const [collapsed, setCollapsed] = useState(false);

  const statuses = useServiceStore((s) => s.statuses);
  const startService = useServiceStore((s) => s.startService);
  const stopService = useServiceStore((s) => s.stopService);

  const runningCount = group.services.filter(
    (svc) => (statuses[svc.id] ?? "stopped") === "running"
  ).length;

  const handleStartAll = async (e: React.MouseEvent) => {
    e.stopPropagation();
    for (const svc of group.services) {
      if (svc.service_type === "task") continue;
      if ((statuses[svc.id] ?? "stopped") === "running") continue;
      await startService(svc.id);
    }
  };

  const handleStopAll = async (e: React.MouseEvent) => {
    e.stopPropagation();
    for (const svc of [...group.services].reverse()) {
      if ((statuses[svc.id] ?? "stopped") === "running") {
        await stopService(svc.id);
      }
    }
  };

  return (
    <div className={styles.group}>
      <div
        className={styles.groupHeader}
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className={styles.groupLabel}>
          <span
            className={`${styles.groupChevron}${collapsed ? ` ${styles.groupChevronCollapsed}` : ""}`}
          >
            <IconChevron size={10} />
          </span>
          {group.label}
          <span className={styles.groupCount}>
            {runningCount}/{group.services.length}
          </span>
        </span>
        <div className={styles.groupActions}>
          <button
            className={`${styles.groupBtn} ${styles.groupBtnStart}`}
            onClick={handleStartAll}
            title="Start all"
          >
            <IconPlay size={12} />
          </button>
          <button
            className={`${styles.groupBtn} ${styles.groupBtnStop}`}
            onClick={handleStopAll}
            title="Stop all"
          >
            <IconStop size={12} />
          </button>
        </div>
      </div>

      <div
        className={`${styles.groupServices}${collapsed ? ` ${styles.groupServicesCollapsed}` : ""}`}
      >
        {group.services.map((svc) => (
          <ServiceItem key={svc.id} service={svc} />
        ))}
      </div>
    </div>
  );
}

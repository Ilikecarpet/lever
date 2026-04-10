import { useState } from "react";
import type { ServiceGroup } from "../../types";
import { useServiceStore } from "../../stores/serviceStore";
import { useGitStore } from "../../stores/gitStore";
import { useTerminalStore } from "../../stores/terminalStore";
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
  const setActiveLog = useServiceStore((s) => s.setActiveLog);

  const gitInfo = useGitStore((s) => s.gitInfo[group.id]);
  const setActiveGitGroup = useGitStore((s) => s.setActiveGitGroup);
  const loadPrs = useGitStore((s) => s.loadPrs);
  const refreshGitInfo = useGitStore((s) => s.refreshGitInfo);

  const setActiveTab = useTerminalStore((s) => s.setActiveTab);

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

  const handleOpenGitPanel = (e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveLog(null);
    setActiveTab(null);
    setActiveGitGroup(group.id);
    refreshGitInfo(group.id, group.repo_path);
    loadPrs(group.id, group.repo_path);
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
            &#9660;
          </span>
          {group.label}{" "}
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
            &#9654;
          </button>
          <button
            className={`${styles.groupBtn} ${styles.groupBtnStop}`}
            onClick={handleStopAll}
            title="Stop all"
          >
            &#9724;
          </button>
        </div>
      </div>

      {group.repo_path && (
        <div className={styles.gitBranch} onClick={handleOpenGitPanel}>
          <span className={styles.gitBranchIcon}>&#9579;</span>
          <span className={styles.gitBranchName}>
            {gitInfo?.current_branch ?? "..."}
          </span>
          {gitInfo?.is_dirty && (
            <span className={styles.gitDirty}>&#9679;</span>
          )}
        </div>
      )}

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

import { useState } from "react";
import { useGitStore } from "../../stores/gitStore";
import { useConfigStore } from "../../stores/configStore";
import type { GitFileStatus } from "../../types";
import styles from "./GitPanel.module.css";

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ChangesSection({ files }: { files: GitFileStatus[] }) {
  const [shown, setShown] = useState(10);

  if (files.length === 0) return null;

  const visible = files.slice(0, shown);
  const remaining = files.length - shown;

  return (
    <div className={styles.gitSection}>
      <div className={styles.gitSectionHeader}>
        Changes{" "}
        <span className={styles.gitSectionCount}>{files.length}</span>
      </div>
      <div className={styles.gitSectionBody}>
        {visible.map((f, i) => {
          const badge =
            f.status === "new"
              ? "A"
              : f.status === "deleted"
                ? "D"
                : f.status === "renamed"
                  ? "R"
                  : "M";
          const badgeCls = f.staged
            ? styles.badgeStaged
            : f.status === "new"
              ? styles.badgeNew
              : f.status === "deleted"
                ? styles.badgeDeleted
                : styles.badgeModified;

          return (
            <div key={i} className={styles.gitFileItem}>
              <span className={`${styles.gitFileBadge} ${badgeCls}`}>
                {badge}
              </span>
              <span className={styles.filePath}>{f.path}</span>
              {f.staged && (
                <span className={styles.stagedLabel}>staged</span>
              )}
            </div>
          );
        })}
        {remaining > 0 && (
          <button
            className={styles.gitShowMore}
            onClick={() => setShown((s) => s + 10)}
          >
            Show more ({remaining} remaining)
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main GitPanel
// ---------------------------------------------------------------------------

export default function GitPanel() {
  const activeGitGroupId = useGitStore((s) => s.activeGitGroupId);
  const gitInfo = useGitStore((s) => s.gitInfo);
  const fetchGit = useGitStore((s) => s.fetch);
  const pull = useGitStore((s) => s.pull);
  const groups = useConfigStore((s) => s.groups);

  if (!activeGitGroupId) return null;

  const group = groups.find((g) => g.id === activeGitGroupId);
  const repoPath = group?.repo_path ?? "";
  const info = gitInfo[activeGitGroupId];

  if (!info) {
    return (
      <div className={styles.gitPanel}>
        <div className={styles.gitLoading}>Loading git info...</div>
      </div>
    );
  }

  return (
    <div className={styles.gitPanel}>
      <div className={styles.gitPanelHeader}>
        <h3>
          <span>&#9579;</span>
          <span className={styles.branchMono}>{info.current_branch}</span>
          {info.is_dirty ? (
            <span className={styles.dirtyIndicator}>
              &#9679; modified
            </span>
          ) : (
            <span className={styles.cleanIndicator}>clean</span>
          )}
        </h3>
        <div className={styles.gitActions}>
          <button
            className={styles.actionBtn}
            onClick={() => fetchGit(activeGitGroupId, repoPath)}
          >
            Fetch
          </button>
          <button
            className={styles.actionBtn}
            onClick={() => pull(activeGitGroupId, repoPath)}
          >
            Pull
          </button>
        </div>
      </div>
      <div className={styles.gitPanelBody}>
        <ChangesSection files={info.changed_files} />
      </div>
    </div>
  );
}

import { useState, useMemo } from "react";
import { useGitStore } from "../../stores/gitStore";
import { useConfigStore } from "../../stores/configStore";
import type {
  GitFileStatus,
  GitBranchInfo,
  GitPrInfo,
} from "../../types";
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

function BranchSection({
  title,
  branches,
  groupId,
  repoPath,
  batchSize = 15,
}: {
  title: string;
  branches: GitBranchInfo[];
  groupId: string;
  repoPath: string;
  batchSize?: number;
}) {
  const [filter, setFilter] = useState("");
  const [shown, setShown] = useState(batchSize);
  const checkout = useGitStore((s) => s.checkout);

  const filtered = useMemo(
    () =>
      branches.filter(
        (b) =>
          !filter || b.name.toLowerCase().includes(filter.toLowerCase())
      ),
    [branches, filter]
  );

  const visible = filtered.slice(0, shown);
  const remaining = filtered.length - shown;

  return (
    <div className={styles.gitSection}>
      <div className={styles.gitSectionHeader}>
        {title}{" "}
        <span className={styles.gitSectionCount}>{branches.length}</span>
      </div>
      <div className={styles.gitSectionBody}>
        <input
          className={styles.gitBranchSearch}
          placeholder={`Filter ${title.toLowerCase()}...`}
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setShown(batchSize);
          }}
        />
        {filtered.length === 0 && (
          <div className={styles.gitEmpty}>No matching branches</div>
        )}
        {visible.map((b) => (
          <div
            key={b.name}
            className={`${styles.gitBranchItem}${b.is_current ? ` ${styles.gitBranchItemCurrent}` : ""}`}
            onClick={
              b.is_current
                ? undefined
                : () => checkout(groupId, repoPath, b.name, b.is_remote)
            }
          >
            <span className={styles.check}>
              {b.is_current ? "\u2713" : ""}
            </span>
            <span className={styles.branchName}>{b.name}</span>
            {b.is_remote && (
              <span className={styles.remoteTag}>remote</span>
            )}
          </div>
        ))}
        {remaining > 0 && (
          <button
            className={styles.gitShowMore}
            onClick={() => setShown((s) => s + batchSize)}
          >
            Show more ({remaining} remaining)
          </button>
        )}
      </div>
    </div>
  );
}

function PrSection({
  prs,
  groupId,
  repoPath,
  branches,
}: {
  prs: GitPrInfo[] | undefined;
  groupId: string;
  repoPath: string;
  branches: GitBranchInfo[];
}) {
  const checkout = useGitStore((s) => s.checkout);
  const [shown, setShown] = useState(10);

  const handlePrClick = (pr: GitPrInfo) => {
    const localMatch = branches.find(
      (b) => !b.is_remote && b.name === pr.branch
    );
    const remoteMatch = branches.find(
      (b) => b.is_remote && b.name.endsWith("/" + pr.branch)
    );
    if (localMatch) {
      checkout(groupId, repoPath, pr.branch, false);
    } else if (remoteMatch) {
      checkout(groupId, repoPath, remoteMatch.name, true);
    }
  };

  const visible = prs ? prs.slice(0, shown) : [];
  const remaining = prs ? prs.length - shown : 0;

  return (
    <div className={styles.gitSection}>
      <div className={styles.gitSectionHeader}>
        Pull Requests{" "}
        <span className={styles.gitSectionCount}>
          {prs ? prs.length : "..."}
        </span>
      </div>
      <div className={styles.gitSectionBody}>
        {!prs && <div className={styles.gitLoading}>Loading...</div>}
        {prs && prs.length === 0 && (
          <div className={styles.gitEmpty}>No open pull requests</div>
        )}
        {visible.map((pr) => (
          <div
            key={pr.number}
            className={styles.gitPrItem}
            onClick={() => handlePrClick(pr)}
          >
            <div className={styles.gitPrRow}>
              <span className={styles.gitPrNumber}>#{pr.number}</span>
              <span className={styles.gitPrTitle}>{pr.title}</span>
              {pr.is_draft && (
                <span className={styles.gitPrDraft}>Draft</span>
              )}
            </div>
            <div className={styles.gitPrMeta}>
              <span>{pr.author}</span>
              <span className={styles.gitPrBranch}>{pr.branch}</span>
            </div>
          </div>
        ))}
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
  const prCache = useGitStore((s) => s.prCache);
  const fetchGit = useGitStore((s) => s.fetch);
  const pull = useGitStore((s) => s.pull);
  const groups = useConfigStore((s) => s.groups);

  if (!activeGitGroupId) return null;

  const group = groups.find((g) => g.id === activeGitGroupId);
  const repoPath = group?.repo_path ?? "";
  const info = gitInfo[activeGitGroupId];
  const prs = prCache[activeGitGroupId];

  if (!info) {
    return (
      <div className={styles.gitPanel}>
        <div className={styles.gitLoading}>Loading git info...</div>
      </div>
    );
  }

  const localBranches = info.branches.filter((b) => !b.is_remote);
  const remoteBranches = info.branches.filter((b) => b.is_remote);

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

        <BranchSection
          title="Local branches"
          branches={localBranches}
          groupId={activeGitGroupId}
          repoPath={repoPath}
        />

        <BranchSection
          title="Remote branches"
          branches={remoteBranches}
          groupId={activeGitGroupId}
          repoPath={repoPath}
        />

        <PrSection
          prs={prs}
          groupId={activeGitGroupId}
          repoPath={repoPath}
          branches={info.branches}
        />

        {/* Recent commits - inline */}
        <div className={styles.gitSection}>
          <div className={styles.gitSectionHeader}>
            Recent commits{" "}
            <span className={styles.gitSectionCount}>
              {info.recent_commits.length}
            </span>
          </div>
          <div className={styles.gitSectionBody}>
            {info.recent_commits.map((c) => (
              <div key={c.hash} className={styles.gitCommitItem}>
                <span className={styles.gitCommitHash}>
                  {c.short_hash}
                </span>
                <span className={styles.gitCommitMsg}>{c.summary}</span>
                <span className={styles.gitCommitTime}>{c.time_ago}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

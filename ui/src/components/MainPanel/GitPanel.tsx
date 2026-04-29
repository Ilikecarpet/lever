import { useEffect, useRef, useState } from "react";
import { useGitStore } from "../../stores/gitStore";
import * as api from "../../lib/tauri";
import type { GitFileStatus } from "../../types";
import { IconBranch, IconFolder } from "../Icons";
import styles from "./GitPanel.module.css";

type SectionMode = "staged" | "unstaged";

type DiffNode =
  | { kind: "fileHeader"; path: string; tag: string | null }
  | { kind: "hunk"; label: string }
  | { kind: "info"; text: string }
  | { kind: "add"; text: string }
  | { kind: "del"; text: string }
  | { kind: "ctx"; text: string };

function parseDiff(text: string, multipleFiles: boolean): DiffNode[] {
  const lines = text.split("\n");
  const nodes: DiffNode[] = [];
  let pendingTag: string | null = null;
  let firstFileHeader = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const path = m ? m[2] : line.slice("diff --git ".length);
      if (multipleFiles) {
        nodes.push({ kind: "fileHeader", path, tag: pendingTag });
      }
      pendingTag = null;
      firstFileHeader = false;
      continue;
    }

    if (line.startsWith("new file")) {
      pendingTag = "new";
      continue;
    }
    if (line.startsWith("deleted file")) {
      pendingTag = "deleted";
      continue;
    }
    if (line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      continue;
    }
    if (line.startsWith("@@")) {
      const m = line.match(/^@@\s+(.+?)\s+@@(.*)$/);
      nodes.push({ kind: "hunk", label: m ? m[1] : line });
      continue;
    }
    if (line.startsWith("Binary file") || line.startsWith("(empty directory") || line.startsWith("(no changes)") || line.startsWith("(failed to read file")) {
      nodes.push({ kind: "info", text: line });
      continue;
    }
    if (line.startsWith("+")) {
      nodes.push({ kind: "add", text: line.slice(1) });
      continue;
    }
    if (line.startsWith("-")) {
      nodes.push({ kind: "del", text: line.slice(1) });
      continue;
    }
    if (line.startsWith(" ")) {
      nodes.push({ kind: "ctx", text: line.slice(1) });
      continue;
    }
    if (line.length === 0 && i === lines.length - 1) continue;
  }

  if (pendingTag && !multipleFiles && firstFileHeader === false) {
    nodes.unshift({ kind: "info", text: pendingTag === "new" ? "(new file)" : "(deleted)" });
  }
  return nodes;
}

function DiffView({ text }: { text: string }) {
  const fileCount = (text.match(/^diff --git /gm) || []).length;
  const nodes = parseDiff(text, fileCount > 1);

  return (
    <div className={styles.diffView}>
      {nodes.map((node, i) => {
        switch (node.kind) {
          case "fileHeader":
            return (
              <div key={i} className={styles.diffFileHeader}>
                <span className={styles.diffFilePath}>{node.path}</span>
                {node.tag && (
                  <span className={styles.diffFileTag}>{node.tag}</span>
                )}
              </div>
            );
          case "hunk":
            return (
              <div key={i} className={styles.diffHunk}>
                {node.label}
              </div>
            );
          case "info":
            return (
              <div key={i} className={styles.diffInfo}>
                {node.text}
              </div>
            );
          case "add":
            return (
              <div key={i} className={styles.diffAdd}>
                <span className={styles.diffSign}>+</span>
                <span className={styles.diffLineText}>{node.text || " "}</span>
              </div>
            );
          case "del":
            return (
              <div key={i} className={styles.diffDel}>
                <span className={styles.diffSign}>-</span>
                <span className={styles.diffLineText}>{node.text || " "}</span>
              </div>
            );
          case "ctx":
            return (
              <div key={i} className={styles.diffContext}>
                <span className={styles.diffSign}> </span>
                <span className={styles.diffLineText}>{node.text || " "}</span>
              </div>
            );
        }
      })}
    </div>
  );
}

function FileItem({
  file,
  repoPath,
  mode,
  selected,
  onSelect,
}: {
  file: GitFileStatus;
  repoPath: string;
  mode: SectionMode;
  selected: boolean;
  onSelect: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [discardMenu, setDiscardMenu] = useState<{ x: number; y: number } | null>(null);
  const discardBtnRef = useRef<HTMLButtonElement | null>(null);
  const stage = useGitStore((s) => s.stage);
  const unstage = useGitStore((s) => s.unstage);
  const discard = useGitStore((s) => s.discard);

  useEffect(() => {
    if (!discardMenu) return;
    const handler = (e: MouseEvent) => {
      const menu = document.querySelector(`[data-discard-menu="${file.path}"]`);
      if (menu && menu.contains(e.target as Node)) return;
      if (discardBtnRef.current && discardBtnRef.current.contains(e.target as Node)) return;
      setDiscardMenu(null);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [discardMenu, file.path]);

  const badge =
    file.status === "new"
      ? "A"
      : file.status === "deleted"
        ? "D"
        : file.status === "renamed"
          ? "R"
          : "M";
  const badgeCls =
    file.status === "new"
      ? styles.badgeNew
      : file.status === "deleted"
        ? styles.badgeDeleted
        : styles.badgeModified;

  const handleRowClick = (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      window.getSelection()?.removeAllRanges();
      onSelect(file.path);
      return;
    }
    void toggleDiff();
  };

  const toggleDiff = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (diff !== null || loading) return;
    setLoading(true);
    setError(null);
    try {
      const d = await api.gitDiff(repoPath, file.path, file.staged);
      setDiff(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleStageToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (acting) return;
    setActing(true);
    try {
      if (file.staged) await unstage(file.path);
      else await stage(file.path);
    } finally {
      setActing(false);
    }
  };

  const handleDiscardClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (acting) return;
    if (discardMenu) {
      setDiscardMenu(null);
      return;
    }
    setDiscardMenu({ x: e.clientX, y: e.clientY });
  };

  const handleConfirmDiscard = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (acting) return;
    setActing(true);
    try {
      await discard(file.path);
      setDiscardMenu(null);
    } finally {
      setActing(false);
    }
  };

  const handleCancelDiscard = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDiscardMenu(null);
  };

  const discardLabel = (() => {
    const label = file.is_dir ? "directory" : "file";
    return file.status === "new"
      ? `Delete this untracked ${label}?`
      : `Discard changes to this ${label}?`;
  })();

  return (
    <>
      <div
        className={`${styles.gitFileItem} ${styles.gitFileItemClickable} ${expanded ? styles.gitFileItemExpanded : ""} ${selected ? styles.gitFileItemSelected : ""}`}
        onClick={handleRowClick}
        role="button"
      >
        <button
          className={`${styles.gitFileAction} ${file.staged ? styles.gitFileActionUnstage : styles.gitFileActionStage}`}
          onClick={handleStageToggle}
          disabled={acting}
          title={file.staged ? "Unstage" : "Stage"}
          aria-label={file.staged ? "Unstage file" : "Stage file"}
        >
          {file.staged ? "−" : "+"}
        </button>
        {mode === "unstaged" && (
          <button
            ref={discardBtnRef}
            className={`${styles.gitFileAction} ${styles.gitFileActionDiscard} ${discardMenu ? styles.gitFileActionDiscardActive : ""}`}
            onClick={handleDiscardClick}
            disabled={acting}
            title={discardMenu ? "Cancel" : "Discard changes"}
            aria-label="Discard changes"
          >
            ↺
          </button>
        )}
        <span className={styles.gitFileChevron}>{expanded ? "▾" : "▸"}</span>
        <span className={`${styles.gitFileBadge} ${badgeCls}`}>{badge}</span>
        {file.is_dir && (
          <span className={styles.gitFileFolderIcon} title="Directory">
            <IconFolder size={11} />
          </span>
        )}
        <span className={styles.filePath}>
          {file.path}
          {file.is_dir && !file.path.endsWith("/") ? "/" : ""}
        </span>
      </div>
      {discardMenu && (
        <div
          className={styles.discardMenu}
          style={{ left: discardMenu.x, top: discardMenu.y }}
          data-discard-menu={file.path}
          onClick={(e) => e.stopPropagation()}
        >
          <div className={styles.discardMenuWarning}>{discardLabel}</div>
          <div className={styles.discardMenuActions}>
            <button
              className={styles.discardMenuCancel}
              onClick={handleCancelDiscard}
              disabled={acting}
            >
              Cancel
            </button>
            <button
              className={styles.discardMenuYes}
              onClick={handleConfirmDiscard}
              disabled={acting}
            >
              {acting ? "Discarding…" : "Yes, discard"}
            </button>
          </div>
        </div>
      )}
      {expanded && (
        <div className={styles.diffContainer}>
          {loading && <div className={styles.diffStatus}>Loading diff…</div>}
          {error && <div className={styles.diffError}>{error}</div>}
          {!loading && !error && diff !== null && <DiffView text={diff} />}
        </div>
      )}
    </>
  );
}

function ChangesSection({
  title,
  files,
  repoPath,
  mode,
}: {
  title: string;
  files: GitFileStatus[];
  repoPath: string;
  mode: SectionMode;
}) {
  const [shown, setShown] = useState(10);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const stageMany = useGitStore((s) => s.stageMany);
  const unstageMany = useGitStore((s) => s.unstageMany);
  const stageAll = useGitStore((s) => s.stageAll);
  const unstageAll = useGitStore((s) => s.unstageAll);

  // Drop selected paths that no longer exist in the section.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const known = new Set(files.map((f) => f.path));
      const next = new Set<string>();
      for (const p of prev) if (known.has(p)) next.add(p);
      return next.size === prev.size ? prev : next;
    });
  }, [files]);

  const visible = files.slice(0, shown);
  const remaining = files.length - shown;

  const handleSelect = (path: string) => {
    const next = new Set(selected);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setSelected(next);
  };

  const clearSelection = () => setSelected(new Set());

  const handleHeaderAction = async () => {
    const paths = Array.from(selected);
    if (paths.length > 0) {
      if (mode === "unstaged") await stageMany(paths);
      else await unstageMany(paths);
      clearSelection();
      return;
    }
    if (files.length === 0) return;
    if (mode === "unstaged") await stageAll();
    else await unstageAll();
  };

  const selectionCount = selected.size;
  const headerActionLabel =
    selectionCount > 0
      ? mode === "unstaged"
        ? `+ Stage selected (${selectionCount})`
        : `− Unstage selected (${selectionCount})`
      : mode === "unstaged"
        ? "+ Stage all"
        : "− Unstage all";
  const headerActionCls =
    mode === "unstaged"
      ? styles.gitSectionActionStage
      : styles.gitSectionActionUnstage;

  return (
    <div className={styles.gitSection}>
      <div className={styles.gitSectionHeader}>
        <span className={styles.gitSectionTitle}>
          {title}{" "}
          <span className={styles.gitSectionCount}>{files.length}</span>
        </span>
        <span className={styles.gitSectionActions}>
          {selectionCount > 0 && (
            <button
              className={styles.gitSectionAction}
              onClick={clearSelection}
              title="Clear selection"
            >
              Clear
            </button>
          )}
          {files.length > 0 && (
            <button
              className={`${styles.gitSectionAction} ${headerActionCls}`}
              onClick={handleHeaderAction}
              title={headerActionLabel}
            >
              {headerActionLabel}
            </button>
          )}
        </span>
      </div>
      <div className={styles.gitSectionBody}>
        {files.length === 0 && (
          <div className={styles.gitSectionEmpty}>(none)</div>
        )}
        {visible.map((f, i) => (
          <FileItem
            key={`${f.path}-${f.staged}-${i}`}
            file={f}
            repoPath={repoPath}
            mode={mode}
            selected={selected.has(f.path)}
            onSelect={handleSelect}
          />
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

export default function GitPanel() {
  const activeGitGroupId = useGitStore((s) => s.activeGitGroupId);
  const gitInfo = useGitStore((s) => s.gitInfo);
  const repoPath = useGitStore((s) => s.repoPath);
  const fetchGit = useGitStore((s) => s.fetch);
  const pull = useGitStore((s) => s.pull);

  if (!activeGitGroupId) return null;

  if (!gitInfo) {
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
          <IconBranch size={14} />
          <span className={styles.branchMono}>{gitInfo.current_branch}</span>
          {gitInfo.is_dirty ? (
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
            onClick={() => fetchGit()}
          >
            Fetch
          </button>
          <button
            className={styles.actionBtn}
            onClick={() => pull()}
          >
            Pull
          </button>
        </div>
      </div>
      <div className={styles.gitPanelBody}>
        {gitInfo.changed_files.length > 0 && (
          <>
            <ChangesSection
              title="Staged"
              files={gitInfo.changed_files.filter((f) => f.staged)}
              repoPath={repoPath}
              mode="staged"
            />
            <ChangesSection
              title="Changes"
              files={gitInfo.changed_files.filter((f) => !f.staged)}
              repoPath={repoPath}
              mode="unstaged"
            />
          </>
        )}
      </div>
    </div>
  );
}

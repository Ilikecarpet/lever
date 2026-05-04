import { useState, useEffect, useRef } from "react";
import * as api from "../../lib/tauri";
import { useGitStore } from "../../stores/gitStore";
import styles from "./NewWorktreeModal.module.css";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreate: (branch: string, path: string) => Promise<void>;
}

function sanitizeBranchForPath(branch: string): string {
  return branch
    .replace(/\//g, "-")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export default function NewWorktreeModal({ open, onClose, onCreate }: Props) {
  const repoPath = useGitStore((s) => s.repoPath);
  const [branch, setBranch] = useState("");
  const [path, setPath] = useState("");
  const [pathEdited, setPathEdited] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [existing, setExisting] = useState<api.ExistingWorktree[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const mouseDownOnOverlay = useRef(false);

  useEffect(() => {
    if (!open) return;
    setBranch("");
    setPath("");
    setPathEdited(false);
    setError("");
    setCreating(false);

    const pid = api.getProjectId();
    if (pid) {
      api.listBranches(pid).then(setBranches).catch(() => setBranches([]));
      api.listExistingWorktrees(pid).then(setExisting).catch(() => setExisting([]));
    }

    setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  const trimmedBranch = branch.trim();
  const adoptable = trimmedBranch
    ? existing.find((w) => w.branch === trimmedBranch)
    : undefined;
  const namespaceConflict = trimmedBranch && !adoptable
    ? branches.find(
        (b) =>
          b !== trimmedBranch &&
          (b.startsWith(`${trimmedBranch}/`) || trimmedBranch.startsWith(`${b}/`))
      )
    : undefined;

  useEffect(() => {
    if (!pathEdited && branch && repoPath) {
      const sanitized = sanitizeBranchForPath(branch);
      setPath(`${repoPath}-worktrees/${sanitized}`);
    }
  }, [branch, repoPath, pathEdited]);

  if (!open) return null;

  const filteredBranches = branch
    ? branches.filter(
        (b) => b.toLowerCase().includes(branch.toLowerCase()) && b !== branch
      )
    : branches;

  const handleCreate = async () => {
    const finalBranch = branch.trim();
    const finalPath = adoptable ? adoptable.path : path.trim();
    if (!finalBranch || !finalPath) return;
    setCreating(true);
    setError("");
    try {
      await onCreate(finalBranch, finalPath);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCreating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleCreate();
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <div
      className={styles.overlay}
      onMouseDown={(e) => { mouseDownOnOverlay.current = e.target === e.currentTarget; }}
      onMouseUp={(e) => { if (mouseDownOnOverlay.current && e.target === e.currentTarget) onClose(); }}
    >
      <div
        className={styles.modal}
        onKeyDown={handleKeyDown}
      >
        <div className={styles.title}>New Worktree</div>

        <div className={styles.field}>
          <div className={styles.label}>Branch</div>
          <input
            ref={inputRef}
            className={styles.input}
            placeholder="feature/my-branch"
            value={branch}
            onChange={(e) => {
              setBranch(e.target.value);
              setShowSuggestions(true);
            }}
            onFocus={() => setShowSuggestions(true)}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
          />
          {showSuggestions && filteredBranches.length > 0 && (
            <div className={styles.suggestions}>
              {filteredBranches.slice(0, 10).map((b) => (
                <div
                  key={b}
                  className={styles.suggestion}
                  onMouseDown={() => {
                    setBranch(b);
                    setShowSuggestions(false);
                  }}
                >
                  {b}
                </div>
              ))}
            </div>
          )}
        </div>

        {adoptable && (
          <div className={styles.adoptBadge}>
            Worktree already exists at <span className={styles.adoptPath}>{adoptable.path}</span>
          </div>
        )}

        {namespaceConflict && (
          <div className={styles.warnBadge}>
            Can't create branch <span className={styles.warnName}>{trimmedBranch}</span> — it
            collides with existing branch <span className={styles.warnName}>{namespaceConflict}</span>.
            Pick a different name.
          </div>
        )}

        <div className={styles.field}>
          <div className={styles.label}>Path</div>
          <input
            className={styles.input}
            placeholder="/path/to/worktree"
            value={adoptable ? adoptable.path : path}
            onChange={(e) => {
              setPath(e.target.value);
              setPathEdited(true);
            }}
            disabled={!!adoptable}
          />
        </div>

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.actions}>
          <button
            className={`${styles.btn} ${styles.btnCancel}`}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className={`${styles.btn} ${styles.btnCreate}`}
            onClick={handleCreate}
            disabled={!branch.trim() || (!adoptable && !path.trim()) || !!namespaceConflict || creating}
          >
            {creating
              ? (adoptable ? "Opening..." : "Creating...")
              : (adoptable ? "Open Worktree" : "Create Worktree")}
          </button>
        </div>
      </div>
    </div>
  );
}

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
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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
    }

    setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

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
    if (!branch.trim() || !path.trim()) return;
    setCreating(true);
    setError("");
    try {
      await onCreate(branch.trim(), path.trim());
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
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
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

        <div className={styles.field}>
          <div className={styles.label}>Path</div>
          <input
            className={styles.input}
            placeholder="/path/to/worktree"
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              setPathEdited(true);
            }}
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
            disabled={!branch.trim() || !path.trim() || creating}
          >
            {creating ? "Creating..." : "Create Worktree"}
          </button>
        </div>
      </div>
    </div>
  );
}

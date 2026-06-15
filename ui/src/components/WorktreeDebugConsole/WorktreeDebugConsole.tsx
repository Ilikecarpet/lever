import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { onWorktreeDebug, type WorktreeDebugEvent } from "../../lib/tauri";
import styles from "./WorktreeDebugConsole.module.css";

interface LogLine {
  key: number;
  kind: WorktreeDebugEvent["kind"] | "divider";
  text: string;
}

/**
 * A floating mini-terminal that surfaces the git commands and output produced
 * while removing a worktree. Auto-opens when a removal starts so failures are
 * visible for debugging. Always mounted so it never misses an event.
 */
export default function WorktreeDebugConsole() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    const push = (kind: LogLine["kind"], text: string, isRunStart: boolean) => {
      setLines((prev) => {
        const next = [...prev];
        // A new removal attempt starts with the "Removing worktree" line.
        // Insert a divider so successive attempts stay visually grouped and
        // earlier (e.g. failed) runs aren't lost.
        if (isRunStart && prev.length > 0) {
          next.push({ key: seq.current++, kind: "divider", text: "──────── new attempt ────────" });
        }
        next.push({ key: seq.current++, kind, text });
        return next;
      });
      setOpen(true);
      setCollapsed(false);
    };

    // A removal attempt begins with the backend "Removing worktree" line, so
    // only that starts a new divider-separated group.
    const unlisten = onWorktreeDebug((ev: WorktreeDebugEvent) => {
      push(ev.kind, ev.text, ev.kind === "info" && ev.text.startsWith("Removing worktree"));
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Keep the newest line in view as output streams in.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, collapsed]);

  if (!open) return null;

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.title}>
          <span className={styles.dot} />
          Worktree removal
        </div>
        <button
          className={styles.btn}
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? "Show" : "Hide"}
        </button>
        <button className={styles.btn} onClick={() => setLines([])} title="Clear output">
          Clear
        </button>
        <button
          className={styles.btn}
          onClick={() => {
            setOpen(false);
            setLines([]);
          }}
          title="Close"
        >
          ✕
        </button>
      </div>
      {!collapsed && (
        <div className={styles.body} ref={bodyRef}>
          {lines.length === 0 ? (
            <span className={styles.empty}>Waiting for output…</span>
          ) : (
            lines.map((l) => (
              <span key={l.key} className={`${styles.line} ${styles[l.kind]}`}>
                {l.text}
              </span>
            ))
          )}
        </div>
      )}
    </div>
  );
}

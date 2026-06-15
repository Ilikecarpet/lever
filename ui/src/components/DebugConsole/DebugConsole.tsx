import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { onDebugLog, type DebugLogEvent } from "../../lib/tauri";
import { useSettingsStore } from "../../stores/settingsStore";
import styles from "./DebugConsole.module.css";

interface LogLine {
  key: number;
  kind: DebugLogEvent["kind"] | "divider";
  category: string;
  text: string;
}

/**
 * A floating mini-terminal that surfaces backend actions (git commands,
 * service/worktree/PTY operations) and their output, live. Gated behind the
 * "Debug console" setting (off by default); only listens while enabled.
 */
export default function DebugConsole() {
  const enabled = useSettingsStore((s) => s.debugConsole);
  const setDebugConsole = useSettingsStore((s) => s.setDebugConsole);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const unlisten = onDebugLog((ev: DebugLogEvent) => {
      setLines((prev) => {
        const next = [...prev];
        // Each "action" line begins a new operation — separate them visually.
        if (ev.kind === "action" && prev.length > 0) {
          next.push({ key: seq.current++, kind: "divider", category: "", text: "" });
        }
        next.push({ key: seq.current++, kind: ev.kind, category: ev.category, text: ev.text });
        // Cap retained history so a long session can't grow unbounded.
        return next.length > 2000 ? next.slice(next.length - 2000) : next;
      });
      setCollapsed(false);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [enabled]);

  // Keep the newest line in view as output streams in.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, collapsed]);

  if (!enabled) return null;

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.title}>
          <span className={styles.dot} />
          Debug console
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
          onClick={() => setDebugConsole(false)}
          title="Disable the debug console (re-enable from the Lever menu)"
        >
          ✕
        </button>
      </div>
      {!collapsed && (
        <div className={styles.body} ref={bodyRef}>
          {lines.length === 0 ? (
            <span className={styles.empty}>Listening for backend actions…</span>
          ) : (
            lines.map((l) =>
              l.kind === "divider" ? (
                <span key={l.key} className={`${styles.line} ${styles.divider}`}>
                  ────────────────────
                </span>
              ) : (
                <span key={l.key} className={`${styles.line} ${styles[l.kind]}`}>
                  {l.kind === "action" && l.category && (
                    <span className={styles.tag}>{l.category}</span>
                  )}
                  {l.text}
                </span>
              )
            )
          )}
        </div>
      )}
    </div>
  );
}

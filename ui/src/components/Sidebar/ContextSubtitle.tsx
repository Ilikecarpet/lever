import type { AgentInfo } from "../../types";
import styles from "./ContextSubtitle.module.css";

/** The second line of a branch row. The path, until a conversation is running
 *  here — then the lines Claude Code says it has changed, followed by that
 *  conversation's title. The counts lead because they are fixed-width and
 *  always fully legible; the title is what gives up room when the row is
 *  narrow. A worktree can hold several conversations, so the caller passes the
 *  one in the focused pane. The path stays reachable in the tooltip. */
export default function ContextSubtitle({ path, agent }: { path: string; agent: AgentInfo | null }) {
  const shortPath = path.replace(/^\/Users\/[^/]+/, "~");
  const usage = agent?.usage;
  const conversation = usage?.reported?.title ?? usage?.sessionName ?? null;
  const lines = usage?.reported;
  const hasLines = !!lines && (lines.linesAdded != null || lines.linesRemoved != null);

  if (!conversation) {
    return (
      <span className={styles.subtitle} title={path}>
        <span className={styles.path}>{shortPath}</span>
      </span>
    );
  }
  return (
    <span className={styles.subtitle} title={`${conversation}\n${path}`}>
      {hasLines && (
        <span className={styles.lines} title="Lines changed by this conversation, as Claude Code counts them">
          <span className={styles.added}>+{lines.linesAdded ?? 0}</span>{" "}
          <span className={styles.removed}>−{lines.linesRemoved ?? 0}</span>
        </span>
      )}
      <span className={styles.conversation}>{conversation}</span>
    </span>
  );
}

import { createContext, memo, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { editedFiles, lineCounts, lineDiff, shortPath, shortenPaths, type ChatItem, type ToolContent, type ToolItem } from "../../lib/acpChat";

/** The chat's checkout, for showing paths relative to it. */
export const CwdContext = createContext("");
import {
  IconBrain,
  IconCheck,
  IconChevronRight,
  IconClose,
  IconCommand,
  IconEditLine,
  IconFile,
  IconGlobe,
  IconMove,
  IconSearch,
  IconSparkle,
  IconSpinner,
  IconTrash,
  IconPencil,
} from "../Icons";
import { CopyButton, Markdown } from "./Markdown";
import { LeverMark } from "./LeverMark";
import styles from "./Chat.module.css";

// ---------------------------------------------------------------------------
// Grouping: tool calls and thinking between two messages are one block of
// "activity", folded to a one-line summary once the turn has moved on — the
// conversation stays readable, the detail stays one click away.
// ---------------------------------------------------------------------------

type ActivityEntry = ToolItem | Extract<ChatItem, { kind: "thought" }> | Extract<ChatItem, { kind: "permission" }>;

type Block =
  | { type: "item"; item: ChatItem }
  | { type: "activity"; id: string; entries: ActivityEntry[] };

function toBlocks(items: ChatItem[]): Block[] {
  const blocks: Block[] = [];
  for (const item of items) {
    const isActivity =
      item.kind === "tool" || item.kind === "thought" || (item.kind === "permission" && !!item.outcome);
    if (item.kind === "permission" && !item.outcome) continue; // shown in the dock until answered
    if (isActivity) {
      const last = blocks[blocks.length - 1];
      if (last?.type === "activity") last.entries.push(item as ActivityEntry);
      else blocks.push({ type: "activity", id: item.id, entries: [item as ActivityEntry] });
    } else {
      blocks.push({ type: "item", item });
    }
  }
  return blocks;
}

const KIND_ICON: Record<string, (p: { size?: number }) => ReactNode> = {
  read: IconFile,
  edit: IconEditLine,
  delete: IconTrash,
  move: IconMove,
  search: IconSearch,
  execute: IconCommand,
  fetch: IconGlobe,
  think: IconBrain,
};

function KindIcon({ kind }: { kind?: string }) {
  const Icon = (kind && KIND_ICON[kind]) || IconSparkle;
  return <Icon size={12} />;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function summarize(entries: ActivityEntry[]): string {
  const count: Record<string, number> = {};
  let thoughts = 0;
  for (const e of entries) {
    if (e.kind === "thought") thoughts++;
    else if (e.kind === "tool") count[e.toolKind ?? "other"] = (count[e.toolKind ?? "other"] ?? 0) + 1;
  }
  const parts: string[] = [];
  if (count.read) parts.push(`Read ${plural(count.read, "file", "files")}`);
  if (count.search) parts.push(`searched ${plural(count.search, "time", "times")}`);
  if (count.edit) {
    const files = editedFiles(entries as ChatItem[]);
    parts.push(files ? `edited ${plural(files, "file", "files")}` : `made ${plural(count.edit, "edit", "edits")}`);
  }
  if (count.delete) parts.push(`deleted ${plural(count.delete, "file", "files")}`);
  if (count.move) parts.push(`moved ${plural(count.move, "file", "files")}`);
  if (count.execute) parts.push(`ran ${plural(count.execute, "command", "commands")}`);
  if (count.fetch) parts.push(`fetched ${plural(count.fetch, "page", "pages")}`);
  const other = (count.other ?? 0) + (count.think ?? 0);
  if (other) parts.push(`used ${plural(other, "tool", "tools")}`);
  if (parts.length === 0 && thoughts) return "Thought it through";
  const s = parts.join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatDuration(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Opens and closes by animating its height. Children mount on first open
 *  and stay, so closing animates rather than snapping shut. */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  return (
    <div className={styles.collapse} data-open={open}>
      <div className={styles.collapseInner}>{(mounted || open) && children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function Transcript({
  items,
  working,
  turnStartedAt,
  onEdit,
}: {
  items: ChatItem[];
  working: boolean;
  turnStartedAt: number | null;
  onEdit: (text: string) => void;
}) {
  const blocks = useMemo(() => toBlocks(items), [items]);
  const lastBlock = blocks[blocks.length - 1];
  const liveActivity = working && lastBlock?.type === "activity";

  return (
    <>
      {blocks.map((b, i) =>
        b.type === "activity" ? (
          <ActivityGroup key={b.id} entries={b.entries} live={working && i === blocks.length - 1} />
        ) : (
          <ItemView
            key={b.item.id}
            item={b.item}
            onEdit={onEdit}
            streaming={working && i === blocks.length - 1 && b.item.kind === "agent"}
          />
        )
      )}
      {working && <LiveStatus startedAt={turnStartedAt} quiet={liveActivity || lastBlock?.type === "item" && lastBlock.item.kind === "agent"} />}
    </>
  );
}

const ItemView = memo(function ItemView({
  item,
  onEdit,
  streaming,
}: {
  item: ChatItem;
  onEdit: (text: string) => void;
  streaming?: boolean;
}) {
  switch (item.kind) {
    case "user":
      return (
        <div className={styles.userRow}>
          <div className={styles.userBubble}>
            {item.images && item.images.length > 0 && (
              <div className={styles.userImages}>
                {item.images.map((img, i) => (
                  <img key={i} src={`data:${img.mimeType};base64,${img.data}`} alt={img.name ?? "attachment"} />
                ))}
              </div>
            )}
            {item.attached && item.attached.length > 0 && (
              <div className={styles.userFiles}>
                {item.attached.map((p) => (
                  <span key={p} className={styles.fileChip} title={p}>
                    <IconFile size={12} />
                    <span className={styles.fileChipName}>{p.split("/").pop()}</span>
                  </span>
                ))}
              </div>
            )}
            {item.text && <div className={styles.userText}>{renderMentions(item.text)}</div>}
          </div>
          {item.text && (
            <div className={styles.msgActions}>
              <CopyButton text={item.text} />
              <button className={styles.iconBtn} title="Edit as a new message" onClick={() => onEdit(item.text)}>
                <IconPencil size={12} />
              </button>
            </div>
          )}
        </div>
      );
    case "agent":
      return (
        <div className={`${styles.agentRow}${streaming ? ` ${styles.streaming}` : ""}`}>
          <div className={styles.prose}>
            <Markdown text={item.text} />
          </div>
          <div className={styles.msgActions}>
            <CopyButton text={item.text} />
          </div>
        </div>
      );
    case "turnEnd":
      return (
        <div className={styles.turnEnd}>
          <span className={styles.turnRule} />
          <span>
            {item.stopReason === "cancelled" ? "Stopped after " : item.stopReason === "error" ? "Failed after " : "Worked for "}
            {formatDuration(item.durationMs)}
            {item.stopReason === "max_tokens" && " · hit the output limit"}
            {item.stopReason === "max_turn_requests" && " · hit the turn limit"}
            {item.stopReason === "refusal" && " · declined"}
          </span>
          <span className={styles.turnRule} />
        </div>
      );
    case "notice":
      return <div className={item.tone === "error" ? styles.noticeError : styles.notice}>{item.text}</div>;
    default:
      return null;
  }
});

/** @path mentions in a sent message, set apart the way they were typed. */
function renderMentions(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/(^|\s)(@[\w./-]+)/g)) {
    const at = (m.index ?? 0) + m[1].length;
    if (at > last) out.push(text.slice(last, at));
    out.push(
      <span key={at} className={styles.mention}>
        {m[2]}
      </span>
    );
    last = at + m[2].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function LiveStatus({ startedAt, quiet }: { startedAt: number | null; quiet: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = startedAt ? formatDuration(now - startedAt) : "";
  return (
    <div className={`${styles.live}${quiet ? ` ${styles.liveQuiet}` : ""}`}>
      <LeverMark size={22} working />
      <span className={styles.shimmer}>{quiet ? "Working" : "Thinking"}</span>
      {elapsed && <span className={styles.liveTime}>{elapsed}</span>}
      <span className={styles.liveHint}>esc to stop</span>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ActivityGroup({ entries, live }: { entries: ActivityEntry[]; live: boolean }) {
  const cwd = useContext(CwdContext);
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? live;
  const running = entries.filter((e) => e.kind === "tool" && (e.status === "in_progress" || e.status === "pending"));
  const failed = entries.some((e) => e.kind === "tool" && e.status === "failed");
  const edits = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const e of entries) {
      if (e.kind !== "tool") continue;
      for (const c of e.content) {
        if (c.type !== "diff") continue;
        const n = lineCounts(c.oldText ?? "", c.newText ?? "");
        added += n.added;
        removed += n.removed;
      }
    }
    return added || removed ? { added, removed } : null;
  }, [entries]);

  const toolsOnly = entries.filter((e) => !(e.kind === "permission" && e.toolCallId && entries.some((t) => t.id === e.toolCallId)));
  if (toolsOnly.length === 1 && toolsOnly[0].kind === "tool") {
    const perm = entries.find((e) => e.kind === "permission");
    return (
      <div className={styles.activity}>
        <ToolRow item={toolsOnly[0]} decision={perm && perm.kind === "permission" ? decisionLabel(perm) : undefined} />
      </div>
    );
  }
  if (entries.length === 1 && entries[0].kind === "tool") {
    return (
      <div className={styles.activity}>
        <ToolRow item={entries[0]} />
      </div>
    );
  }

  // An answered permission belongs on the tool row it was about, not on a
  // line of its own repeating the same title.
  const decisions = new Map<string, string>();
  const tools = new Set(entries.filter((e) => e.kind === "tool").map((e) => e.id));
  for (const e of entries) {
    if (e.kind === "permission" && e.toolCallId && tools.has(e.toolCallId)) decisions.set(e.toolCallId, decisionLabel(e));
  }
  const decided = new Set(decisions.keys());
  const current = running[running.length - 1];
  return (
    <div className={styles.activity}>
      <button className={styles.activityHead} onClick={() => setOpen(!expanded)}>
        <span className={`${styles.chev}${expanded ? ` ${styles.chevOpen}` : ""}`}>
          <IconChevronRight size={9} />
        </span>
        <span className={styles.activitySummary}>
          {live && current && current.kind === "tool" ? shortenPaths(current.title, cwd) : summarize(entries)}
        </span>
        {edits && <DiffStat {...edits} />}
        {failed && <span className={styles.failTag}>failed</span>}
        {live && <LeverMark size={14} working />}
      </button>
      <Collapse open={expanded}>
        <div className={styles.activityBody}>
          {entries.filter((e) => !(e.kind === "permission" && decided.has(e.toolCallId ?? ""))).map((e) =>
            e.kind === "tool" ? (
              <ToolRow key={e.id} item={e} decision={decisions.get(e.id)} />
            ) : e.kind === "thought" ? (
              <ThoughtRow key={e.id} text={e.text} />
            ) : (
              <div key={e.id} className={styles.decision}>
                <span className={e.outcome?.startsWith("reject") || e.outcome === "cancelled" ? styles.decisionNo : styles.decisionYes}>
                  {e.outcome === "cancelled"
                    ? "Cancelled"
                    : e.options.find((o) => o.optionId === e.outcome)?.name ?? e.outcome}
                </span>
                <span className={styles.decisionTitle}>{shortenPaths(e.title, cwd)}</span>
              </div>
            )
          )}
        </div>
      </Collapse>
    </div>
  );
}

export function DiffStat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className={styles.diffStat}>
      {added > 0 && <span className={styles.statAdd}>+{added}</span>}
      {removed > 0 && <span className={styles.statDel}>−{removed}</span>}
    </span>
  );
}

function ThoughtRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.toolRow}>
      <button className={styles.toolHead} onClick={() => setOpen((o) => !o)}>
        <span className={styles.toolIcon}>
          <IconBrain size={12} />
        </span>
        <span className={styles.toolLabel}>Thinking</span>
        <span className={styles.toolPreview}>{text.replace(/\s+/g, " ").slice(0, 120)}</span>
      </button>
      <Collapse open={open}>
        <div className={`${styles.toolBody} ${styles.thoughtText}`}>{text}</div>
      </Collapse>
    </div>
  );
}

function decisionLabel(e: Extract<ChatItem, { kind: "permission" }>): string {
  if (e.outcome === "cancelled") return "Cancelled";
  const opt = e.options.find((o) => o.optionId === e.outcome);
  if (!opt) return e.outcome ?? "";
  return opt.kind.startsWith("allow") ? (opt.kind === "allow_always" ? "Always allowed" : "Approved") : "Declined";
}

function ToolRow({ item, decision }: { item: ToolItem; decision?: string }) {
  const cwd = useContext(CwdContext);
  const diffs = item.content.filter((c) => c.type === "diff");
  const [open, setOpen] = useState(false);
  const status = item.status ?? "pending";
  const running = status === "pending" || status === "in_progress";
  const command = typeof item.rawInput?.command === "string" ? (item.rawInput.command as string) : null;
  const text = item.content
    .filter((c) => c.type === "content" && c.content?.text)
    .map((c) => c.content!.text!)
    .join("\n\n");
  const output = item.toolKind === "execute" ? item.rawOutput ?? stripFence(text) : null;
  const hasBody = diffs.length > 0 || !!command || !!text || !!output;
  const stat = useMemo(() => {
    if (!diffs.length) return null;
    let added = 0;
    let removed = 0;
    for (const d of diffs) {
      const n = lineCounts(d.oldText ?? "", d.newText ?? "");
      added += n.added;
      removed += n.removed;
    }
    return { added, removed };
  }, [diffs]);

  return (
    <div className={styles.toolRow} data-status={status}>
      <button className={styles.toolHead} onClick={() => setOpen((o) => !o)} disabled={!hasBody}>
        <span className={styles.toolIcon}>
          <KindIcon kind={item.toolKind} />
        </span>
        <span className={`${styles.toolLabel}${item.toolKind === "execute" ? ` ${styles.mono}` : ""}`} title={item.title}>
          {shortenPaths(item.title, cwd)}
        </span>
        {stat && <DiffStat {...stat} />}
        {decision && (
          <span className={decision === "Declined" || decision === "Cancelled" ? styles.decisionNo : styles.decisionYes}>{decision}</span>
        )}
        <span key={status} className={`${styles.toolStatus}${running ? "" : ` ${styles.statusPop}`}`}>
          {running ? (
            <IconSpinner size={11} className={styles.spin} />
          ) : status === "failed" ? (
            <IconClose size={9} />
          ) : status === "completed" ? (
            <IconCheck size={11} />
          ) : null}
        </span>
      </button>
      {hasBody && (
        <Collapse open={open}>
        <div className={styles.toolBody}>
          {diffs.map((d, i) => (
            <DiffView key={i} c={d} />
          ))}
          {item.toolKind === "execute" ? (
            <div className={styles.termOut}>
              {command && <div className={styles.termCmd}>$ {command}</div>}
              {output && <pre>{output.length > 20000 ? `${output.slice(0, 20000)}\n…` : output}</pre>}
            </div>
          ) : (
            diffs.length === 0 && text && <Markdown text={text.length > 20000 ? `${text.slice(0, 20000)}\n…` : text} />
          )}
        </div>
        </Collapse>
      )}
    </div>
  );
}

function stripFence(t: string) {
  const m = t.match(/^```[\w-]*\n([\s\S]*?)\n?```$/);
  return m ? m[1] : t;
}

export function DiffView({ c, path }: { c: ToolContent; path?: string }) {
  return <Diff before={c.oldText ?? null} after={c.newText ?? ""} path={path ?? c.path ?? ""} />;
}

export function Diff({ before, after, path: fullPath }: { before: string | null; after: string; path: string }) {
  const cwd = useContext(CwdContext);
  const path = fullPath ? shortPath(fullPath, cwd) : "";
  const rows = useMemo(() => lineDiff(before ?? "", after), [before, after]);
  return (
    <div className={styles.diff}>
      {path && (
        <div className={styles.diffHead}>
          <span>{path.split("/").pop()}</span>
          <span className={styles.diffDir}>{path.split("/").slice(0, -1).join("/")}</span>
          {before === null && <span className={styles.newTag}>new</span>}
        </div>
      )}
      <div className={styles.diffBody}>
        {rows.map((r, i) =>
          r.op === "…" ? (
            <div key={i} className={styles.diffGap}>⋯</div>
          ) : (
            <div key={i} className={r.op === "+" ? styles.diffAdd : r.op === "-" ? styles.diffDel : styles.diffCtx}>
              <span className={styles.diffNum}>{r.op === "+" ? r.b : r.a}</span>
              <span className={styles.diffOp}>{r.op === " " ? "" : r.op === "-" ? "−" : "+"}</span>
              <span className={styles.diffText}>{r.text || " "}</span>
            </div>
          )
        )}
      </div>
    </div>
  );
}

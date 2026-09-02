import { useState, useRef, useEffect } from "react";
import { useFocusedPaneAgent } from "../../hooks/useAgentActivity";
import { useSettingsStore } from "../../stores/settingsStore";
import type { AgentUsage } from "../../types";
import styles from "./AgentMeter.module.css";

/** 92089 -> "92.1k", 1627530 -> "1.63M", 1239805640 -> "1.24B". Exact below a
 *  thousand. Session cache reads reach ten digits, which no popover column can
 *  hold — the full number lives in the row's tooltip instead. */
function short(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 100_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 100_000_000 ? 2 : 0)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

function exact(n: number): string {
  return n.toLocaleString();
}

/** The window is what everything is measured against, so it reads as a round
 *  number ("200k", "1M") rather than a formatted count. */
function windowLabel(n: number): string {
  return n >= 1_000_000 ? `${n / 1_000_000}M` : `${n / 1_000}k`;
}

/** Colour follows headroom, not the theme accent: past three quarters of the
 *  window a compaction is close enough to be worth noticing. */
function pressure(fraction: number): string {
  if (fraction >= 0.9) return styles.high;
  if (fraction >= 0.75) return styles.medium;
  return "";
}

/** The four things taking up the window, largest first — cache read dominates
 *  a warm session, so it anchors the bar's left edge. */
function segmentsOf(u: AgentUsage) {
  return [
    { key: "cached", label: "Cached", value: u.cacheReadTokens, cls: styles.swCached },
    { key: "new", label: "New", value: u.cacheWriteTokens, cls: styles.swNew },
    { key: "input", label: "Input", value: u.freshInputTokens, cls: styles.swInput },
    { key: "reply", label: "Reply", value: u.replyTokens, cls: styles.swReply },
  ];
}

/** A session total: compact in the column, exact on hover. `hint` explains a
 *  figure that otherwise reads as a bug. */
function TotalRow({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel} title={hint}>
        {label}
        {hint && <span className={styles.hintMark}>?</span>}
      </span>
      <span className={styles.rowValue} title={exact(value)}>
        {short(value)}
      </span>
    </div>
  );
}

export default function AgentMeter() {
  const agent = useFocusedPaneAgent();
  const windowSetting = useSettingsStore((s) => s.agentContextWindow);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Nothing here is a control, so the popover closes on any click that lands
  // outside it — including one in the terminal the user is going back to.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", handler);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const usage = agent?.usage;
  const hasUsage = !!usage;

  // Close rather than strand an open popover when focus moves to a pane whose
  // terminal has no agent in it.
  useEffect(() => {
    if (!hasUsage) setOpen(false);
  }, [hasUsage]);

  if (!agent || !usage) return null;

  // An explicit setting wins over the backend's guess, except that a session
  // which has already outgrown the chosen size keeps the larger one — a meter
  // pinned at 100% would say less than the real number.
  const limit = windowSetting === "auto"
    ? usage.contextLimit
    : Math.max(windowSetting, usage.contextLimit);
  const fraction = limit > 0 ? Math.min(usage.contextTokens / limit, 1) : 0;
  const percent = Math.round(fraction * 100);
  const segments = segmentsOf(usage);

  return (
    <div className={styles.wrap} ref={ref}>
      <button
        className={`${styles.meter}${open ? ` ${styles.meterOpen}` : ""}`}
        // Reading the numbers should not cost the terminal its keyboard focus.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        title={`${agent.name} — ${exact(usage.contextTokens)} of ${windowLabel(
          limit
        )} context tokens`}
      >
        <span className={`${styles.name}${agent.active ? ` ${styles.nameActive}` : ""}`}>
          {agent.name}
        </span>
        <span className={styles.track}>
          <span
            className={`${styles.fill} ${pressure(fraction)}`}
            style={{ width: `${Math.max(fraction * 100, 2)}%` }}
          />
        </span>
        <span className={styles.percent}>{percent}%</span>
      </button>

      {open && (
        <div className={styles.popover}>
          <div className={styles.head}>
            <span className={styles.headName}>
              {usage.sessionName ?? agent.name}
            </span>
            <span className={styles.headMeta}>
              {usage.model ?? "unknown model"}
              {usage.cliVersion ? ` · v${usage.cliVersion}` : ""}
            </span>
          </div>

          <div className={styles.section}>
            <div className={styles.sectionHead}>
              <span>Context</span>
              <span className={styles.sectionValue}>
                {short(usage.contextTokens)} / {windowLabel(limit)}
                <span className={`${styles.pct} ${pressure(fraction)}`}>{percent}%</span>
              </span>
            </div>
            <div className={styles.stack}>
              {segments.map((s) => (
                <span
                  key={s.key}
                  className={`${styles.stackSeg} ${s.cls}`}
                  style={{
                    width: `${(s.value / Math.max(limit, 1)) * 100}%`,
                  }}
                />
              ))}
            </div>
            {segments.map((s) => (
              <div key={s.key} className={styles.row}>
                <span className={`${styles.swatch} ${s.cls}`} />
                <span className={styles.rowLabel}>{s.label}</span>
                <span className={styles.rowValue}>{exact(s.value)}</span>
              </div>
            ))}
            {/* The figure is a floor, and saying so costs one line. Where the
                window came from matters just as much: an inferred one is a
                guess that has not been contradicted yet. */}
            <p className={styles.note}>
              Measured at the last reply — tool output since then is not counted.
              {usage.contextLimitSource === "inferred" &&
                " Window size assumed; turn on the Claude Code bridge in Settings to read the real one."}
            </p>
          </div>

          <div className={styles.section}>
            <div className={styles.sectionHead}>
              <span>Session</span>
              <span className={styles.sectionValue}>
                {usage.turns} {usage.turns === 1 ? "turn" : "turns"}
              </span>
            </div>
            <TotalRow
              label="Input"
              value={usage.totalInputTokens}
              hint="Tokens sent fresh. With prompt caching this stays tiny — a couple of tokens a turn — because the conversation is served from cache instead."
            />
            <TotalRow label="Output" value={usage.totalOutputTokens} />
            <TotalRow
              label="Cache read"
              value={usage.totalCacheReadTokens}
              hint="The conversation re-read on every turn, summed across the session. It dwarfs the others by design, and is a billing figure rather than a measure of new material."
            />
            <TotalRow label="Cache write" value={usage.totalCacheWriteTokens} />
            {usage.sidechainOutputTokens > 0 && (
              <TotalRow
                label="Subagents"
                value={usage.sidechainOutputTokens}
                hint="Subagent replies, which are billed to the session but never enter this context window."
              />
            )}
            {usage.catchingUp && (
              <p className={styles.note}>
                Still reading this session's history — totals are climbing toward
                the real figure.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

import { useState, useRef, useEffect, type ReactNode } from "react";
import { useFocusedPaneAgent } from "../../hooks/useAgentActivity";
import { useSettingsStore, type MeterSection } from "../../stores/settingsStore";
import { useServiceStore } from "../../stores/serviceStore";
import type { AgentUsage, RateLimitWindow, ReportedDetails } from "../../types";
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

/** A duration in the two largest useful units: "2h 14m", "4d 3h", "under a
 *  minute". Reset times are read at a glance, so seconds would only jitter. */
function spanLabel(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "under a minute";
  const days = Math.floor(mins / 1_440);
  const hours = Math.floor((mins % 1_440) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  const rem = mins % 60;
  if (hours > 0) return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
  return `${rem}m`;
}

/** Cents matter on a short session and clutter a long one. */
function costLabel(usd: number): string {
  return usd >= 10 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2)}`;
}

/** Only a figure that has fallen behind says how old it is; a fresh one is
 *  simply current. Claude Code writes the payload while a session is drawing,
 *  so with every session idle the number sits still. */
const STALE_AFTER_MS = 5 * 60_000;

/** One rolling window of the plan: what has gone, and when it comes back. A
 *  window whose reset has already passed is shown as reset rather than at its
 *  last known figure, which is now wrong by construction. */
function PlanWindow({ label, win, now }: { label: string; win: RateLimitWindow; now: number }) {
  const resetAt = win.resetsAt * 1000;
  const rolledOver = resetAt <= now;
  const fraction = rolledOver ? 0 : Math.min(win.usedPercentage / 100, 1);
  return (
    <div className={styles.plan}>
      <div className={styles.row}>
        <span className={styles.rowLabel}>{label}</span>
        <span className={styles.planReset}>
          {rolledOver ? "reset · awaiting a new report" : `resets in ${spanLabel(resetAt - now)}`}
        </span>
        <span className={`${styles.rowValue} ${pressure(fraction)}`}>
          {rolledOver ? "—" : `${Math.round(win.usedPercentage)}%`}
        </span>
      </div>
      <span className={styles.planTrack}>
        <span
          className={`${styles.fill} ${pressure(fraction)}`}
          style={{ width: `${fraction * 100}%` }}
        />
      </span>
    </div>
  );
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

/** A row whose value is already a string — a price, a pair of line counts. */
function TextRow({ label, value, hint, title }: { label: string; value: ReactNode; hint?: string; title?: string }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel} title={hint}>
        {label}
        {hint && <span className={styles.hintMark}>?</span>}
      </span>
      <span className={styles.rowValue} title={title}>
        {value}
      </span>
    </div>
  );
}

/** A popover section that folds to its header. The header keeps its summary
 *  figure either way, so a collapsed section still answers the quick question
 *  and only hides the breakdown. Folded, it also gains a small bar for the
 *  section's one figure that is a percentage — the glance the breakdown was
 *  giving. Which sections are folded is remembered. */
function Section({ id, title, value, bar, children }: {
  id: MeterSection;
  title: string;
  value: ReactNode;
  /** 0–1, with an optional pressure class; omitted when nothing is a percentage. */
  bar?: { fraction: number; cls?: string };
  children: ReactNode;
}) {
  const collapsed = useSettingsStore((s) => s.agentMeterCollapsed.includes(id));
  const toggle = useSettingsStore((s) => s.toggleAgentMeterSection);
  return (
    <div className={styles.section}>
      <button
        className={`${styles.sectionHead}${collapsed ? ` ${styles.sectionCollapsed}` : ""}`}
        onClick={() => toggle(id)}
        aria-expanded={!collapsed}
        title={collapsed ? "Show details" : "Hide details"}
      >
        <span className={styles.sectionTitle}>
          <span className={styles.chevron} aria-hidden>›</span>
          {title}
        </span>
        {collapsed && bar && (
          <span className={styles.headTrack}>
            <span
              className={`${styles.fill} ${bar.cls ?? ""}`}
              style={{ width: `${Math.max(Math.min(bar.fraction, 1) * 100, 2)}%` }}
            />
          </span>
        )}
        <span className={styles.sectionValue}>{value}</span>
      </button>
      {!collapsed && children}
    </div>
  );
}

/** The flags that change how a session behaves — and what it costs. Effort
 *  always shows; the others only when they depart from the default. */
function chipsOf(r: ReportedDetails): string[] {
  const out: string[] = [];
  if (r.effort) out.push(`${r.effort} effort`);
  if (r.fastMode) out.push("fast");
  if (r.thinking === false) out.push("no thinking");
  return out;
}

export default function AgentMeter() {
  const agent = useFocusedPaneAgent();
  const windowSetting = useSettingsStore((s) => s.agentContextWindow);
  const sessionCollapsed = useSettingsStore((s) => s.agentMeterCollapsed.includes("session"));
  const limits = useServiceStore((s) => s.rateLimits);
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

  // Countdowns are in minutes, so a slow tick keeps them honest without
  // re-rendering on every poll. The footer shows one too, so it always runs.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

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
  const reported = usage.reported;

  // The plan headline is the tighter window — the one that runs out first is
  // the one you plan around. The weekly window stands in when Claude Code has
  // not sent an hourly one.
  const leadKey = limits?.fiveHour ? "5h" : limits?.sevenDay ? "7d" : null;
  const lead = limits?.fiveHour ?? limits?.sevenDay ?? null;
  const leadLive = !!lead && lead.resetsAt * 1000 > now;
  const leadUsed = leadLive ? Math.min(lead!.usedPercentage / 100, 1) : 0;
  const leadLeft = leadLive ? Math.max(0, Math.round(100 - lead!.usedPercentage)) : null;
  const newestReport = Math.max(limits?.fiveHour?.reportedAt ?? 0, limits?.sevenDay?.reportedAt ?? 0) * 1000;
  const reportAge = newestReport > 0 ? now - newestReport : 0;

  // The footer names the model when the bridge says which, else the CLI.
  const shortName = reported?.modelName ?? agent.name;
  const headName = reported?.title ?? usage.sessionName ?? agent.name;
  const modelLabel = reported?.modelName ?? usage.model ?? "unknown model";
  const chips = reported ? chipsOf(reported) : [];

  const cacheExpiry = reported?.cacheExpiresAt ? reported.cacheExpiresAt * 1000 : null;
  const hitRatio = reported?.cacheHitRatio ?? null;
  const cacheLive = reported?.cacheWarm === true && cacheExpiry !== null && cacheExpiry > now;

  const tooltip = [
    `${headName} — ${exact(usage.contextTokens)} of ${windowLabel(limit)} context tokens`,
    leadLeft !== null && lead
      ? `Plan: ${leadLeft}% of the ${leadKey === "5h" ? "5-hour" : "7-day"} window left, resets in ${spanLabel(lead.resetsAt * 1000 - now)}`
      : null,
  ].filter(Boolean).join("\n");

  return (
    <div className={styles.wrap} ref={ref}>
      <button
        className={`${styles.meter}${open ? ` ${styles.meterOpen}` : ""}`}
        // Reading the numbers should not cost the terminal its keyboard focus.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        title={tooltip}
      >
        <span className={`${styles.name}${agent.active ? ` ${styles.nameActive}` : ""}`}>
          {shortName}
        </span>
        <span className={styles.gauge}>
          <span className={styles.gaugeLabel}>ctx</span>
          <span className={styles.track}>
            <span
              className={`${styles.fill} ${pressure(fraction)}`}
              style={{ width: `${Math.max(fraction * 100, 2)}%` }}
            />
          </span>
          <span className={styles.percent}>{percent}%</span>
        </span>
        {lead && (
          <span className={styles.gauge}>
            <span className={styles.gaugeLabel}>{leadKey}</span>
            <span className={styles.track}>
              <span
                className={`${styles.fill} ${pressure(leadUsed)}`}
                style={{ width: `${leadLive ? Math.max(leadUsed * 100, 2) : 0}%` }}
              />
            </span>
            <span className={styles.percent}>{leadLeft === null ? "—" : `${leadLeft}%`}</span>
          </span>
        )}
      </button>

      {open && (
        <div className={styles.popover}>
          <div className={styles.head}>
            <span className={styles.headName} title={headName}>{headName}</span>
            <span className={styles.headMeta}>
              <span className={styles.headModel} title={usage.model ?? undefined}>{modelLabel}</span>
              {usage.cliVersion ? ` · v${usage.cliVersion}` : ""}
              {chips.map((c) => (
                <span key={c} className={styles.chip}>{c}</span>
              ))}
            </span>
          </div>

          <Section
            id="context"
            title="Context"
            bar={{ fraction, cls: pressure(fraction) }}
            value={
              <>
                {short(usage.contextTokens)} / {windowLabel(limit)}
                <span className={`${styles.pct} ${pressure(fraction)}`}>{percent}%</span>
              </>
            }
          >
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
                " Window size assumed; turn on the Claude Code bridge in Settings to read the real one, along with your plan's remaining usage."}
            </p>
          </Section>

          {limits && (
            <Section
              id="plan"
              title="Plan"
              bar={{ fraction: leadUsed, cls: pressure(leadUsed) }}
              value={
                leadLeft === null ? "—" : (
                  <>
                    <span className={`${styles.pct} ${pressure(leadUsed)}`}>{leadLeft}%</span>
                    left
                  </>
                )
              }
            >
              {limits.fiveHour && <PlanWindow label="5 hour" win={limits.fiveHour} now={now} />}
              {limits.sevenDay && <PlanWindow label="7 day" win={limits.sevenDay} now={now} />}
              <p className={styles.note}>
                Your account's usage as Claude Code reports it, across every session.
                {reportAge > STALE_AFTER_MS &&
                  ` Last reported ${spanLabel(reportAge)} ago — it only refreshes while a session is drawing.`}
              </p>
            </Section>
          )}

          {/* Nothing in Session is a share of a whole except the cache hit
              rate — how much of each turn was served from cache — so that is
              the folded bar, and the folded line names it. */}
          <Section
            id="session"
            title="Session"
            bar={hitRatio !== null ? { fraction: hitRatio } : undefined}
            value={
              <>
                {reported?.costUsd != null && `${costLabel(reported.costUsd)} · `}
                {sessionCollapsed && hitRatio !== null
                  ? `${Math.round(hitRatio * 100)}% cached`
                  : `${usage.turns} ${usage.turns === 1 ? "turn" : "turns"}`}
              </>
            }
          >
            {reported?.costUsd != null && (
              <TextRow
                label="Cost"
                value={costLabel(reported.costUsd)}
                title={`$${reported.costUsd.toFixed(4)}`}
                hint="At API list price, as Claude Code tallies it since this process started — a resumed conversation starts again from zero. On a subscription this is what the session would have cost, not what you pay."
              />
            )}
            {reported && (reported.linesAdded != null || reported.linesRemoved != null) && (
              <TextRow
                label="Lines changed"
                value={
                  <>
                    <span className={styles.added}>+{exact(reported.linesAdded ?? 0)}</span>
                    {" "}
                    <span className={styles.removed}>−{exact(reported.linesRemoved ?? 0)}</span>
                  </>
                }
              />
            )}
            {/* Three states, not two: Claude Code says nothing about the cache
                until this process's first request, and a resumed conversation
                spends a while in that gap. A dash with a reason beats a row
                that comes and goes. */}
            {reported && (
              <TextRow
                label="Prompt cache"
                value={
                  reported.cacheWarm == null
                    ? "—"
                    : cacheLive
                      ? `warm · ${spanLabel(cacheExpiry! - now)} left`
                      : "cold"
                }
                title={reported.cacheWarm == null ? "Reported after this session's first turn" : undefined}
                hint={
                  reported.cacheWarm == null
                    ? "Claude Code reports the cache only once this process has made a request. Until then there is nothing to show."
                    : `Claude keeps the conversation cached server-side for ${reported.cacheTtl ?? "a while"} after each turn; ` +
                      `a turn sent while it is warm re-reads almost nothing.` +
                      (reported.cacheRecacheTokens
                        ? ` Once it lapses, the next turn re-reads ${exact(reported.cacheRecacheTokens)} tokens.`
                        : "") +
                      (reported.cacheCarried
                        ? " Carried over from before this conversation was resumed; Claude Code reports afresh after the first turn."
                        : "")
                }
              />
            )}
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
          </Section>
        </div>
      )}
    </div>
  );
}

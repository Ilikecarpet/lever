import { useEffect, useRef, useState } from "react";
import type { Chat, ChatState } from "../../lib/acpChat";
import { useServiceStore } from "../../stores/serviceStore";
import type { RateLimitWindow } from "../../types";
import styles from "./Chat.module.css";

/** 92089 -> "92.1k", 1627530 -> "1.63M"; exact below a thousand. */
function short(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 100_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function windowLabel(n: number): string {
  return n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1_000)}k`;
}

function spanLabel(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "under a minute";
  const days = Math.floor(mins / 1_440);
  const hours = Math.floor((mins % 1_440) / 60);
  if (days > 0) return hours ? `${days}d ${hours}h` : `${days}d`;
  return hours ? `${hours}h ${mins % 60}m` : `${mins}m`;
}

/** Past three quarters of a budget is worth a glance; past 90%, a warning. */
function tone(fraction: number): string {
  if (fraction >= 0.9) return "var(--red)";
  if (fraction >= 0.75) return "var(--yellow)";
  return "var(--accent)";
}

/**
 * The ring beside the send button, and the panel it opens: how full this
 * chat's context is, what the session has cost in tokens, and how much of the
 * plan is left. Compact appears once the context is filling, since that is
 * the moment it is worth doing.
 */
export function UsageButton({ chat, state }: { chat: Chat; state: ChatState }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const limits = useServiceStore((s) => s.rateLimits);
  const usage = state.usage!;

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc, true);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc, true);
    };
  }, [open]);

  const fraction = Math.min(1, usage.used / usage.size);
  const pct = Math.round(fraction * 100);
  const r = 7;
  const circ = 2 * Math.PI * r;
  const ringTone = fraction > 0.85 ? "var(--red)" : fraction > 0.6 ? "var(--yellow)" : "var(--text-dim)";

  const t = state.totals;
  const billed = t.input + t.cacheRead + t.cacheWrite;
  const hitRate = billed > 0 ? t.cacheRead / billed : null;
  const option = (id: string) => state.configOptions.find((o) => o.id === id);
  const model = option("model");
  const picked = model?.options.find((o) => o.value === model.currentValue);
  const modelName = picked ? (picked.value === "default" && picked.description ? picked.description : picked.name) : null;
  const effort = option("effort")?.currentValue;
  const canCompact = state.commands.some((c) => c.name === "compact") && state.status === "ready";
  const now = Date.now();

  return (
    <div className={styles.usageWrap} ref={ref}>
      <button
        className={`${styles.ring}${open ? ` ${styles.ringOpen}` : ""}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        title="Context and usage"
      >
        <svg width="18" height="18" viewBox="0 0 18 18">
          <circle cx="9" cy="9" r={r} fill="none" stroke="var(--border-hover)" strokeWidth="2" />
          <circle
            cx="9"
            cy="9"
            r={r}
            fill="none"
            stroke={ringTone}
            strokeWidth="2"
            strokeDasharray={`${circ * fraction} ${circ}`}
            strokeLinecap="round"
            transform="rotate(-90 9 9)"
            className={styles.ringArc}
          />
        </svg>
        <span className={styles.ringPct}>{pct}%</span>
      </button>

      {open && (
        <div className={styles.usagePanel} role="dialog" aria-label="Context and usage">
          <div className={styles.usageHead}>
            <span className={styles.usageModel}>{modelName ?? "Context"}</span>
            {effort && effort !== "default" && <span className={styles.usageChip}>{effort} effort</span>}
          </div>

          <section className={styles.usageSection}>
            <div className={styles.usageRow}>
              <span className={styles.usageLabel}>Context</span>
              <span className={styles.usageFigure}>
                {short(usage.used)} <span className={styles.usageDim}>/ {windowLabel(usage.size)}</span>
              </span>
            </div>
            <div className={styles.usageBar}>
              <span style={{ width: `${Math.max(fraction * 100, 1.5)}%`, background: tone(fraction) }} />
            </div>
            <div className={styles.usageNote}>
              <span style={{ color: tone(fraction) }}>{pct}% used</span>
              <span>{short(Math.max(0, usage.size - usage.used))} left</span>
            </div>
            {fraction >= 0.6 && (
              <div className={styles.usageAdvice}>
                {fraction >= 0.85
                  ? "Nearly full. Claude will compact on its own soon; compacting now lets you choose when."
                  : "Filling up. Compacting summarises the conversation so far and frees room."}
              </div>
            )}
          </section>

          <section className={styles.usageSection}>
            <div className={styles.usageLabel}>This chat</div>
            <div className={styles.usageGrid}>
              <Stat label="Cost" value={usage.cost != null ? `$${usage.cost.toFixed(2)}` : "—"} hint="At API list price. On a subscription this is not what you pay." />
              <Stat label="Turns" value={String(t.turns)} />
              <Stat label="Output" value={short(t.output)} hint="Tokens Claude wrote." />
              <Stat label="Cache hit" value={hitRate == null ? "—" : `${Math.round(hitRate * 100)}%`} hint="Share of input served from the prompt cache. High is cheap and fast." />
              <Stat label="Cache read" value={short(t.cacheRead)} />
              <Stat label="Cache write" value={short(t.cacheWrite)} />
            </div>
            {t.turns === 0 && <div className={styles.usageNote}>Totals start with this chat's first reply.</div>}
          </section>

          {limits && (limits.fiveHour || limits.sevenDay) && (
            <section className={styles.usageSection}>
              <div className={styles.usageLabel}>Plan</div>
              {limits.fiveHour && <PlanRow label="5 hour" win={limits.fiveHour} now={now} />}
              {limits.sevenDay && <PlanRow label="Weekly" win={limits.sevenDay} now={now} />}
            </section>
          )}

          {canCompact && (
            <button
              className={styles.usageAction}
              onClick={() => {
                setOpen(false);
                chat.prompt("/compact");
              }}
              title="Summarise the conversation so far to free context"
            >
              Compact conversation
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className={styles.usageStat} title={hint}>
      <span className={styles.usageStatValue}>{value}</span>
      <span className={styles.usageStatLabel}>{label}</span>
    </div>
  );
}

/** One of the plan's rolling windows; one past its reset reads as reset. */
function PlanRow({ label, win, now }: { label: string; win: RateLimitWindow; now: number }) {
  const resetAt = win.resetsAt * 1000;
  const rolled = resetAt <= now;
  const fraction = rolled ? 0 : Math.min(win.usedPercentage / 100, 1);
  return (
    <div className={styles.usagePlan}>
      <div className={styles.usageRow}>
        <span>{label}</span>
        <span className={styles.usageDim}>{rolled ? "reset" : `resets in ${spanLabel(resetAt - now)}`}</span>
        <span className={styles.usageFigure} style={{ color: tone(fraction) }}>
          {rolled ? "—" : `${Math.round(win.usedPercentage)}%`}
        </span>
      </div>
      <div className={styles.usageBar}>
        <span style={{ width: `${Math.max(fraction * 100, 1.5)}%`, background: tone(fraction) }} />
      </div>
    </div>
  );
}

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { DbColumnInfo, DbSchema, DbTableInfo, DbValueHit } from "../../types";
import type { ValueSearch } from "../../stores/dbStore";
import { formatCount, formatMs } from "../../lib/sql";
import { IconKey, IconLink, IconTable, IconView, IconSearch, IconStop, IconChevronRight } from "../Icons";
import styles from "./SchemaSearch.module.css";

export type SearchScope = "all" | "tables" | "views" | "columns" | "values";

const SCOPES: { id: SearchScope; label: string }[] = [
  { id: "all", label: "All" },
  { id: "tables", label: "Tables" },
  { id: "views", label: "Views" },
  { id: "columns", label: "Columns" },
];

/** Mirrors the backend: tables over this are skipped unless asked for. */
const LARGE_TABLE_ROWS = 1_000_000;

/** Under "All", a section shows this many before "Show all". */
const PREVIEW = { objects: 12, columns: 6 };
/** A scope of its own lists this many; past that, narrow the query. */
const CAP = 400;

interface TableHit {
  kind: "table";
  ns: string;
  table: DbTableInfo;
  rank: number;
}
interface ColumnHit {
  kind: "column";
  ns: string;
  table: DbTableInfo;
  column: DbColumnInfo;
  rank: number;
}
type Hit = TableHit | ColumnHit;

/**
 * How well a name matches: exact, then prefix, then the start of a word
 * (`team_member` for "member"), then anywhere. Lower is better; -1 is no
 * match. This is what puts the `member` table above a hundred columns that
 * merely contain the word.
 */
function rank(name: string, needle: string): number {
  const n = name.toLowerCase();
  if (n === needle) return 0;
  if (n.startsWith(needle)) return 1;
  const i = n.indexOf(needle);
  if (i < 0) return -1;
  return /[_\-.\s$]/.test(n[i - 1]) || (name[i] !== n[i] && name[i - 1] === n[i - 1]) ? 2 : 3;
}

const isView = (t: DbTableInfo) => t.kind !== "table";

function byRank<T extends { rank: number }>(name: (h: T) => string) {
  return (a: T, b: T) => a.rank - b.rank || name(a).length - name(b).length || name(a).localeCompare(name(b));
}

export interface SchemaSearchHandle {
  /** Arrow keys and Enter from the filter field. Returns true when handled. */
  key: (e: React.KeyboardEvent) => boolean;
}

interface Props {
  schema: DbSchema;
  query: string;
  scope: SearchScope;
  onScope: (s: SearchScope) => void;
  onOpen: (ns: string, table: string) => void;
  /** The connection's latest value search, if any. */
  values: ValueSearch | undefined;
  /** Tagged production: a value search asks before it runs. */
  risky: boolean;
  onValueSearch: (exact: boolean, skipLarge: boolean) => void;
  onCancelValues: () => void;
  onOpenHit: (hit: DbValueHit, exact: boolean) => void;
}

const SchemaSearch = forwardRef<SchemaSearchHandle, Props>(function SchemaSearch(
  { schema, query, scope, onScope, onOpen, values, risky, onValueSearch, onCancelValues, onOpenHit },
  ref
) {
  const [exact, setExact] = useState(values?.exact ?? false);
  const [skipLarge, setSkipLarge] = useState(values?.skipLarge ?? true);
  const [confirming, setConfirming] = useState(false);
  // Results belong to the text they were found for; edit it and they step aside.
  const current = values && values.query === query.trim() ? values : undefined;
  const plan = useMemo(() => {
    let tables = 0;
    let large = 0;
    for (const ns of schema.namespaces)
      for (const t of ns.tables) {
        if (t.kind === "view" || t.kind === "foreign table") continue;
        tables++;
        if ((t.rows ?? 0) > LARGE_TABLE_ROWS) large++;
      }
    return { tables, large };
  }, [schema]);
  const runValues = (opts?: { skipLarge?: boolean }) => {
    if (risky && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    const skip = opts?.skipLarge ?? skipLarge;
    if (opts?.skipLarge !== undefined) setSkipLarge(skip);
    onValueSearch(exact, skip);
  };
  useEffect(() => setConfirming(false), [query, scope]);
  const needle = query.trim().toLowerCase();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const multiNs = schema.namespaces.length > 1;

  const hits = useMemo(() => {
    const tables: TableHit[] = [];
    const views: TableHit[] = [];
    const columns: ColumnHit[] = [];
    for (const ns of schema.namespaces) {
      for (const t of ns.tables) {
        const r = rank(t.name, needle);
        if (r >= 0) (isView(t) ? views : tables).push({ kind: "table", ns: ns.name, table: t, rank: r });
        for (const c of t.columns) {
          const cr = rank(c.name, needle);
          if (cr >= 0) columns.push({ kind: "column", ns: ns.name, table: t, column: c, rank: cr });
        }
      }
    }
    // The namespace you work in wins a tie, so `public.member` beats `audit.member`.
    const home = (h: Hit) => (h.ns === schema.current ? 0 : 1);
    tables.sort((a, b) => a.rank - b.rank || home(a) - home(b) || byRank<TableHit>((h) => h.table.name)(a, b));
    views.sort((a, b) => a.rank - b.rank || home(a) - home(b) || byRank<TableHit>((h) => h.table.name)(a, b));
    columns.sort((a, b) => a.rank - b.rank || home(a) - home(b) || byRank<ColumnHit>((h) => h.column.name)(a, b));
    return { tables, views, columns };
  }, [schema, needle]);

  // Sections as shown in this scope, each with how many rows it renders.
  const sections = useMemo(() => {
    const objects = [...hits.tables, ...hits.views].sort((a, b) => a.rank - b.rank);
    const all: { id: string; title: string; items: Hit[]; total: number }[] =
      scope === "all"
        ? [
            { id: "objects", title: "Tables and views", items: objects, total: objects.length },
            { id: "columns", title: "Columns", items: hits.columns, total: hits.columns.length },
          ]
        : scope === "tables"
          ? [{ id: "tables", title: "Tables", items: hits.tables, total: hits.tables.length }]
          : scope === "views"
            ? [{ id: "views", title: "Views", items: hits.views, total: hits.views.length }]
            : [{ id: "columns", title: "Columns", items: hits.columns, total: hits.columns.length }];
    return all
      .filter((s) => s.total > 0)
      .map((s) => {
        const limit = scope === "all" && !expanded[s.id] ? (s.id === "objects" ? PREVIEW.objects : PREVIEW.columns) : CAP;
        return { ...s, items: s.items.slice(0, limit) };
      });
  }, [hits, scope, expanded]);

  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const valueHits = current?.hits ?? [];
  const navCount = scope === "values" ? valueHits.length : flat.length;

  useEffect(() => setActive(0), [needle, scope]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-hit="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  useImperativeHandle(ref, () => ({
    key: (e) => {
      if (e.key === "ArrowDown") {
        setActive((a) => Math.min(navCount - 1, a + 1));
        return true;
      }
      if (e.key === "ArrowUp") {
        setActive((a) => Math.max(0, a - 1));
        return true;
      }
      if (e.key === "Enter" && scope === "values") {
        if (current && valueHits[active]) onOpenHit(valueHits[active], current.exact);
        else if (!current?.running) runValues();
        return true;
      }
      if (e.key === "Enter" && flat[active]) {
        onOpen(flat[active].ns, flat[active].table.name);
        return true;
      }
      // Tab steps through the scopes without leaving the field.
      if (e.key === "Tab") {
        if (scope === "values") return true;
        const i = SCOPES.findIndex((s) => s.id === scope);
        onScope(SCOPES[(i + (e.shiftKey ? SCOPES.length - 1 : 1)) % SCOPES.length].id);
        return true;
      }
      return false;
    },
  }));

  const counts: Record<SearchScope, number | null> = {
    all: hits.tables.length + hits.views.length + hits.columns.length,
    tables: hits.tables.length,
    views: hits.views.length,
    columns: hits.columns.length,
    // Unknown until a search has run for this text.
    values: current && !current.running ? current.hits.length : null,
  };

  let index = -1;

  return (
    <div className={styles.root}>
      {scope === "values" ? (
        <div className={styles.valuesHead}>
          <span className={styles.valuesHeadText}>Searching inside rows</span>
          <button className={styles.noteLink} onMouseDown={(e) => e.preventDefault()} onClick={() => onScope("all")}>
            Back to names
          </button>
        </div>
      ) : (
      <div className={styles.scopes} role="tablist" aria-label="Search in">
        {SCOPES.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={scope === s.id}
            className={`${styles.scope}${scope === s.id ? ` ${styles.scopeOn}` : ""}${counts[s.id] === 0 ? ` ${styles.scopeEmpty}` : ""}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onScope(s.id)}
          >
            {s.label}
            <span className={styles.scopeCount}>{counts[s.id]! > 999 ? "999+" : counts[s.id]}</span>
          </button>
        ))}
      </div>
      )}

      <div className={styles.list} ref={listRef}>
        {scope === "values" && (
          <ValuePanel
            query={query.trim()}
            search={current}
            exact={exact}
            skipLarge={skipLarge}
            plan={plan}
            risky={risky}
            confirming={confirming}
            active={active}
            onExact={setExact}
            onSkipLarge={setSkipLarge}
            onRun={runValues}
            onCancelConfirm={() => setConfirming(false)}
            onCancel={onCancelValues}
            onOpenHit={(h) => current && onOpenHit(h, current.exact)}
            onHover={setActive}
          />
        )}
        {scope !== "values" && flat.length === 0 && (
          <div className={styles.empty}>
            <div className={styles.emptyTitle}>
              No {scope === "all" ? "table, view or column" : scope.slice(0, -1)} named like “{query.trim()}”
            </div>
            {scope !== "all" && counts.all! > 0 && (
              <button className={styles.emptyLink} onClick={() => onScope("all")}>
                {formatCount(counts.all!)} {counts.all === 1 ? "match" : "matches"} elsewhere — search everything
              </button>
            )}
            {counts.all === 0 && <ValuesCta query={query.trim()} prominent onClick={() => onScope("values")} />}
          </div>
        )}

        {scope !== "values" && sections.map((s) => (
          <section key={s.id} className={styles.section}>
            <div className={styles.sectionHead}>
              <span>{s.title}</span>
              <span className={styles.sectionCount}>{formatCount(s.total)}</span>
            </div>
            {s.items.map((h) => {
              index += 1;
              const i = index;
              return h.kind === "table" ? (
                <button
                  key={`t:${h.ns}.${h.table.name}`}
                  data-hit={i}
                  className={`${styles.hit}${i === active ? ` ${styles.hitActive}` : ""}`}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => onOpen(h.ns, h.table.name)}
                  title={`${h.ns}.${h.table.name} — open`}
                >
                  <span className={styles.hitIcon}>{isView(h.table) ? <IconView size={12} /> : <IconTable size={12} />}</span>
                  <span className={styles.hitName}>
                    <span className={styles.hitLabel}>
                      <Mark text={h.table.name} needle={needle} />
                    </span>
                  </span>
                  {multiNs && <span className={styles.hitNs}>{h.ns}</span>}
                  <span className={styles.hitMeta}>
                    {isView(h.table) ? h.table.kind : h.table.rows !== null && h.table.rows > 0 ? `${compactRows(h.table.rows)} rows` : "table"}
                  </span>
                </button>
              ) : (
                <button
                  key={`c:${h.ns}.${h.table.name}.${h.column.name}`}
                  data-hit={i}
                  className={`${styles.hit} ${styles.hitColumn}${i === active ? ` ${styles.hitActive}` : ""}`}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => onOpen(h.ns, h.table.name)}
                  title={`${h.ns}.${h.table.name}.${h.column.name} ${h.column.type} — open ${h.table.name}`}
                >
                  <span className={styles.hitIcon}>
                    {h.column.pk ? (
                      <span className={styles.pk}>
                        <IconKey size={10} />
                      </span>
                    ) : h.column.references ? (
                      <span className={styles.fk}>
                        <IconLink size={10} />
                      </span>
                    ) : (
                      <span className={styles.colDot} />
                    )}
                  </span>
                  <span className={styles.hitName}>
                    <span className={styles.hitLabel}>
                      <Mark text={h.column.name} needle={needle} />
                    </span>
                    <span className={styles.hitParent}>
                      {multiNs && h.ns !== schema.current ? `${h.ns}.` : ""}
                      {h.table.name}
                    </span>
                  </span>
                  <span className={styles.hitType}>{h.column.type}</span>
                </button>
              );
            })}
            {scope === "all" && s.total > s.items.length && (
              <button
                className={styles.more}
                onClick={() => (s.id === "columns" ? onScope("columns") : setExpanded((x) => ({ ...x, [s.id]: true })))}
              >
                Show all {formatCount(s.total)}
              </button>
            )}
            {scope !== "all" && s.total > s.items.length && (
              <div className={styles.capNote}>
                Showing the best {formatCount(s.items.length)} of {formatCount(s.total)} — type more to narrow it
              </div>
            )}
          </section>
        ))}
      </div>

      <div className={styles.foot}>
        <span>
          <kbd>↑↓</kbd> move
        </span>
        <span>
          <kbd>↵</kbd> {scope === "values" && !current ? "search" : "open"}
        </span>
        <span>
          <kbd>⇥</kbd> type
        </span>
        <span>
          <kbd>esc</kbd> clear
        </span>
      </div>
    </div>
  );
});

export default SchemaSearch;

function compactRows(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

function Mark({ text, needle }: { text: string; needle: string }) {
  const i = text.toLowerCase().indexOf(needle);
  if (!needle || i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className={styles.mark}>{text.slice(i, i + needle.length)}</mark>
      {text.slice(i + needle.length)}
    </>
  );
}

/** The way into a value search, offered only when no name matches: it reads
 *  every table, so it is never run on its own. */
function ValuesCta({ query, prominent, onClick }: { query: string; prominent?: boolean; onClick: () => void }) {
  return (
    <button className={`${styles.cta}${prominent ? ` ${styles.ctaProminent}` : ""}`} onClick={onClick}>
      <span className={styles.ctaIcon}>
        <IconSearch size={12} />
      </span>
      <span className={styles.ctaText}>
        <span>
          Search values for <b>“{query}”</b>
        </span>
        <span className={styles.ctaSub}>Looks inside every table's rows</span>
      </span>
      <IconChevronRight size={9} />
    </button>
  );
}

interface ValuePanelProps {
  query: string;
  search: ValueSearch | undefined;
  exact: boolean;
  skipLarge: boolean;
  plan: { tables: number; large: number };
  risky: boolean;
  confirming: boolean;
  active: number;
  onExact: (v: boolean) => void;
  onSkipLarge: (v: boolean) => void;
  onRun: (opts?: { skipLarge?: boolean }) => void;
  onCancelConfirm: () => void;
  onCancel: () => void;
  onOpenHit: (hit: DbValueHit) => void;
  onHover: (i: number) => void;
}

function ValuePanel(p: ValuePanelProps) {
  const { search } = p;
  const [showFailed, setShowFailed] = useState(false);
  const count = p.plan.tables - (p.skipLarge ? p.plan.large : 0);
  const running = !!search?.running;
  const pct = search && search.total > 0 ? Math.round((search.searched / search.total) * 100) : 0;

  return (
    <div className={styles.values}>
      <div className={styles.valueOptions}>
        <div className={styles.matchSeg} role="radiogroup" aria-label="Match">
          {[false, true].map((x) => (
            <button
              key={String(x)}
              role="radio"
              aria-checked={p.exact === x}
              className={p.exact === x ? styles.matchOn : ""}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => p.onExact(x)}
              disabled={running}
            >
              {x ? "Exact value" : "Contains"}
            </button>
          ))}
        </div>
        {p.plan.large > 0 && (
          <label className={styles.skipLarge} title="Tables the planner estimates at over a million rows">
            <input type="checkbox" checked={p.skipLarge} onChange={(e) => p.onSkipLarge(e.target.checked)} disabled={running} />
            Skip {p.plan.large} table{p.plan.large === 1 ? "" : "s"} over 1M rows
          </label>
        )}
      </div>

      {p.confirming ? (
        <div className={`${styles.confirm} lv-rise`}>
          <div className={styles.confirmTitle}>This connection is tagged production</div>
          <div className={styles.confirmText}>
            A value search reads {formatCount(count)} tables one after another. It can't write, and each table stops after 15 s, but it
            is real load on the server.
          </div>
          <div className={styles.confirmActions}>
            <button className={`${styles.runBtn} ${styles.runDanger} lv-press`} onClick={() => p.onRun()}>
              Search anyway
            </button>
            <button className={`${styles.textBtn} lv-press`} onClick={p.onCancelConfirm}>
              Cancel
            </button>
          </div>
        </div>
      ) : running ? (
        <div className={styles.progressBox}>
          <div className={styles.progressTop}>
            <span>
              Searching {formatCount(search!.searched)} of {formatCount(search!.total || count)} tables
            </span>
            <button className={`${styles.textBtn} lv-press`} onClick={p.onCancel}>
              <IconStop size={8} /> Stop
            </button>
          </div>
          <div className={styles.track}>
            <div className={styles.fill} style={{ width: `${Math.max(pct, 3)}%` }} />
          </div>
          {search!.current && <div className={styles.progressCurrent}>{search!.current}</div>}
        </div>
      ) : !search ? (
        <button className={`${styles.runBtn} lv-press`} onClick={() => p.onRun()} disabled={!p.query}>
          <IconSearch size={11} /> Search {formatCount(count)} table{count === 1 ? "" : "s"}
          <kbd>↵</kbd>
        </button>
      ) : null}

      {search && !running && (
        <div className={styles.summary}>
          {search.error ? (
            <span className={styles.summaryError}>{search.error.message}</span>
          ) : (
            <>
              <span>
                {search.cancelled ? "Stopped · " : ""}
                {search.hits.length
                  ? `Found in ${formatCount(search.hits.length)} table${search.hits.length === 1 ? "" : "s"}`
                  : `No table holds ${search.exact ? "exactly " : ""}“${search.query}”`}
              </span>
              <span className={styles.summarySub}>
                {formatCount(search.searched)} of {formatCount(search.total)} searched
                {search.elapsedMs !== null ? ` in ${formatMs(search.elapsedMs)}` : ""}
              </span>
            </>
          )}
          <button className={`${styles.textBtn} lv-press`} onClick={() => p.onRun()} title="Run the search again">
            Search again
          </button>
        </div>
      )}

      {search && search.hits.length > 0 && (
        <div className={styles.hits}>
          {search.hits.map((h, i) => (
            <button
              key={`${h.namespace}.${h.table}`}
              data-hit={i}
              className={`${styles.valueHit}${i === p.active ? ` ${styles.hitActive}` : ""} lv-rise`}
              style={{ ["--i" as string]: Math.min(i, 8) }}
              onMouseMove={() => i !== p.active && p.onHover(i)}
              onClick={() => p.onOpenHit(h)}
              title={`Open ${h.namespace}.${h.table} filtered to these rows`}
            >
              <div className={styles.valueHitTop}>
                <span className={styles.hitIcon}>
                  <IconTable size={12} />
                </span>
                <span className={styles.valueHitName}>{h.table}</span>
                <span className={styles.valueHitRows}>
                  {h.more ? `${h.rows}+` : h.rows} row{h.rows === 1 && !h.more ? "" : "s"}
                </span>
              </div>
              <div className={styles.valueHitCols}>
                {h.columns.map((c) => (
                  <span key={c} className={styles.colChip}>
                    {c}
                  </span>
                ))}
              </div>
              {h.preview && (
                <div className={styles.valuePreview}>
                  <Mark text={h.preview} needle={search.query.toLowerCase()} />
                </div>
              )}
            </button>
          ))}
        </div>
      )}

      {search && !running && search.skipped.length > 0 && (
        <div className={styles.note}>
          Skipped {search.skipped.length} table{search.skipped.length === 1 ? "" : "s"} over 1M rows.{" "}
          <button className={styles.noteLink} onClick={() => p.onRun({ skipLarge: false })}>
            Include them
          </button>
        </div>
      )}
      {search && search.failed.length > 0 && (
        <div className={styles.note}>
          <button className={styles.noteLink} onClick={() => setShowFailed((v) => !v)}>
            {search.failed.length} table{search.failed.length === 1 ? "" : "s"} couldn't be searched
          </button>
          {showFailed && (
            <ul className={styles.failedList}>
              {search.failed.map((f) => (
                <li key={f.table}>
                  <b>{f.table}</b> {f.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!search && !p.confirming && (
        <div className={styles.valueHint}>
          Reads every table's rows for the text, smallest tables first, on a read-only connection. Each table stops after 15 s.
        </div>
      )}
    </div>
  );
}

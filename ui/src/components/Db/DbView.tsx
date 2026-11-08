import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { useConfigStore } from "../../stores/configStore";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { useGitStore } from "../../stores/gitStore";
import { usePanelStore } from "../../stores/panelStore";
import {
  useDbStore,
  useSchema,
  editCount,
  PAGE_SIZE,
  type ConsoleTab,
  type DbTarget,
  type TableTab,
  type StatementOutcome,
} from "../../stores/dbStore";
import { splitStatements, statementAt, tableRef, quoteIdent, quoteLiteral, ENGINE_LABEL, formatCount, formatMs } from "../../lib/sql";
import type { DbConnectionDef, DbSchema, DbTableInfo, DbError } from "../../types";
import { useClampToViewport } from "../../hooks/useClampToViewport";
import { usePresence } from "../../hooks/usePresence";
import SqlEditor, { markError, flashRange } from "./SqlEditor";
import DataGrid, { type GridEditing } from "./DataGrid";
import SchemaSearch, { type SchemaSearchHandle, type SearchScope } from "./SchemaSearch";
import {
  IconChevronRight,
  IconClose,
  IconClock,
  IconDatabase,
  IconKey,
  IconLink,
  IconLock,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconStop,
  IconTable,
  IconView,
  IconFilter,
  IconCommand,
  IconSparkle,
  IconCheck,
} from "../Icons";
import menuStyles from "../ContextMenu/ContextMenu.module.css";
import styles from "./DbView.module.css";

const EXPLORER_KEY = "lever-db-explorer-width";
const SPLIT_KEY = "lever-db-editor-ratio";

function readNum(key: string, fallback: number, min: number, max: number): number {
  const v = Number(localStorage.getItem(key));
  return Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}

function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Keeps a clock ticking while something is in flight, for elapsed time. */
function useNow(active: boolean, every = 100): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(id);
  }, [active, every]);
  return now;
}

// ---------------------------------------------------------------------------
// The pane
// ---------------------------------------------------------------------------

interface Props {
  paneId: string;
  connId: string;
  worktreeId: string | null;
  isActive: boolean;
}

export default function DbView({ paneId, connId, worktreeId, isActive }: Props) {
  const def = useConfigStore((s) => s.databases.find((d) => d.id === connId));
  const target = useMemo<DbTarget>(() => ({ connId, worktreeId }), [connId, worktreeId]);
  const schemaEntry = useSchema(target);
  const loadSchema = useDbStore((s) => s.loadSchema);
  const pane = useDbStore((s) => s.panes[paneId]);
  const ensurePane = useDbStore((s) => s.pane);
  const [explorerW, setExplorerW] = useState(() => readNum(EXPLORER_KEY, 260, 180, 520));

  useEffect(() => {
    ensurePane(paneId);
  }, [paneId, ensurePane]);

  // Load once per connection and checkout; a url edit forgets the schema, and
  // this loads it again.
  const defUrl = def?.url;
  useEffect(() => {
    if (def && !schemaEntry?.schema && !schemaEntry?.loading && !schemaEntry?.error) loadSchema(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def, defUrl, target, schemaEntry]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = explorerW;
    document.body.style.cursor = "col-resize";
    let w = startW;
    const onMove = (ev: MouseEvent) => {
      w = Math.min(520, Math.max(180, startW + ev.clientX - startX));
      setExplorerW(w);
    };
    const onUp = () => {
      document.body.style.cursor = "";
      localStorage.setItem(EXPLORER_KEY, String(w));
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  if (!def) {
    return (
      <div className={styles.gone}>
        <IconDatabase size={28} />
        <div className={styles.goneTitle}>This connection was removed</div>
        <div className={styles.goneHint}>Close the tab, or add the database again from the sidebar.</div>
      </div>
    );
  }
  if (!pane) return null;

  return (
    <div className={styles.root} data-color={def.color ?? undefined}>
      <Explorer
        width={explorerW}
        def={def}
        target={target}
        paneId={paneId}
        schema={schemaEntry?.schema ?? null}
        loading={!!schemaEntry?.loading}
        error={schemaEntry?.error ?? null}
      />
      <div className={styles.explorerResize} onMouseDown={startResize} />
      <Workbench def={def} target={target} paneId={paneId} schema={schemaEntry?.schema ?? null} isActive={isActive} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Explorer: the connection, and its schema as a filterable tree
// ---------------------------------------------------------------------------

interface ExplorerProps {
  width: number;
  def: DbConnectionDef;
  target: DbTarget;
  paneId: string;
  schema: DbSchema | null;
  loading: boolean;
  error: DbError | null;
}

function Explorer({ width, def, target, paneId, schema, loading, error }: ExplorerProps) {
  const loadSchema = useDbStore((s) => s.loadSchema);
  const openTable = useDbStore((s) => s.openTable);
  const addConsole = useDbStore((s) => s.addConsole);
  const editDatabase = usePanelStore((s) => s.editDatabase);
  const worktrees = useWorktreeStore((s) => s.worktrees);
  const branch = useGitStore((s) => s.gitInfo?.current_branch ?? "main");
  const checkout = target.worktreeId ? worktrees.find((w) => w.id === target.worktreeId)?.branch ?? "worktree" : branch;

  const [filter, setFilter] = useState("");
  const [scope, setScope] = useState<SearchScope>("all");
  const searchRef = useRef<SchemaSearchHandle>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; ns: string; table: DbTableInfo } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const lastMenu = useRef(menu);
  if (menu) lastMenu.current = menu;
  const menuPresence = usePresence(!!menu);
  const shownMenu = menu ?? lastMenu.current;
  useClampToViewport(menuRef, shownMenu?.x ?? 0, shownMenu?.y ?? 0);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);

  const needle = filter.trim().toLowerCase();
  const multiNs = (schema?.namespaces.length ?? 0) > 1;
  const tableCount = schema?.namespaces.reduce((n, ns) => n + ns.tables.length, 0) ?? 0;

  const nsOpen = (ns: string) => open[`ns:${ns}`] ?? (ns === schema?.current || !multiNs);
  const toggle = (key: string, fallback: boolean) => setOpen((o) => ({ ...o, [key]: !(o[key] ?? fallback) }));

  const view = useMemo(() => {
    if (!schema) return [];
    return schema.namespaces
      .map((ns) => {
        const tables = ns.tables
          .map((t) => {
            if (!needle) return { table: t, columns: null as null | typeof t.columns };
            const nameHit = t.name.toLowerCase().includes(needle);
            const cols = t.columns.filter((c) => c.name.toLowerCase().includes(needle));
            if (!nameHit && cols.length === 0) return null;
            return { table: t, columns: nameHit ? null : cols };
          })
          .filter(Boolean) as { table: DbTableInfo; columns: DbTableInfo["columns"] | null }[];
        return { ns: ns.name, tables };
      })
      .filter((n) => !needle || n.tables.length > 0);
  }, [schema, needle]);

  const ref = (ns: string, t: string) => tableRef(def.engine, ns, t, schema?.current ?? null);

  return (
    <aside className={styles.explorer} style={{ width }}>
      <div className={styles.connHead}>
        <span className={styles.connIcon}>
          <IconDatabase size={15} />
        </span>
        <div className={styles.connText}>
          <span className={styles.connName} title={def.name}>
            {def.name}
          </span>
          <span className={styles.connSub}>
            {schema ? `${ENGINE_LABEL[def.engine]} ${schema.version.split(/[\s(]/)[0]}` : ENGINE_LABEL[def.engine]}
            <i>·</i>
            <span className={styles.connBranch} title="The checkout this connection is resolved in">
              {checkout}
            </span>
          </span>
        </div>
        <button
          className={`${styles.iconBtn} lv-press${loading ? ` ${styles.spinning}` : ""}`}
          onClick={() => loadSchema(target, true)}
          title="Reload schema"
          disabled={loading}
        >
          <IconRefresh size={12} />
        </button>
      </div>

      {(def.read_only || def.agent_access) && (
        <div className={styles.badges}>
          {def.read_only && (
            <span className={styles.badge} title="Writes are refused for this connection">
              <IconLock size={10} /> Read-only
            </span>
          )}
          {def.agent_access && (
            <span className={styles.badge} title="Agents can read this database over Lever's MCP server">
              <IconSparkle size={10} /> Agents can read
            </span>
          )}
        </div>
      )}

      <div className={styles.filter}>
        <IconSearch size={12} />
        <input
          ref={filterRef}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              if (filter) setFilter("");
              else filterRef.current?.blur();
              return;
            }
            if (needle && searchRef.current?.key(e)) e.preventDefault();
          }}
          placeholder={schema ? `Search ${formatCount(tableCount)} table${tableCount === 1 ? "" : "s"} and their columns` : "Search"}
          spellCheck={false}
        />
        {filter && (
          <button className={styles.filterClear} onClick={() => setFilter("")} aria-label="Clear filter">
            <IconClose size={9} />
          </button>
        )}
      </div>

      {schema && needle ? (
        <SchemaSearch
          ref={searchRef}
          schema={schema}
          query={filter}
          scope={scope}
          onScope={setScope}
          onOpen={(ns, table) => openTable(paneId, target, ns, table)}
        />
      ) : (
      <div className={styles.tree}>
        {!schema && loading && (
          <div className={styles.skeleton}>
            {Array.from({ length: 9 }, (_, i) => (
              <div key={i} className={styles.skelRow} style={{ width: `${55 + ((i * 37) % 40)}%`, animationDelay: `${i * 60}ms` }} />
            ))}
          </div>
        )}

        {!schema && error && (
          <div className={`${styles.connError} lv-rise`}>
            <div className={styles.connErrorTitle}>Couldn't connect</div>
            <div className={styles.connErrorMsg}>{error.message}</div>
            {error.hint && <div className={styles.connErrorMsg}>{error.hint}</div>}
            <div className={styles.connErrorActions}>
              <button className={`${styles.pillBtn} lv-press`} onClick={() => loadSchema(target, true)}>
                Retry
              </button>
              <button className={`${styles.pillBtn} ${styles.pillGhost} lv-press`} onClick={() => editDatabase(def.id)}>
                Edit connection
              </button>
            </div>
          </div>
        )}

        {schema && tableCount === 0 && <div className={styles.treeEmpty}>No tables yet</div>}

        {view.map(({ ns, tables }) => {
          const nsIsOpen = needle ? true : nsOpen(ns);
          return (
            <div key={ns}>
              {multiNs && (
                <button className={styles.nsRow} onClick={() => toggle(`ns:${ns}`, ns === schema?.current)}>
                  <span className={`${styles.chev}${nsIsOpen ? ` ${styles.chevOpen}` : ""}`}>
                    <IconChevronRight size={9} />
                  </span>
                  <span className={styles.nsName}>{ns}</span>
                  <span className={styles.nsCount}>{tables.length}</span>
                </button>
              )}
              {nsIsOpen &&
                tables.map(({ table, columns }) => {
                  const key = `t:${ns}.${table.name}`;
                  const expanded = columns ? true : open[key] ?? false;
                  const shown = columns ?? table.columns;
                  return (
                    <div key={table.name}>
                      <div
                        className={`${styles.tableRow}${multiNs ? ` ${styles.indented}` : ""}`}
                        onClick={() => openTable(paneId, target, ns, table.name)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setMenu({ x: e.clientX, y: e.clientY, ns, table });
                        }}
                        title={`${ns}.${table.name} — click to open`}
                      >
                        <button
                          className={`${styles.chev}${expanded ? ` ${styles.chevOpen}` : ""}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggle(key, false);
                          }}
                          aria-label={expanded ? "Hide columns" : "Show columns"}
                        >
                          <IconChevronRight size={9} />
                        </button>
                        <span className={styles.tableIcon}>
                          {table.kind === "table" ? <IconTable size={12} /> : <IconView size={12} />}
                        </span>
                        <span className={styles.tableName}>
                          <Highlight text={table.name} needle={columns ? "" : needle} />
                        </span>
                        {table.rows !== null && table.rows > 0 && (
                          <span className={styles.tableRows} title={`About ${formatCount(table.rows)} rows`}>
                            {compact(table.rows)}
                          </span>
                        )}
                      </div>
                      {expanded && (
                        <div className={styles.columns}>
                          {shown.map((c) => (
                            <div
                              key={c.name}
                              className={`${styles.colRow}${multiNs ? ` ${styles.indented}` : ""}`}
                              title={[
                                `${c.name} ${c.type}`,
                                c.pk ? "primary key" : null,
                                !c.nullable ? "not null" : null,
                                c.default ? `default ${c.default}` : null,
                                c.references ? `→ ${c.references}` : null,
                              ]
                                .filter(Boolean)
                                .join("\n")}
                            >
                              <span className={styles.colIcon}>
                                {c.pk ? (
                                  <span className={styles.pk}>
                                    <IconKey size={10} />
                                  </span>
                                ) : c.references ? (
                                  <span className={styles.fk}>
                                    <IconLink size={10} />
                                  </span>
                                ) : (
                                  <span className={styles.colDot} />
                                )}
                              </span>
                              <span className={styles.colName}>
                                <Highlight text={c.name} needle={needle} />
                              </span>
                              <span className={styles.colType}>
                                {c.type}
                                {!c.nullable && !c.pk ? "!" : ""}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
      )}

      {menuPresence.mounted && shownMenu && (
        <div
          ref={menuRef}
          className={`${menuStyles.menu} ${styles.menu} lv-pop${menuPresence.closing ? " lv-closing" : ""}`}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className={menuStyles.header}>
            {shownMenu.ns}.{shownMenu.table.name}
          </div>
          <button
            className={menuStyles.item}
            onClick={() => {
              openTable(paneId, target, shownMenu.ns, shownMenu.table.name);
              setMenu(null);
            }}
          >
            <IconTable size={12} /> Open data
          </button>
          <button
            className={menuStyles.item}
            onClick={() => {
              const cols = shownMenu.table.columns.map((c) => (/^[a-z_][a-z0-9_]*$/.test(c.name) ? c.name : quoteIdent(def.engine, c.name)));
              addConsole(paneId, `SELECT ${cols.join(", ")}\nFROM ${ref(shownMenu.ns, shownMenu.table.name)}\nLIMIT 100;\n`);
              setMenu(null);
            }}
          >
            <IconCommand size={12} /> Query in new console
          </button>
          <button
            className={menuStyles.item}
            onClick={() => {
              navigator.clipboard.writeText(ref(shownMenu.ns, shownMenu.table.name));
              setMenu(null);
            }}
          >
            Copy name
          </button>
        </div>
      )}
    </aside>
  );
}

function Highlight({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{text}</>;
  const i = text.toLowerCase().indexOf(needle);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className={styles.hit}>{text.slice(i, i + needle.length)}</mark>
      {text.slice(i + needle.length)}
    </>
  );
}

// ---------------------------------------------------------------------------
// Workbench: tabs of consoles and tables
// ---------------------------------------------------------------------------

interface WorkbenchProps {
  def: DbConnectionDef;
  target: DbTarget;
  paneId: string;
  schema: DbSchema | null;
  isActive: boolean;
}

function Workbench({ def, target, paneId, schema, isActive }: WorkbenchProps) {
  const pane = useDbStore((s) => s.panes[paneId]);
  const setActiveTab = useDbStore((s) => s.setActiveTab);
  const closeTab = useDbStore((s) => s.closeTab);
  const addConsole = useDbStore((s) => s.addConsole);
  if (!pane) return null;
  const active = pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0];

  return (
    <section className={styles.workbench}>
      <div className={styles.tabBar}>
        <div className={styles.tabs}>
          {pane.tabs.map((t) => (
            <div
              key={t.id}
              className={`${styles.tab}${t.id === active.id ? ` ${styles.tabActive}` : ""}`}
              onClick={() => setActiveTab(paneId, t.id)}
              onAuxClick={(e) => e.button === 1 && closeTab(paneId, t.id)}
              title={t.kind === "table" ? `${t.namespace}.${t.table}` : t.title}
            >
              <span className={styles.tabIcon}>
                {t.kind === "table" ? (
                  <IconTable size={11} />
                ) : t.running ? (
                  <span className={styles.tabSpinner} />
                ) : (
                  <span className={styles.sqlGlyph}>SQL</span>
                )}
              </span>
              <span className={styles.tabLabel}>{t.kind === "table" ? t.table : t.title}</span>
              <button
                className={styles.tabClose}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(paneId, t.id);
                }}
                aria-label="Close tab"
              >
                <IconClose size={8} />
              </button>
            </div>
          ))}
          <button className={`${styles.tabNew} lv-press`} onClick={() => addConsole(paneId)} title="New console">
            <IconPlus size={12} />
          </button>
        </div>
        <HistoryButton connId={def.id} onPick={(sql) => addConsole(paneId, sql)} />
      </div>

      <div className={styles.tabBody}>
        {pane.tabs.map((t) => (
          <div key={t.id} className={styles.tabPage} style={{ display: t.id === active.id ? "flex" : "none" }}>
            {t.kind === "console" ? (
              <ConsoleView tab={t} def={def} target={target} paneId={paneId} schema={schema} isActive={isActive && t.id === active.id} />
            ) : (
              <TableView tab={t} def={def} target={target} paneId={paneId} schema={schema} />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// History, with agents' queries alongside yours
// ---------------------------------------------------------------------------

function HistoryButton({ connId, onPick }: { connId: string; onPick: (sql: string) => void }) {
  const history = useDbStore((s) => s.history[connId]);
  const lastAgent = useDbStore((s) => s.agentActivity.find((a) => a.connId === connId));
  const [open, setOpen] = useState(false);
  const [show, setShow] = useState<"all" | "agent">("all");
  const presence = usePresence(open);
  const ref = useRef<HTMLDivElement>(null);
  const now = useNow(!!lastAgent, 1000);
  const agentLive = !!lastAgent && now - lastAgent.at < 4000;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const list = (history ?? []).filter((h) => show === "all" || h.source === "agent");

  return (
    <div className={styles.historyWrap} ref={ref}>
      {lastAgent && (
        <span
          className={`${styles.agentChip}${agentLive ? ` ${styles.agentChipLive}` : ""}`}
          title={`An agent ${lastAgent.error ? "tried a query" : "read this database"} ${ago(lastAgent.at)}`}
          onClick={() => {
            setShow("agent");
            setOpen(true);
          }}
        >
          <span className={styles.agentDot} />
          Agent {agentLive ? "reading" : ago(lastAgent.at)}
        </span>
      )}
      <button
        className={`${styles.iconBtn} lv-press${open ? ` ${styles.iconBtnOn}` : ""}`}
        onClick={() => {
          setShow("all");
          setOpen((o) => !o);
        }}
        title="Query history"
      >
        <IconClock size={13} />
      </button>
      {presence.mounted && (
        <div className={`${menuStyles.menu} ${styles.historyMenu} lv-pop${presence.closing ? " lv-closing" : ""}`}>
          <div className={styles.historyHead}>
            <span>History</span>
            <div className={styles.miniSeg}>
              {(["all", "agent"] as const).map((k) => (
                <button key={k} className={show === k ? styles.miniSegOn : ""} onClick={() => setShow(k)}>
                  {k === "all" ? "All" : "Agents"}
                </button>
              ))}
            </div>
          </div>
          <div className={styles.historyList}>
            {list.length === 0 && (
              <div className={styles.historyEmpty}>
                {show === "agent" ? "No agent has queried this database yet." : "Statements you run show up here."}
              </div>
            )}
            {list.slice(0, 60).map((h, i) => (
              <button
                key={i}
                className={styles.historyItem}
                onClick={() => {
                  onPick(h.sql.endsWith(";") ? `${h.sql}\n` : `${h.sql};\n`);
                  setOpen(false);
                }}
                title="Open in a new console"
              >
                <code className={`${styles.historySql}${h.ok ? "" : ` ${styles.historyFailed}`}`}>{h.sql}</code>
                <span className={styles.historyMeta}>
                  {h.source === "agent" && <span className={styles.historyAgent}>agent</span>}
                  {!h.ok && <span className={styles.historyErr}>failed</span>}
                  {ago(h.at)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Console: an editor over its results
// ---------------------------------------------------------------------------

interface ConsoleProps {
  tab: ConsoleTab;
  def: DbConnectionDef;
  target: DbTarget;
  paneId: string;
  schema: DbSchema | null;
  isActive: boolean;
}

function ConsoleView({ tab, def, target, paneId, schema, isActive }: ConsoleProps) {
  const patchTab = useDbStore((s) => s.patchTab);
  const runConsole = useDbStore((s) => s.runConsole);
  const cancel = useDbStore((s) => s.cancel);
  const viewRef = useRef<EditorView | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(() => readNum(SPLIT_KEY, 0.42, 0.12, 0.88));

  useEffect(() => {
    if (isActive) viewRef.current?.focus();
  }, [isActive]);

  const run = useCallback(
    (all: boolean) => {
      const view = viewRef.current;
      if (!view) return;
      const text = view.state.doc.toString();
      const sel = view.state.selection.main;
      let statements;
      if (all) {
        statements = splitStatements(text);
      } else if (!sel.empty) {
        // A selection runs as typed, split into its statements.
        statements = splitStatements(text.slice(sel.from, sel.to)).map((s) => ({ ...s, from: s.from + sel.from, to: s.to + sel.from }));
      } else {
        const one = statementAt(text, sel.head);
        statements = one ? [one] : [];
      }
      if (statements.length === 0) return;
      markError(view, null);
      flashRange(view, [statements[0].from, statements[statements.length - 1].to]);
      runConsole(paneId, tab.id, target, statements).then(() => {
        // Point at where the server said a statement went wrong.
        const t = useDbStore.getState().panes[paneId]?.tabs.find((x) => x.id === tab.id);
        if (t?.kind !== "console" || !t.run || !viewRef.current) return;
        const failed = t.run.outcomes.find((o) => o.error);
        if (!failed?.error) return;
        if (failed.error.position) {
          const at = failed.from + failed.error.position - 1;
          const rest = viewRef.current.state.doc.sliceString(at, at + 64);
          const word = /^[^\s,;()]+/.exec(rest)?.[0].length ?? 1;
          markError(viewRef.current, [at, at + word]);
        } else {
          markError(viewRef.current, [failed.from, failed.from + failed.sql.length]);
        }
      });
    },
    [paneId, tab.id, target, runConsole]
  );

  const startSplit = (e: React.MouseEvent) => {
    e.preventDefault();
    const body = bodyRef.current;
    if (!body) return;
    const rect = body.getBoundingClientRect();
    document.body.style.cursor = "row-resize";
    let r = ratio;
    const onMove = (ev: MouseEvent) => {
      r = Math.min(0.88, Math.max(0.12, (ev.clientY - rect.top) / rect.height));
      setRatio(r);
    };
    const onUp = () => {
      document.body.style.cursor = "";
      localStorage.setItem(SPLIT_KEY, String(r));
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div className={styles.console} ref={bodyRef}>
      <div className={styles.editor} style={{ flexBasis: `${ratio * 100}%` }}>
        <SqlEditor
          value={tab.sql}
          engine={def.engine}
          schema={schema}
          onChange={(sql) => patchTab(paneId, tab.id, { sql })}
          onRun={() => run(false)}
          onRunAll={() => run(true)}
          onReady={(h) => (viewRef.current = h.view)}
          autoFocus={isActive}
        />
      </div>

      <div className={styles.toolbar} onMouseDown={(e) => e.target === e.currentTarget && startSplit(e)}>
        <div className={styles.splitGrip} onMouseDown={startSplit} />
        {tab.running ? (
          <button className={`${styles.runBtn} ${styles.cancelBtn} lv-press`} onClick={() => cancel(target)}>
            <IconStop size={10} /> Cancel
          </button>
        ) : (
          <button className={`${styles.runBtn} lv-press`} onClick={() => run(false)} title="Run the selection, or the statement at the cursor">
            <IconPlay size={10} /> Run <kbd>⌘↵</kbd>
          </button>
        )}
        <button className={`${styles.ghostBtn} lv-press`} onClick={() => run(true)} disabled={tab.running} title="Run every statement in the console">
          Run all <kbd>⇧⌘↵</kbd>
        </button>
        <span className={styles.toolbarSpacer} />
        {def.read_only && (
          <span className={styles.toolbarNote}>
            <IconLock size={10} /> Read-only
          </span>
        )}
        <RunStatus tab={tab} />
      </div>

      <div className={styles.results}>
        <Results tab={tab} paneId={paneId} schema={schema} />
      </div>
    </div>
  );
}

function RunStatus({ tab }: { tab: ConsoleTab }) {
  const now = useNow(tab.running);
  if (tab.running && tab.run) {
    const done = tab.run.outcomes.length;
    return (
      <span className={styles.status}>
        {tab.run.planned > 1 ? `Statement ${Math.min(done + 1, tab.run.planned)} of ${tab.run.planned} · ` : "Running · "}
        {formatMs(now - tab.run.startedAt)}
      </span>
    );
  }
  if (!tab.run) return null;
  const total = tab.run.outcomes.reduce((n, o) => n + o.elapsedMs, 0);
  const failed = tab.run.outcomes.some((o) => o.error?.cancelled === false);
  const stopped = tab.run.outcomes.length < tab.run.planned;
  return (
    <span className={styles.status}>
      {failed ? "Failed" : stopped ? "Stopped" : tab.run.planned > 1 ? `${tab.run.planned} statements` : "Done"} · {formatMs(total)}
    </span>
  );
}

function Results({ tab, paneId, schema }: { tab: ConsoleTab; paneId: string; schema: DbSchema | null }) {
  const patchTab = useDbStore((s) => s.patchTab);
  const run = tab.run;

  if (!run) {
    return (
      <div className={styles.resultsEmpty}>
        <div className={styles.resultsEmptyTitle}>Results show up here</div>
        <div className={styles.shortcuts}>
          <span>
            <kbd>⌘↵</kbd> run statement
          </span>
          <span>
            <kbd>⇧⌘↵</kbd> run all
          </span>
          <span>
            <kbd>⌃Space</kbd> complete
          </span>
        </div>
      </div>
    );
  }

  const shown = run.outcomes[run.shown];
  const multi = run.planned > 1;

  return (
    <div className={styles.resultsInner}>
      {tab.running && <div className={styles.progress} />}
      {multi && (
        <div className={styles.outcomeBar}>
          {run.outcomes.map((o, i) => (
            <button
              key={i}
              className={`${styles.outcome}${i === run.shown ? ` ${styles.outcomeOn}` : ""}${o.error ? ` ${styles.outcomeErr}` : ""}`}
              onClick={() => patchTab(paneId, tab.id, { run: { ...run, shown: i } })}
              title={o.sql}
            >
              <span className={styles.outcomeIdx}>{i + 1}</span>
              <span className={styles.outcomeText}>{outcomeLabel(o)}</span>
            </button>
          ))}
          {tab.running && run.outcomes.length < run.planned && (
            <span className={`${styles.outcome} ${styles.outcomePending}`}>
              <span className={styles.outcomeIdx}>{run.outcomes.length + 1}</span>
              <span className={styles.tabSpinner} />
            </span>
          )}
        </div>
      )}
      {shown ? <OutcomeView outcome={shown} schema={schema} /> : <div className={styles.resultsEmpty} />}
    </div>
  );
}

function outcomeLabel(o: StatementOutcome): string {
  if (o.error) return o.error.cancelled ? "cancelled" : "error";
  if (o.set && o.set.columns.length > 0) return `${formatCount(o.set.rows.length)}${o.set.truncated ? "+" : ""} rows`;
  return `${formatCount(o.set?.affected ?? 0)} affected`;
}

/** The first table a SELECT reads from, to borrow its column types. */
function typesFor(sql: string, schema: DbSchema | null): { types?: Record<string, string>; keys?: Set<string> } {
  if (!schema) return {};
  const m = /\bfrom\s+((?:"[^"]+"|`[^`]+`|[\w$]+)(?:\.(?:"[^"]+"|`[^`]+`|[\w$]+))?)/i.exec(sql);
  if (!m) return {};
  const parts = m[1].split(".").map((p) => p.replace(/^["`]|["`]$/g, ""));
  const [ns, name] = parts.length === 2 ? parts : [schema.current, parts[0]];
  const t = schema.namespaces
    .filter((n) => !ns || n.name === ns)
    .flatMap((n) => n.tables)
    .find((x) => x.name === name || x.name.toLowerCase() === name.toLowerCase());
  if (!t) return {};
  return {
    types: Object.fromEntries(t.columns.map((c) => [c.name, c.type])),
    keys: new Set(t.columns.filter((c) => c.pk).map((c) => c.name)),
  };
}

function OutcomeView({ outcome, schema }: { outcome: StatementOutcome; schema: DbSchema | null }) {
  const { types, keys } = useMemo(() => typesFor(outcome.sql, schema), [outcome.sql, schema]);
  if (outcome.error) return <ErrorCard error={outcome.error} sql={outcome.sql} />;
  const set = outcome.set;
  if (!set || set.columns.length === 0) {
    return (
      <div className={`${styles.okCard} lv-rise`}>
        <span className={styles.okIcon}>
          <IconCheck size={14} />
        </span>
        <div>
          <div className={styles.okTitle}>
            {formatCount(set?.affected ?? 0)} row{set?.affected === 1 ? "" : "s"} affected
          </div>
          <div className={styles.okSub}>
            {formatMs(outcome.elapsedMs)} · <code>{firstLine(outcome.sql)}</code>
          </div>
        </div>
      </div>
    );
  }
  return (
    <>
      <DataGrid set={set} types={types} keys={keys} />
      <div className={styles.gridFoot}>
        <span>
          {formatCount(set.rows.length)} row{set.rows.length === 1 ? "" : "s"}
          {set.truncated && <span className={styles.footNote}> · first {formatCount(set.rows.length)} fetched; add a LIMIT or narrow the query for the rest</span>}
        </span>
        <span className={styles.toolbarSpacer} />
        <span>{formatMs(outcome.elapsedMs)}</span>
      </div>
    </>
  );
}

function firstLine(sql: string): string {
  const l = sql.split("\n")[0];
  return l.length > 80 ? `${l.slice(0, 80)}…` : l;
}

function ErrorCard({ error, sql }: { error: DbError; sql?: string }) {
  if (error.cancelled) {
    return (
      <div className={`${styles.cancelCard} lv-rise`}>
        <IconStop size={10} /> Cancelled{sql ? <code>{firstLine(sql)}</code> : null}
      </div>
    );
  }
  return (
    <div className={`${styles.errorCard} lv-rise`}>
      <div className={styles.errorTitle}>{error.message}</div>
      {error.detail && <div className={styles.errorLine}><b>Detail</b> {error.detail}</div>}
      {error.hint && <div className={styles.errorLine}><b>Hint</b> {error.hint}</div>}
      {sql && <pre className={styles.errorSql}>{sql}</pre>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table: a page of rows, with search, a WHERE clause and sorting
// ---------------------------------------------------------------------------

interface TableProps {
  tab: TableTab;
  def: DbConnectionDef;
  target: DbTarget;
  paneId: string;
  schema: DbSchema | null;
}

function TableView({ tab, def, target, paneId, schema }: TableProps) {
  const browse = useDbStore((s) => s.browse);
  const addConsole = useDbStore((s) => s.addConsole);
  const store = useDbStore.getState;
  const [search, setSearch] = useState(tab.search);
  const [where, setWhere] = useState(tab.where);
  const [nudge, setNudge] = useState(0);
  const [review, setReview] = useState<string[] | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const searchTimer = useRef<number>();

  const info = schema?.namespaces.find((n) => n.name === tab.namespace)?.tables.find((t) => t.name === tab.table);
  const types = useMemo(() => (info ? Object.fromEntries(info.columns.map((c) => [c.name, c.type])) : undefined), [info]);
  const keys = useMemo(() => (info ? new Set(info.columns.filter((c) => c.pk).map((c) => c.name)) : undefined), [info]);

  useEffect(() => setWhere(tab.where), [tab.where]);

  // Why rows here can't be edited, if they can't.
  const lockedReason = !info
    ? null
    : def.read_only
      ? "Read-only connection"
      : info.kind !== "table"
        ? `A ${info.kind} — read-only here`
        : !info.columns.some((c) => c.pk)
          ? "No primary key, so rows can't be edited safely"
          : null;
  const canEdit = !!info && !lockedReason;
  const changes = editCount(tab.pending);
  const dirty = changes > 0;

  const editing = useMemo<GridEditing | undefined>(() => {
    if (!canEdit || !info) return undefined;
    return {
      pending: tab.pending,
      failedRow: tab.failedRow,
      // Binary values show as a preview; writing that text back would corrupt them.
      locked: new Set(info.columns.filter((c) => /bytea|blob|binary|geometry/i.test(c.type)).map((c) => c.name)),
      onEdit: (row, column, value) => store().editCell(paneId, tab.id, row, column, value),
      onRevertCell: (row, column) => store().revertCell(paneId, tab.id, row, column),
      onToggleDelete: (row) => store().toggleDelete(paneId, tab.id, row),
    };
  }, [canEdit, info, tab.pending, tab.failedRow, paneId, tab.id, store]);

  // Paging, filtering or sorting reloads the page, which would drop unsaved
  // edits; it waits until they are submitted or reverted, and says so.
  const go = (p: Partial<TableTab>) => {
    if (dirty) {
      setNudge((n) => n + 1);
      return;
    }
    browse(paneId, tab.id, target, p);
  };

  const submit = async () => {
    if (!info || !dirty || tab.submitting) return;
    const n = changes;
    const out = await store().submitEdits(paneId, tab.id, target, info);
    if (out) {
      setReview(null);
      setSaved(n);
      window.setTimeout(() => setSaved(null), 2600);
    }
  };

  const openReview = async () => {
    if (!info) return;
    if (review) {
      setReview(null);
      return;
    }
    const out = await store().submitEdits(paneId, tab.id, target, info, true);
    if (out) setReview(out);
  };

  // Edits change what a review showed; it closes rather than going stale.
  useEffect(() => setReview(null), [tab.pending]);

  const onSearch = (v: string) => {
    setSearch(v);
    window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => go({ search: v, offset: 0 }), 280);
  };

  const total = tab.data?.total ?? null;
  const count = tab.data?.set.rows.length ?? 0;
  const from = count ? tab.offset + 1 : 0;
  const to = tab.offset + count;
  const hasNext = total !== null ? to < total : count === tab.limit;
  const filtered = !!(tab.search || tab.where);

  const filterValue = (column: string, value: string | null) => {
    const col = quoteIdent(def.engine, column);
    const clause = value === null ? `${col} IS NULL` : `${col} = ${quoteLiteral(value)}`;
    const next = tab.where.trim() ? `${tab.where.trim()} AND ${clause}` : clause;
    setWhere(next);
    go({ where: next, offset: 0 });
  };

  const updated = Object.keys(tab.pending.updates).filter((k) => !tab.pending.deletes.includes(Number(k))).length;
  const summary = [
    updated && `${updated} edited`,
    tab.pending.inserts.length && `${tab.pending.inserts.length} added`,
    tab.pending.deletes.length && `${tab.pending.deletes.length} deleted`,
  ].filter(Boolean).join(" · ");

  return (
    <div
      className={styles.tableView}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "s") {
          e.preventDefault();
          submit();
        }
      }}
    >
      <div className={styles.tableBar}>
        <div className={styles.searchBox}>
          <IconSearch size={12} />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && search) onSearch("");
              if (e.key === "Enter") {
                window.clearTimeout(searchTimer.current);
                go({ search, offset: 0 });
              }
            }}
            placeholder="Search rows"
            spellCheck={false}
          />
        </div>
        <div className={`${styles.whereBox}${tab.where ? ` ${styles.whereBoxOn}` : ""}`}>
          <span className={styles.whereLabel}>
            <IconFilter size={11} /> WHERE
          </span>
          <input
            value={where}
            onChange={(e) => setWhere(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") go({ where, offset: 0 });
              if (e.key === "Escape") {
                setWhere("");
                if (tab.where) go({ where: "", offset: 0 });
              }
            }}
            placeholder={info?.columns[0] ? `${info.columns[0].name} = …  ↵ to apply` : "condition  ↵ to apply"}
            spellCheck={false}
          />
          {where && (
            <button
              className={styles.filterClear}
              onClick={() => {
                setWhere("");
                go({ where: "", offset: 0 });
              }}
              aria-label="Clear condition"
            >
              <IconClose size={9} />
            </button>
          )}
        </div>
        <span className={styles.toolbarSpacer} />
        {lockedReason && (
          <span className={styles.toolbarNote} title={lockedReason}>
            <IconLock size={10} /> {lockedReason}
          </span>
        )}
        {canEdit && (
          <button
            className={`${styles.ghostBtn} lv-press`}
            onClick={() => store().addRow(paneId, tab.id)}
            disabled={!tab.data || tab.submitting}
            title="Add a row; it's saved when you submit"
          >
            <IconPlus size={11} /> Row
          </button>
        )}
        <button
          className={`${styles.iconBtn} lv-press${tab.loading ? ` ${styles.spinning}` : ""}`}
          onClick={() => go({})}
          title="Reload"
        >
          <IconRefresh size={12} />
        </button>
        <button
          className={`${styles.ghostBtn} lv-press`}
          onClick={() => tab.data && addConsole(paneId, `${tab.data.sql};\n`)}
          disabled={!tab.data}
          title="Open this page's SELECT in a console"
        >
          <IconCommand size={11} /> Open in console
        </button>
      </div>

      <div className={styles.tableBody}>
        {tab.loading && <div className={styles.progress} />}
        {tab.error ? (
          <ErrorCard error={tab.error} />
        ) : tab.data ? (
          tab.data.set.rows.length === 0 && tab.pending.inserts.length === 0 ? (
            <>
              {/* The header still says what the table holds. */}
              <div className={styles.noRows}>
                <div className={styles.noRowsTitle}>{filtered ? "No rows match" : "This table is empty"}</div>
                {!filtered && canEdit && (
                  <button className={`${styles.pillBtn} lv-press`} onClick={() => store().addRow(paneId, tab.id)}>
                    <IconPlus size={11} /> Add a row
                  </button>
                )}
                {filtered && (
                  <button
                    className={`${styles.pillBtn} ${styles.pillGhost} lv-press`}
                    onClick={() => {
                      setSearch("");
                      setWhere("");
                      go({ search: "", where: "", offset: 0 });
                    }}
                  >
                    Clear filters
                  </button>
                )}
              </div>
            </>
          ) : (
            <DataGrid
              set={tab.data.set}
              types={types}
              keys={keys}
              rowOffset={tab.offset}
              sort={tab.orderBy ? { column: tab.orderBy, descending: tab.descending } : null}
              editing={editing}
              onSort={(column) => {
                // Ascending, descending, then unsorted.
                if (tab.orderBy !== column) go({ orderBy: column, descending: false, offset: 0 });
                else if (!tab.descending) go({ descending: true, offset: 0 });
                else go({ orderBy: null, descending: false, offset: 0 });
              }}
              onFilterValue={filterValue}
            />
          )
        ) : (
          <div className={styles.skeletonGrid}>
            {Array.from({ length: 12 }, (_, i) => (
              <div key={i} className={styles.skelRow} style={{ animationDelay: `${i * 50}ms` }} />
            ))}
          </div>
        )}
      </div>

      {review && (
        <div className={`${styles.review} lv-rise`}>
          <div className={styles.reviewHead}>
            <span>
              {review.length} statement{review.length === 1 ? "" : "s"}, run in one transaction
            </span>
            <button className={`${styles.iconBtn} lv-press`} onClick={() => setReview(null)} aria-label="Close review">
              <IconClose size={10} />
            </button>
          </div>
          <pre className={styles.reviewSql}>{review.map((sql) => `${sql};`).join("\n")}</pre>
        </div>
      )}

      {dirty || tab.submitError ? (
        <div key={nudge} className={`${styles.changesBar}${nudge ? ` ${styles.changesNudge}` : ""}${tab.submitError ? ` ${styles.changesFailed}` : ""}`}>
          <span className={styles.changesDot} />
          <div className={styles.changesText}>
            {tab.submitError ? (
              <>
                <span className={styles.changesError}>{tab.submitError.message}</span>
                {tab.submitError.hint && <span className={styles.changesSub}>{tab.submitError.hint}</span>}
              </>
            ) : (
              <>
                <span>
                  {changes} unsaved change{changes === 1 ? "" : "s"}
                </span>
                <span className={styles.changesSub}>{nudge ? "Submit or revert before paging, filtering or sorting" : summary}</span>
              </>
            )}
          </div>
          <button className={`${styles.ghostBtn} lv-press${review ? ` ${styles.ghostBtnOn}` : ""}`} onClick={openReview} disabled={!dirty || tab.submitting}>
            Review SQL
          </button>
          <button className={`${styles.ghostBtn} lv-press`} onClick={() => store().revertEdits(paneId, tab.id)} disabled={tab.submitting}>
            Revert
          </button>
          <button className={`${styles.runBtn} lv-press`} onClick={submit} disabled={!dirty || tab.submitting}>
            {tab.submitting ? "Saving…" : "Submit"} <kbd>⌘S</kbd>
          </button>
        </div>
      ) : (
      <div className={styles.gridFoot}>
        <span>
          {saved !== null ? (
            <span className={`${styles.savedNote} lv-rise`}>
              <IconCheck size={11} /> Saved {saved} change{saved === 1 ? "" : "s"}
            </span>
          ) : tab.data ? (
            <>
              {count ? `${formatCount(from)}–${formatCount(to)}` : "0"}
              {total !== null && ` of ${formatCount(total)}`} row{(total ?? count) === 1 ? "" : "s"}
              {filtered && <span className={styles.footNote}> · filtered</span>}
            </>
          ) : (
            "Loading…"
          )}
        </span>
        <span className={styles.toolbarSpacer} />
        {tab.data && <span>{formatMs(tab.data.elapsedMs)}</span>}
        <div className={styles.pager}>
          <button
            className={`${styles.pageBtn} lv-press`}
            disabled={tab.offset === 0 || tab.loading}
            onClick={() => go({ offset: Math.max(0, tab.offset - PAGE_SIZE) })}
            aria-label="Previous page"
          >
            ‹
          </button>
          <button
            className={`${styles.pageBtn} lv-press`}
            disabled={!hasNext || tab.loading}
            onClick={() => go({ offset: tab.offset + PAGE_SIZE })}
            aria-label="Next page"
          >
            ›
          </button>
        </div>
      </div>
      )}
    </div>
  );
}

import { create } from "zustand";
import * as api from "../lib/tauri";
import { splitStatements, type Statement } from "../lib/sql";
import type {
  DbValueHit,
  DbValueSearchEvent,
  DbRowChange,
  DbTableInfo,
  DbAgentActivity,
  DbBrowseOutput,
  DbError,
  DbResultSet,
  DbSchema,
} from "../types";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One statement's outcome in a console run. */
export interface StatementOutcome {
  sql: string;
  /** Where the statement sits in the console's text, to point at an error. */
  from: number;
  set: DbResultSet | null;
  error: DbError | null;
  elapsedMs: number;
}

export interface ConsoleRun {
  outcomes: StatementOutcome[];
  /** Index of the outcome whose rows are showing. */
  shown: number;
  /** Statements the run was asked for — fewer outcomes means it stopped early. */
  planned: number;
  startedAt: number;
}

export interface ConsoleTab {
  kind: "console";
  id: string;
  title: string;
  sql: string;
  running: boolean;
  run: ConsoleRun | null;
}

/** A row in the grid: one the page loaded, or one being added. */
export interface RowRef {
  added: boolean;
  index: number;
}

/** Edits not yet sent. `updates` is keyed by row index in the loaded page;
 *  a value of null is NULL. An added row's missing column takes its default. */
export interface PendingEdits {
  updates: Record<number, Record<string, string | null>>;
  deletes: number[];
  inserts: Record<string, string | null>[];
}

export const NO_EDITS: PendingEdits = { updates: {}, deletes: [], inserts: [] };

export function editCount(p: PendingEdits): number {
  const updated = Object.keys(p.updates).filter((k) => !p.deletes.includes(Number(k))).length;
  return updated + p.deletes.length + p.inserts.length;
}

export interface TableTab {
  kind: "table";
  pending: PendingEdits;
  /** The row the last failed submit stopped at. */
  failedRow: RowRef | null;
  submitting: boolean;
  submitError: DbError | null;
  id: string;
  namespace: string;
  table: string;
  search: string;
  where: string;
  orderBy: string | null;
  descending: boolean;
  offset: number;
  limit: number;
  loading: boolean;
  data: DbBrowseOutput | null;
  error: DbError | null;
}

export type DbTab = ConsoleTab | TableTab;

export interface DbPaneState {
  tabs: DbTab[];
  activeTabId: string;
}

export interface SchemaEntry {
  schema: DbSchema | null;
  loading: boolean;
  error: DbError | null;
}

export interface HistoryEntry {
  sql: string;
  at: number;
  ok: boolean;
  /** Where it came from: the console, or an agent over MCP. */
  source: "you" | "agent";
}

/** A search for a value through every table, as it runs and when done. */
export interface ValueSearch {
  id: string;
  query: string;
  exact: boolean;
  skipLarge: boolean;
  running: boolean;
  searched: number;
  total: number;
  current: string | null;
  hits: DbValueHit[];
  failed: { table: string; message: string }[];
  skipped: string[];
  cancelled: boolean;
  elapsedMs: number | null;
  error: DbError | null;
}

/** Where a pane's queries go: its connection, in its checkout, on the
 *  database picked in the explorer (null is the one the URL names). */
export interface DbTarget {
  connId: string;
  worktreeId: string | null;
  database: string | null;
}

export const PAGE_SIZE = 200;
const HISTORY_MAX = 200;

const schemaKey = (t: DbTarget) => `${t.connId}|${t.worktreeId ?? "main"}|${t.database ?? ""}`;
/** The database choice is per connection and checkout, not per database. */
const choiceKey = (connId: string, worktreeId: string | null) => `${connId}|${worktreeId ?? "main"}`;

function choicesKey(): string {
  return `lever-db-database-${api.getProjectId() ?? "none"}`;
}

function readChoices(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(choicesKey()) ?? "{}");
    if (v && typeof v === "object") return v;
  } catch {}
  return {};
}

let tabCounter = 0;
const nextTabId = () => `dbt-${++tabCounter}`;

function newConsole(title = "Console", sql = ""): ConsoleTab {
  return { kind: "console", id: nextTabId(), title, sql, running: false, run: null };
}

function historyKey(): string {
  return `lever-db-history-${api.getProjectId() ?? "none"}`;
}

function readHistory(): Record<string, HistoryEntry[]> {
  try {
    const v = JSON.parse(localStorage.getItem(historyKey()) ?? "{}");
    if (v && typeof v === "object") return v;
  } catch {}
  return {};
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface DbState {
  schemas: Record<string, SchemaEntry>;
  panes: Record<string, DbPaneState>;
  /** Per connection, newest first. */
  history: Record<string, HistoryEntry[]>;
  /** Agent calls as they arrive, newest first; drives the "agent" chip. */
  agentActivity: DbAgentActivity[];
  /** The latest value search per connection and checkout. */
  valueSearches: Record<string, ValueSearch>;
  /** The database picked per connection and checkout; absent is the URL's. */
  databaseChoice: Record<string, string>;

  chooseDatabase: (paneId: string, connId: string, worktreeId: string | null, database: string | null) => void;

  loadSchema: (t: DbTarget, refresh?: boolean) => Promise<void>;
  pane: (paneId: string) => DbPaneState;
  setActiveTab: (paneId: string, tabId: string) => void;
  addConsole: (paneId: string, sql?: string) => string;
  /** Opens a table's tab, or focuses it; `filter` narrows it as it opens. */
  openTable: (paneId: string, t: DbTarget, namespace: string, table: string, filter?: { search?: string; where?: string }) => void;
  startValueSearch: (t: DbTarget, query: string, exact: boolean, skipLarge: boolean) => Promise<void>;
  cancelValueSearch: (t: DbTarget) => void;
  onValueSearchEvent: (e: DbValueSearchEvent) => void;
  closeTab: (paneId: string, tabId: string) => void;
  patchTab: (paneId: string, tabId: string, patch: Partial<DbTab>) => void;
  dropPane: (paneId: string) => void;

  runConsole: (paneId: string, tabId: string, t: DbTarget, statements: Statement[]) => Promise<void>;
  cancel: (t: DbTarget) => void;
  browse: (paneId: string, tabId: string, t: DbTarget, patch?: Partial<TableTab>) => Promise<void>;

  editCell: (paneId: string, tabId: string, row: RowRef, column: string, value: string | null) => void;
  revertCell: (paneId: string, tabId: string, row: RowRef, column: string) => void;
  toggleDelete: (paneId: string, tabId: string, row: RowRef) => void;
  addRow: (paneId: string, tabId: string) => void;
  revertEdits: (paneId: string, tabId: string) => void;
  /** Sends the pending edits in one transaction; with `dryRun`, only builds
   *  the SQL. Returns the statements, or null when it failed. */
  submitEdits: (paneId: string, tabId: string, t: DbTarget, table: DbTableInfo, dryRun?: boolean) => Promise<string[] | null>;

  recordAgent: (a: DbAgentActivity) => void;
  forgetConnection: (connId: string) => void;
}

/** Runs cancelled mid-script stop before their next statement. */
const cancelled = new Set<string>();

export const useDbStore = create<DbState>((set, get) => {
  const findTab = (paneId: string, tabId: string) => get().panes[paneId]?.tabs.find((t) => t.id === tabId);

  const patch = (paneId: string, tabId: string, p: Partial<DbTab>) =>
    set((s) => {
      const pane = s.panes[paneId];
      if (!pane) return s;
      return {
        panes: {
          ...s.panes,
          [paneId]: { ...pane, tabs: pane.tabs.map((t) => (t.id === tabId ? ({ ...t, ...p } as DbTab) : t)) },
        },
      };
    });

  const remember = (connId: string, entry: HistoryEntry) => {
    set((s) => {
      const list = [entry, ...(s.history[connId] ?? []).filter((h) => h.sql !== entry.sql)].slice(0, HISTORY_MAX);
      const history = { ...s.history, [connId]: list };
      try {
        localStorage.setItem(historyKey(), JSON.stringify(history));
      } catch {}
      return { history };
    });
  };

  return {
    schemas: {},
    panes: {},
    // Read once the window knows its project; see initDbListeners.
    history: {},
    agentActivity: [],
    valueSearches: {},
    databaseChoice: {},

    chooseDatabase: (paneId, connId, worktreeId, database) => {
      set((s) => {
        const databaseChoice = { ...s.databaseChoice };
        if (database) databaseChoice[choiceKey(connId, worktreeId)] = database;
        else delete databaseChoice[choiceKey(connId, worktreeId)];
        try {
          localStorage.setItem(choicesKey(), JSON.stringify(databaseChoice));
        } catch {}
        // Table tabs name tables in the database they came from; consoles
        // simply run against the new one.
        const pane = s.panes[paneId];
        if (!pane) return { databaseChoice };
        let tabs = pane.tabs.filter((t) => t.kind !== "table");
        if (!tabs.length) tabs = [newConsole()];
        const activeTabId = tabs.some((t) => t.id === pane.activeTabId) ? pane.activeTabId : tabs[0].id;
        return { databaseChoice, panes: { ...s.panes, [paneId]: { tabs, activeTabId } } };
      });
    },

    loadSchema: async (t, refresh = false) => {
      const key = schemaKey(t);
      const prev = get().schemas[key];
      if (prev?.loading) return;
      set((s) => ({ schemas: { ...s.schemas, [key]: { schema: prev?.schema ?? null, loading: true, error: null } } }));
      try {
        const schema = await api.dbSchema(t.connId, t.worktreeId, t.database, refresh);
        set((s) => ({ schemas: { ...s.schemas, [key]: { schema, loading: false, error: null } } }));
      } catch (e) {
        set((s) => ({
          schemas: { ...s.schemas, [key]: { schema: prev?.schema ?? null, loading: false, error: api.toDbError(e) } },
        }));
      }
    },

    pane: (paneId) => {
      const existing = get().panes[paneId];
      if (existing) return existing;
      const first = newConsole();
      const pane: DbPaneState = { tabs: [first], activeTabId: first.id };
      set((s) => ({ panes: { ...s.panes, [paneId]: pane } }));
      return pane;
    },

    setActiveTab: (paneId, tabId) =>
      set((s) => (s.panes[paneId] ? { panes: { ...s.panes, [paneId]: { ...s.panes[paneId], activeTabId: tabId } } } : s)),

    addConsole: (paneId, sql = "") => {
      const pane = get().pane(paneId);
      const n = pane.tabs.filter((t) => t.kind === "console").length;
      const tab = newConsole(n === 0 ? "Console" : `Console ${n + 1}`, sql);
      set((s) => ({ panes: { ...s.panes, [paneId]: { tabs: [...pane.tabs, tab], activeTabId: tab.id } } }));
      return tab.id;
    },

    openTable: (paneId, t, namespace, table, filter) => {
      const pane = get().pane(paneId);
      const existing = pane.tabs.find((x) => x.kind === "table" && x.namespace === namespace && x.table === table);
      if (existing && existing.kind === "table") {
        get().setActiveTab(paneId, existing.id);
        // A filter re-narrows it — unless that would drop unsaved edits.
        if (filter && editCount(existing.pending) === 0) {
          get().browse(paneId, existing.id, t, { search: filter.search ?? "", where: filter.where ?? "", offset: 0 });
        }
        return;
      }
      const tab: TableTab = {
        kind: "table",
        id: nextTabId(),
        namespace,
        table,
        search: filter?.search ?? "",
        where: filter?.where ?? "",
        orderBy: null,
        descending: false,
        offset: 0,
        limit: PAGE_SIZE,
        loading: false,
        data: null,
        error: null,
        pending: NO_EDITS,
        failedRow: null,
        submitting: false,
        submitError: null,
      };
      set((s) => ({ panes: { ...s.panes, [paneId]: { tabs: [...pane.tabs, tab], activeTabId: tab.id } } }));
      get().browse(paneId, tab.id, t);
    },

    closeTab: (paneId, tabId) =>
      set((s) => {
        const pane = s.panes[paneId];
        if (!pane) return s;
        const idx = pane.tabs.findIndex((t) => t.id === tabId);
        let tabs = pane.tabs.filter((t) => t.id !== tabId);
        // A pane is never empty: closing the last tab leaves a fresh console.
        if (tabs.length === 0) tabs = [newConsole()];
        const activeTabId =
          pane.activeTabId === tabId ? tabs[Math.min(idx, tabs.length - 1)].id : pane.activeTabId;
        return { panes: { ...s.panes, [paneId]: { tabs, activeTabId } } };
      }),

    patchTab: patch,

    dropPane: (paneId) =>
      set((s) => {
        const { [paneId]: _, ...rest } = s.panes;
        return { panes: rest };
      }),

    runConsole: async (paneId, tabId, t, statements) => {
      const tab = findTab(paneId, tabId);
      if (!tab || tab.kind !== "console" || tab.running || statements.length === 0) return;
      const key = schemaKey(t);
      cancelled.delete(key);
      const run: ConsoleRun = { outcomes: [], shown: 0, planned: statements.length, startedAt: Date.now() };
      patch(paneId, tabId, { running: true, run });

      let changedSchema = false;
      for (const st of statements) {
        if (cancelled.has(key)) break;
        const started = performance.now();
        let outcome: StatementOutcome;
        try {
          const out = await api.dbQuery(t.connId, t.worktreeId, t.database, st.sql);
          // One statement is sent at a time, so one set comes back; a driver
          // that splits further still shows its last.
          const shown = out.sets.find((s) => s.columns.length > 0) ?? out.sets[out.sets.length - 1] ?? null;
          if (out.sets.some((s) => s.columns.length === 0)) changedSchema = true;
          outcome = { sql: st.sql, from: st.from, set: shown, error: null, elapsedMs: out.elapsedMs };
        } catch (e) {
          outcome = {
            sql: st.sql,
            from: st.from,
            set: null,
            error: api.toDbError(e),
            elapsedMs: Math.round(performance.now() - started),
          };
        }
        remember(t.connId, { sql: st.sql, at: Date.now(), ok: !outcome.error, source: "you" });
        run.outcomes = [...run.outcomes, outcome];
        // Show the latest statement that returned rows, else the latest.
        const lastWithRows = run.outcomes.map((o) => !!o.set?.columns.length).lastIndexOf(true);
        run.shown = outcome.error ? run.outcomes.length - 1 : lastWithRows >= 0 ? lastWithRows : run.outcomes.length - 1;
        patch(paneId, tabId, { run: { ...run } });
        if (outcome.error) break;
      }
      cancelled.delete(key);
      patch(paneId, tabId, { running: false });
      if (changedSchema) get().loadSchema(t, true);
    },

    cancel: (t) => {
      cancelled.add(schemaKey(t));
      api.dbCancel(t.connId, t.worktreeId, t.database).catch(() => {});
    },

    browse: async (paneId, tabId, t, p = {}) => {
      const tab = findTab(paneId, tabId);
      if (!tab || tab.kind !== "table") return;
      const next = { ...tab, ...p };
      // A new page, filter or sort starts from what the database holds.
      patch(paneId, tabId, { ...p, loading: true, pending: NO_EDITS, failedRow: null, submitError: null });
      try {
        const data = await api.dbBrowse(t.connId, t.worktreeId, t.database, {
          namespace: next.namespace,
          table: next.table,
          search: next.search || undefined,
          where: next.where || undefined,
          orderBy: next.orderBy ?? undefined,
          descending: next.descending,
          offset: next.offset,
          limit: next.limit,
        });
        patch(paneId, tabId, { loading: false, data, error: null });
      } catch (e) {
        patch(paneId, tabId, { loading: false, error: api.toDbError(e) });
      }
    },

    editCell: (paneId, tabId, row, column, value) => {
      const tab = findTab(paneId, tabId);
      if (!tab || tab.kind !== "table" || !tab.data) return;
      const p = tab.pending;
      if (row.added) {
        const inserts = p.inserts.map((r, i) => (i === row.index ? { ...r, [column]: value } : r));
        patch(paneId, tabId, { pending: { ...p, inserts }, submitError: null });
        return;
      }
      const ci = tab.data.set.columns.findIndex((c) => c.name === column);
      const original = tab.data.set.rows[row.index]?.[ci];
      const rowEdits = { ...(p.updates[row.index] ?? {}) };
      // Typing the value back is no edit at all.
      if (value === original) delete rowEdits[column];
      else rowEdits[column] = value;
      const updates = { ...p.updates };
      if (Object.keys(rowEdits).length) updates[row.index] = rowEdits;
      else delete updates[row.index];
      patch(paneId, tabId, { pending: { ...p, updates }, submitError: null });
    },

    revertCell: (paneId, tabId, row, column) => {
      const tab = findTab(paneId, tabId);
      if (!tab || tab.kind !== "table") return;
      const p = tab.pending;
      if (row.added) {
        const inserts = p.inserts.map((r, i) => {
          if (i !== row.index) return r;
          const { [column]: _, ...rest } = r;
          return rest;
        });
        patch(paneId, tabId, { pending: { ...p, inserts } });
        return;
      }
      const { [column]: _, ...rest } = p.updates[row.index] ?? {};
      const updates = { ...p.updates };
      if (Object.keys(rest).length) updates[row.index] = rest;
      else delete updates[row.index];
      patch(paneId, tabId, { pending: { ...p, updates } });
    },

    toggleDelete: (paneId, tabId, row) => {
      const tab = findTab(paneId, tabId);
      if (!tab || tab.kind !== "table") return;
      const p = tab.pending;
      // An added row that is deleted simply never existed.
      if (row.added) {
        patch(paneId, tabId, { pending: { ...p, inserts: p.inserts.filter((_, i) => i !== row.index) }, failedRow: null });
        return;
      }
      const deletes = p.deletes.includes(row.index) ? p.deletes.filter((d) => d !== row.index) : [...p.deletes, row.index];
      patch(paneId, tabId, { pending: { ...p, deletes }, submitError: null });
    },

    addRow: (paneId, tabId) => {
      const tab = findTab(paneId, tabId);
      if (!tab || tab.kind !== "table") return;
      patch(paneId, tabId, { pending: { ...tab.pending, inserts: [...tab.pending.inserts, {}] } });
    },

    revertEdits: (paneId, tabId) => patch(paneId, tabId, { pending: NO_EDITS, failedRow: null, submitError: null }),

    submitEdits: async (paneId, tabId, t, table, dryRun = false) => {
      const tab = findTab(paneId, tabId);
      if (!tab || tab.kind !== "table" || !tab.data || tab.submitting) return null;
      const { columns, rows } = tab.data.set;
      const p = tab.pending;
      const pk = table.columns.filter((c) => c.pk).map((c) => c.name);
      const keyOf = (i: number) =>
        pk.map((name) => ({ column: name, value: rows[i][columns.findIndex((c) => c.name === name)] }));
      // The order changes are sent in, and the row each one is about, so a
      // failure can be pointed at.
      const changes: DbRowChange[] = [];
      const refs: RowRef[] = [];
      for (const [k, set] of Object.entries(p.updates)) {
        const i = Number(k);
        if (p.deletes.includes(i)) continue;
        changes.push({ kind: "update", key: keyOf(i), set: Object.entries(set).map(([column, value]) => ({ column, value })) });
        refs.push({ added: false, index: i });
      }
      for (const i of p.deletes) {
        changes.push({ kind: "delete", key: keyOf(i) });
        refs.push({ added: false, index: i });
      }
      p.inserts.forEach((r, i) => {
        changes.push({ kind: "insert", values: Object.entries(r).map(([column, value]) => ({ column, value })) });
        refs.push({ added: true, index: i });
      });
      if (!changes.length) return [];
      if (!dryRun) patch(paneId, tabId, { submitting: true, submitError: null, failedRow: null });
      try {
        const out = await api.dbApply(t.connId, t.worktreeId, t.database, tab.namespace, tab.table, changes, dryRun);
        if (!dryRun) {
          for (const sql of out.statements) remember(t.connId, { sql, at: Date.now(), ok: true, source: "you" });
          patch(paneId, tabId, { submitting: false });
          await get().browse(paneId, tabId, t);
        }
        return out.statements;
      } catch (e) {
        const err = api.toDbError(e);
        const at = err.changeIndex ?? null;
        patch(paneId, tabId, { submitting: false, submitError: err, failedRow: at !== null ? refs[at] ?? null : null });
        return null;
      }
    },

    startValueSearch: async (t, query, exact, skipLarge) => {
      const key = schemaKey(t);
      const prev = get().valueSearches[key];
      if (prev?.running) get().cancelValueSearch(t);
      const id = `vs-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const fresh: ValueSearch = {
        id, query, exact, skipLarge, running: true, searched: 0, total: 0, current: null,
        hits: [], failed: [], skipped: [], cancelled: false, elapsedMs: null, error: null,
      };
      set((s) => ({ valueSearches: { ...s.valueSearches, [key]: fresh } }));
      const finish = (p: Partial<ValueSearch>) =>
        set((s) => {
          const cur = s.valueSearches[key];
          if (!cur || cur.id !== id) return s;
          return { valueSearches: { ...s.valueSearches, [key]: { ...cur, ...p, running: false, current: null } } };
        });
      try {
        const out = await api.dbSearchValues(t.connId, t.worktreeId, t.database, id, query, exact, skipLarge);
        finish({ searched: out.searched, total: out.total, skipped: out.skipped, cancelled: out.cancelled, elapsedMs: out.elapsedMs });
      } catch (e) {
        finish({ error: api.toDbError(e) });
      }
    },

    cancelValueSearch: (t) => {
      const cur = get().valueSearches[schemaKey(t)];
      if (!cur?.running) return;
      api.dbCancelValueSearch(t.connId, t.worktreeId, t.database, cur.id).catch(() => {});
    },

    onValueSearchEvent: (e) =>
      set((s) => {
        const entry = Object.entries(s.valueSearches).find(([, v]) => v.id === e.searchId);
        if (!entry) return s;
        const [key, cur] = entry;
        const next: ValueSearch = {
          ...cur,
          searched: e.searched,
          total: e.total,
          current: e.current ?? cur.current,
          hits: e.hit ? [...cur.hits, e.hit] : cur.hits,
          failed: e.failed ? [...cur.failed, e.failed] : cur.failed,
        };
        return { valueSearches: { ...s.valueSearches, [key]: next } };
      }),

    recordAgent: (a) => {
      set((s) => ({ agentActivity: [a, ...s.agentActivity].slice(0, 100) }));
      if (a.sql) remember(a.connId, { sql: a.sql, at: a.at, ok: !a.error, source: "agent" });
    },

    forgetConnection: (connId) =>
      set((s) => {
        const schemas = Object.fromEntries(Object.entries(s.schemas).filter(([k]) => !k.startsWith(`${connId}|`)));
        return { schemas };
      }),
  };
});

/** The database a pane works in: the one picked, or null for the URL's. */
export function useDatabaseChoice(connId: string, worktreeId: string | null): string | null {
  return useDbStore((s) => s.databaseChoice[choiceKey(connId, worktreeId)] ?? null);
}

export function useValueSearch(t: DbTarget): ValueSearch | undefined {
  return useDbStore((s) => s.valueSearches[schemaKey(t)]);
}

export function useSchema(t: DbTarget): SchemaEntry | undefined {
  return useDbStore((s) => s.schemas[schemaKey(t)]);
}

/** Subscribes the window to agents' database calls; returns the unsubscribe. */
export function initDbListeners(): Promise<() => void> {
  useDbStore.setState({ history: readHistory(), databaseChoice: readChoices() });
  const agents = api.tauriListen<DbAgentActivity>("db-agent-activity", (a) => useDbStore.getState().recordAgent(a));
  const values = api.tauriListen<DbValueSearchEvent>("db-value-search", (e) => useDbStore.getState().onValueSearchEvent(e));
  return Promise.all([agents, values]).then((fns) => () => fns.forEach((f) => f()));
}

export { splitStatements };

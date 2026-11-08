import type { DbEngine } from "../types";

/** One statement of a script, with where it sits in the text. */
export interface Statement {
  sql: string;
  /** Offsets into the script, `end` exclusive, trimmed of whitespace. */
  from: number;
  to: number;
}

/**
 * Splits a script on top-level semicolons, stepping over strings, quoted
 * identifiers, comments and Postgres dollar-quoted bodies, so a function
 * definition or a `';'` literal stays one statement.
 */
export function splitStatements(text: string): Statement[] {
  const out: Statement[] = [];
  let start = 0;
  let i = 0;
  const n = text.length;

  const push = (end: number) => {
    let from = start;
    let to = end;
    while (from < to && /\s/.test(text[from])) from++;
    while (to > from && /\s/.test(text[to - 1])) to--;
    const sql = text.slice(from, to);
    // A run of comments alone is not a statement.
    if (sql && stripComments(sql).trim()) out.push({ sql, from, to });
  };

  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "-" && next === "-") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
    } else if (c === "#" && /^#(?!>)/.test(text.slice(i, i + 2)) && isLineStart(text, i)) {
      // MySQL's other line comment, only where it can't be an operator.
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
    } else if (c === "/" && next === "*") {
      const endIdx = text.indexOf("*/", i + 2);
      i = endIdx === -1 ? n : endIdx + 2;
    } else if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < n) {
        if (text[i] === "\\" && c === "'") {
          i += 2;
          continue;
        }
        if (text[i] === c) {
          if (text[i + 1] === c) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
    } else if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (m) {
        const tag = m[0];
        const endIdx = text.indexOf(tag, i + tag.length);
        i = endIdx === -1 ? n : endIdx + tag.length;
      } else {
        i++;
      }
    } else if (c === ";") {
      push(i);
      start = i + 1;
      i++;
    } else {
      i++;
    }
  }
  push(n);
  return out;
}

function isLineStart(text: string, i: number): boolean {
  for (let j = i - 1; j >= 0; j--) {
    if (text[j] === "\n") return true;
    if (!/\s/.test(text[j])) return false;
  }
  return true;
}

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The statement the cursor is in — or, between two, the one just before it. */
export function statementAt(text: string, pos: number): Statement | null {
  const all = splitStatements(text);
  if (all.length === 0) return null;
  for (const s of all) {
    if (pos >= s.from && pos <= s.to) return s;
  }
  let best: Statement | null = null;
  for (const s of all) {
    if (s.to <= pos) best = s;
  }
  return best ?? all[0];
}

export function quoteIdent(engine: DbEngine, name: string): string {
  if (engine === "mysql") return "`" + name.replace(/`/g, "``") + "`";
  return '"' + name.replace(/"/g, '""') + '"';
}

/** An identifier as you'd type it: bare when it can be, quoted when not. */
export function ident(engine: DbEngine, name: string): string {
  const bare = engine === "mysql" ? /^[A-Za-z_][A-Za-z0-9_$]*$/ : /^[a-z_][a-z0-9_$]*$/;
  return bare.test(name) ? name : quoteIdent(engine, name);
}

export function tableRef(engine: DbEngine, namespace: string, table: string, current: string | null): string {
  if (namespace === current || (engine === "sqlite" && namespace === "main")) return ident(engine, table);
  return `${ident(engine, namespace)}.${ident(engine, table)}`;
}

export function quoteLiteral(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

const NUMERIC_TYPE = /^(int|integer|bigint|smallint|tinyint|mediumint|serial|bigserial|numeric|decimal|real|double|float|money|oid|year)/i;
const NUMERIC_VALUE = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** Whether a column reads as numbers — right-aligned and tabular in a grid. */
export function isNumericColumn(type: string | null, sample: (string | null)[]): boolean {
  if (type) return NUMERIC_TYPE.test(type);
  let seen = 0;
  for (const v of sample) {
    if (v === null) continue;
    if (!NUMERIC_VALUE.test(v)) return false;
    seen++;
  }
  return seen > 0;
}

export const ENGINE_LABEL: Record<DbEngine, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  sqlite: "SQLite",
};

export const ENGINE_PORT: Record<DbEngine, number | null> = {
  postgres: 5432,
  mysql: 3306,
  sqlite: null,
};

/** Fields of a server URL, for editing one without hand-assembling it. */
export interface UrlParts {
  user: string;
  password: string;
  host: string;
  port: string;
  database: string;
  /** Everything after `?`, kept verbatim. */
  params: string;
}

export function parseUrl(url: string): UrlParts | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^:/?#]*)(?::(\d+))?(?:\/([^?#]*))?(?:\?(.*))?$/i.exec(url.trim());
  if (!m) return null;
  const dec = (s: string | undefined) => {
    if (!s) return "";
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  return {
    user: dec(m[2]),
    password: dec(m[3]),
    host: m[4] ?? "",
    port: m[5] ?? "",
    database: dec(m[6]),
    params: m[7] ?? "",
  };
}

export function buildUrl(engine: DbEngine, p: UrlParts): string {
  const scheme = engine === "mysql" ? "mysql" : "postgres";
  const enc = (s: string) => encodeURIComponent(s).replace(/%24%7B/g, "${").replace(/%7D/g, "}");
  const auth = p.user ? `${enc(p.user)}@` : "";
  const port = p.port ? `:${p.port}` : "";
  const db = p.database ? `/${enc(p.database)}` : "";
  const params = p.params ? `?${p.params}` : "";
  return `${scheme}://${auth}${p.host || "localhost"}${port}${db}${params}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

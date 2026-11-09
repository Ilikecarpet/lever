import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DbResultSet } from "../../types";
import type { PendingEdits, RowRef } from "../../stores/dbStore";
import { isNumericColumn } from "../../lib/sql";
import { useClampToViewport } from "../../hooks/useClampToViewport";
import { usePresence } from "../../hooks/usePresence";
import { IconClose, IconCopy, IconFilter, IconSortAsc, IconSortDesc, IconKey, IconTrash, IconUndo, IconEditLine } from "../Icons";
import menuStyles from "../ContextMenu/ContextMenu.module.css";
import styles from "./DataGrid.module.css";

const ROW_H = 26;
const HEAD_H = 32;
const OVERSCAN = 12;
const MIN_COL = 56;
const MAX_AUTO_COL = 380;
const CHAR_W = 7.3;

export interface SortState {
  column: string;
  descending: boolean;
}

/** What the grid needs to edit a table's rows. Without it, it only reads. */
export interface GridEditing {
  pending: PendingEdits;
  failedRow: RowRef | null;
  /** Columns whose values can't round-trip as text (binary). */
  locked: Set<string>;
  onEdit: (row: RowRef, column: string, value: string | null) => void;
  onRevertCell: (row: RowRef, column: string) => void;
  onToggleDelete: (row: RowRef) => void;
}

interface Props {
  set: DbResultSet;
  /** Column types from the schema, for a table whose driver didn't say. */
  types?: Record<string, string>;
  /** Primary-key columns, marked in the header. */
  keys?: Set<string>;
  /** Server-side sort: when given, clicking a header asks for it. Without
   *  it the grid sorts the rows it already has. */
  sort?: SortState | null;
  onSort?: (column: string) => void;
  /** Number shown on the first row, for a page further into a table. */
  rowOffset?: number;
  /** Narrows a table to rows equal to a cell's value. */
  onFilterValue?: (column: string, value: string | null) => void;
  editing?: GridEditing;
}

interface Cell {
  row: number;
  col: number;
}

/** A row as shown: loaded or added, with pending edits laid over it.
 *  `undefined` is an added row's untouched column, which takes its default. */
interface ViewRow {
  ref: RowRef;
  cells: (string | null | undefined)[];
  changed: boolean[];
  deleted: boolean;
}

function displayValue(v: string | null | undefined): string {
  if (v === undefined) return "DEFAULT";
  if (v === null) return "NULL";
  // One line per row: newlines become a visible mark rather than wrapping.
  return v.length > 400 ? v.slice(0, 400).replace(/\n/g, "↵") + "…" : v.replace(/\n/g, "↵");
}

function compare(a: string | null, b: string | null, numeric: boolean): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (numeric) return Number(a) - Number(b);
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function tsvEscape(v: string | null | undefined): string {
  if (v === null || v === undefined) return "";
  return /[\t\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** A value as JSON would hold it: numbers stay numbers when they are. */
function jsonValue(v: string | null | undefined, numeric: boolean): unknown {
  if (v === null || v === undefined) return null;
  if (numeric && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

function prettyValue(v: string | null | undefined): { text: string; json: boolean } {
  if (v === undefined) return { text: "DEFAULT", json: false };
  if (v === null) return { text: "NULL", json: false };
  const s = v.trim();
  if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
    try {
      return { text: JSON.stringify(JSON.parse(s), null, 2), json: true };
    } catch {}
  }
  return { text: v, json: false };
}

/** The character a point in a cell falls on, so an edit can start where you
 *  clicked rather than with the whole value selected. */
function offsetAt(x: number, y: number, cell: HTMLElement): number | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (pos && cell.contains(pos.offsetNode)) return pos.offset;
  const range = document.caretRangeFromPoint?.(x, y);
  if (range && cell.contains(range.startContainer)) return range.startOffset;
  return null;
}

/** The word around an offset, as a double-click in any text field picks it. */
function wordAt(text: string, at: number): [number, number] {
  const isWord = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch);
  let from = Math.min(at, text.length);
  // A click just past a word's last letter still means that word.
  if (!isWord(text[from]) && isWord(text[from - 1])) from -= 1;
  if (!isWord(text[from])) return [at, at];
  let to = from;
  while (from > 0 && isWord(text[from - 1])) from--;
  while (to < text.length && isWord(text[to])) to++;
  return [from, to];
}

const sameRef = (a: RowRef | null, b: RowRef) => !!a && a.added === b.added && a.index === b.index;

export default function DataGrid({ set, types, keys, sort, onSort, rowOffset = 0, onFilterValue, editing }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 400 });
  const [selected, setSelected] = useState<Cell | null>(null);
  const [inspect, setInspect] = useState(false);
  const [inspDraft, setInspDraft] = useState<string | null>(null);
  /** `sel` is the selection the field opens with: the double-clicked word, or
   *  the caret at the end. */
  const [cellEdit, setCellEdit] = useState<{ row: number; col: number; draft: string; touched: boolean; sel: [number, number] } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; cell: Cell } | null>(null);
  const [localSort, setLocalSort] = useState<SortState | null>(null);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const lastMenu = useRef(menu);
  if (menu) lastMenu.current = menu;
  const menuPresence = usePresence(!!menu);
  const shownMenu = menu ?? lastMenu.current;
  useClampToViewport(menuRef, shownMenu?.x ?? 0, shownMenu?.y ?? 0);

  const columns = set.columns;
  const colKey = columns.map((c) => c.name).join("\u0001");

  const numeric = useMemo(
    () =>
      columns.map((c, i) =>
        isNumericColumn(c.type ?? types?.[c.name] ?? null, set.rows.slice(0, 100).map((r) => r[i]))
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [colKey, set.rows, types]
  );

  // Widths fit the header and the first rows, so most columns need no drag.
  const autoWidths = useMemo(() => {
    return columns.map((c, i) => {
      // The header carries the type and a key mark too; fit them, within reason.
      const type = c.type ?? types?.[c.name] ?? "";
      let chars = c.name.length + 3 + (type ? Math.min(type.length, 14) * 0.85 + 1 : 0) + (keys?.has(c.name) ? 2 : 0);
      for (const r of set.rows.slice(0, 200)) {
        const v = r[i];
        chars = Math.max(chars, v === null ? 4 : Math.min(v.length, 60));
      }
      return Math.round(Math.min(MAX_AUTO_COL, Math.max(MIN_COL, chars * CHAR_W + 22)));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colKey, set.rows, types, keys]);
  const [widths, setWidths] = useState<number[]>(autoWidths);
  const widthsFor = useRef(colKey);
  // A new column set gets fresh widths; a new page of the same columns keeps
  // whatever was dragged.
  if (widthsFor.current !== colKey) {
    widthsFor.current = colKey;
    setWidths(autoWidths);
  }

  const activeSort = onSort ? sort ?? null : localSort;

  // Loaded rows, in display order, by their index in the page — edits are
  // keyed by that index, so they follow a row through a local sort.
  const order = useMemo(() => {
    const idx = set.rows.map((_, i) => i);
    if (onSort || !localSort) return idx;
    const c = columns.findIndex((col) => col.name === localSort.column);
    if (c < 0) return idx;
    idx.sort((a, b) => compare(set.rows[a][c], set.rows[b][c], numeric[c]));
    return localSort.descending ? idx.reverse() : idx;
  }, [set.rows, localSort, onSort, columns, numeric]);

  const pending = editing?.pending;
  const rows: ViewRow[] = useMemo(() => {
    const loaded = order.map((i): ViewRow => {
      const edits = pending?.updates[i];
      return {
        ref: { added: false, index: i },
        cells: columns.map((c, ci) => (edits && c.name in edits ? edits[c.name] : set.rows[i][ci])),
        changed: columns.map((c) => !!edits && c.name in edits),
        deleted: !!pending?.deletes.includes(i),
      };
    });
    const added = (pending?.inserts ?? []).map((r, i): ViewRow => ({
      ref: { added: true, index: i },
      cells: columns.map((c) => (c.name in r ? r[c.name] : undefined)),
      changed: columns.map((c) => c.name in r),
      deleted: false,
    }));
    return [...loaded, ...added];
  }, [order, pending, columns, set.rows]);

  useEffect(() => {
    setSelected(null);
    setInspect(false);
    setCellEdit(null);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [set]);

  // A row added at the bottom comes into view, ready to type into.
  const addedCount = pending?.inserts.length ?? 0;
  const prevAdded = useRef(addedCount);
  useEffect(() => {
    if (addedCount > prevAdded.current) {
      const row = rows.length - 1;
      setSelected({ row, col: 0 });
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
        el?.focus();
      });
    }
    prevAdded.current = addedCount;
  }, [addedCount, rows.length]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport((v) => ({ ...v, height: el.clientHeight })));
    ro.observe(el);
    setViewport({ top: el.scrollTop, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const first = Math.max(0, Math.floor((viewport.top - HEAD_H) / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((viewport.top + viewport.height) / ROW_H) + OVERSCAN);
  const gutter = Math.max(44, String(rowOffset + rows.length).length * 8 + 26);
  const template = `${gutter}px ${widths.map((w) => `${w}px`).join(" ")}`;
  const totalWidth = gutter + widths.reduce((a, b) => a + b, 0);

  const copy = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }, []);

  const rowTsv = (r: number) => rows[r].cells.map(tsvEscape).join("\t");
  const rowJson = (r: number) =>
    JSON.stringify(Object.fromEntries(columns.map((c, i) => [c.name, jsonValue(rows[r].cells[i], numeric[i])])), null, 2);

  const editable = (c: Cell) =>
    !!editing && !!rows[c.row] && !rows[c.row].deleted && !editing.locked.has(columns[c.col].name);
  // A single-line field would flatten line breaks, so those values open in
  // the side panel; everything else, however long, edits in the row.
  const needsPanel = (v: string | null | undefined) => typeof v === "string" && v.includes("\n");

  const openPanel = (c: Cell) => {
    setSelected(c);
    setInspDraft(editable(c) ? rows[c.row].cells[c.col] ?? "" : null);
    setInspect(true);
  };

  const startEdit = (c: Cell, initial?: string, at?: number | null) => {
    if (!editable(c)) return;
    const v = rows[c.row].cells[c.col];
    if (needsPanel(v) && initial === undefined) {
      openPanel(c);
      return;
    }
    setSelected(c);
    const draft = initial ?? v ?? "";
    const sel: [number, number] = at != null && initial === undefined && typeof v === "string" ? wordAt(draft, at) : [draft.length, draft.length];
    setCellEdit({ row: c.row, col: c.col, draft, touched: initial !== undefined, sel });
  };

  const commitEdit = () => {
    if (!cellEdit || !editing) return;
    if (cellEdit.touched) editing.onEdit(rows[cellEdit.row].ref, columns[cellEdit.col].name, cellEdit.draft);
    setCellEdit(null);
    requestAnimationFrame(() => scrollRef.current?.focus());
  };

  const scrollToCell = (c: Cell) => {
    const el = scrollRef.current;
    if (!el) return;
    const top = HEAD_H + c.row * ROW_H;
    if (top - HEAD_H < el.scrollTop) el.scrollTop = top - HEAD_H;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
    const left = gutter + widths.slice(0, c.col).reduce((a, b) => a + b, 0);
    const right = left + widths[c.col];
    if (left - gutter < el.scrollLeft) el.scrollLeft = left - gutter;
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
  };

  const move = (dr: number, dc: number, from = selected) => {
    if (!from) return;
    const next = {
      row: Math.max(0, Math.min(rows.length - 1, from.row + dr)),
      col: Math.max(0, Math.min(columns.length - 1, from.col + dc)),
    };
    setSelected(next);
    scrollToCell(next);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (cellEdit || !selected || rows.length === 0) return;
    const meta = e.metaKey || e.ctrlKey;
    const row = rows[selected.row];
    if (meta && e.key === "c") {
      e.preventDefault();
      copy(e.shiftKey ? rowTsv(selected.row) : row.cells[selected.col] ?? "");
      return;
    }
    if (editing && meta && e.key === "Backspace") {
      e.preventDefault();
      editing.onToggleDelete(row.ref);
      return;
    }
    if (editing && (e.key === "Enter" || e.key === "F2") && editable(selected)) {
      e.preventDefault();
      startEdit(selected);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (inspect) setInspect(false);
      else openPanel(selected);
      return;
    }
    if (e.key === "Escape") {
      if (inspect) setInspect(false);
      else setSelected(null);
      return;
    }
    // Typing over a cell replaces its value, as in a spreadsheet.
    if (editing && !meta && !e.altKey && e.key.length === 1 && editable(selected)) {
      e.preventDefault();
      startEdit(selected, e.key);
      return;
    }
    const steps: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      Tab: [0, e.shiftKey ? -1 : 1],
    };
    const d = steps[e.key];
    if (!d) return;
    e.preventDefault();
    move(d[0] * (meta ? rows.length : 1), d[1] * (meta ? columns.length : 1));
  };

  const startResize = (e: React.MouseEvent, i: number) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[i];
    document.body.style.cursor = "col-resize";
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(MIN_COL, startW + ev.clientX - startX);
      setWidths((ws) => ws.map((x, j) => (j === i ? w : x)));
    };
    const onUp = () => {
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const autoFit = (i: number) => {
    let chars = columns[i].name.length + 4;
    for (const r of rows) chars = Math.max(chars, Math.min(displayValue(r.cells[i]).length, 200));
    setWidths((ws) => ws.map((x, j) => (j === i ? Math.max(MIN_COL, Math.round(chars * CHAR_W + 22)) : x)));
  };

  const headerClick = (name: string) => {
    if (onSort) {
      onSort(name);
      return;
    }
    // Ascending, descending, then back to the order the rows came in.
    setLocalSort((s) =>
      s?.column !== name ? { column: name, descending: false } : s.descending ? null : { column: name, descending: true }
    );
  };

  if (columns.length === 0) return null;

  const sel = selected && rows[selected.row] ? selected : null;
  const selValue = sel ? rows[sel.row].cells[sel.col] : null;
  const pretty = sel ? prettyValue(selValue) : null;
  const panelEditable = !!sel && inspDraft !== null && editable(sel);

  const applyPanel = (value: string | null) => {
    if (!sel || !editing) return;
    editing.onEdit(rows[sel.row].ref, columns[sel.col].name, value);
    setInspDraft(value ?? "");
  };

  return (
    <div className={styles.wrap}>
      <div
        ref={scrollRef}
        className={styles.scroll}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={(e) => {
          const top = e.currentTarget.scrollTop;
          setViewport((v) => (v.top === top ? v : { ...v, top }));
        }}
      >
        <div style={{ width: totalWidth, height: HEAD_H + rows.length * ROW_H, position: "relative" }}>
          <div className={styles.head} style={{ gridTemplateColumns: template, width: totalWidth }}>
            <div className={`${styles.hcell} ${styles.gutterHead}`} />
            {columns.map((c, i) => {
              const type = c.type ?? types?.[c.name] ?? null;
              const sorted = activeSort?.column === c.name;
              return (
                <div
                  key={c.name + i}
                  className={`${styles.hcell}${numeric[i] ? ` ${styles.num}` : ""}${sorted ? ` ${styles.hcellSorted}` : ""}`}
                  onClick={() => headerClick(c.name)}
                  title={type ? `${c.name} · ${type}` : c.name}
                >
                  <span className={styles.hname}>
                    {keys?.has(c.name) && (
                      <span className={styles.hkey}>
                        <IconKey size={10} />
                      </span>
                    )}
                    {c.name}
                  </span>
                  {type && <span className={styles.htype}>{type}</span>}
                  {sorted && (
                    <span className={styles.hsort}>
                      {activeSort!.descending ? <IconSortDesc size={10} /> : <IconSortAsc size={10} />}
                    </span>
                  )}
                  <span
                    className={styles.resize}
                    onMouseDown={(e) => startResize(e, i)}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      autoFit(i);
                    }}
                  />
                </div>
              );
            })}
          </div>

          {rows.slice(first, last).map((r, k) => {
            const ri = first + k;
            const rowSelected = sel?.row === ri;
            const failed = sameRef(editing?.failedRow ?? null, r.ref);
            return (
              <div
                key={r.ref.added ? `a${r.ref.index}` : r.ref.index}
                className={[
                  styles.row,
                  ri % 2 ? styles.rowAlt : "",
                  rowSelected ? styles.rowSelected : "",
                  r.deleted ? styles.rowDeleted : "",
                  r.ref.added ? styles.rowAdded : "",
                  failed ? styles.rowFailed : "",
                ].filter(Boolean).join(" ")}
                style={{ top: HEAD_H + ri * ROW_H, gridTemplateColumns: template, width: totalWidth }}
              >
                <div className={styles.gutter}>
                  {r.ref.added ? <span className={styles.mark}>+</span> : r.deleted ? <span className={styles.mark}>−</span> : rowOffset + r.ref.index + 1}
                </div>
                {r.cells.map((v, ci) => {
                  const isSel = rowSelected && sel?.col === ci;
                  const isEditing = cellEdit?.row === ri && cellEdit.col === ci;
                  return (
                    <div
                      key={ci}
                      className={[
                        styles.cell,
                        numeric[ci] ? styles.num : "",
                        v === null || v === undefined ? styles.null : "",
                        r.changed[ci] ? styles.cellChanged : "",
                        isSel ? styles.cellSelected : "",
                        isEditing ? styles.cellEditing : "",
                      ].filter(Boolean).join(" ")}
                      onMouseDown={(e) => {
                        if (e.button !== 0 || isEditing) return;
                        if (cellEdit) commitEdit();
                        setSelected({ row: ri, col: ci });
                      }}
                      onDoubleClick={(e) => {
                        if (!editing) return openPanel({ row: ri, col: ci });
                        startEdit({ row: ri, col: ci }, undefined, offsetAt(e.clientX, e.clientY, e.currentTarget));
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setSelected({ row: ri, col: ci });
                        setMenu({ x: e.clientX, y: e.clientY, cell: { row: ri, col: ci } });
                      }}
                    >
                      {isEditing ? (
                        <input
                          className={styles.cellInput}
                          autoFocus
                          value={cellEdit.draft}
                          placeholder={v === null ? "NULL" : v === undefined ? "DEFAULT" : ""}
                          spellCheck={false}
                          onFocus={(e) => {
                            const el = e.currentTarget;
                            const [a, b] = cellEdit.sel;
                            el.setSelectionRange(a, b);
                            // Focusing scrolls a long value to its end; a
                            // double-clicked word was visible where it sat, so
                            // the field stays put rather than jumping away.
                            if (b < el.value.length) requestAnimationFrame(() => (el.scrollLeft = 0));
                          }}
                          onChange={(e) => setCellEdit({ ...cellEdit, draft: e.target.value, touched: true })}
                          onBlur={commitEdit}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commitEdit();
                              move(1, 0, { row: ri, col: ci });
                            } else if (e.key === "Tab") {
                              e.preventDefault();
                              commitEdit();
                              move(0, e.shiftKey ? -1 : 1, { row: ri, col: ci });
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              setCellEdit(null);
                              requestAnimationFrame(() => scrollRef.current?.focus());
                            }
                          }}
                        />
                      ) : (
                        displayValue(v)
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {inspect && sel && pretty && (
        <aside className={`${styles.inspector} lv-rise`}>
          <div className={styles.inspHead}>
            <div className={styles.inspTitle}>
              <span className={styles.inspCol}>{columns[sel.col].name}</span>
              <span className={styles.inspMeta}>
                {columns[sel.col].type ?? types?.[columns[sel.col].name] ?? "value"} ·{" "}
                {rows[sel.row].ref.added ? "new row" : `row ${rowOffset + rows[sel.row].ref.index + 1}`}
                {!panelEditable && pretty.json ? " · JSON" : ""}
                {rows[sel.row].changed[sel.col] ? " · edited" : ""}
              </span>
            </div>
            <button className={`${styles.iconBtn} lv-press`} onClick={() => copy(selValue ?? "")} title="Copy value (⌘C)">
              <IconCopy size={12} />
            </button>
            <button className={`${styles.iconBtn} lv-press`} onClick={() => setInspect(false)} title="Close (Esc)">
              <IconClose size={10} />
            </button>
          </div>
          {panelEditable ? (
            <>
              <textarea
                className={styles.inspEdit}
                value={inspDraft ?? ""}
                placeholder={selValue === null ? "NULL" : selValue === undefined ? "DEFAULT" : ""}
                spellCheck={false}
                onChange={(e) => setInspDraft(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    applyPanel(inspDraft ?? "");
                  }
                  if (e.key === "Escape") setInspect(false);
                }}
              />
              <div className={styles.inspActions}>
                <button className={`${styles.inspBtn} lv-press`} onClick={() => applyPanel(null)} disabled={selValue === null}>
                  Set NULL
                </button>
                {rows[sel.row].changed[sel.col] && (
                  <button
                    className={`${styles.inspBtn} lv-press`}
                    onClick={() => {
                      editing!.onRevertCell(rows[sel.row].ref, columns[sel.col].name);
                      setInspect(false);
                    }}
                  >
                    Revert
                  </button>
                )}
                <span className={styles.toolbarSpacer} />
                <button
                  className={`${styles.inspBtn} ${styles.inspBtnPrimary} lv-press`}
                  onClick={() => applyPanel(inspDraft ?? "")}
                  disabled={(inspDraft ?? "") === (selValue ?? "") && selValue !== null}
                >
                  Apply <kbd>⌘↵</kbd>
                </button>
              </div>
            </>
          ) : (
            <>
              <pre className={`${styles.inspBody}${selValue === null || selValue === undefined ? ` ${styles.null}` : ""}`}>{pretty.text}</pre>
              {typeof selValue === "string" && (
                <div className={styles.inspFoot}>{selValue.length.toLocaleString("en-US")} characters</div>
              )}
            </>
          )}
        </aside>
      )}

      {copied && <div className={`${styles.toast} lv-pop`}>Copied</div>}

      {menuPresence.mounted && shownMenu && rows[shownMenu.cell.row] && (
        <div
          ref={menuRef}
          className={`${menuStyles.menu} ${styles.menu} lv-pop${menuPresence.closing ? " lv-closing" : ""}`}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {(() => {
            const cell = shownMenu.cell;
            const row = rows[cell.row];
            const value = row.cells[cell.col];
            const name = columns[cell.col].name;
            const act = (f: () => void) => () => {
              f();
              setMenu(null);
            };
            const canEdit = editable(cell);
            return (
              <>
                {canEdit && (
                  <>
                    <button className={menuStyles.item} onClick={act(() => startEdit(cell))}>
                      <IconEditLine size={12} /> Edit value
                    </button>
                    {value !== null && (
                      <button className={menuStyles.item} onClick={act(() => editing!.onEdit(row.ref, name, null))}>
                        Set to NULL
                      </button>
                    )}
                    {row.changed[cell.col] && (
                      <button className={menuStyles.item} onClick={act(() => editing!.onRevertCell(row.ref, name))}>
                        <IconUndo size={12} /> Revert value
                      </button>
                    )}
                    <div className={menuStyles.divider} />
                  </>
                )}
                <button className={menuStyles.item} onClick={act(() => copy(value ?? ""))}>
                  <IconCopy size={12} /> Copy value
                </button>
                <button className={menuStyles.item} onClick={act(() => copy(rowTsv(cell.row)))}>
                  <IconCopy size={12} /> Copy row
                </button>
                <button className={menuStyles.item} onClick={act(() => copy(rowJson(cell.row)))}>
                  <IconCopy size={12} /> Copy row as JSON
                </button>
                <button
                  className={menuStyles.item}
                  onClick={act(() => copy([name, ...rows.map((r) => tsvEscape(r.cells[cell.col]))].join("\n")))}
                >
                  <IconCopy size={12} /> Copy column
                </button>
                {onFilterValue && !row.ref.added && value !== undefined && (
                  <>
                    <div className={menuStyles.divider} />
                    <button className={menuStyles.item} onClick={act(() => onFilterValue(name, value))}>
                      <IconFilter size={12} /> Only rows where {name} {value === null ? "is NULL" : "is this"}
                    </button>
                  </>
                )}
                <div className={menuStyles.divider} />
                <button className={menuStyles.item} onClick={act(() => openPanel(cell))}>
                  Open value
                </button>
                {editing && (
                  <button
                    className={`${menuStyles.item}${row.deleted ? "" : ` ${menuStyles.danger}`}`}
                    onClick={act(() => editing.onToggleDelete(row.ref))}
                  >
                    {row.deleted ? <IconUndo size={12} /> : <IconTrash size={12} />}
                    {row.deleted ? "Keep row" : row.ref.added ? "Discard new row" : "Delete row"}
                    <span className={styles.menuKbd}>⌘⌫</span>
                  </button>
                )}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}

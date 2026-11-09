import { useEffect, useRef } from "react";
import { EditorState, StateEffect, StateField, Compartment, type Extension } from "@codemirror/state";
import {
  EditorView,
  Decoration,
  type DecorationSet,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  placeholder as placeholderExt,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { sql, PostgreSQL, MySQL, SQLite, type SQLNamespace } from "@codemirror/lang-sql";
import { tags as t } from "@lezer/highlight";
import type { DbEngine, DbSchema } from "../../types";

// ---------------------------------------------------------------------------
// Look: everything from the theme's variables, so the editor changes with
// the app and matches the chat's code blocks token for token.
// ---------------------------------------------------------------------------

const theme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "12.5px",
    backgroundColor: "transparent",
    color: "var(--text)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.65",
    overflow: "auto",
  },
  ".cm-content": { padding: "10px 0", caretColor: "var(--accent)" },
  ".cm-line": { padding: "0 14px 0 6px" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "var(--text-muted)",
    opacity: "0.55",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 14px", minWidth: "34px" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--surface) 55%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-dim)" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--accent-subtle) !important",
  },
  ".cm-selectionMatch": { backgroundColor: "var(--accent-dim)" },
  ".cm-matchingBracket": {
    backgroundColor: "transparent",
    outline: "1px solid var(--border-hover)",
    borderRadius: "2px",
  },
  ".cm-placeholder": { color: "var(--text-muted)", fontStyle: "normal" },
  ".cm-tooltip": {
    border: "none",
    backgroundColor: "var(--surface-raised)",
    borderRadius: "var(--radius-md)",
    boxShadow: "var(--shadow-float)",
    overflow: "hidden",
  },
  ".cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    maxHeight: "260px",
    padding: "4px",
  },
  ".cm-tooltip-autocomplete > ul > li": {
    padding: "3px 8px !important",
    borderRadius: "6px",
    color: "var(--text-dim)",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--surface-hover)",
    color: "var(--text)",
  },
  ".cm-completionDetail": { color: "var(--text-muted)", fontStyle: "normal", marginLeft: "10px" },
  ".cm-completionMatchedText": { textDecoration: "none", color: "var(--accent)" },
  ".cm-completionIcon": { opacity: "0.6", width: "1.4em" },
  ".cm-panels": { backgroundColor: "var(--surface-raised)", color: "var(--text)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-search": { fontFamily: "var(--font-sans)", fontSize: "12px", padding: "6px 10px" },
  ".cm-search input, .cm-search button": {
    fontFamily: "inherit",
    fontSize: "12px",
    borderRadius: "6px",
    border: "1px solid var(--border)",
    backgroundColor: "var(--surface)",
    color: "var(--text)",
    backgroundImage: "none",
  },
  ".cm-searchMatch": { backgroundColor: "var(--yellow-dim)", outline: "1px solid var(--yellow)" },
  ".cm-sqlError": {
    textDecoration: "underline wavy var(--red)",
    textUnderlineOffset: "3px",
    backgroundColor: "var(--red-dim)",
  },
  ".cm-runFlash": {
    backgroundColor: "var(--accent-dim)",
    transition: "background-color 0.6s var(--ease-out)",
  },
});

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "var(--accent)" },
  { tag: [t.string, t.special(t.string)], color: "var(--green)" },
  { tag: [t.number, t.bool, t.null], color: "var(--yellow)" },
  { tag: [t.lineComment, t.blockComment, t.comment], color: "var(--text-muted)", fontStyle: "italic" },
  { tag: [t.typeName, t.standard(t.name)], color: "var(--blue)" },
  { tag: [t.function(t.variableName), t.special(t.name)], color: "var(--accent-hover)" },
  { tag: [t.punctuation, t.separator, t.bracket], color: "var(--text-muted)" },
  { tag: [t.operator], color: "var(--text-dim)" },
  { tag: [t.special(t.variableName), t.labelName], color: "var(--blue)" },
]);

// ---------------------------------------------------------------------------
// Marks: where the server says a statement failed, and which statement ran.
// ---------------------------------------------------------------------------

const setMarks = StateEffect.define<{ error?: [number, number] | null; flash?: [number, number] | null }>();

const marks = StateField.define<{ error: DecorationSet; flash: DecorationSet }>({
  create: () => ({ error: Decoration.none, flash: Decoration.none }),
  update(value, tr) {
    let { error, flash } = value;
    error = error.map(tr.changes);
    flash = flash.map(tr.changes);
    // Editing clears the error: it described text that is no longer there.
    if (tr.docChanged) error = Decoration.none;
    for (const e of tr.effects) {
      if (!e.is(setMarks)) continue;
      if (e.value.error !== undefined) {
        const r = e.value.error;
        error = r && r[1] > r[0] ? Decoration.set([Decoration.mark({ class: "cm-sqlError" }).range(r[0], r[1])]) : Decoration.none;
      }
      if (e.value.flash !== undefined) {
        const r = e.value.flash;
        flash = r && r[1] > r[0] ? Decoration.set([Decoration.mark({ class: "cm-runFlash" }).range(r[0], r[1])]) : Decoration.none;
      }
    }
    return { error, flash };
  },
  provide: (f) => [EditorView.decorations.from(f, (v) => v.error), EditorView.decorations.from(f, (v) => v.flash)],
});

// ---------------------------------------------------------------------------
// Completion from the live schema
// ---------------------------------------------------------------------------

function completionSchema(schema: DbSchema | null): { schema: SQLNamespace; defaultSchema?: string } {
  if (!schema) return { schema: {} };
  const ns: Record<string, Record<string, SQLNamespace>> = {};
  for (const n of schema.namespaces) {
    ns[n.name] = {};
    for (const tbl of n.tables) {
      ns[n.name][tbl.name] = {
        self: { label: tbl.name, type: tbl.kind === "table" ? "class" : "interface", detail: tbl.kind },
        children: tbl.columns.map((c) => ({ label: c.name, type: "property", detail: c.type })),
      };
    }
  }
  return { schema: ns, defaultSchema: schema.current ?? undefined };
}

function language(engine: DbEngine, schema: DbSchema | null): Extension {
  const dialect = engine === "mysql" ? MySQL : engine === "sqlite" ? SQLite : PostgreSQL;
  return sql({ dialect, upperCaseKeywords: true, ...completionSchema(schema) });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface SqlEditorHandle {
  view: EditorView;
}

interface Props {
  value: string;
  engine: DbEngine;
  schema: DbSchema | null;
  onChange: (value: string) => void;
  /** ⌘↵ — the selection, or the statement at the cursor. */
  onRun: () => void;
  /** ⇧⌘↵ — every statement. */
  onRunAll: () => void;
  onReady?: (h: SqlEditorHandle) => void;
  autoFocus?: boolean;
}

export default function SqlEditor({ value, engine, schema, onChange, onRun, onRunAll, onReady, autoFocus }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lang = useRef(new Compartment());
  // Handlers change every render; the editor is built once and reads these.
  const handlers = useRef({ onChange, onRun, onRunAll });
  handlers.current = { onChange, onRun, onRunAll };

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion({ icons: true, activateOnTyping: true }),
          highlightSelectionMatches(),
          placeholderExt("Write SQL — ⌘↵ runs the statement at the cursor, ⇧⌘↵ runs them all"),
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => {
                handlers.current.onRun();
                return true;
              },
            },
            {
              key: "Shift-Mod-Enter",
              run: () => {
                handlers.current.onRunAll();
                return true;
              },
            },
            ...closeBracketsKeymap,
            ...completionKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...defaultKeymap,
            indentWithTab,
          ]),
          lang.current.of(language(engine, schema)),
          syntaxHighlighting(highlight),
          theme,
          marks,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) handlers.current.onChange(u.state.doc.toString());
          }),
          EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
        ],
      }),
    });
    viewRef.current = view;
    onReady?.({ view });
    if (autoFocus) view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Built once; value, schema and engine are synced by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // New tables and columns complete as soon as the schema reloads.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: lang.current.reconfigure(language(engine, schema)) });
  }, [engine, schema]);

  // Text set from outside (history, "open in console") replaces the doc.
  useEffect(() => {
    const view = viewRef.current;
    if (view && view.state.doc.toString() !== value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div ref={host} style={{ height: "100%", minHeight: 0 }} />;
}

/** Underlines where a statement failed and scrolls it into view. */
export function markError(view: EditorView, range: [number, number] | null) {
  const len = view.state.doc.length;
  const r = range ? ([Math.min(range[0], len), Math.min(range[1], len)] as [number, number]) : null;
  view.dispatch({
    effects: [setMarks.of({ error: r }), ...(r ? [EditorView.scrollIntoView(r[0], { y: "nearest" })] : [])],
  });
}

/** Briefly tints the statement that was sent, so you see what ran. */
export function flashRange(view: EditorView, range: [number, number]) {
  view.dispatch({ effects: setMarks.of({ flash: range }) });
  window.setTimeout(() => {
    if (view.dom.isConnected) view.dispatch({ effects: setMarks.of({ flash: null }) });
  }, 450);
}

import { memo, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { highlight } from "../../lib/highlight";
import { IconCheck, IconCopy } from "../Icons";
import styles from "./Chat.module.css";

// ---------------------------------------------------------------------------
// A small Markdown renderer for agent replies.
//
// It builds React elements and never HTML strings: agent output is untrusted
// (it can echo whatever a web page or file said), and this web view can invoke
// Lever's commands, so nothing an agent prints may become markup. Covers what
// agents actually write — headings, lists, quotes, tables, rules, fenced code
// and the inline basics — and leaves everything else as plain text.
// ---------------------------------------------------------------------------

const INLINE =
  /(``[^`][\s\S]*?``|`[^`]+`)|(\*\*[^*]+\*\*)|(~~[^~]+~~)|(\*[^*\s][^*]*\*)|(\b_[^_\s][^_]*_\b)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

const HL = { kw: styles.hlKw, str: styles.hlStr, num: styles.hlNum, com: styles.hlCom, type: styles.hlType, fn: styles.hlFn };

function link(href: string, label: ReactNode, key: string) {
  return (
    <a
      key={key}
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault();
        openUrl(href).catch(() => {});
      }}
    >
      {label}
    </a>
  );
}

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const tok = m[0];
    const key = `${keyBase}-${n++}`;
    if (m[1]) {
      // A double-backtick span holds code that itself contains backticks,
      // padded by a space on each side that is not part of it.
      const fence = tok.startsWith("``") ? 2 : 1;
      let body = tok.slice(fence, -fence);
      if (fence === 2 && body.startsWith(" ") && body.endsWith(" ") && body.trim()) body = body.slice(1, -1);
      out.push(<code key={key}>{body}</code>);
    }
    else if (m[2]) out.push(<strong key={key}>{inline(tok.slice(2, -2), key)}</strong>);
    else if (m[3]) out.push(<del key={key}>{inline(tok.slice(2, -2), key)}</del>);
    else if (m[4] || m[5]) out.push(<em key={key}>{inline(tok.slice(1, -1), key)}</em>);
    else if (m[6]) {
      const close = tok.indexOf("](");
      const label = tok.slice(1, close);
      const href = tok.slice(close + 2, -1);
      out.push(/^https?:\/\//.test(href) ? link(href, inline(label, key), key) : <span key={key}>{label}</span>);
    } else if (m[7]) out.push(link(tok, tok, key));
    last = at + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const splitRow = (line: string) =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

export function CopyButton({ text, label, className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={className ?? styles.iconBtn}
      title="Copy"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        });
      }}
    >
      {done ? <IconCheck size={12} /> : <IconCopy size={12} />}
      {label && <span>{done ? "Copied" : label}</span>}
    </button>
  );
}

export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeHead}>
        <span>{lang || "code"}</span>
        <CopyButton text={code} label="Copy" className={styles.codeCopy} />
      </div>
      <pre>
        <code>{highlight(code, lang, HL)}</code>
      </pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  const key = () => `b${k++}`;

  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)/);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i += 1;
      blocks.push(<CodeBlock key={key()} code={body.join("\n")} lang={fence[2]} />);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      // Headings sit inside a pane, not a page: h1 renders at h3 size.
      const Tag = (["h3", "h4", "h5", "h6", "h6", "h6"] as const)[heading[1].length - 1];
      const kk = key();
      blocks.push(<Tag key={kk}>{inline(heading[2], kk)}</Tag>);
      i += 1;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr key={key()} />);
      i += 1;
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(splitRow(lines[i++]));
      const kk = key();
      blocks.push(
        <div key={kk} className={styles.tableWrap}>
          <table>
            <thead>
              <tr>{head.map((c, j) => <th key={j}>{inline(c, `${kk}h${j}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c, `${kk}r${ri}c${j}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    const listMatch = line.match(/^(\s*)([-*+]|\d+[.)])\s+/);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[2]);
      const start = ordered ? parseInt(listMatch[2], 10) : undefined;
      const items: { text: string; sub: string[] }[] = [];
      const baseIndent = listMatch[1].length;
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (m && m[1].length <= baseIndent && /\d/.test(m[2]) === ordered) {
          items.push({ text: m[3], sub: [] });
        } else if (items.length && (m || /^\s{2,}\S/.test(lines[i]))) {
          items[items.length - 1].sub.push(lines[i].slice(Math.min(baseIndent + 2, lines[i].search(/\S/))));
        } else break;
        i += 1;
      }
      const kk = key();
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List key={kk} start={start !== 1 ? start : undefined}>
          {items.map((it, j) => {
            const task = it.text.match(/^\[([ xX])\]\s+(.*)$/);
            return (
              <li key={j} className={task ? styles.taskItem : undefined}>
                {task ? (
                  <>
                    <span className={styles.taskBox} data-done={task[1] !== " "} />
                    {inline(task[2], `${kk}-${j}`)}
                  </>
                ) : (
                  inline(it.text, `${kk}-${j}`)
                )}
                {it.sub.length > 0 && <Markdown text={it.sub.join("\n")} />}
              </li>
            );
          })}
        </List>
      );
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push(
        <blockquote key={key()}>
          <Markdown text={quote.join("\n")} />
        </blockquote>
      );
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(```|~~~|#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\|)/.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    if (para.length === 0) para.push(lines[i++]);
    const kk = key();
    blocks.push(<p key={kk}>{inline(para.join("\n"), kk)}</p>);
  }

  return <>{blocks}</>;
});

import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// Syntax colouring for code in chat replies.
//
// One tokenizer for the C-family, shell, Python, Rust, Go, JSON, YAML and
// friends: comments, strings, numbers, keywords and the odd type name. It is
// not a parser and does not try to be — the aim is code that reads as code at
// a glance, without shipping a grammar per language. Output is React text
// nodes, never HTML.
// ---------------------------------------------------------------------------

const KEYWORDS = new Set(
  (
    "as async await break case catch class const continue crate def default defer del do elif else enum " +
    "except export extends false fi final finally fn for from func function go if impl import in interface " +
    "let loop match mod module mut new nil none null package pass pub raise return self static struct super " +
    "switch then this throw trait true try type typeof undefined unsafe use var void where while with yield " +
    "lambda not and or is echo local readonly done esac"
  ).split(" ")
);

const HASH_COMMENT = new Set(["sh", "bash", "zsh", "shell", "console", "py", "python", "rb", "ruby", "yaml", "yml", "toml", "dockerfile", "make", "makefile", "r"]);

type Tok = { cls: "kw" | "str" | "num" | "com" | "type" | "fn" | null; text: string };

function tokenize(code: string, lang: string): Tok[] {
  const hash = HASH_COMMENT.has(lang);
  const slash = !hash || lang === "";
  const toks: Tok[] = [];
  let i = 0;
  let plain = "";
  const flush = () => {
    if (plain) toks.push({ cls: null, text: plain });
    plain = "";
  };
  while (i < code.length) {
    const c = code[i];
    const rest = code.slice(i, i + 2);
    // comments
    if ((slash && rest === "//") || (hash && c === "#" && (i === 0 || /\s/.test(code[i - 1])))) {
      const end = code.indexOf("\n", i);
      flush();
      toks.push({ cls: "com", text: code.slice(i, end < 0 ? code.length : end) });
      i = end < 0 ? code.length : end;
      continue;
    }
    if (slash && rest === "/*") {
      const end = code.indexOf("*/", i + 2);
      const stop = end < 0 ? code.length : end + 2;
      flush();
      toks.push({ cls: "com", text: code.slice(i, stop) });
      i = stop;
      continue;
    }
    // strings
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== c) {
        if (code[j] === "\\") j++;
        if (code[j] === "\n" && c !== "`") break;
        j++;
      }
      flush();
      toks.push({ cls: "str", text: code.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    // numbers
    if (/[0-9]/.test(c) && !/[\w$]/.test(code[i - 1] ?? "")) {
      const m = code.slice(i).match(/^(0x[\da-f_]+|\d[\d_]*(\.\d+)?(e[+-]?\d+)?)/i);
      if (m) {
        flush();
        toks.push({ cls: "num", text: m[0] });
        i += m[0].length;
        continue;
      }
    }
    // words
    if (/[A-Za-z_$]/.test(c)) {
      const m = code.slice(i).match(/^[A-Za-z_$][\w$]*/)!;
      const w = m[0];
      const next = code[i + w.length];
      flush();
      if (KEYWORDS.has(w)) toks.push({ cls: "kw", text: w });
      else if (/^[A-Z][a-z]/.test(w)) toks.push({ cls: "type", text: w });
      else if (next === "(") toks.push({ cls: "fn", text: w });
      else toks.push({ cls: null, text: w });
      i += w.length;
      continue;
    }
    plain += c;
    i++;
  }
  flush();
  return toks;
}

/** Languages not worth colouring: prose and plain output. */
const PLAIN = new Set(["text", "txt", "plain", "markdown", "md", "diff", "log", "output"]);

export function highlight(code: string, lang: string, classes: Record<string, string>): ReactNode[] {
  const l = lang.toLowerCase();
  if (PLAIN.has(l) || code.length > 60_000) return [code];
  return tokenize(code, l).map((t, i) => (t.cls ? <span key={i} className={classes[t.cls]}>{t.text}</span> : t.text));
}

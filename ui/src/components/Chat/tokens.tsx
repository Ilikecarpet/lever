import type { ReactNode } from "react";

/** `@path` mentions and `/command`s, each starting a word and ending one. */
const TOKEN = /(^|\s)(\/([\w:.-]+)|@[\w./-]+)(?=\s|$)/g;

/** Text with its mentions and commands wrapped for colouring. With
 *  `commands`, only those names count as commands. */
export function renderTokens(text: string, className: string, commands?: Set<string>): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m[3] !== undefined && commands && !commands.has(m[3])) continue;
    const at = (m.index ?? 0) + m[1].length;
    if (at > last) out.push(text.slice(last, at));
    out.push(
      <mark key={at} className={className}>
        {m[2]}
      </mark>
    );
    last = at + m[2].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

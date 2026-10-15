import { useEffect, useLayoutEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle } from "react";
import * as api from "../../lib/tauri";
import type { Chat, ChatState, ImageAttachment } from "../../lib/acpChat";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { IconAt, IconClose, IconFile, IconPaperclip, IconSend, IconSlash, IconStop } from "../Icons";
import { PickerMenu, type MenuItem } from "./Menu";
import styles from "./Chat.module.css";

/** What each permission mode is worth flagging as, at a glance. */
export const MODE_TONE: Record<string, string> = {
  auto: "var(--accent)",
  default: "var(--text-dim)",
  acceptEdits: "var(--blue)",
  plan: "var(--green)",
  dontAsk: "var(--yellow)",
  bypassPermissions: "var(--red)",
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

/** Something going out with the next message: an image the agent will see,
 *  or a file on disk it is pointed at and can open itself. */
type Attachment =
  | ({ kind: "image" } & ImageAttachment)
  | { kind: "file"; path: string; name: string };

export interface ComposerHandle {
  setDraft: (text: string) => void;
  focus: () => void;
}

type Suggest =
  | { type: "slash"; query: string; items: { name: string; description?: string }[] }
  | { type: "file"; query: string; start: number; items: string[] };

/** Fuzzy match a path: every query character in order, scored so filename
 *  hits and runs of adjacent matches come first. */
function score(path: string, q: string): number {
  if (!q) return 1;
  const p = path.toLowerCase();
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (base.startsWith(q)) return 1000 - p.length;
  if (base.includes(q)) return 800 - p.length;
  if (p.includes(q)) return 600 - p.length;
  let i = 0;
  let run = 0;
  let s = 0;
  for (const ch of p) {
    if (ch === q[i]) {
      i++;
      run++;
      s += run * 2;
      if (i === q.length) return s - p.length / 10;
    } else run = 0;
  }
  return -1;
}

export const Composer = forwardRef<ComposerHandle, {
  chat: Chat;
  state: ChatState;
  cwd: string;
  centered?: boolean;
  placeholder?: string;
  /** The chat in front of the user: the one a file dropped on the window is for. */
  active?: boolean;
  /** Esc pressed twice in quick succession, as in Claude Code: rewind. */
  onDoubleEscape?: () => void;
}>(function Composer({ chat, state, cwd, centered, placeholder, active, onDoubleEscape }, ref) {
  const lastEscape = useRef(0);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [files, setFiles] = useState<string[] | null>(null);
  const [historyAt, setHistoryAt] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [launch, setLaunch] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    setDraft: (t: string) => {
      setDraft(t);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(t.length, t.length);
        setCaret(t.length);
      });
    },
    focus: () => inputRef.current?.focus(),
  }));

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [draft]);

  const working = state.status === "working";
  const canSend = (state.status === "ready" || working) && (draft.trim().length > 0 || attachments.length > 0);

  // --- suggestions ---------------------------------------------------------

  const before = draft.slice(0, caret);
  const fileQuery = before.match(/(^|\s)@([\w./-]*)$/);
  const slashQuery = draft.match(/^\/(\S*)$/);

  useEffect(() => {
    if (fileQuery && files === null) {
      setFiles([]);
      api.acpListFiles(cwd).then(setFiles).catch(() => setFiles([]));
    }
  }, [!!fileQuery, files, cwd]);

  const suggest: Suggest | null = useMemo(() => {
    if (slashQuery && state.commands.length) {
      const q = slashQuery[1].toLowerCase();
      const items = state.commands.filter((c) => c.name.toLowerCase().includes(q))
        .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
        .slice(0, 8);
      return items.length ? { type: "slash", query: q, items } : null;
    }
    if (fileQuery && files) {
      const q = fileQuery[2].toLowerCase();
      const items = files
        .map((f) => [f, score(f, q)] as const)
        .filter(([, s]) => s >= 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([f]) => f);
      return items.length ? { type: "file", query: q, start: caret - fileQuery[2].length - 1, items } : null;
    }
    return null;
  }, [slashQuery?.[1], fileQuery?.[2], files, state.commands, caret]);

  const suggestKey = suggest ? `${suggest.type}:${suggest.query}` : null;
  const showSuggest = suggest && dismissed !== suggestKey;

  useEffect(() => setPick(0), [suggestKey]);

  const accept = (i: number) => {
    if (!suggest) return;
    if (suggest.type === "slash") {
      const t = `/${suggest.items[i].name} `;
      setDraft(t);
      setCaret(t.length);
    } else {
      const path = suggest.items[i];
      const t = `${draft.slice(0, suggest.start)}@${path} ${draft.slice(caret)}`;
      const at = suggest.start + path.length + 2;
      setDraft(t);
      requestAnimationFrame(() => {
        inputRef.current?.setSelectionRange(at, at);
        setCaret(at);
      });
    }
  };

  // --- attachments ---------------------------------------------------------

  const failAttach = (msg: string) => {
    setAttachError(msg);
    setTimeout(() => setAttachError((m) => (m === msg ? null : m)), 5000);
  };

  /** Images pasted from the clipboard arrive as bytes, with no path. */
  const addImageFiles = (list: FileList | File[]) => {
    for (const f of Array.from(list)) {
      if (!f.type.startsWith("image/")) continue;
      if (f.size > MAX_IMAGE_BYTES) {
        failAttach(`${f.name || "That image"} is over 5 MB.`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result);
        const data = url.slice(url.indexOf(",") + 1);
        setAttachments((l) => [...l, { kind: "image", mimeType: f.type, data, name: f.name || "Pasted image" }]);
      };
      reader.readAsDataURL(f);
    }
  };

  /** Files picked or dropped arrive as paths: images are read so the agent
   *  sees them; anything else goes as a reference it can open. */
  const addPaths = async (paths: string[]) => {
    for (const path of paths) {
      const name = path.split("/").pop() ?? path;
      if (attachmentsRef.current.some((a) => a.kind === "file" && a.path === path)) continue;
      if (IMAGE_EXT.test(path)) {
        try {
          const img = await api.acpReadImage(path);
          setAttachments((l) => [...l, { kind: "image", ...img, name }]);
        } catch (e) {
          failAttach(String(e));
        }
      } else {
        setAttachments((l) => [...l, { kind: "file", path, name }]);
      }
    }
    inputRef.current?.focus();
  };
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const pickFiles = async () => {
    try {
      const picked = await openDialog({ multiple: true, directory: false, defaultPath: cwd, title: "Attach files" });
      if (!picked) return;
      addPaths(Array.isArray(picked) ? picked : [picked]);
    } catch (e) {
      failAttach(`Could not open the file picker: ${e}`);
    }
  };

  // The window, not the page, receives files dropped from Finder: Tauri
  // hands them over as paths. Only the chat in front takes them.
  const addPathsRef = useRef(addPaths);
  addPathsRef.current = addPaths;
  useEffect(() => {
    if (!active) return;
    let unlisten: (() => void) | undefined;
    let live = true;
    const over = (x: number, y: number) => {
      const r = composerRef.current?.closest("[data-chat-drop]")?.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      const px = x / ratio;
      const py = y / ratio;
      return !!r && px >= r.left && px <= r.right && py >= r.top && py <= r.bottom;
    };
    let webview: ReturnType<typeof getCurrentWebview>;
    try {
      webview = getCurrentWebview();
    } catch {
      return; // not running inside Lever's window: no native drops to take
    }
    webview
      .onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === "over") setDragging(over(p.position.x, p.position.y));
        else if (p.type === "leave") setDragging(false);
        else if (p.type === "drop") {
          setDragging(false);
          if (over(p.position.x, p.position.y) && p.paths.length) addPathsRef.current(p.paths);
        }
      })
      .then((fn) => {
        if (live) unlisten = fn;
        else fn();
      })
      .catch(() => {});
    return () => {
      live = false;
      unlisten?.();
    };
  }, [active]);

  // --- sending -------------------------------------------------------------

  const send = () => {
    if (!canSend) return;
    const known = new Set(files ?? []);
    const mentioned = [...draft.matchAll(/(^|\s)@([\w./-]+)/g)].map((m) => m[2]).filter((p) => known.has(p));
    chat.prompt(draft, {
      images: attachments.filter((a): a is Extract<Attachment, { kind: "image" }> => a.kind === "image"),
      paths: attachments.flatMap((a) => (a.kind === "file" ? [a.path] : [])),
      files: [...new Set(mentioned)],
    });
    // The arrow flies off; the class comes off again once it has.
    setLaunch((n) => n + 1);
    setTimeout(() => setLaunch(0), 420);
    setDraft("");
    setAttachments([]);
    setCaret(0);
    setHistoryAt(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (showSuggest && suggest) {
      const n = suggest.items.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setPick((p) => (p + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && suggest.type === "file")) {
        e.preventDefault();
        accept(pick);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(suggestKey);
        return;
      }
    }
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      chat.cycleMode();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
      return;
    }
    if (e.key === "Escape" && working) {
      e.preventDefault();
      chat.cancel();
      return;
    }
    if (e.key === "Escape" && onDoubleEscape) {
      e.preventDefault();
      const now = Date.now();
      if (now - lastEscape.current < 500) {
        lastEscape.current = 0;
        onDoubleEscape();
      } else {
        lastEscape.current = now;
      }
      return;
    }
    // Walk back through what was sent, as a shell does, while the draft is
    // either empty or itself a recalled message.
    const recalled = historyAt !== null && draft === chat.sent[historyAt];
    if (e.key === "ArrowUp" && (draft === "" || recalled) && chat.sent.length) {
      e.preventDefault();
      const at = historyAt === null ? chat.sent.length - 1 : Math.max(0, historyAt - 1);
      setHistoryAt(at);
      setDraft(chat.sent[at]);
      return;
    }
    if (e.key === "ArrowDown" && recalled) {
      e.preventDefault();
      if (historyAt! >= chat.sent.length - 1) {
        setHistoryAt(null);
        setDraft("");
      } else {
        setHistoryAt(historyAt! + 1);
        setDraft(chat.sent[historyAt! + 1]);
      }
    }
  };

  // --- toolbar -------------------------------------------------------------

  const option = (id: string) => state.configOptions.find((o) => o.id === id && o.type === "select");
  const mode = option("mode");
  const model = option("model");
  const effort = option("effort");
  const items = (o: NonNullable<ReturnType<typeof option>>, tones?: Record<string, string>): MenuItem[] =>
    o.options.map((x) => ({ value: x.value, label: x.name, description: x.description, tone: tones?.[x.value] }));

  return (
    <div
      ref={composerRef}
      className={`${styles.composer}${centered ? ` ${styles.composerCentered}` : ""}${dragging ? ` ${styles.composerDrag}` : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        addImageFiles(e.dataTransfer.files);
      }}
      onMouseDown={(e) => {
        if (!(e.target as HTMLElement).closest("button, textarea, [role=listbox]")) {
          e.preventDefault();
          inputRef.current?.focus();
        }
      }}
    >
      {showSuggest && suggest && (
        <div className={styles.suggest} role="listbox">
          <div className={styles.menuHeading}>
            {suggest.type === "slash" ? "Commands" : "Files"}
            <span className={styles.suggestKeys}>↑↓ to move · tab to {suggest.type === "slash" ? "complete" : "insert"}</span>
          </div>
          {suggest.type === "slash"
            ? suggest.items.map((c, i) => (
                <button
                  key={c.name}
                  className={`${styles.suggestItem}${i === pick ? ` ${styles.menuItemHover}` : ""}`}
                  onMouseEnter={() => setPick(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    accept(i);
                  }}
                >
                  <span className={styles.suggestIcon}><IconSlash size={12} /></span>
                  <span className={styles.suggestName}>/{c.name}</span>
                  {c.description && <span className={styles.suggestDesc}>{c.description}</span>}
                </button>
              ))
            : suggest.items.map((f, i) => {
                const slash = f.lastIndexOf("/");
                return (
                  <button
                    key={f}
                    className={`${styles.suggestItem}${i === pick ? ` ${styles.menuItemHover}` : ""}`}
                    onMouseEnter={() => setPick(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      accept(i);
                    }}
                  >
                    <span className={styles.suggestIcon}><IconAt size={12} /></span>
                    <span className={styles.suggestName}>{f.slice(slash + 1)}</span>
                    <span className={styles.suggestDesc}>{slash > 0 ? f.slice(0, slash) : ""}</span>
                  </button>
                );
              })}
        </div>
      )}

      {dragging && <div className={styles.dropHint}>Drop to attach</div>}

      {attachments.length > 0 && (
        <div className={styles.attachments}>
          {attachments.map((a, i) =>
            a.kind === "image" ? (
              <div key={i} className={styles.thumb} title={a.name}>
                <img src={`data:${a.mimeType};base64,${a.data}`} alt={a.name ?? "image"} />
                <button className={styles.thumbRemove} title="Remove" onClick={() => setAttachments((l) => l.filter((_, j) => j !== i))}>
                  <IconClose size={8} />
                </button>
              </div>
            ) : (
              <div key={i} className={styles.fileChip} title={a.path}>
                <IconFile size={13} />
                <span className={styles.fileChipName}>{a.name}</span>
                <button className={styles.fileChipRemove} title="Remove" onClick={() => setAttachments((l) => l.filter((_, j) => j !== i))}>
                  <IconClose size={8} />
                </button>
              </div>
            )
          )}
        </div>
      )}
      {attachError && <div className={styles.attachError}>{attachError}</div>}

      <textarea
        ref={inputRef}
        className={styles.input}
        rows={centered ? 2 : 1}
        value={draft}
        placeholder={
          state.status === "exited"
            ? "The agent stopped. Restart it above to keep going."
            : working
              ? "Queue a follow-up…"
              : placeholder ?? "Ask anything, @ to mention a file, / for commands"
        }
        disabled={state.status === "exited" || state.status === "auth"}
        onChange={(e) => {
          setDraft(e.target.value);
          setCaret(e.target.selectionStart);
          setHistoryAt(null);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          const imgs = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
          if (imgs.length) {
            e.preventDefault();
            addImageFiles(imgs);
          }
        }}
        spellCheck={false}
      />

      <div className={styles.toolbar}>
        <button className={styles.toolBtn} title="Attach files or images (or drop them here)" onClick={pickFiles}>
          <IconPaperclip size={14} />
        </button>
        {mode && (
          <PickerMenu
            heading="Permissions  ·  ⇧Tab to cycle"
            items={items(mode, MODE_TONE)}
            value={mode.currentValue}
            onChange={(v) => chat.setOption("mode", v)}
            title="Permission mode (⇧Tab)"
          />
        )}
        <span className={styles.spacer} />
        {model && (
          <PickerMenu heading="Model" items={items(model)} value={model.currentValue} onChange={(v) => chat.setOption("model", v)} align="right" />
        )}
        {effort && (
          <PickerMenu heading="Effort" items={items(effort)} value={effort.currentValue} onChange={(v) => chat.setOption("effort", v)} align="right" />
        )}
        {state.usage && state.usage.size > 0 && <ContextRing used={state.usage.used} size={state.usage.size} cost={state.usage.cost} />}
        {/* One button that turns from send into stop and back, rather than
            two swapping places. */}
        <button
          className={`${styles.sendBtn}${working && !canSend ? ` ${styles.stopBtn}` : ""}${launch ? ` ${styles.launch}` : ""}`}
          onClick={working && !canSend ? () => chat.cancel() : send}
          disabled={!(working && !canSend) && !canSend}
          title={working && !canSend ? "Stop (Esc)" : working ? "Queue (Enter)" : "Send (Enter)"}
        >
          <span className={styles.sendIcon}>
            <IconSend size={13} />
          </span>
          <span className={styles.stopIcon}>
            <IconStop size={9} />
          </span>
        </button>
      </div>
    </div>
  );
});

function ContextRing({ used, size, cost }: { used: number; size: number; cost?: number }) {
  const pct = Math.min(1, used / size);
  const r = 7;
  const c = 2 * Math.PI * r;
  const tone = pct > 0.85 ? "var(--red)" : pct > 0.6 ? "var(--yellow)" : "var(--text-dim)";
  return (
    <span
      className={styles.ring}
      title={`Context: ${used.toLocaleString()} of ${size.toLocaleString()} tokens (${Math.round(pct * 100)}%)${cost != null ? `\nSession cost: $${cost.toFixed(2)}` : ""}`}
    >
      <svg width="18" height="18" viewBox="0 0 18 18">
        <circle cx="9" cy="9" r={r} fill="none" stroke="var(--border-hover)" strokeWidth="2" />
        <circle
          cx="9"
          cy="9"
          r={r}
          fill="none"
          stroke={tone}
          strokeWidth="2"
          strokeDasharray={`${c * pct} ${c}`}
          strokeLinecap="round"
          transform="rotate(-90 9 9)"
        />
      </svg>
      <span className={styles.ringPct}>{Math.round(pct * 100)}%</span>
    </span>
  );
}

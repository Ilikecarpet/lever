import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AGENTS,
  ensureChat,
  fileChanges,
  useChatState,
  type AgentId,
  type Chat,
  type ChatItem,
  type ChatState,
  type SessionSummary,
  shortenPaths,
} from "../../lib/acpChat";
import { useGitStore, MAIN_GIT_TARGET } from "../../stores/gitStore";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { useSettingsStore, FONT_SIZE_DEFAULT } from "../../stores/settingsStore";
import { IconUndo, IconPanelNarrow, IconPanelWiden, IconArrowDown, IconBranch, IconChat, IconChevronRight, IconClock, IconDiff, IconRetry, IconSearch } from "../Icons";
import { Composer, type ComposerHandle } from "./Composer";
import { Transcript, Diff, DiffStat, CwdContext, Collapse, formatDuration } from "./Transcript";
import { CodeBlock } from "./Markdown";
import { AgentLogo } from "./AgentLogo";
import styles from "./Chat.module.css";

const COLUMN_DEFAULT = 760;
const COLUMN_MIN = 480;
const COLUMN_KEY = "lever-chat-column-width";

function readColumnWidth(): number {
  try {
    const v = Number(localStorage.getItem(COLUMN_KEY));
    if (Number.isFinite(v) && v >= COLUMN_MIN) return v;
  } catch {}
  return COLUMN_DEFAULT;
}

/**
 * How wide the conversation runs, dragged by a handle on its right edge and
 * remembered across chats. The column stays centred, so the handle moves by
 * half what the column grows. Double-click puts it back.
 */
function useColumnWidth(mainRef: React.RefObject<HTMLDivElement>) {
  const [width, setWidth] = useState(readColumnWidth);
  const [mainWidth, setMainWidth] = useState(0);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const measure = () => setMainWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [mainRef]);

  const shown = mainWidth ? Math.min(width, mainWidth) : width;

  const save = (w: number) => {
    try {
      localStorage.setItem(COLUMN_KEY, String(Math.round(w)));
    } catch {}
  };

  const onHandleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = mainRef.current;
    if (!el) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const centre = rect.left + rect.width / 2;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    setDragging(true);
    let last = width;
    const move = (ev: PointerEvent) => {
      last = Math.max(COLUMN_MIN, Math.min(2 * (ev.clientX - centre), rect.width));
      setWidth(last);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      setDragging(false);
      save(last);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  const reset = () => {
    setWidth(COLUMN_DEFAULT);
    save(COLUMN_DEFAULT);
  };

  return { width: shown, mainWidth, dragging, onHandleDown, reset };
}

/** The branch checked out where this chat runs. */
function useBranch(worktreeId: string | null): string | undefined {
  const worktree = useWorktreeStore((s) => (worktreeId ? s.worktrees.find((w) => w.id === worktreeId) : undefined));
  const mainBranch = useGitStore((s) => s.gitInfo?.current_branch);
  return worktreeId ? worktree?.branch : mainBranch;
}

export default function ChatView({
  paneId,
  cwd,
  worktreeId,
  isActive,
  init,
}: {
  paneId: string;
  cwd: string;
  worktreeId: string | null;
  isActive: boolean;
  init?: { agent?: AgentId; resumeSessionId?: string };
}) {
  const chat = useMemo(() => ensureChat(paneId, cwd, init), [paneId, cwd]);
  const state = useChatState(chat);
  const composer = useRef<ComposerHandle>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [showChanges, setShowChanges] = useState(false);
  const mainRef = useRef<HTMLDivElement>(null);
  const column = useColumnWidth(mainRef);
  // The width grabber shows only when the pointer comes near the edge it sits on.
  const [nearEdge, setNearEdge] = useState(false);
  const onMainMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = mainRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const edge = r.left + r.width / 2 + column.width / 2;
    const near = Math.abs(e.clientX - edge) < 48;
    if (near !== nearEdge) setNearEdge(near);
  };
  // Settings → Type size scales the chat as it does terminals; the chat's
  // sizes are drawn for the default.
  const zoom = useSettingsStore((s) => s.terminalFontSize) / FONT_SIZE_DEFAULT;
  const branch = useBranch(worktreeId);

  useEffect(() => {
    chat.watched = isActive;
    if (isActive) composer.current?.focus();
  }, [chat, isActive]);

  // Follow the conversation while the reader is at the bottom; leave them be
  // once they scroll up to read something.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [state.items, state.status]);

  const changes = useMemo(() => fileChanges(state.items, cwd), [state.items, cwd]);
  const totals = useMemo(
    () => changes.reduce((t, c) => ({ added: t.added + c.added, removed: t.removed + c.removed }), { added: 0, removed: 0 }),
    [changes]
  );
  const waiting = state.items.filter((i): i is Extract<ChatItem, { kind: "permission" }> => i.kind === "permission" && !i.outcome);
  const pending = waiting[0];
  // Rewinding: picking which message to go back to, then how far.
  const [rewind, setRewind] = useState<{ step: "pick" } | { step: "confirm"; id: string } | null>(null);
  const canRewind = state.canFork && state.status === "ready" && state.items.some((i) => i.kind === "user");
  const doRewind = async (id: string, code: boolean) => {
    setRewind(null);
    const text = await chat.rewind(id, { code });
    if (text != null) composer.current?.setDraft(text);
  };
  const empty = state.items.length === 0 && !state.loading;
  const working = state.status === "working";

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinned.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  return (
    <CwdContext.Provider value={cwd}>
    <div className={styles.chat} data-chat-drop>
      <Header
        chat={chat}
        state={state}
        changes={changes.length}
        totals={totals}
        showChanges={showChanges}
        onToggleChanges={() => setShowChanges((s) => !s)}
        empty={empty}
        branch={branch}
      />

      <div className={styles.chatBody}>
        <div
          className={`${styles.chatMain}${column.dragging ? ` ${styles.chatMainResizing}` : ""}`}
          ref={mainRef}
          onMouseMove={onMainMove}
          onMouseLeave={() => setNearEdge(false)}
          style={{ "--chat-zoom": zoom, "--chat-col": `${column.width}px` } as React.CSSProperties}
        >
          {!empty && column.mainWidth > COLUMN_MIN + 40 && (
            <div
              className={`${styles.columnHandle}${nearEdge || column.dragging ? ` ${styles.columnHandleShown}` : ""}`}
              style={{ left: `calc(50% + ${column.width / 2}px - 4px)` }}
              onPointerDown={column.onHandleDown}
              onDoubleClick={column.reset}
              role="separator"
              aria-orientation="vertical"
              title="Drag to widen the conversation · double-click to reset"
            />
          )}
          {empty ? (
            <Welcome chat={chat} state={state} cwd={cwd} branch={branch} composer={composer} active={isActive} />
          ) : (
            <>
              <div
                className={styles.scroller}
                ref={scrollRef}
                onScroll={(e) => {
                  const el = e.currentTarget;
                  const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
                  pinned.current = bottom;
                  setAtBottom(bottom);
                }}
              >
                <div className={styles.column}>
                  {state.loading && <div className={styles.loadingHistory}>Loading conversation…</div>}
                  <Transcript
                    items={state.items}
                    working={working}
                    turnStartedAt={state.turnStartedAt}
                    onEdit={(t) => composer.current?.setDraft(t)}
                    onRewind={canRewind ? (id) => setRewind({ step: "confirm", id }) : undefined}
                  />
                  {state.status === "exited" && (
                    <div className={styles.exitedCard}>
                      <span>{AGENTS[state.agent].name} stopped running.</span>
                      <button className={styles.secondaryBtn} onClick={() => chat.switchAgent(state.agent)}>
                        <IconRetry size={12} /> Start a new chat
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div className={styles.dock}>
                <div className={styles.column}>
                  {!atBottom && (
                    <button className={styles.jumpBtn} onClick={scrollToBottom} title="Jump to latest">
                      <IconArrowDown size={13} />
                    </button>
                  )}
                  <PlanCard state={state} />
                  {pending && <PermissionDock key={pending.id} chat={chat} item={pending} queued={waiting.length - 1} agent={AGENTS[state.agent].name} cwd={cwd} />}
                  {rewind && canRewind && (
                    <RewindDock
                      chat={chat}
                      state={state}
                      step={rewind}
                      onPick={(id) => setRewind({ step: "confirm", id })}
                      onChoose={doRewind}
                      onClose={() => {
                        setRewind(null);
                        composer.current?.focus();
                      }}
                    />
                  )}
                  <Composer
                    ref={composer}
                    chat={chat}
                    state={state}
                    cwd={cwd}
                    active={isActive}
                    onDoubleEscape={canRewind ? () => setRewind({ step: "pick" }) : undefined}
                  />
                  <div className={styles.footnote}>
                    {AGENTS[state.agent].name} can make mistakes and acts on this checkout. Review its changes before you commit.
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {showChanges && changes.length > 0 && (
          <ChangesPanel changes={changes} totals={totals} worktreeId={worktreeId} cwd={cwd} onClose={() => setShowChanges(false)} />
        )}
      </div>
    </div>
    </CwdContext.Provider>
  );
}

// ---------------------------------------------------------------------------

function Header({
  chat,
  state,
  changes,
  totals,
  showChanges,
  onToggleChanges,
  empty,
  branch,
}: {
  chat: Chat;
  state: ChatState;
  changes: number;
  totals: { added: number; removed: number };
  showChanges: boolean;
  onToggleChanges: () => void;
  empty: boolean;
  branch?: string;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  return (
    <div className={styles.header}>
      <div className={styles.headerTitle}>
        <span className={styles.agentBadge} data-agent={state.agent}>
          <AgentLogo agent={state.agent} size={15} />
        </span>
        <span key={state.title ?? ""} className={styles.titleText}>
          {state.title ?? (empty ? `New chat` : "Untitled chat")}
        </span>
      </div>
      <div className={styles.headerActions}>
        {changes > 0 && (
          <button
            className={`${styles.headerBtn}${showChanges ? ` ${styles.headerBtnOn}` : ""}`}
            onClick={onToggleChanges}
            title="Files this chat changed"
          >
            <IconDiff size={13} />
            <span>{changes === 1 ? "1 file" : `${changes} files`}</span>
            <DiffStat {...totals} />
          </button>
        )}
        {state.canList && (
          <div className={styles.menuWrap}>
            <button
              className={`${styles.headerIconBtn}${historyOpen ? ` ${styles.headerBtnOn}` : ""}`}
              onClick={() => setHistoryOpen((o) => !o)}
              title="Past conversations"
            >
              <IconClock size={14} />
            </button>
            {historyOpen && <HistoryMenu chat={chat} branch={branch} onClose={() => setHistoryOpen(false)} />}
          </div>
        )}
        <button
          className={styles.headerIconBtn}
          onClick={() => chat.newSession()}
          title="New conversation in this pane"
          disabled={empty || state.status === "starting"}
        >
          <IconChat size={14} />
        </button>
      </div>
    </div>
  );
}

function relativeTime(iso?: string | null) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function useSessions(chat: Chat, enabled: boolean) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    chat
      .listSessions()
      .then((s) => live && setSessions(s))
      .catch(() => live && setSessions([]));
    return () => {
      live = false;
    };
  }, [chat, enabled]);
  return sessions;
}

function HistoryMenu({ chat, branch, onClose }: { chat: Chat; branch?: string; onClose: () => void }) {
  const sessions = useSessions(chat, true);
  const [q, setQ] = useState("");
  // Only Claude records a branch per session; without one there is nothing
  // to narrow by.
  const branchKnown = !!branch && (sessions ?? []).some((s) => s.branch);
  const [scope, setScope] = useState<"branch" | "all">("branch");
  const byBranch = branchKnown && scope === "branch";
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.parentElement?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [onClose]);

  const shown = (sessions ?? []).filter(
    (s) => (!byBranch || s.branch === branch) && (s.title ?? "").toLowerCase().includes(q.toLowerCase())
  );

  return (
    <div className={styles.history} ref={ref} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className={styles.historySearch}>
        <IconSearch size={12} />
        <input autoFocus placeholder="Search conversations" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {branchKnown && (
        <div className={styles.scopeTabs} role="tablist">
          <button role="tab" aria-selected={scope === "branch"} className={scope === "branch" ? styles.scopeOn : undefined} onClick={() => setScope("branch")}>
            <IconBranch size={11} /> {branch}
          </button>
          <button role="tab" aria-selected={scope === "all"} className={scope === "all" ? styles.scopeOn : undefined} onClick={() => setScope("all")}>
            All branches
          </button>
        </div>
      )}
      <div className={styles.historyList}>
        {sessions === null && <div className={styles.historyEmpty}>Loading…</div>}
        {sessions !== null && shown.length === 0 && (
          <div className={styles.historyEmpty}>{byBranch && !q ? `No conversations on ${branch} yet` : "No conversations here yet"}</div>
        )}
        {shown.map((s) => (
          <button
            key={s.sessionId}
            className={styles.historyItem}
            onClick={() => {
              onClose();
              chat.loadSession(s);
            }}
          >
            <span className={styles.historyTitle}>{s.title || "Untitled"}</span>
            {!byBranch && s.branch && <span className={styles.branchTag}>{s.branch}</span>}
            <span className={styles.historyTime}>{relativeTime(s.updatedAt)}</span>
          </button>
        ))}
      </div>
      <div className={styles.historyFoot}>Includes conversations started in a terminal in this checkout.</div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const SUGGESTIONS = [
  { label: "Explain this codebase", prompt: "Give me a tour of this codebase: what it does, how it's laid out, and where the important pieces live." },
  { label: "Review my changes", prompt: "Review my uncommitted changes. Point out bugs, risky spots and anything unfinished." },
  { label: "Find a bug", prompt: "Look for a real bug in this project, explain it, and propose a fix." },
  { label: "Write tests", prompt: "Find the least-tested important code in this project and write tests for it." },
];

function Welcome({
  chat,
  state,
  cwd,
  branch,
  composer,
  active,
}: {
  chat: Chat;
  state: ChatState;
  cwd: string;
  branch?: string;
  composer: React.RefObject<ComposerHandle>;
  active: boolean;
}) {
  const repo = cwd.split("/").filter(Boolean).pop();
  const all = useSessions(chat, state.canList && state.status === "ready");
  // What you were doing on this branch; the clock in the header has the rest.
  const branchKnown = !!branch && (all ?? []).some((s) => s.branch);
  const sessions = all && branchKnown ? all.filter((s) => s.branch === branch) : all;
  // Still on its way only while the agent is starting or can list at all;
  // an agent that died or wants a sign-in has nothing coming.
  const recentLoading = all === null && (state.status === "starting" || (state.canList && state.status === "ready"));
  const agentName = AGENTS[state.agent].name;

  return (
    <div className={styles.welcome}>
      <div className={styles.welcomeInner}>
        <AgentSwitch chat={chat} agent={state.agent} />

        <h2 className={styles.greeting} style={{ "--i": 1 } as React.CSSProperties}>What should we work on?</h2>
        <div className={styles.where} style={{ "--i": 2 } as React.CSSProperties}>
          <span className={styles.whereRepo}>{repo}</span>
          {branch && (
            <span className={styles.whereBranch}>
              <IconBranch size={11} /> {branch}
            </span>
          )}
        </div>

        {state.status === "auth" ? (
          <AuthCard chat={chat} state={state} />
        ) : (
          <>
            <div className={styles.staggerItem} style={{ "--i": 3, width: "100%" } as React.CSSProperties}>
            <Composer
              ref={composer}
              chat={chat}
              state={state}
              cwd={cwd}
              active={active}
              centered
              placeholder={state.status === "starting" ? `Starting ${agentName}…` : `Ask ${agentName} to build, fix or explain…`}
            />
            </div>
            <div className={styles.chips}>
              {SUGGESTIONS.map((s, i) => (
                <button
                  key={s.label}
                  className={styles.chip}
                  style={{ "--i": 4 + i * 0.5 } as React.CSSProperties}
                  onClick={() => composer.current?.setDraft(s.prompt)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </>
        )}

        {state.items.length === 0 && state.status === "exited" && (
          <div className={styles.exitedCard}>
            <span>{agentName} could not start.</span>
            <button className={styles.secondaryBtn} onClick={() => chat.switchAgent(state.agent)}>
              <IconRetry size={12} /> Try again
            </button>
          </div>
        )}

        {/* The list's room is held from the first frame, loading or empty,
            so the composer above sits where it will end up instead of
            jumping when the list arrives. */}
        <div className={styles.recent} style={{ "--i": 6 } as React.CSSProperties}>
          <div className={styles.recentHead}>
            {branch && (all === null || branchKnown) ? `Recent on ${branch}` : "Recent in this checkout"}
          </div>
          <div className={styles.recentList}>
            {recentLoading
              ? [0, 1, 2].map((i) => (
                  <div key={i} className={styles.recentSkeleton} style={{ "--j": i } as React.CSSProperties}>
                    <span />
                  </div>
                ))
              : !sessions || sessions.length === 0
                ? <div className={styles.recentEmpty}>No conversations {branchKnown ? "on this branch" : "here"} yet</div>
                : sessions.slice(0, 5).map((s, i) => (
                    <button
                      key={s.sessionId}
                      className={`${styles.recentItem} ${styles.recentRow}`}
                      style={{ "--j": i } as React.CSSProperties}
                      onClick={() => chat.loadSession(s)}
                    >
                      <IconChat size={12} />
                      <span className={styles.historyTitle}>{s.title || "Untitled"}</span>
                      <span className={styles.historyTime}>{relativeTime(s.updatedAt)}</span>
                      <IconChevronRight size={9} />
                    </button>
                  ))}
          </div>
        </div>
      </div>
      <NoticeTail items={state.items} />
    </div>
  );
}

/** Claude or Codex, with a pill that slides to the one picked. */
function AgentSwitch({ chat, agent }: { chat: Chat; agent: AgentId }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const el = refs.current[agent];
    if (el) setPill({ left: el.offsetLeft, width: el.offsetWidth });
  }, [agent]);
  return (
    <div className={styles.agentSwitch} role="tablist" style={{ "--i": 0 } as React.CSSProperties}>
      {pill && <span className={styles.agentPill} style={{ transform: `translateX(${pill.left}px)`, width: pill.width }} />}
      {(Object.keys(AGENTS) as AgentId[]).map((id) => (
        <button
          key={id}
          ref={(el) => {
            refs.current[id] = el;
          }}
          role="tab"
          aria-selected={agent === id}
          className={agent === id ? styles.agentOn : undefined}
          onClick={() => agent !== id && chat.switchAgent(id)}
        >
          <span className={styles.agentBadge} data-agent={id}>
            <AgentLogo agent={id} size={15} />
          </span>
          {AGENTS[id].name}
        </button>
      ))}
    </div>
  );
}

/** Start-up errors land in the transcript, which the welcome screen hides. */
function NoticeTail({ items }: { items: ChatItem[] }) {
  const errors = items.filter((i) => i.kind === "notice" && i.tone === "error");
  if (!errors.length) return null;
  return (
    <div className={styles.welcomeErrors}>
      {errors.slice(-2).map((e) => e.kind === "notice" && <div key={e.id} className={styles.noticeError}>{e.text}</div>)}
    </div>
  );
}

function AuthCard({ chat, state }: { chat: Chat; state: ChatState }) {
  return (
    <div className={styles.authCard}>
      <div className={styles.authTitle}>Sign in to {AGENTS[state.agent].name}</div>
      <div className={styles.authHint}>{AGENTS[state.agent].name} needs an account before it can start. A browser window may open.</div>
      <div className={styles.authMethods}>
        {state.authMethods.map((m) => (
          <button key={m.id} className={styles.authBtn} onClick={() => chat.authenticate(m.id)} title={m.description}>
            {m.name}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function PlanCard({ state }: { state: ChatState }) {
  const [open, setOpen] = useState(true);
  const plan = state.plan;
  const done = plan.filter((p) => p.status === "completed").length;
  if (!plan.length || (done === plan.length && state.status !== "working")) return null;
  const current = plan.find((p) => p.status === "in_progress");
  return (
    <div className={styles.planCard}>
      <button className={styles.planHead} onClick={() => setOpen((o) => !o)}>
        <span className={`${styles.chev}${open ? ` ${styles.chevOpen}` : ""}`}>
          <IconChevronRight size={9} />
        </span>
        <span className={styles.planTitle}>{open || !current ? "Plan" : current.content}</span>
        <span className={styles.planCount}>
          {done} of {plan.length}
        </span>
        <span className={styles.planBar}>
          <span style={{ width: `${(done / plan.length) * 100}%` }} />
        </span>
      </button>
      <Collapse open={open}>
        <ol className={styles.planList}>
          {plan.map((p, i) => (
            <li key={i} data-status={p.status}>
              <span className={styles.planMark} />
              {p.content}
            </li>
          ))}
        </ol>
      </Collapse>
    </div>
  );
}

function PermissionDock({
  chat,
  item,
  agent,
  queued,
  cwd,
}: {
  chat: Chat;
  item: Extract<ChatItem, { kind: "permission" }>;
  agent: string;
  queued: number;
  cwd: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);

  // Take focus for the answer unless the user is mid-sentence in the composer.
  useEffect(() => {
    const a = document.activeElement as HTMLTextAreaElement | null;
    if (!a || a.tagName !== "TEXTAREA" || !a.value) primary.current?.focus();
  }, [item.id]);

  return (
    <div
      className={styles.permDock}
      ref={ref}
      onKeyDown={(e) => {
        const n = parseInt(e.key, 10);
        if (n >= 1 && n <= item.options.length) {
          e.preventDefault();
          chat.answer(item.id, item.options[n - 1].optionId);
        }
      }}
    >
      <div className={styles.permHead}>
        <span className={styles.permPulse} />
        <span>
          {agent} wants to <b>{describeKind(item.toolKind)}</b>
        </span>
        {queued > 0 && <span className={styles.permQueue}>+{queued} more waiting</span>}
      </div>
      <div className={styles.permTitle} title={item.title}>{shortenPaths(item.title, cwd)}</div>
      {item.preview?.command && <CodeBlock code={item.preview.command} lang="sh" />}
      {item.preview?.diff && (
        <div className={styles.permDiff}>
          <Diff before={item.preview.diff.oldText ?? null} after={item.preview.diff.newText ?? ""} path={item.preview.diff.path ?? ""} />
        </div>
      )}
      <div className={styles.permOptions}>
        {item.options.map((o, i) => (
          <button
            key={o.optionId}
            ref={i === 0 ? primary : undefined}
            className={o.kind.startsWith("allow") ? (i === 0 ? styles.allowBtn : styles.allowAltBtn) : styles.rejectBtn}
            onClick={() => chat.answer(item.id, o.optionId)}
          >
            <span className={styles.keyHint}>{i + 1}</span>
            {o.name}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Rewind, docked above the composer like an approval: first which of your
 * messages to go back to (newest first), then whether to take the code back
 * with the conversation. Keys: ↑↓ and Enter to pick, 1/2 to choose, Esc out.
 */
function RewindDock({
  chat,
  state,
  step,
  onPick,
  onChoose,
  onClose,
}: {
  chat: Chat;
  state: ChatState;
  step: { step: "pick" } | { step: "confirm"; id: string };
  onPick: (id: string) => void;
  onChoose: (id: string, code: boolean) => void;
  onClose: () => void;
}) {
  const messages = state.items.filter((i): i is Extract<ChatItem, { kind: "user" }> => i.kind === "user").reverse();
  const [hover, setHover] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [step.step]);

  const target = step.step === "confirm" ? state.items.find((i) => i.id === step.id) : null;
  const edits = step.step === "confirm" ? chat.editsAfter(step.id) : [];
  const files = new Set(edits.flatMap((t) => t.content.filter((c) => c.type === "diff").map((c) => c.path)));

  return (
    <div
      className={styles.rewindDock}
      ref={ref}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        } else if (step.step === "pick" && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
          e.preventDefault();
          const d = e.key === "ArrowDown" ? 1 : -1;
          setHover((h) => (h + d + messages.length) % messages.length);
        } else if (step.step === "pick" && e.key === "Enter" && messages[hover]) {
          e.preventDefault();
          onPick(messages[hover].id);
        } else if (step.step === "confirm" && (e.key === "1" || e.key === "Enter")) {
          e.preventDefault();
          onChoose(step.id, false);
        } else if (step.step === "confirm" && e.key === "2" && edits.length) {
          e.preventDefault();
          onChoose(step.id, true);
        }
      }}
    >
      <div className={styles.permHead}>
        <IconUndo size={13} />
        <span>
          <b>Rewind</b> {step.step === "pick" ? "to before which message?" : "to before this message"}
        </span>
        <span className={styles.permQueue}>esc to cancel</span>
      </div>
      {step.step === "pick" ? (
        <div className={styles.rewindList}>
          {messages.map((m, i) => {
            const n = chat.editsAfter(m.id).length;
            return (
              <button
                key={m.id}
                className={`${styles.rewindItem}${i === hover ? ` ${styles.menuItemHover}` : ""}`}
                onMouseEnter={() => setHover(i)}
                onClick={() => onPick(m.id)}
              >
                <span className={styles.rewindText}>{m.text.split("\n")[0] || "(image)"}</span>
                {n > 0 && <span className={styles.rewindEdits}>{n} {n === 1 ? "edit" : "edits"} after</span>}
              </button>
            );
          })}
        </div>
      ) : (
        <>
          <div className={styles.rewindQuote}>{target?.kind === "user" ? target.text : ""}</div>
          <div className={styles.permOptions}>
            <button className={styles.allowBtn} onClick={() => onChoose(step.id, false)}>
              <span className={styles.keyHint}>1</span>
              Restore conversation
            </button>
            {edits.length > 0 && (
              <button className={styles.allowAltBtn} onClick={() => onChoose(step.id, true)}>
                <span className={styles.keyHint}>2</span>
                Restore conversation and code ({edits.length} {edits.length === 1 ? "edit" : "edits"}, {files.size} {files.size === 1 ? "file" : "files"})
              </button>
            )}
            <button className={styles.rejectBtn} onClick={onClose}>
              Cancel
            </button>
          </div>
          <div className={styles.rewindNote}>
            The agent forgets everything from this message on; the conversation as it is now stays in History.
            {edits.length > 0 && " Code is restored only where a file still holds exactly what the agent wrote."}
          </div>
        </>
      )}
    </div>
  );
}

function describeKind(kind?: string) {
  switch (kind) {
    case "edit":
      return "edit a file";
    case "delete":
      return "delete a file";
    case "move":
      return "move a file";
    case "execute":
      return "run a command";
    case "fetch":
      return "fetch a page";
    case "read":
      return "read a file";
    default:
      return "use a tool";
  }
}

// ---------------------------------------------------------------------------

const DRAWER_MIN = 300;
const DRAWER_DEFAULT = 420;
const DRAWER_KEY = "lever-chat-changes-width";

function readDrawerWidth(): number {
  try {
    const v = Number(localStorage.getItem(DRAWER_KEY));
    if (Number.isFinite(v) && v >= DRAWER_MIN) return v;
  } catch {}
  return DRAWER_DEFAULT;
}

/**
 * The changes drawer's width: dragged by its left edge, anywhere from a
 * narrow column to half the chat, and remembered between chats. The cap
 * follows the chat as it resizes, so a wide drawer never crowds the
 * conversation out.
 */
function useDrawerWidth() {
  const ref = useRef<HTMLElement>(null);
  const [want, setWant] = useState(readDrawerWidth);
  const [max, setMax] = useState(Infinity);
  const [dragging, setDragging] = useState(false);
  const narrowRef = useRef(Math.min(want, DRAWER_DEFAULT));

  useLayoutEffect(() => {
    const body = ref.current?.parentElement;
    if (!body) return;
    const measure = () => setMax(Math.max(DRAWER_MIN, Math.floor(body.clientWidth / 2)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(body);
    return () => ro.disconnect();
  }, []);

  const width = Math.min(Math.max(want, DRAWER_MIN), max);
  const wide = width >= max - 1;

  const remember = (w: number) => {
    try {
      localStorage.setItem(DRAWER_KEY, String(Math.round(w)));
    } catch {}
  };

  const onHandleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = ref.current;
    if (!el) return;
    const right = el.getBoundingClientRect().right;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    setDragging(true);
    let last = width;
    const move = (ev: PointerEvent) => {
      last = Math.min(Math.max(right - ev.clientX, DRAWER_MIN), max);
      setWant(last);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      setDragging(false);
      if (last < max - 1) narrowRef.current = last;
      remember(last);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  /** Half the chat, or back to the narrower width it had before. */
  const toggleWide = () => {
    const next = wide ? narrowRef.current : max;
    if (!wide) narrowRef.current = width;
    setWant(next);
    remember(next);
  };

  return { ref, width, max, wide, dragging, onHandleDown, toggleWide };
}

function ChangesPanel({
  changes,
  totals,
  worktreeId,
  cwd,
  onClose,
}: {
  changes: ReturnType<typeof fileChanges>;
  totals: { added: number; removed: number };
  worktreeId: string | null;
  cwd: string;
  onClose: () => void;
}) {
  const [openPath, setOpenPath] = useState<string | null>(changes.length === 1 ? changes[0].path : null);
  const setActiveGitGroup = useGitStore((s) => s.setActiveGitGroup);
  const { ref, width, max, wide, dragging, onHandleDown, toggleWide } = useDrawerWidth();

  return (
    <aside
      ref={ref}
      className={`${styles.changes}${dragging ? ` ${styles.changesDragging}` : ""}`}
      style={{ width }}
    >
      <div
        className={styles.drawerHandle}
        onPointerDown={onHandleDown}
        onDoubleClick={toggleWide}
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={DRAWER_MIN}
        aria-valuemax={max}
        aria-valuenow={width}
        title="Drag to resize · double-click for half the chat"
      />
      <div className={styles.changesHead}>
        <div>
          <div className={styles.changesTitle}>Changes in this chat</div>
          <div className={styles.changesSub}>
            {changes.length === 1 ? "1 file" : `${changes.length} files`} · <DiffStat {...totals} />
          </div>
        </div>
        <div className={styles.changesActions}>
          <button className={styles.iconBtn} onClick={toggleWide} title={wide ? "Back to narrow" : "Widen to half the chat"}>
            {wide ? <IconPanelNarrow size={14} /> : <IconPanelWiden size={14} />}
          </button>
          <button className={styles.iconBtn} onClick={onClose} title="Close">
            ×
          </button>
        </div>
      </div>
      <div className={styles.changesList}>
        {changes.map((c) => {
          const open = openPath === c.path;
          return (
            <div key={c.path} className={styles.changeItem}>
              <button className={styles.changeRow} onClick={() => setOpenPath(open ? null : c.path)}>
                <span className={`${styles.chev}${open ? ` ${styles.chevOpen}` : ""}`}>
                  <IconChevronRight size={9} />
                </span>
                <span className={styles.changeName}>{c.path.split("/").pop()}</span>
                <span className={styles.changeDir}>{c.path.split("/").slice(0, -1).join("/")}</span>
                <DiffStat added={c.added} removed={c.removed} />
              </button>
              <Collapse open={open}>
                <div className={styles.hunks}>
                  {c.hunks.map((h, i) => (
                    <Diff key={i} before={h.before} after={h.after} path="" />
                  ))}
                </div>
              </Collapse>
            </div>
          );
        })}
      </div>
      <div className={styles.changesFoot}>
        <button
          className={styles.secondaryBtn}
          onClick={() => setActiveGitGroup(worktreeId ?? MAIN_GIT_TARGET, cwd)}
          title="Stage what you want to keep (⌘G)"
        >
          Review in Git panel
        </button>
        <span className={styles.changesNote}>Shows what the agent wrote; later edits by hand are in Git.</span>
      </div>
    </aside>
  );
}

export { formatDuration };

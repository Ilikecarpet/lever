import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { artifactOf, type Artifact, type ToolItem } from "../../lib/acpChat";
import { useThemeStore } from "../../stores/themeStore";
import { IconClose, IconExpand, IconSparkle } from "../Icons";
import { CopyButton, Markdown } from "./Markdown";
import chat from "./Chat.module.css";
import styles from "./Artifact.module.css";

// ---------------------------------------------------------------------------
// Artifacts: HTML, SVG or Markdown an agent shows inline through Lever's
// show_artifact tool.
//
// HTML and SVG are the agent's own markup and run its scripts, so they get a
// frame of their own: sandboxed without same-origin, its origin is opaque and
// it can reach neither this page nor Lever's commands, and its CSP allows no
// network at all. All it can do is post its size, ask to open a link, or
// pass on an Escape, each checked here before anything happens.
//
// Inline, an artifact never scrolls: the frame is laid out at the page's own
// size and scaled down from here, by a transform, to fit the column —
// whatever the agent's CSS says — and a little further if that leaves it just
// over INLINE_CAP. Anything that would turn unreadable is cut off instead,
// under a fade that expands it.
// Expanded, the same element is lifted into the top layer as a popover
// (moving an iframe would reload it), fills the window at full size, and
// scrolls like a page.
// ---------------------------------------------------------------------------

/** The tallest an artifact stands in the conversation. */
const INLINE_CAP = 480;
const MIN_HEIGHT = 60;
/** A page's height is believed up to this: one sized off the frame's own
 *  height (100vh plus a margin) grows each time the frame does. */
const MAX_HEIGHT = 4000;
/** Likewise a page's width: one sized in percent overflows at any width. */
const MAX_WIDTH = 2400;
/** The smallest a wide page is scaled to fit the column; past it, it is cut off. */
const MIN_SCALE = 0.4;
/** How far a page is shrunk to fit INLINE_CAP. Shrinking a long page to fit
 *  would leave it unreadable, so past this it is cut off instead. */
const HEIGHT_SQUEEZE = 0.75;

const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";

const THEME_VARS = [
  "--bg", "--surface", "--surface-raised", "--border", "--text", "--text-dim", "--text-muted",
  "--accent", "--accent-dim", "--green", "--red", "--yellow", "--blue", "--font-sans", "--font-mono",
];

/** Runs in the frame: reports the page's size whenever it may have changed
 *  (charts draw after load), scrolls only when Lever says it is expanded,
 *  hands link clicks to Lever instead of navigating the frame, and passes
 *  Escape out so it can close. */
const bridge = (id: string) => `(() => {
  const post = (m) => parent.postMessage(Object.assign({ leverArtifact: ${JSON.stringify(id)} }, m), "*");
  const root = document.documentElement;
  root.style.overflow = "hidden";
  let lw = 0, lh = 0, liw = 0, queued = false;
  const measure = () => {
    queued = false;
    if (!document.body) return;
    const w = root.scrollWidth, h = Math.ceil(document.body.getBoundingClientRect().height);
    if (innerWidth !== liw || Math.abs(w - lw) > 1 || Math.abs(h - lh) > 1) {
      post({ w: (lw = w), h: (lh = h), iw: (liw = innerWidth) });
    }
  };
  // A timer, not a frame callback: those pause in a frame scrolled out of view.
  const soon = () => { if (!queued) { queued = true; setTimeout(measure, 16); } };
  addEventListener("DOMContentLoaded", () => {
    new ResizeObserver(soon).observe(document.body);
    new MutationObserver(soon).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    soon();
  });
  addEventListener("load", () => { soon(); setTimeout(soon, 300); setTimeout(soon, 1200); });
  addEventListener("resize", soon);
  addEventListener("message", (e) => {
    if (e.source !== parent || !e.data) return;
    if (typeof e.data.leverExpanded === "boolean") {
      root.style.overflow = e.data.leverExpanded ? "auto" : "hidden";
      root.classList.toggle("lever-expanded", e.data.leverExpanded);
    }
  });
  addEventListener("keydown", (e) => { if (e.key === "Escape") post({ escape: true }); });
  document.addEventListener("click", (e) => {
    const a = e.target instanceof Element && e.target.closest("a[href]");
    if (!a || a.getAttribute("href").startsWith("#")) return;
    e.preventDefault();
    if (/^https?:/i.test(a.href)) post({ open: a.href });
  }, true);
})();`;

function frameDoc(id: string, a: Artifact): string {
  const root = getComputedStyle(document.documentElement);
  const vars = THEME_VARS.map((v) => `${v}:${root.getPropertyValue(v).trim()};`).join("");
  let body = a.content.replace(/^\s*<!doctype[^>]*>/i, "");
  if (a.type === "svg" && !/xmlns=/.test(body)) body = body.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  // An agent's own <html>, <head> and <body> tags still parse after these:
  // their attributes merge onto the real ones and their styles apply —
  // except sizing html and body, which is the frame's to do: a body held to
  // 100vh or 100vw grows with the frame that measures it. Border-box on
  // everything, because width: 100% plus padding is how most pages overflow.
  // Expanded, a picture is held to the screen's height too: scaled to the
  // full width, a canvas or chart would run off the bottom. Not inline, where
  // the frame's height follows the page and the cap would only shrink it.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>:root{${vars}color-scheme:dark light}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0!important;width:auto!important;min-width:0!important;max-width:none!important;height:auto!important;min-height:0!important}
body{display:flow-root;padding:16px;background:var(--bg);color:var(--text);font:13px/1.55 var(--font-sans);overflow-wrap:break-word}
img,video,canvas,svg,iframe,pre{max-width:100%}img,video,canvas{height:auto}img,video,canvas,svg{vertical-align:bottom}pre{overflow:auto}
.lever-expanded :is(canvas,img,video,svg){max-height:calc(100vh - 32px);object-fit:contain}
${a.type === "svg" ? "body{display:flex;justify-content:center}svg{height:auto}" : ""}</style>
<script>${bridge(id)}</script></head><body>${body}</body></html>`;
}

/** The chat's Type size zoom, which an element inherits from its column. */
function chatZoom(el: Element): number {
  return parseFloat(getComputedStyle(el).getPropertyValue("--chat-zoom")) || 1;
}

/** The fade over an artifact cut off inline, which opens the rest. */
function More({ onExpand }: { onExpand: () => void }) {
  return (
    <button className={styles.more} onClick={onExpand}>
      <span>Show all</span>
    </button>
  );
}

function Frame({
  id,
  artifact,
  expanded,
  onExpand,
  onEscape,
}: {
  id: string;
  artifact: Artifact;
  expanded: boolean;
  onExpand: () => void;
  onEscape: () => void;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  // The chat's Type size zoom. Under a zoomed parent WebKit lays a frame's
  // page out wider than the frame and it runs off the side, so the frame
  // takes the zoom back out and its sizes below are screen pixels rather
  // than the zoomed column's. WebKit only honours that if it is in place
  // before the page loads, so the frame waits for it, and is made afresh
  // when the Type size changes. Null until read.
  const [zoom, setZoom] = useState<number | null>(null);
  // The column's width in screen pixels, kept from inline: expanded, the
  // frame is the window's.
  const [col, setCol] = useState(0);
  // The widest the page has shown it needs, by overflowing the width it was
  // laid out at. Remembered rather than re-measured, so resizing the column
  // only rescales the frame instead of laying it out twice per step.
  const [need, setNeed] = useState(0);
  const [pageH, setPageH] = useState(120);
  const live = useRef({ expanded, onEscape, col, zoom });
  live.current = { expanded, onEscape, col, zoom };
  // A new theme rebuilds the frame so its colours follow.
  const theme = useThemeStore((s) => s.activeThemeId);
  const doc = useMemo(() => frameDoc(id, artifact), [id, artifact.content, artifact.type, theme]);

  useLayoutEffect(() => {
    if (wrap.current) setZoom(chatZoom(wrap.current));
  }, []);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      if (live.current.expanded) return;
      const z = chatZoom(el);
      // A new Type size means a new frame, measured afresh.
      if (z !== live.current.zoom) setNeed(0);
      setZoom(z);
      // Down, so a part pixel is never cut off.
      setCol(Math.floor(e.contentRect.width * z));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow || e.data?.leverArtifact !== id) return;
      const { w, h, iw, open, escape } = e.data;
      // Sizes measured while expanded are the window's, not the page's.
      if (typeof w === "number" && typeof h === "number" && typeof iw === "number" && !live.current.expanded) {
        // Only an overflow at the column's own width counts. Once widened, a
        // page sized off the frame (100vw plus a margin) overflows again by
        // the same margin, and believing it would widen it without end.
        const atColumn = Math.abs(iw - live.current.col) <= 1;
        if (atColumn && w > iw + 1) setNeed((n) => Math.min(MAX_WIDTH, Math.max(n, Math.ceil(w))));
        setPageH(Math.min(Math.max(h, MIN_HEIGHT), MAX_HEIGHT));
      }
      // Only after a click: clicking into the frame focuses it, while a page
      // script posting on its own would open tabs nobody asked for.
      const clicked = document.activeElement === ref.current;
      if (clicked && typeof open === "string" && /^https?:\/\//i.test(open)) openUrl(open).catch(() => {});
      if (escape === true) live.current.onEscape();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [id]);

  const tell = () => ref.current?.contentWindow?.postMessage({ leverExpanded: expanded }, "*");
  useEffect(tell, [expanded]);

  // All in screen pixels; the cap grows with the type size like the column.
  const z = zoom ?? 1;
  const cap = INLINE_CAP * z;
  const width = Math.max(need, col);
  const widthFit = col ? Math.min(1, col / width) : 1;
  const widthScale = Math.max(widthFit, MIN_SCALE);
  const heightFit = cap / (pageH * widthScale);
  const scale = heightFit >= HEIGHT_SQUEEZE ? widthScale * Math.min(1, heightFit) : widthScale;
  const cut = widthFit < MIN_SCALE || pageH * scale > cap + 1;
  return (
    // The wrapper is in the zoomed column, so its height goes back into its units.
    <div ref={wrap} className={styles.frameWrap} style={expanded ? undefined : { height: Math.min(pageH * scale, cap) / z }}>
      {zoom !== null && <iframe
        key={zoom}
        ref={ref}
        className={styles.frame}
        title={artifact.title}
        sandbox="allow-scripts"
        srcDoc={doc}
        onLoad={tell}
        style={
          expanded || !col
            ? { zoom: 1 / zoom }
            : {
                zoom: 1 / zoom,
                width,
                height: pageH,
                transform: scale < 1 ? `scale(${scale})` : undefined,
                // Centred when the height is what it was scaled to fit.
                marginLeft: Math.max(0, (col - width * scale) / 2),
              }
        }
      />}
      {cut && !expanded && <More onExpand={onExpand} />}
    </div>
  );
}

/** Markdown is text, which is no use scaled: inline it is cut off at the
 *  cap instead, under the same fade. */
function Doc({ text, expanded, onExpand }: { text: string; expanded: boolean; onExpand: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [cut, setCut] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCut(el.scrollHeight > el.clientHeight + 1));
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className={styles.doc} style={expanded ? undefined : { maxHeight: INLINE_CAP }}>
      <div className={chat.prose}>
        <Markdown text={text} />
      </div>
      {cut && !expanded && <More onExpand={onExpand} />}
    </div>
  );
}

const EMPTY: Artifact = { title: "Artifact", type: "html", content: "" };

export const ArtifactCard = memo(function ArtifactCard({ item }: { item: ToolItem }) {
  // Worked out here, from the input alone, so the card skips the re-render
  // the transcript does for every streamed token.
  const artifact = useMemo(() => artifactOf(item), [item.rawInput, item.name, item.title]) ?? EMPTY;
  // The input streams in; drawing each partial page would reload the frame
  // on every chunk, so it waits for the call to land.
  const writing = item.status === "pending" || item.status === "in_progress";
  const [expanded, setExpanded] = useState(false);
  const slot = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  // Held while expanded, so the conversation does not close up beneath it.
  const [held, setHeld] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // Escape, or anything else that closes the popover, closes it here too.
    const onToggle = (e: Event) => {
      if ((e as Event & { newState?: string }).newState === "closed") setExpanded(false);
    };
    el.addEventListener("toggle", onToggle);
    return () => el.removeEventListener("toggle", onToggle);
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (expanded && !el.matches(":popover-open")) {
      el.showPopover();
      // Off the composer, whose Escape would stop the agent as well.
      close.current?.focus();
    } else if (!expanded && el.matches(":popover-open")) {
      el.hidePopover();
    }
    if (!expanded) setHeld(null);
  }, [expanded]);

  const expand = () => {
    setHeld(slot.current?.offsetHeight ?? null);
    setExpanded(true);
  };

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <span className={styles.icon}>
          <IconSparkle size={12} />
        </span>
        <span className={styles.title} title={artifact.title}>
          {artifact.title}
        </span>
        <span className={styles.type}>{artifact.type}</span>
        {artifact.content && <CopyButton text={artifact.content} label="Copy" className={chat.codeCopy} />}
        {!writing && (
          <button className={chat.codeCopy} title="Expand" onClick={expand}>
            <IconExpand size={12} />
          </button>
        )}
      </div>
      <div ref={slot} style={held ? { height: held } : undefined}>
        <div ref={box} className={styles.box} {...({ popover: "auto" } as object)}>
          {expanded && (
            <div className={styles.fullHead}>
              <span className={styles.icon}>
                <IconSparkle size={12} />
              </span>
              <span className={styles.title}>{artifact.title}</span>
              <span className={styles.type}>{artifact.type}</span>
              <CopyButton text={artifact.content} label="Copy" className={chat.codeCopy} />
              <button ref={close} className={styles.close} title="Close (Esc)" onClick={() => setExpanded(false)}>
                <IconClose size={10} />
                <span>Close</span>
                <kbd>esc</kbd>
              </button>
            </div>
          )}
          {writing ? (
            <div className={styles.writing}>
              <span className={chat.shimmer}>Drawing</span>
            </div>
          ) : artifact.type === "markdown" ? (
            <Doc text={artifact.content} expanded={expanded} onExpand={expand} />
          ) : (
            <Frame id={item.id} artifact={artifact} expanded={expanded} onExpand={expand} onEscape={() => setExpanded(false)} />
          )}
        </div>
      </div>
    </div>
  );
});

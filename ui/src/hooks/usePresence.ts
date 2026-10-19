import { useEffect, useState } from "react";

/** How long the shared exit animations in global.css take, plus a frame. */
const EXIT_MS = 180;

/**
 * Keeps something mounted while it animates out. `mounted` says whether to
 * render it at all; `closing` is true for the short stretch after `open`
 * goes false, while it should wear the `lv-closing` class:
 *
 *   const { mounted, closing } = usePresence(open);
 *   if (!mounted) return null;
 *   <div className={`${styles.menu} lv-pop${closing ? " lv-closing" : ""}`}>
 */
export function usePresence(open: boolean, exitMs = EXIT_MS) {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const t = setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, exitMs);
    return () => clearTimeout(t);
    // `mounted` is read, not tracked: only a change of `open` starts an exit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, exitMs]);

  return { mounted: open || mounted, closing: !open && closing };
}

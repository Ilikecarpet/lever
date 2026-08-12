/** How long the sidebar's collapse transitions run (see the `grid-template-rows`
 *  transitions in Sidebar/WorktreeSection/GroupItem CSS). Scrolling before the
 *  fold settles would target the pre-animation layout. */
const FOLD_MS = 240;

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Runs `scroll` once the branch fold has finished. Returns a cleanup function
 * for the caller's effect, so a rapid context switch cancels the pending
 * scroll instead of yanking the view after the user has moved on.
 */
export function afterFold(scroll: (behavior: ScrollBehavior) => void): () => void {
  const reduced = prefersReducedMotion();
  const t = setTimeout(
    () => scroll(reduced ? "auto" : "smooth"),
    reduced ? 0 : FOLD_MS
  );
  return () => clearTimeout(t);
}

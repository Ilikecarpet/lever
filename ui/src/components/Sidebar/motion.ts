import { useRef, useState } from "react";
import { usePresence } from "../../hooks/usePresence";

/* Rows that arrive with the config are the sidebar's starting contents and
   should simply be there; only rows added afterwards (a new group, service or
   worktree) rise in. Module-level because the rows and the sidebar are
   separate components, and it only ever flips once per window. */
let settled = false;

/** Called by the sidebar once the first loaded config has rendered. */
export function markSidebarSettled() {
  settled = true;
}

/** True when this row mounted after the initial load. Read once on mount, so
 *  re-renders, folds and sidebar collapse never replay the entrance. */
export function useRiseOnMount() {
  const [rise] = useState(() => settled);
  return rise;
}

type Point = { x: number; y: number };

/** Presence for a context menu opened at the cursor. The open state is the
 *  click point or null, so the last point is held on to while the menu plays
 *  its exit; otherwise the clamp would fling it to the corner as it fades. */
export function useMenuPresence(at: Point | null) {
  const { mounted, closing } = usePresence(at !== null);
  const last = useRef<Point>({ x: 0, y: 0 });
  if (at) last.current = at;
  return { mounted, closing, pos: last.current };
}

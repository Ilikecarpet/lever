import { useLayoutEffect } from "react";
import type { RefObject } from "react";

/**
 * Keep a fixed-position popup (context menu, confirm popover) fully inside
 * the viewport. Pass the desired anchor point (usually the click position);
 * the element is nudged left/up when it would overflow an edge.
 *
 * Runs on every render so menus that grow (e.g. inline confirm accordions)
 * stay in view as they expand.
 */
export function useClampToViewport(
  ref: RefObject<HTMLElement | null>,
  x: number,
  y: number,
  margin = 8
) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const maxLeft = window.innerWidth - width - margin;
    const maxTop = window.innerHeight - height - margin;
    el.style.left = `${Math.max(margin, Math.min(x, maxLeft))}px`;
    el.style.top = `${Math.max(margin, Math.min(y, maxTop))}px`;
  });
}

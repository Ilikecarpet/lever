import styles from "./LeverMark.module.css";

/** The drawing's bounds: wide enough for the lever's whole swing. */
const VIEW = { x: 1.5, y: 1, w: 28, h: 23 };

/** The pivot the lever swings about, in drawing units. */
export const PIVOT = { x: 12, y: 18.5 };

/**
 * Lever's mark, seen side-on: a red knob on a chrome stick, pivoting out of
 * a metal base. While `working`, the lever is pulled down through its arc,
 * held, and springs back past rest — the app's own way of saying an agent is
 * busy. `size` is the height; the width follows the drawing.
 */
export function LeverMark({ size = 16, working = false, className }: { size?: number; working?: boolean; className?: string }) {
  const arm = (
    <>
      <rect x={PIVOT.x - 0.95} y={PIVOT.y - 13} width="1.9" height="13" rx="0.95" fill="url(#lm-chrome)" />
      {/* The ball turns back against the stick, so its light stays put —
          up and to the left — wherever the lever is. */}
      <g className={styles.knob}>
        <circle cx={PIVOT.x} cy={PIVOT.y - 13.2} r="3.7" fill="url(#lm-knob)" />
        <ellipse cx={PIVOT.x - 1.25} cy={PIVOT.y - 14.6} rx="1.35" ry="0.9" fill="#fff" opacity="0.6" />
      </g>
    </>
  );
  return (
    <svg
      width={(size * VIEW.w) / VIEW.h}
      height={size}
      viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`}
      className={`${styles.mark}${working ? ` ${styles.working}` : ""}${className ? ` ${className}` : ""}`}
      aria-hidden
    >
      <defs>
        {/* The stick's chrome is lit across its width, and turns with it. */}
        <linearGradient id="lm-chrome" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#7c7c7c" />
          <stop offset="0.4" stopColor="#f4f4f4" />
          <stop offset="0.7" stopColor="#c9c9c9" />
          <stop offset="1" stopColor="#5f5f5f" />
        </linearGradient>
        <radialGradient id="lm-knob" cx="0.36" cy="0.3" r="0.78">
          <stop offset="0" stopColor="#ff9a8b" />
          <stop offset="0.4" stopColor="#e8392b" />
          <stop offset="1" stopColor="#7e130d" />
        </radialGradient>
        {/* Light from above: the base's top face is lit, its front in shade. */}
        <linearGradient id="lm-top" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#8a8a8a" />
          <stop offset="1" stopColor="#5a5a5a" />
        </linearGradient>
        <linearGradient id="lm-front" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#3d3d3d" />
          <stop offset="1" stopColor="#1c1c1c" />
        </linearGradient>
        <filter id="lm-blur" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="0.7" />
        </filter>
        <radialGradient id="lm-hub" cx="0.38" cy="0.32" r="0.8">
          <stop offset="0" stopColor="#f2f2f2" />
          <stop offset="0.55" stopColor="#9a9a9a" />
          <stop offset="1" stopColor="#4a4a4a" />
        </radialGradient>
      </defs>

      <g className={styles.base}>
        {/* the knob's shadow on the base's top face follows the swing */}
        <ellipse cx={PIVOT.x} cy="18.4" rx="3" ry="0.55" className={styles.shadow} />
        {/* top face, then front face, of the housing */}
        <path d="M4.5 18 L20.5 18 L22 19.3 L3 19.3 Z" fill="url(#lm-top)" />
        <rect x="3" y="19.3" width="19" height="3.7" rx="0.8" fill="url(#lm-front)" />
        <rect x="3" y="19.3" width="19" height="0.45" fill="#fff" opacity="0.12" />
        {/* the slot the stick swings in */}
        <path d="M8.5 18.35 L16.5 18.35 L17 18.95 L8 18.95 Z" fill="#0b0b0b" />
      </g>

      {/* A faint trailing copy blurs the fast part of the swing. */}
      <g className={styles.ghost} filter="url(#lm-blur)">{arm}</g>
      <g className={styles.arm}>{arm}</g>

      <circle cx={PIVOT.x} cy={PIVOT.y} r="2.1" fill="url(#lm-hub)" className={styles.hub} />
      <circle cx={PIVOT.x} cy={PIVOT.y} r="0.6" fill="#3a3a3a" className={styles.hub} />
    </svg>
  );
}

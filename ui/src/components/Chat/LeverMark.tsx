import { useState } from "react";
import styles from "./LeverMark.module.css";

/** The drawing's bounds: wide enough for the beam's whole rock. */
const VIEW = { x: 3, y: 5.5, w: 23, h: 17 };

/** The fulcrum's tip, which the beam rocks on, in drawing units. */
export const PIVOT = { x: 12, y: 14 };

/** Where a thing resting on the short arm sits, with the beam at rest. */
const REST = { x: 6.14, y: 10.54 };

/** The ways the lever can play while working. Each starts and ends at rest
 *  with nothing on the beam, so a new one can take over at the end of any
 *  loop: a thing drops in over the top edge onto the short arm, and the long
 *  arm is driven down to throw it out of the frame.
 *  - pop: straight up and out the top
 *  - fling: low across the frame and out the side */
const MOVES = ["pop", "fling"] as const;
const THINGS = ["ball", "box", "wedge"] as const;
type Move = (typeof MOVES)[number];
type Thing = (typeof THINGS)[number];
const pick = <T,>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)];

function ThingShape({ thing }: { thing: Thing }) {
  if (thing === "box") return <rect x={REST.x - 1.1} y={REST.y - 1.1} width="2.2" height="2.2" rx="0.45" />;
  if (thing === "wedge") return <path d={`M${REST.x} ${REST.y - 1.4} L${REST.x + 1.3} ${REST.y + 1.06} H${REST.x - 1.3} Z`} />;
  return <circle cx={REST.x} cy={REST.y} r="1.2" />;
}

/**
 * Lever's mark, as in the app icon: the "l" laid down as a beam, resting on
 * the flipped "v" as its fulcrum. While `working`, it throws things off the
 * beam, picking the move and the thing at random each loop: the app's own way of saying an
 * agent is busy. `size` is the height; the width follows the drawing.
 */
export function LeverMark({ size = 16, working = false, className }: { size?: number; working?: boolean; className?: string }) {
  const [play, setPlay] = useState(() => ({ move: pick(MOVES), thing: pick(THINGS) }));
  // The beam sits one stroke above the tip, so rocking about the tip keeps
  // it resting on the fulcrum. Its foot curls up at the short end.
  const beam = <path d={`M24 ${PIVOT.y - 2.6} H6.3 Q5 ${PIVOT.y - 2.6} 5 ${PIVOT.y - 3.9}`} />;
  return (
    <svg
      width={(size * VIEW.w) / VIEW.h}
      height={size}
      viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`}
      fill="none"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`${styles.mark}${working ? ` ${styles.working} ${styles[play.move]}` : ""}${className ? ` ${className}` : ""}`}
      aria-hidden
    >
      <defs>
        <filter id="lm-blur" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="0.7" />
        </filter>
      </defs>

      <path d={`M7.5 21 L${PIVOT.x} ${PIVOT.y} L16.5 21`} className={styles.fulcrum} />

      {/* The thing being played with: moved as a whole, spun about its centre. */}
      <g className={styles.thing}>
        <g className={styles.spin}>
          <ThingShape thing={play.thing} />
        </g>
      </g>

      {/* A faint trailing copy blurs the fast part of the rock. */}
      <g className={styles.ghost} filter="url(#lm-blur)">{beam}</g>
      <g className={styles.beam} onAnimationIteration={() => setPlay({ move: pick(MOVES), thing: pick(THINGS) })}>
        {beam}
      </g>
    </svg>
  );
}

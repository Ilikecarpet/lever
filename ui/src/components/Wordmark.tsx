// The "lever" wordmark: monoline letters in the current text colour, the v flipped
// into a fulcrum in the accent colour. Source art lives in docs/brand/.
export function Wordmark({ height = 24, className }: { height?: number; className?: string }) {
  return (
    <svg
      height={height}
      viewBox="15 -9 452 178"
      fill="none"
      strokeWidth="18"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="lever"
      className={className}
      style={{ display: "block" }}
    >
      <g stroke="currentColor">
        <path d="M24 0 V146 Q24 160 38 160" />
        <path d="M60 110 H160 A50 50 0 1 0 145.4 145.4" />
        <path d="M280 110 H380 A50 50 0 1 0 365.4 145.4" />
        <path d="M412 160 V60 M412 100 Q412 60 458 62" />
      </g>
      <path d="M182 160 L222 60 L262 160" stroke="var(--accent)" />
    </svg>
  );
}

const s = { display: "inline-block", verticalAlign: "middle" } as const;

type P = { size?: number; className?: string };

export function IconPlay({ size = 12, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" style={s} className={className}>
      <path d="M4.5 2.5l9 5.5-9 5.5z" />
    </svg>
  );
}

export function IconStop({ size = 12, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" style={s} className={className}>
      <rect x="3" y="3" width="10" height="10" rx="1.5" />
    </svg>
  );
}

export function IconClose({ size = 12, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={s} className={className}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

export function IconChevron({ size = 10, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" style={s} className={className}>
      <path d="M4.5 6l3.5 4 3.5-4z" />
    </svg>
  );
}

export function IconPlus({ size = 14, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={s} className={className}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

export function IconMinus({ size = 14, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={s} className={className}>
      <path d="M3 8h10" />
    </svg>
  );
}

export function IconUndo({ size = 14, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={s} className={className}>
      <path d="M3 6.5h7a3.5 3.5 0 010 7H7" />
      <path d="M6 3.5l-3 3 3 3" />
    </svg>
  );
}

export function IconCheckCircle({ size = 14, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={s} className={className}>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M5.2 8.2l2 2 3.8-4.2" />
    </svg>
  );
}

export function IconSplitV({ size = 14, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={s} className={className}>
      <rect x="1.5" y="2" width="13" height="12" rx="2" />
      <line x1="8" y1="2" x2="8" y2="14" />
    </svg>
  );
}

export function IconSplitH({ size = 14, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={s} className={className}>
      <rect x="1.5" y="2" width="13" height="12" rx="2" />
      <line x1="1.5" y1="8" x2="14.5" y2="8" />
    </svg>
  );
}

export function IconBranch({ size = 14, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={s} className={className}>
      <circle cx="4" cy="4" r="1.5" />
      <circle cx="4" cy="12" r="1.5" />
      <circle cx="12" cy="6" r="1.5" />
      <path d="M4 5.5v5M4 5.5c0 2 2 2.5 6.5 1" />
    </svg>
  );
}

export function IconLog({ size = 12, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={s} className={className}>
      <path d="M2 4h12M2 8h9M2 12h6" />
    </svg>
  );
}

export function IconGear({ size = 14, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={s} className={className}>
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </svg>
  );
}

export function IconTerminal({ size = 14, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={s} className={className}>
      <rect x="1" y="2" width="14" height="12" rx="2" />
      <path d="M4 6l2.5 2L4 10M9 10h3" />
    </svg>
  );
}

export function IconFolder({ size = 14, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={s} className={className}>
      <path d="M2 4v8a1 1 0 001 1h10a1 1 0 001-1V6a1 1 0 00-1-1H8L6.5 3.5A1 1 0 005.8 3H3a1 1 0 00-1 1z" />
    </svg>
  );
}

export function IconExport({ size = 14, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={s} className={className}>
      <path d="M8 2v8M5 5l3-3 3 3M3 10v3h10v-3" />
    </svg>
  );
}

export function IconDownload({ size = 14, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={s} className={className}>
      <path d="M8 2.5V10M5 7l3 3 3-3M3 11v2h10v-2" />
    </svg>
  );
}

export function IconPencil({ size = 12, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={s} className={className}>
      <path d="M11.5 2.5l2 2L6 12l-2.8.8L4 10z" />
    </svg>
  );
}

export function IconTrash({ size = 12, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={s} className={className}>
      <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9a1 1 0 001 1h4.6a1 1 0 001-1L12 4" />
    </svg>
  );
}

export function IconSidebarCollapse({ size = 14, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={s} className={className}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <line x1="6.5" y1="3" x2="6.5" y2="13" />
      <path d="M11 6.5L9.5 8L11 9.5" />
    </svg>
  );
}

export function IconSidebarExpand({ size = 14, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={s} className={className}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <line x1="6.5" y1="3" x2="6.5" y2="13" />
      <path d="M9.5 6.5L11 8L9.5 9.5" />
    </svg>
  );
}

export function IconChat({ size = 14, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" style={s} className={className}>
      <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
    </svg>
  );
}

export function IconSend({ size = 14, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={s} className={className}>
      <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
    </svg>
  );
}

const line = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export function IconCheck({ size = 12, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...line} strokeWidth={2} style={s} className={className}>
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

export function IconCopy({ size = 12, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...line} style={s} className={className}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.5v-.5a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h.5" />
    </svg>
  );
}

export function IconFile({ size = 12, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...line} style={s} className={className}>
      <path d="M9 2H4.5a1 1 0 00-1 1v10a1 1 0 001 1h7a1 1 0 001-1V5.5L9 2z" />
      <path d="M9 2v3.5h3.5" />
    </svg>
  );
}

export function IconSearch({ size = 12, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...line} style={s} className={className}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </svg>
  );
}

export function IconGlobe({ size = 12, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...line} style={s} className={className}>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14C6.2 12.3 5.4 10.3 5.4 8S6.2 3.7 8 2z" />
    </svg>
  );
}

export function IconSparkle({ size = 12, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" style={s} className={className}>
      <path d="M8 1.5c.4 2.9 1.6 4.1 4.5 4.5v.1C9.6 6.5 8.4 7.7 8 10.6h-.1C7.5 7.7 6.3 6.5 3.4 6.1V6C6.3 5.6 7.5 4.4 7.9 1.5H8zM12.5 10c.2 1.4.8 2 2.2 2.2v.1c-1.4.2-2 .8-2.2 2.2h-.1c-.2-1.4-.8-2-2.2-2.2v-.1c1.4-.2 2-.8 2.2-2.2h.1z" />
    </svg>
  );
}

export function IconClock({ size = 14, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...line} style={s} className={className}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </svg>
  );
}

export function IconPaperclip({ size = 14, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...line} style={s} className={className}>
      <path d="M13 7.5l-5.2 5.2a3 3 0 01-4.3-4.2L9 3a2 2 0 012.8 2.8L6.4 11.2a1 1 0 01-1.4-1.4L10 4.8" />
    </svg>
  );
}

export function IconArrowDown({ size = 14, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...line} strokeWidth={1.8} style={s} className={className}>
      <path d="M8 3v10M3.5 8.5L8 13l4.5-4.5" />
    </svg>
  );
}

export function IconChevronRight({ size = 10, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...line} strokeWidth={2} style={s} className={className}>
      <path d="M6 3.5L10.5 8 6 12.5" />
    </svg>
  );
}

export function IconDiff({ size = 14, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...line} style={s} className={className}>
      <path d="M5 2.5v6M2 5.5h6M2 12.5h6M11 3v10M11 13l-2-2M11 13l2-2" />
    </svg>
  );
}

export function IconEditLine({ size = 12, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...line} style={s} className={className}>
      <path d="M10.5 2.5l3 3L6 13H3v-3l7.5-7.5z" />
    </svg>
  );
}

export function IconCommand({ size = 12, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...line} style={s} className={className}>
      <path d="M3 4.5l3.5 3.5L3 11.5M8 12h5" />
    </svg>
  );
}

export function IconSpinner({ size = 12, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={s} className={className}>
      <path d="M8 2a6 6 0 016 6" />
    </svg>
  );
}

export function IconRetry({ size = 12, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...line} style={s} className={className}>
      <path d="M2.5 8a5.5 5.5 0 109.6-3.6M12.5 2v3h-3" />
    </svg>
  );
}

export function IconMove({ size = 12, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...line} style={s} className={className}>
      <path d="M2 8h11M10 5l3 3-3 3" />
    </svg>
  );
}

export function IconBrain({ size = 12, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...line} style={s} className={className}>
      <path d="M6 13.5V3a2 2 0 00-3.5 1.4A2.3 2.3 0 002 8.5a2.3 2.3 0 001.5 3.6A2 2 0 006 13.5zM10 13.5V3a2 2 0 013.5 1.4A2.3 2.3 0 0114 8.5a2.3 2.3 0 01-1.5 3.6A2 2 0 0110 13.5z" />
    </svg>
  );
}

export function IconAt({ size = 14, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...line} style={s} className={className}>
      <circle cx="8" cy="8" r="2.5" />
      <path d="M10.5 8v1a2 2 0 004 0V8a6.5 6.5 0 10-2.6 5.2" />
    </svg>
  );
}

export function IconSlash({ size = 14, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...line} style={s} className={className}>
      <rect x="2" y="2" width="12" height="12" rx="3" />
      <path d="M9.5 5l-3 6" />
    </svg>
  );
}

/** A right-hand panel growing leftward. */
export function IconPanelWiden({ size = 14, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...line} style={s} className={className}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <line x1="9.5" y1="3" x2="9.5" y2="13" />
      <path d="M6.5 6.5L5 8l1.5 1.5" />
    </svg>
  );
}

/** A right-hand panel shrinking back. */
export function IconPanelNarrow({ size = 14, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...line} style={s} className={className}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <line x1="6.5" y1="3" x2="6.5" y2="13" />
      <path d="M9.5 6.5L11 8l-1.5 1.5" />
    </svg>
  );
}

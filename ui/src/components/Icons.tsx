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

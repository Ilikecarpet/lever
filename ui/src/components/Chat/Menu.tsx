import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconCheck, IconChevron } from "../Icons";
import styles from "./Chat.module.css";

export interface MenuItem {
  value: string;
  label: string;
  description?: string;
  /** A dot colour, for menus whose choices carry a meaning (modes). */
  tone?: string;
}

/**
 * A pill that opens a list of choices above it — the composer's mode, model
 * and effort pickers. Keyboard: arrows to move, Enter to pick, Esc to close.
 */
export function PickerMenu({
  items,
  value,
  onChange,
  title,
  icon,
  align = "left",
  heading,
}: {
  items: MenuItem[];
  value: string;
  onChange: (value: string) => void;
  title?: string;
  icon?: ReactNode;
  align?: "left" | "right";
  heading?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const current = items.find((i) => i.value === value);

  useEffect(() => {
    if (!open) return;
    setHover(Math.max(0, items.findIndex((i) => i.value === value)));
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open, items, value]);

  const pick = (v: string) => {
    setOpen(false);
    if (v !== value) onChange(v);
  };

  return (
    <div
      className={styles.menuWrap}
      ref={ref}
      onKeyDown={(e) => {
        if (!open) return;
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const d = e.key === "ArrowDown" ? 1 : -1;
          setHover((h) => (h + d + items.length) % items.length);
        } else if (e.key === "Enter") {
          e.preventDefault();
          pick(items[hover].value);
        }
      }}
    >
      <button className={`${styles.pill}${open ? ` ${styles.pillOpen}` : ""}`} onClick={() => setOpen((o) => !o)} title={title}>
        {current?.tone && <span className={styles.toneDot} style={{ background: current.tone }} />}
        {icon}
        <span>{current?.label ?? value}</span>
        <IconChevron size={8} />
      </button>
      {open && (
        <div className={`${styles.menu} ${align === "right" ? styles.menuRight : ""}`} role="listbox">
          {heading && <div className={styles.menuHeading}>{heading}</div>}
          {items.map((item, i) => (
            <button
              key={item.value}
              role="option"
              aria-selected={item.value === value}
              className={`${styles.menuItem}${i === hover ? ` ${styles.menuItemHover}` : ""}`}
              onMouseEnter={() => setHover(i)}
              onClick={() => pick(item.value)}
            >
              <span className={styles.menuCheck}>{item.value === value && <IconCheck size={11} />}</span>
              <span className={styles.menuText}>
                <span className={styles.menuLabel}>
                  {item.tone && <span className={styles.toneDot} style={{ background: item.tone }} />}
                  {item.label}
                </span>
                {item.description && <span className={styles.menuDesc}>{item.description}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

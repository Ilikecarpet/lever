import type { ReactNode } from "react";
import styles from "./ContextMenu.module.css";

interface ConfirmAccordionProps {
  open: boolean;
  warning: ReactNode;
  confirmLabel: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
}

/** An inline confirmation that slides open under a context menu's item. */
export default function ConfirmAccordion({
  open,
  warning,
  confirmLabel,
  onCancel,
  onConfirm,
}: ConfirmAccordionProps) {
  return (
    <div className={`${styles.confirm}${open ? ` ${styles.confirmOpen}` : ""}`}>
      <div className={styles.confirmInner}>
        <div className={styles.confirmWarning}>{warning}</div>
        <div className={styles.confirmActions}>
          <button className={`${styles.confirmCancel} lv-press`} onClick={onCancel}>
            Cancel
          </button>
          <button
            className={`${styles.confirmYes} ${styles.confirmYesDanger} lv-press`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

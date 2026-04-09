import { useRef, useEffect } from "react";
import { useTerminalStore } from "../../stores/terminalStore";
import { usePty } from "../../hooks/usePty";
import "@xterm/xterm/css/xterm.css";
import styles from "./TerminalView.module.css";

interface Props {
  tabId: string;
}

export default function TerminalView({ tabId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { focus, fit } = usePty(tabId, containerRef);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const isActive = activeTabId === tabId;

  useEffect(() => {
    if (isActive) {
      fit();
      focus();
    }
  }, [isActive, fit, focus]);

  return (
    <div
      className={`${styles.termPanel}${isActive ? ` ${styles.active}` : ""}`}
    >
      <div className={styles.termContainer} ref={containerRef} />
    </div>
  );
}

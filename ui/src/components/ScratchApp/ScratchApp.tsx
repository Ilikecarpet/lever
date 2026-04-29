import { useRef, useEffect } from "react";
import { usePty, focusPty } from "../../hooks/usePty";
import "@xterm/xterm/css/xterm.css";
import styles from "./ScratchApp.module.css";

const PANE_ID = "scratch-pane";

export default function ScratchApp() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { fit } = usePty(PANE_ID, containerRef);

  useEffect(() => {
    fit();
    focusPty(PANE_ID);
  }, [fit]);

  return (
    <div className={styles.container} onMouseDown={() => focusPty(PANE_ID)}>
      <div className={styles.termContainer} ref={containerRef} />
    </div>
  );
}

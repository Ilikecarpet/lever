import { useRef, useEffect, useCallback } from "react";
import type { PaneNode } from "../../types/pane";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { usePty, focusPty } from "../../hooks/usePty";
import Divider from "./Divider";
import "@xterm/xterm/css/xterm.css";
import styles from "./PaneView.module.css";

function LeafPane({ id, isActive, visible }: { id: string; isActive: boolean; visible: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { fit } = usePty(id, containerRef);
  const setActivePane = useWorkspaceStore((s) => s.setActivePane);

  useEffect(() => {
    if (visible && isActive) {
      fit();
      // focusPty reads directly from the module-level store,
      // so it works even right after a remount/reattach
      focusPty(id);
    }
  }, [id, isActive, visible, fit]);

  const handleClick = useCallback(() => {
    setActivePane(id);
  }, [id, setActivePane]);

  return (
    <div
      className={`${styles.leafPane}${isActive ? ` ${styles.leafActive}` : ""}`}
      onMouseDown={handleClick}
    >
      <div className={styles.termContainer} ref={containerRef} />
    </div>
  );
}

interface PaneViewProps {
  node: PaneNode;
  activePaneId: string;
  visible?: boolean;
}

export default function PaneView({ node, activePaneId, visible = true }: PaneViewProps) {
  if (node.type === "leaf") {
    return <LeafPane id={node.id} isActive={node.id === activePaneId} visible={visible} />;
  }

  const { direction, ratio, children } = node;
  const splitId = node.id;
  const resizePane = useWorkspaceStore((s) => s.resizePane);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleResize = useCallback(
    (delta: number) => {
      const container = containerRef.current;
      if (!container) return;
      const size =
        direction === "vertical"
          ? container.clientWidth
          : container.clientHeight;
      if (size === 0) return;
      const ratioDelta = delta / size;
      const currentWs = useWorkspaceStore
        .getState()
        .workspaces.find(
          (w) => w.id === useWorkspaceStore.getState().activeWorkspaceId
        );
      if (!currentWs) return;
      const findRatio = (n: PaneNode): number | null => {
        if (n.type === "leaf") return null;
        if (n.id === splitId) return n.ratio;
        return findRatio(n.children[0]) ?? findRatio(n.children[1]);
      };
      const currentRatio = findRatio(currentWs.root) ?? ratio;
      resizePane(splitId, currentRatio + ratioDelta);
    },
    [direction, splitId, resizePane, ratio]
  );

  const firstBasis = `${ratio * 100}%`;

  return (
    <div
      ref={containerRef}
      className={`${styles.splitContainer} ${direction === "vertical" ? styles.splitVertical : styles.splitHorizontal}`}
    >
      <div className={styles.paneChild} style={{ flexBasis: firstBasis, flexGrow: 0, flexShrink: 0 }}>
        <PaneView node={children[0]} activePaneId={activePaneId} visible={visible} />
      </div>
      <Divider direction={direction} onResize={handleResize} />
      <div className={styles.paneChild} style={{ flex: 1 }}>
        <PaneView node={children[1]} activePaneId={activePaneId} visible={visible} />
      </div>
    </div>
  );
}

// ui/src/components/MainPanel/Divider.tsx
import { useState, useCallback, useEffect, useRef } from "react";
import styles from "./Divider.module.css";

interface Props {
  direction: "horizontal" | "vertical";
  onResize: (delta: number) => void;
}

export default function Divider({ direction, onResize }: Props) {
  const [dragging, setDragging] = useState(false);
  const startPos = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startPos.current = direction === "vertical" ? e.clientX : e.clientY;
      setDragging(true);
    },
    [direction]
  );

  useEffect(() => {
    if (!dragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const current = direction === "vertical" ? e.clientX : e.clientY;
      const delta = current - startPos.current;
      startPos.current = current;
      onResize(delta);
    };

    const handleMouseUp = () => {
      setDragging(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragging, direction, onResize]);

  return (
    <>
      <div
        className={`${styles.divider} ${styles[direction]}${dragging ? ` ${styles.dividerActive}` : ""}`}
        onMouseDown={handleMouseDown}
      />
      {dragging && (
        <div
          className={`${styles.dragOverlay} ${direction === "vertical" ? styles.dragOverlayVertical : styles.dragOverlayHorizontal}`}
        />
      )}
    </>
  );
}

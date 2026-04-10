import { useEffect } from "react";
import { tauriListen } from "../lib/tauri";

/**
 * Subscribe to a Tauri event for the lifetime of the component.
 * Automatically unlistens on cleanup.
 */
export function useTauriEvent<T>(
  event: string,
  callback: (payload: T) => void
): void {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    tauriListen<T>(event, (payload) => {
      if (!cancelled) callback(payload);
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event]);
}

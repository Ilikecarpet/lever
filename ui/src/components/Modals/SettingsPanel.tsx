import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as api from "../../lib/tauri";
import { usePanelStore } from "../../stores/panelStore";
import {
  useSettingsStore,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  SCROLLBACK_MIN,
  SCROLLBACK_MAX,
} from "../../stores/settingsStore";
import { useUiStore } from "../../stores/uiStore";
import shell from "./Panel.module.css";
import styles from "./SettingsPanel.module.css";

/** Project- and app-level settings. Per-service settings live in the inspector. */
export default function SettingsPanel() {
  const target = usePanelStore((s) => s.target);
  const close = usePanelStore((s) => s.close);

  const debugConsole = useSettingsStore((s) => s.debugConsole);
  const setDebugConsole = useSettingsStore((s) => s.setDebugConsole);
  const fontSize = useSettingsStore((s) => s.terminalFontSize);
  const setFontSize = useSettingsStore((s) => s.setTerminalFontSize);
  const scrollback = useSettingsStore((s) => s.terminalScrollback);
  const setScrollback = useSettingsStore((s) => s.setTerminalScrollback);
  const stopOnQuit = useSettingsStore((s) => s.stopServicesOnQuit);
  const setStopOnQuit = useSettingsStore((s) => s.setStopServicesOnQuit);

  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const hinge = sidebarCollapsed ? 0 : sidebarWidth;

  const [repoPath, setRepoPath] = useState("");
  /** Kept as text so the field can be empty mid-edit without snapping to a bound. */
  const [scrollbackText, setScrollbackText] = useState(String(scrollback));
  const mouseDownOnOverlay = useRef(false);

  const open = target?.kind === "settings";

  useEffect(() => {
    if (!open) return;
    setScrollbackText(String(useSettingsStore.getState().terminalScrollback));
    const projectId = api.getProjectId();
    if (!projectId) return;
    api.getRepoPath(projectId).then(setRepoPath).catch(() => setRepoPath(""));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  const handleChangeRepoPath = async () => {
    const projectId = api.getProjectId();
    if (!projectId) return;
    const selected = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: repoPath || undefined,
    });
    if (!selected) return;
    const next = selected as string;
    await api.setRepoPath(projectId, next);
    setRepoPath(next);
  };

  const commitScrollback = () => {
    const n = Number(scrollbackText);
    if (!Number.isFinite(n)) {
      setScrollbackText(String(scrollback));
      return;
    }
    setScrollback(n);
    setScrollbackText(String(useSettingsStore.getState().terminalScrollback));
  };

  return (
    <div
      className={shell.overlay}
      style={{ ["--hinge" as string]: `${hinge}px` }}
      onMouseDown={(e) => {
        mouseDownOnOverlay.current = e.target === e.currentTarget;
      }}
      onMouseUp={(e) => {
        if (mouseDownOnOverlay.current && e.target === e.currentTarget) close();
      }}
    >
      <div className={shell.scrim} />
      <div className={shell.panel}>
        <div className={shell.header}>
          <span className={shell.title}>Settings</span>
          <span className={shell.spacer} />
          <button className={shell.btn} onClick={close}>
            Done
          </button>
        </div>

        <div className={shell.scroll}>
          {/* ---- Terminal ---- */}
          <section className={styles.section}>
            <div className={shell.sectionHead}>
              <span className={shell.sectionName}>Terminal</span>
              <span className={shell.sectionRule} />
            </div>

            <div className={styles.row}>
              <div className={styles.rowText}>
                <div className={styles.rowLabel}>Type size</div>
                <div className={styles.rowSub}>Applies to open terminals straight away.</div>
              </div>
              <div className={styles.stepper}>
                <button
                  className={styles.stepBtn}
                  onClick={() => setFontSize(fontSize - 1)}
                  disabled={fontSize <= FONT_SIZE_MIN}
                  aria-label="Smaller"
                >
                  −
                </button>
                <span className={styles.stepValue}>{fontSize}</span>
                <button
                  className={styles.stepBtn}
                  onClick={() => setFontSize(fontSize + 1)}
                  disabled={fontSize >= FONT_SIZE_MAX}
                  aria-label="Larger"
                >
                  +
                </button>
              </div>
            </div>

            <div className={styles.preview} style={{ fontSize: `${fontSize}px` }}>
              <span className={styles.previewPrompt}>$</span> cargo run --bin api
            </div>

            <div className={styles.row}>
              <div className={styles.rowText}>
                <div className={styles.rowLabel}>Scrollback</div>
                <div className={styles.rowSub}>
                  Lines of history kept per terminal. Takes effect in terminals opened
                  after the change.
                </div>
              </div>
              <input
                className={styles.numInput}
                type="number"
                min={SCROLLBACK_MIN}
                max={SCROLLBACK_MAX}
                value={scrollbackText}
                onChange={(e) => setScrollbackText(e.target.value)}
                onBlur={commitScrollback}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                aria-label="Scrollback lines"
              />
            </div>
          </section>

          {/* ---- Services ---- */}
          <section className={styles.section}>
            <div className={shell.sectionHead}>
              <span className={shell.sectionName}>Services</span>
              <span className={shell.sectionRule} />
            </div>
            <Toggle
              label="Stop services when this window closes"
              sub="Off leaves them running in the background with nothing on screen to stop them."
              on={stopOnQuit}
              onChange={setStopOnQuit}
            />
          </section>

          {/* ---- Repository ---- */}
          <section className={styles.section}>
            <div className={shell.sectionHead}>
              <span className={shell.sectionName}>Repository</span>
              <span className={shell.sectionRule} />
            </div>
            <div className={styles.pathValue} title={repoPath || undefined}>
              {repoPath || <span className={styles.pathUnset}>Not set</span>}
            </div>
            <button className={shell.btn} onClick={handleChangeRepoPath}>
              Change…
            </button>
            <div className={shell.hint}>
              Worktrees are created beside this path, and services with no working
              directory of their own run from it.
            </div>
          </section>

          {/* ---- Advanced ---- */}
          <section className={styles.section}>
            <div className={shell.sectionHead}>
              <span className={shell.sectionName}>Advanced</span>
              <span className={shell.sectionRule} />
            </div>
            <Toggle
              label="Debug console"
              sub="A live log of what the backend is doing. Useful when a service will not start."
              on={debugConsole}
              onChange={setDebugConsole}
            />
          </section>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface ToggleProps {
  label: string;
  sub: string;
  on: boolean;
  onChange: (v: boolean) => void;
}

/** The sidebar's service lever, at settings scale. */
function Toggle({ label, sub, on, onChange }: ToggleProps) {
  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <div className={styles.rowLabel}>{label}</div>
        <div className={styles.rowSub}>{sub}</div>
      </div>
      <button
        role="switch"
        aria-checked={on}
        aria-label={label}
        className={`${styles.lever}${on ? ` ${styles.leverOn}` : ""}`}
        onClick={() => onChange(!on)}
      >
        <span className={styles.leverKnob} />
      </button>
    </div>
  );
}

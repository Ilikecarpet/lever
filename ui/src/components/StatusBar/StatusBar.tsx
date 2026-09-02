import { openUrl } from "@tauri-apps/plugin-opener";
import { useConfigStore } from "../../stores/configStore";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { useServiceStore } from "../../stores/serviceStore";
import { useGitStore } from "../../stores/gitStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useUpdateStore } from "../../stores/updateStore";
import { usePanelStore } from "../../stores/panelStore";
import { IconSplitV, IconSplitH, IconClose } from "../Icons";
import AgentMeter from "./AgentMeter";
import styles from "./StatusBar.module.css";

/** Past this the bar starts to crowd; the rest go in the "+N" tooltip. */
const MAX_PORTS = 5;

export default function StatusBar() {
  const groups = useConfigStore((s) => s.groups);
  const statuses = useServiceStore((s) => s.statuses);
  const statusMessage = useGitStore((s) => s.statusMessage);
  const statusKind = useGitStore((s) => s.statusKind);
  const splitPane = useWorkspaceStore((s) => s.splitPane);
  const closePane = useWorkspaceStore((s) => s.closePane);
  const updatePhase = useUpdateStore((s) => s.phase);
  const updateVersion = useUpdateStore((s) => s.version);
  const openSettings = usePanelStore((s) => s.openSettings);
  const ports = useServiceStore((s) => s.ports);
  const worktrees = useWorktreeStore((s) => s.worktrees);

  const allServices = groups.flatMap((g) => g.services);
  const total = allServices.length;
  const running = allServices.filter(
    (svc) => statuses[svc.id] === "running"
  ).length;

  // Every port anything is listening on, worktree services included — the
  // question "which port did that land on" is not scoped to a context. Named
  // by service so a bare number is never ambiguous.
  const listening = [
    ...allServices,
    ...worktrees.flatMap((w) => w.groups.flatMap((g) => g.services)),
  ].flatMap((svc) =>
    (ports[svc.id] ?? []).map((port) => ({ port, label: svc.label }))
  );
  const shown = listening.slice(0, MAX_PORTS);
  const overflow = listening.slice(MAX_PORTS);

  // A service's ports come out of the list together, so they can share one
  // name rather than repeating it: "web :5173 :24678", not "web :5173 web :24678".
  const portGroups: Array<{ label: string; ports: number[] }> = [];
  for (const { port, label } of shown) {
    const last = portGroups[portGroups.length - 1];
    if (last && last.label === label) last.ports.push(port);
    else portGroups.push({ label, ports: [port] });
  }

  return (
    <div className={styles.statusbar}>
      <span className={styles.serviceCount}>
        <span className={`${styles.countDot}${running > 0 ? ` ${styles.countDotActive}` : ""}`} />
        {running}/{total} running
      </span>
      {shown.length > 0 && (
        <span className={styles.ports}>
          {portGroups.map(({ label, ports: svcPorts }) => (
            <span key={`${label}-${svcPorts[0]}`} className={styles.portGroup}>
              <span className={styles.portLabel}>{label}</span>
              {svcPorts.map((port) => (
                <button
                  key={port}
                  className={styles.port}
                  title={`${label} — open http://localhost:${port}`}
                  onClick={() => openUrl(`http://localhost:${port}`).catch(() => {})}
                >
                  :{port}
                </button>
              ))}
            </span>
          ))}
          {overflow.length > 0 && (
            <span
              className={styles.portsMore}
              title={overflow.map((p) => `${p.label} — :${p.port}`).join("\n")}
            >
              +{overflow.length}
            </span>
          )}
        </span>
      )}
      <span
        className={`${styles.info}${statusMessage && statusKind === "error" ? ` ${styles.infoError}` : ""}`}
        title={statusMessage ?? undefined}
      >
        {statusMessage ?? ""}
      </span>
      {/* An announcement, not a second set of controls — the install button
          itself lives in Settings, which this points at. */}
      {(updatePhase === "available" || updatePhase === "downloading") && (
        <button
          className={styles.update}
          onClick={openSettings}
          title="Open Settings to install"
        >
          <span className={styles.updateDot} />
          {updatePhase === "downloading"
            ? `Updating to ${updateVersion}…`
            : `Version ${updateVersion} available`}
        </button>
      )}
      {/* Renders only when the focused pane has an agent we can read. */}
      <AgentMeter />
      <div className={styles.paneControls}>
        <button
          className={styles.paneBtn}
          onClick={() => splitPane("vertical")}
          title="Split vertical (⌘D)"
        >
          <IconSplitV size={13} />
        </button>
        <button
          className={styles.paneBtn}
          onClick={() => splitPane("horizontal")}
          title="Split horizontal (⌘⇧D)"
        >
          <IconSplitH size={13} />
        </button>
        <button
          className={styles.paneBtn}
          onClick={closePane}
          title="Close pane (⌘W)"
        >
          <IconClose size={11} />
        </button>
      </div>
    </div>
  );
}

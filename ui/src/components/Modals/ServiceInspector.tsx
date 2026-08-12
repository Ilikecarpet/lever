import { useState, useEffect, useMemo, useRef } from "react";
import { useConfigStore } from "../../stores/configStore";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { useServiceStore } from "../../stores/serviceStore";
import { useGitStore } from "../../stores/gitStore";
import { useUiStore } from "../../stores/uiStore";
import { usePanelStore } from "../../stores/panelStore";
import type { ServiceDef, ServiceGroup } from "../../types";
import shell from "./Panel.module.css";
import styles from "./ServiceInspector.module.css";

// ---------------------------------------------------------------------------
// Draft state
// ---------------------------------------------------------------------------

interface FormState {
  label: string;
  command: string;
  args: string;
  cwd: string;
  serviceType: string;
  stopCommand: string;
  description: string;
  /** "main:<groupId>" or "<worktreeId>:<groupId>" — where the service lives. */
  target: string;
}

const emptyForm: FormState = {
  label: "",
  command: "",
  args: "",
  cwd: "",
  serviceType: "service",
  stopCommand: "",
  description: "",
  target: "",
};

/** Encode a (worktreeId | null, groupId) pair into a single select value. */
function encodeTarget(worktreeId: string | null, groupId: string): string {
  return `${worktreeId ?? "main"}:${groupId}`;
}

/** Decode a select value back to (worktreeId | null, groupId). */
function decodeTarget(target: string): { worktreeId: string | null; groupId: string } {
  const idx = target.indexOf(":");
  if (idx === -1) return { worktreeId: null, groupId: target };
  const prefix = target.slice(0, idx);
  return { worktreeId: prefix === "main" ? null : prefix, groupId: target.slice(idx + 1) };
}

function formFor(svc: ServiceDef, worktreeId: string | null, groupId: string): FormState {
  return {
    label: svc.label,
    command: svc.command,
    args: svc.args.join(" "),
    cwd: svc.cwd,
    serviceType: svc.service_type,
    stopCommand: svc.stop_command.join(" "),
    description: svc.description,
    target: encodeTarget(worktreeId, groupId),
  };
}

/** A labelled block of groups — the main repo, or one worktree. */
interface Section {
  label: string;
  worktreeId: string | null;
  groups: ServiceGroup[];
}

const TYPE_HINT: Record<string, string> = {
  service: "Stays up until you switch it off. Gets a lever in the sidebar.",
  task: "Runs once and exits. Gets a ring while it works.",
};

// ---------------------------------------------------------------------------
// ServiceInspector
//
// A detail panel with no list of its own: the sidebar is the navigation, and
// the inspector is opened *on* whatever you picked there. It hinges on the
// sidebar's right edge, which is where it came from.
// ---------------------------------------------------------------------------

export default function ServiceInspector() {
  const target = usePanelStore((s) => s.target);
  const close = usePanelStore((s) => s.close);
  const editService = usePanelStore((s) => s.editService);

  const mainGroups = useConfigStore((s) => s.groups);
  const addService = useConfigStore((s) => s.addService);
  const updateService = useConfigStore((s) => s.updateService);
  const moveService = useConfigStore((s) => s.moveService);
  const removeService = useConfigStore((s) => s.removeService);
  const saveConfig = useConfigStore((s) => s.saveConfig);

  const worktrees = useWorktreeStore((s) => s.worktrees);
  const addWorktreeService = useWorktreeStore((s) => s.addWorktreeService);
  const updateWorktreeService = useWorktreeStore((s) => s.updateWorktreeService);
  const moveWorktreeService = useWorktreeStore((s) => s.moveWorktreeService);
  const removeWorktreeService = useWorktreeStore((s) => s.removeWorktreeService);

  const statuses = useServiceStore((s) => s.statuses);
  const stopService = useServiceStore((s) => s.stopService);
  const currentBranch = useGitStore((s) => s.gitInfo?.current_branch ?? "main");

  // The panel hinges on the sidebar's right edge, so it tracks the sidebar
  // live — including mid-drag while the sidebar is being resized.
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const hinge = sidebarCollapsed ? 0 : sidebarWidth;

  const [draft, setDraft] = useState<FormState>(emptyForm);
  /** The draft as it was when loaded — the only thing "dirty" is measured against. */
  const [baseline, setBaseline] = useState<FormState>(emptyForm);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const mouseDownOnOverlay = useRef(false);

  const sections: Section[] = useMemo(
    () => [
      { label: currentBranch, worktreeId: null, groups: mainGroups },
      ...worktrees.map((wt) => ({
        label: wt.branch,
        worktreeId: wt.id as string | null,
        groups: wt.groups,
      })),
    ],
    [currentBranch, mainGroups, worktrees]
  );

  function findGroup(worktreeId: string | null, groupId: string) {
    return sections
      .find((s) => s.worktreeId === worktreeId)
      ?.groups.find((g) => g.id === groupId);
  }
  function findService(worktreeId: string | null, groupId: string, serviceId: string) {
    return findGroup(worktreeId, groupId)?.services.find((s) => s.id === serviceId);
  }

  // Load the draft when the panel is pointed somewhere new. Keyed on `target`
  // alone: saving rewrites the config, and re-running on that would clobber
  // whatever is being typed.
  useEffect(() => {
    setConfirmDelete(false);
    // "settings" is a different panel's target; this one ignores it.
    if (!target || target.kind === "settings") return;

    if (target.kind === "new") {
      const next = { ...emptyForm, target: encodeTarget(target.worktreeId, target.groupId) };
      setDraft(next);
      setBaseline(next);
      window.setTimeout(() => nameRef.current?.focus(), 0);
      return;
    }

    const svc = findService(target.worktreeId, target.groupId, target.serviceId);
    if (!svc) {
      close();
      return;
    }
    const next = formFor(svc, target.worktreeId, target.groupId);
    setDraft(next);
    setBaseline(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);

  // Deliberately re-subscribed every render: closing commits whatever is in the
  // draft, so the handler has to see the current one, not the one from mount.
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleDone();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!target || target.kind === "settings") return null;

  // --- Store dispatch, section-aware ---------------------------------------

  function doAddService(worktreeId: string | null, groupId: string, svc: ServiceDef) {
    if (worktreeId) addWorktreeService(worktreeId, groupId, svc);
    else addService(groupId, svc);
  }
  function doUpdateService(
    worktreeId: string | null,
    groupId: string,
    serviceId: string,
    patch: Partial<ServiceDef>
  ) {
    if (worktreeId) updateWorktreeService(worktreeId, groupId, serviceId, patch);
    else updateService(groupId, serviceId, patch);
  }
  function doMoveService(
    worktreeId: string | null,
    serviceId: string,
    fromGroupId: string,
    toGroupId: string
  ) {
    if (worktreeId) moveWorktreeService(worktreeId, serviceId, fromGroupId, toGroupId);
    else moveService(serviceId, fromGroupId, toGroupId);
  }
  function doRemoveService(worktreeId: string | null, groupId: string, serviceId: string) {
    if (worktreeId) removeWorktreeService(worktreeId, groupId, serviceId);
    else removeService(groupId, serviceId);
  }

  // --- Commit ---------------------------------------------------------------

  const draftValid = draft.label.trim() !== "" && draft.command.trim() !== "";

  function draftPatch(): Partial<ServiceDef> {
    return {
      label: draft.label.trim(),
      command: draft.command.trim(),
      args: draft.args.trim() ? draft.args.trim().split(/\s+/) : [],
      cwd: draft.cwd.trim(),
      service_type: draft.serviceType,
      stop_command: draft.stopCommand.trim() ? draft.stopCommand.trim().split(/\s+/) : [],
      description: draft.description.trim(),
    };
  }

  /** Write an edited service back, moving it if the group changed. */
  function commitEdit(): boolean {
    if (!target || target.kind !== "service" || !draftValid) return false;
    const { worktreeId, groupId } = decodeTarget(draft.target);
    if (!findGroup(worktreeId, groupId)) return false;

    const patch = draftPatch();

    if (target.worktreeId === worktreeId && target.groupId === groupId) {
      doUpdateService(worktreeId, target.groupId, target.serviceId, patch);
    } else if (target.worktreeId === worktreeId) {
      doUpdateService(worktreeId, target.groupId, target.serviceId, patch);
      doMoveService(worktreeId, target.serviceId, target.groupId, groupId);
    } else {
      // Across branches there is no move — lift it out of one and drop it in
      // the other, keeping the id so the runtime keeps tracking the process.
      const old = findService(target.worktreeId, target.groupId, target.serviceId);
      if (!old) return false;
      doRemoveService(target.worktreeId, target.groupId, target.serviceId);
      doAddService(worktreeId, groupId, { ...old, ...patch } as ServiceDef);
    }
    saveConfig();
    return true;
  }

  function handleSave() {
    if (!target || !draftValid) return;

    if (target.kind === "service") {
      if (commitEdit()) {
        const { worktreeId, groupId } = decodeTarget(draft.target);
        setBaseline(draft);
        // Re-point at where it ended up, so a move keeps the panel on it.
        if (worktreeId !== target.worktreeId || groupId !== target.groupId) {
          editService(worktreeId, groupId, target.serviceId);
        }
      }
      return;
    }
    if (target.kind !== "new") return;

    const { worktreeId, groupId } = decodeTarget(draft.target);
    if (!findGroup(worktreeId, groupId)) return;

    // Service ids are referenced by the runtime, so they have to be unique
    // across every branch, not just this group.
    const taken = sections.flatMap((s) => s.groups.flatMap((g) => g.services.map((sv) => sv.id)));
    const base = draft.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || "service";
    let id = base;
    let n = 1;
    while (taken.includes(id)) id = `${base}-${++n}`;

    doAddService(worktreeId, groupId, { id, ...draftPatch() } as ServiceDef);
    saveConfig();
    setBaseline(draft);
    editService(worktreeId, groupId, id);
  }

  /** Leaving saves rather than dropping the work. A draft with no name or no
   *  command cannot be written at all, so that one is discarded — the disabled
   *  Save button is the standing warning that it is not yet saveable. */
  function handleDone() {
    if (dirty && target?.kind === "service") commitEdit();
    close();
  }

  function handleDelete() {
    if (!target || target.kind !== "service") return;
    if ((statuses[target.serviceId] ?? "stopped") === "running") stopService(target.serviceId);
    doRemoveService(target.worktreeId, target.groupId, target.serviceId);
    saveConfig();
    close();
  }

  // --- Derived --------------------------------------------------------------

  const isTask = draft.serviceType === "task";
  const where = decodeTarget(draft.target);
  const whereSection = where ? sections.find((s) => s.worktreeId === where.worktreeId) : null;
  const whereGroup = where ? findGroup(where.worktreeId, where.groupId) : null;

  const heading =
    target.kind === "new" ? "New service" : draft.label.trim() || "Untitled";

  return (
    <div
      className={shell.overlay}
      style={{ ["--hinge" as string]: `${hinge}px` }}
      onMouseDown={(e) => {
        mouseDownOnOverlay.current = e.target === e.currentTarget;
      }}
      onMouseUp={(e) => {
        if (mouseDownOnOverlay.current && e.target === e.currentTarget) handleDone();
      }}
    >
      {/* Dims the main panel only. The sidebar stays lit — it is where the
          panel came from, and it is still the navigation while this is open. */}
      <div className={shell.scrim} />
      <div className={shell.panel}>
        <div className={shell.header}>
          <span className={shell.title}>
            {target.kind === "new" ? "New service" : "Edit service"}
          </span>
          <span className={shell.spacer} />
          <button className={shell.btn} onClick={handleDone}>
            Done
          </button>
        </div>

        <div className={shell.scroll}>
          <div className={styles.detailName}>{heading}</div>

          <>
            <div className={styles.crumbs}>
              <span>{whereSection?.label ?? "—"}</span>
                <i>/</i>
                <span>{whereGroup?.label ?? "—"}</span>
                <i>/</i>
                <span>{isTask ? "task" : "service"}</span>
              </div>

              {/* The command as it will actually be spawned. */}
              <div className={styles.runStrip}>
                <span className={styles.runPrompt}>$</span>
                <span className={styles.runCmd}>
                  {draft.command.trim() || <span className={styles.runEmpty}>command</span>}
                  {draft.args.trim() && <em> {draft.args.trim()}</em>}
                </span>
              </div>
              <div className={styles.runCwd}>
                {draft.cwd.trim() ? `in ${draft.cwd.trim()}` : "in the repository root"}
              </div>

              <div className={styles.fieldSet}>
                <div className={shell.sectionHead}>
                  <span className={shell.sectionName}>Identity</span>
                  <span className={shell.sectionRule} />
                </div>
                <div className={styles.fRow}>
                  <div className={styles.f}>
                    <label htmlFor="si-name">Name</label>
                    <input
                      id="si-name"
                      ref={nameRef}
                      value={draft.label}
                      onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                      placeholder="e.g. Docker Compose"
                    />
                  </div>
                  <div className={styles.f}>
                    <label htmlFor="si-group">Group</label>
                    <select
                      id="si-group"
                      className={styles.mono}
                      value={draft.target}
                      onChange={(e) => setDraft({ ...draft, target: e.target.value })}
                    >
                      {sections.map((sec) => (
                        <optgroup
                          key={sec.worktreeId ?? "main"}
                          label={sec.worktreeId === null ? `${sec.label} (repo)` : sec.label}
                        >
                          {sec.groups.map((g) => (
                            <option
                              key={encodeTarget(sec.worktreeId, g.id)}
                              value={encodeTarget(sec.worktreeId, g.id)}
                            >
                              {g.label}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                </div>
                <div className={styles.f}>
                  <label htmlFor="si-desc">Description</label>
                  <input
                    id="si-desc"
                    value={draft.description}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                    placeholder="Optional"
                  />
                </div>
              </div>

              <div className={styles.fieldSet}>
                <div className={shell.sectionHead}>
                  <span className={shell.sectionName}>Execution</span>
                  <span className={shell.sectionRule} />
                </div>
                <div className={styles.fRow}>
                  <div className={styles.f}>
                    <label htmlFor="si-cmd">Command</label>
                    <input
                      id="si-cmd"
                      className={styles.mono}
                      value={draft.command}
                      onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                      placeholder="e.g. docker"
                    />
                  </div>
                  <div className={styles.f}>
                    <label htmlFor="si-args">Arguments</label>
                    <input
                      id="si-args"
                      className={styles.mono}
                      value={draft.args}
                      onChange={(e) => setDraft({ ...draft, args: e.target.value })}
                      placeholder="e.g. compose up"
                    />
                  </div>
                </div>
                <div className={styles.f}>
                  <label htmlFor="si-cwd">Working directory</label>
                  <input
                    id="si-cwd"
                    className={styles.mono}
                    value={draft.cwd}
                    onChange={(e) => setDraft({ ...draft, cwd: e.target.value })}
                    placeholder="Defaults to the repository root"
                  />
                </div>
                <div className={styles.fRow}>
                  <div className={styles.f}>
                    <label>Type</label>
                    <div className={styles.seg} role="radiogroup" aria-label="Service type">
                      {(["service", "task"] as const).map((t) => (
                        <button
                          key={t}
                          type="button"
                          role="radio"
                          aria-checked={draft.serviceType === t}
                          className={`${styles.segBtn}${
                            draft.serviceType === t ? ` ${styles.segBtnOn}` : ""
                          }`}
                          onClick={() => setDraft({ ...draft, serviceType: t })}
                        >
                          {t === "service" ? "Service" : "Task"}
                        </button>
                      ))}
                    </div>
                    <div className={shell.hint}>{TYPE_HINT[draft.serviceType]}</div>
                  </div>
                  {/* A task exits on its own, so a teardown command has nothing
                      to tear down — the field stays so the value isn't lost,
                      but it is out of the way. */}
                  <div className={`${styles.f}${isTask ? ` ${styles.fMuted}` : ""}`}>
                    <label htmlFor="si-stop">Stop command</label>
                    <input
                      id="si-stop"
                      className={styles.mono}
                      value={draft.stopCommand}
                      disabled={isTask}
                      onChange={(e) => setDraft({ ...draft, stopCommand: e.target.value })}
                      placeholder={isTask ? "Not used for tasks" : "Optional — defaults to SIGTERM"}
                    />
                  </div>
                </div>
              </div>
            </>
        </div>

        <div className={shell.footer}>
              {target.kind === "service" && (
                <button
                  className={`${shell.btn} ${shell.btnDanger} ${shell.btnSm}`}
                  onClick={() => setConfirmDelete((v) => !v)}
                >
                  Delete {isTask ? "task" : "service"}
                </button>
              )}
              <span className={shell.spacer} />
              {dirty && target.kind === "service" && (
                <button
                  className={`${shell.btn} ${shell.btnGhost}`}
                  onClick={() => setDraft(baseline)}
                >
                  Revert
                </button>
              )}
              <button
                className={`${shell.btn} ${shell.btnPrimary}`}
                onClick={handleSave}
                disabled={!draftValid || (target.kind === "service" && !dirty)}
              >
                {target.kind === "new" ? "Add service" : dirty ? "Save" : "Saved"}
              </button>
            </div>

            <div className={styles.confirm} data-open={confirmDelete ? "1" : "0"}>
              <div className={styles.confirmInner}>
                <div className={styles.confirmBox}>
                  <div className={styles.confirmMsg}>
                    Delete <b>{draft.label.trim() || "this service"}</b> permanently.
                    {target.kind === "service" &&
                      (statuses[target.serviceId] ?? "stopped") === "running" &&
                      " It is running — it will be stopped first."}
                  </div>
                  <div className={styles.confirmActions}>
                    <button className={styles.confirmNo} onClick={() => setConfirmDelete(false)}>
                      Cancel
                    </button>
                    <button className={styles.confirmYes} onClick={handleDelete}>
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            </div>
      </div>
    </div>
  );
}

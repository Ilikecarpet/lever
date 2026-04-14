import { useState, useRef, useEffect } from "react";
import { useConfigStore } from "../../stores/configStore";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { useGitStore } from "../../stores/gitStore";
import type { ServiceDef, ServiceGroup } from "../../types";
import { IconBranch } from "../Icons";
import styles from "./ConfigModal.module.css";

interface Props {
  open: boolean;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

interface FormState {
  /** "main:<groupId>" or "<worktreeId>:<groupId>" */
  target: string;
  label: string;
  command: string;
  args: string;
  cwd: string;
  serviceType: string;
  stopCommand: string;
  description: string;
}

const emptyForm: FormState = {
  target: "",
  label: "",
  command: "",
  args: "",
  cwd: "",
  serviceType: "service",
  stopCommand: "",
  description: "",
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
  const groupId = target.slice(idx + 1);
  return { worktreeId: prefix === "main" ? null : prefix, groupId };
}

// ---------------------------------------------------------------------------
// Section — a labelled block of groups (main repo or a worktree)
// ---------------------------------------------------------------------------

interface Section {
  label: string;
  worktreeId: string | null;
  groups: ServiceGroup[];
}

// ---------------------------------------------------------------------------
// ConfigModal
// ---------------------------------------------------------------------------

export default function ConfigModal({ open, onClose }: Props) {
  // Main repo groups
  const mainGroups = useConfigStore((s) => s.groups);
  const addGroup = useConfigStore((s) => s.addGroup);
  const removeGroup = useConfigStore((s) => s.removeGroup);
  const updateGroup = useConfigStore((s) => s.updateGroup);
  const addService = useConfigStore((s) => s.addService);
  const updateService = useConfigStore((s) => s.updateService);
  const moveService = useConfigStore((s) => s.moveService);
  const removeService = useConfigStore((s) => s.removeService);
  const saveConfig = useConfigStore((s) => s.saveConfig);

  // Worktree groups
  const worktrees = useWorktreeStore((s) => s.worktrees);
  const addWorktreeGroup = useWorktreeStore((s) => s.addWorktreeGroup);
  const removeWorktreeGroup = useWorktreeStore((s) => s.removeWorktreeGroup);
  const updateWorktreeGroup = useWorktreeStore((s) => s.updateWorktreeGroup);
  const addWorktreeService = useWorktreeStore((s) => s.addWorktreeService);
  const updateWorktreeService = useWorktreeStore((s) => s.updateWorktreeService);
  const moveWorktreeService = useWorktreeStore((s) => s.moveWorktreeService);
  const removeWorktreeService = useWorktreeStore((s) => s.removeWorktreeService);

  const currentBranch = useGitStore((s) => s.gitInfo?.current_branch ?? "main");

  const [editing, setEditing] = useState<{
    worktreeId: string | null;
    groupId: string;
    serviceId: string;
  } | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);

  const [renamingGroupKey, setRenamingGroupKey] = useState<string | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState<string | null>(null);
  const mouseDownOnOverlay = useRef(false);
  const mouseDownOnFormOverlay = useRef(false);

  useEffect(() => {
    if (renamingGroupKey && renameRef.current) {
      renameRef.current.focus();
    }
  }, [renamingGroupKey]);

  useEffect(() => {
    if (!confirmDeleteGroup) return;
    const timer = setTimeout(() => setConfirmDeleteGroup(null), 2000);
    return () => clearTimeout(timer);
  }, [confirmDeleteGroup]);

  if (!open) return null;

  // Build sections
  const sections: Section[] = [
    { label: currentBranch, worktreeId: null, groups: mainGroups },
    ...worktrees.map((wt) => ({
      label: wt.branch,
      worktreeId: wt.id as string | null,
      groups: wt.groups,
    })),
  ];

  // All groups flattened for the form dropdown
  const allGroups: { worktreeId: string | null; sectionLabel: string; group: ServiceGroup }[] = [];
  for (const sec of sections) {
    for (const g of sec.groups) {
      allGroups.push({ worktreeId: sec.worktreeId, sectionLabel: sec.label, group: g });
    }
  }

  const handleDone = () => onClose();

  // --- Group-level helpers ---

  function groupKey(worktreeId: string | null, groupId: string) {
    return encodeTarget(worktreeId, groupId);
  }

  function doAddGroup(worktreeId: string | null, group: ServiceGroup) {
    if (worktreeId) {
      addWorktreeGroup(worktreeId, group);
    } else {
      addGroup(group);
    }
  }

  function doRemoveGroup(worktreeId: string | null, groupId: string) {
    if (worktreeId) {
      removeWorktreeGroup(worktreeId, groupId);
    } else {
      removeGroup(groupId);
    }
  }

  function doUpdateGroup(worktreeId: string | null, groupId: string, patch: Partial<ServiceGroup>) {
    if (worktreeId) {
      updateWorktreeGroup(worktreeId, groupId, patch);
    } else {
      updateGroup(groupId, patch);
    }
  }

  function doAddService(worktreeId: string | null, groupId: string, svc: ServiceDef) {
    if (worktreeId) {
      addWorktreeService(worktreeId, groupId, svc);
    } else {
      addService(groupId, svc);
    }
  }

  function doUpdateService(worktreeId: string | null, groupId: string, serviceId: string, patch: Partial<ServiceDef>) {
    if (worktreeId) {
      updateWorktreeService(worktreeId, groupId, serviceId, patch);
    } else {
      updateService(groupId, serviceId, patch);
    }
  }

  function doMoveService(worktreeId: string | null, serviceId: string, fromGroupId: string, toGroupId: string) {
    if (worktreeId) {
      moveWorktreeService(worktreeId, serviceId, fromGroupId, toGroupId);
    } else {
      moveService(serviceId, fromGroupId, toGroupId);
    }
  }

  function doRemoveService(worktreeId: string | null, groupId: string, serviceId: string) {
    if (worktreeId) {
      removeWorktreeService(worktreeId, groupId, serviceId);
    } else {
      removeService(groupId, serviceId);
    }
  }

  // --- Form handlers ---

  const openAddForm = () => {
    setEditing(null);
    // Default target: first available group, or auto-create one in main
    let target = "";
    if (allGroups.length > 0) {
      const first = allGroups[0];
      target = encodeTarget(first.worktreeId, first.group.id);
    } else {
      // Auto-create a group in main
      let n = 1;
      while (mainGroups.some((g) => g.id === `group-${n}`)) n++;
      const gid = `group-${n}`;
      addGroup({ id: gid, label: `Group ${n}`, services: [] });
      saveConfig();
      target = encodeTarget(null, gid);
    }
    setForm({ ...emptyForm, target });
    setFormOpen(true);
  };

  const openEditForm = (worktreeId: string | null, groupId: string, svc: ServiceDef) => {
    setEditing({ worktreeId, groupId, serviceId: svc.id });
    setForm({
      target: encodeTarget(worktreeId, groupId),
      label: svc.label,
      command: svc.command,
      args: svc.args.join(" "),
      cwd: svc.cwd,
      serviceType: svc.service_type,
      stopCommand: svc.stop_command.join(" "),
      description: svc.description,
    });
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
  };

  const handleSave = () => {
    const label = form.label.trim();
    const command = form.command.trim();
    if (!label || !command) return;

    const { worktreeId, groupId } = decodeTarget(form.target);
    if (!groupId) return;

    // Verify group exists
    const sec = sections.find((s) => s.worktreeId === worktreeId);
    if (!sec || !sec.groups.some((g) => g.id === groupId)) return;

    const args = form.args.trim() ? form.args.trim().split(/\s+/) : [];
    const stopCommand = form.stopCommand.trim()
      ? form.stopCommand.trim().split(/\s+/)
      : [];

    if (editing) {
      const svc: Partial<ServiceDef> = {
        label,
        command,
        args,
        cwd: form.cwd.trim(),
        service_type: form.serviceType,
        stop_command: stopCommand,
        description: form.description.trim(),
      };

      // Same section & group — just update
      if (editing.worktreeId === worktreeId && editing.groupId === groupId) {
        doUpdateService(worktreeId, editing.groupId, editing.serviceId, svc);
      } else if (editing.worktreeId === worktreeId) {
        // Same section, different group — update then move
        doUpdateService(worktreeId, editing.groupId, editing.serviceId, svc);
        doMoveService(worktreeId, editing.serviceId, editing.groupId, groupId);
      } else {
        // Cross-section move: remove from old, add to new
        const oldSec = sections.find((s) => s.worktreeId === editing.worktreeId);
        const oldGroup = oldSec?.groups.find((g) => g.id === editing.groupId);
        const oldSvc = oldGroup?.services.find((s) => s.id === editing.serviceId);
        if (oldSvc) {
          doRemoveService(editing.worktreeId, editing.groupId, editing.serviceId);
          const fullSvc: ServiceDef = { ...oldSvc, ...svc } as ServiceDef;
          doAddService(worktreeId, groupId, fullSvc);
        }
      }
    } else {
      // Collect all service IDs across all sections for uniqueness
      const allIds = sections.flatMap((s) => s.groups.flatMap((g) => g.services.map((sv) => sv.id)));
      let baseId = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      let id = baseId;
      let n = 1;
      while (allIds.includes(id)) {
        id = baseId + "-" + ++n;
      }

      const svc: ServiceDef = {
        id,
        label,
        command,
        args,
        cwd: form.cwd.trim(),
        service_type: form.serviceType,
        stop_command: stopCommand,
        description: form.description.trim(),
      };
      doAddService(worktreeId, groupId, svc);
    }

    saveConfig();
    closeForm();
  };

  const handleDeleteService = (worktreeId: string | null, groupId: string, serviceId: string) => {
    doRemoveService(worktreeId, groupId, serviceId);
    saveConfig();
  };

  const handleDeleteGroup = (worktreeId: string | null, groupId: string) => {
    const key = groupKey(worktreeId, groupId);
    const sec = sections.find((s) => s.worktreeId === worktreeId);
    const g = sec?.groups.find((gr) => gr.id === groupId);
    if (g && g.services.length > 0 && confirmDeleteGroup !== key) {
      setConfirmDeleteGroup(key);
      return;
    }
    doRemoveGroup(worktreeId, groupId);
    saveConfig();
    setConfirmDeleteGroup(null);
  };

  const handleRenameConfirm = (worktreeId: string | null, groupId: string, value: string) => {
    const name = value.trim();
    if (name) {
      doUpdateGroup(worktreeId, groupId, { label: name });
      saveConfig();
    }
    setRenamingGroupKey(null);
  };

  const handleGroupSelectChange = (value: string) => {
    if (value === "__new__") {
      const name = window.prompt("New group name:");
      if (!name) {
        setForm((f) => ({ ...f, target: allGroups[0] ? encodeTarget(allGroups[0].worktreeId, allGroups[0].group.id) : "" }));
        return;
      }
      const gid = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      if (!mainGroups.find((g) => g.id === gid)) {
        addGroup({ id: gid, label: name, services: [] });
      }
      setForm((f) => ({ ...f, target: encodeTarget(null, gid) }));
    } else {
      setForm((f) => ({ ...f, target: value }));
    }
  };

  return (
    <>
      {/* ---- Service list modal ---- */}
      <div
        className={styles.overlay}
        onMouseDown={(e) => { mouseDownOnOverlay.current = e.target === e.currentTarget; }}
        onMouseUp={(e) => {
          if (mouseDownOnOverlay.current && e.target === e.currentTarget) handleDone();
        }}
      >
        <div className={styles.modal}>
          <div className={styles.modalHeader}>
            <h2>Manage Services</h2>
            <div className={styles.headerActions}>
              <button
                className={`${styles.mBtn} ${styles.mBtnPrimary}`}
                onClick={openAddForm}
              >
                + Add Service
              </button>
              <button className={styles.mBtn} onClick={handleDone}>
                Done
              </button>
            </div>
          </div>
          <div className={styles.modalBody}>
            {sections.map((sec) => (
              <div key={sec.worktreeId ?? "main"}>
                <div className={styles.sectionHeader}>
                  <IconBranch size={12} />
                  <span>{sec.label}</span>
                  {sec.worktreeId === null && (
                    <span className={styles.sectionBadge}>main</span>
                  )}
                </div>

                {sec.groups.length === 0 && (
                  <div className={styles.emptyGroup}>No groups</div>
                )}

                {sec.groups.map((group) => {
                  const key = groupKey(sec.worktreeId, group.id);
                  return (
                    <div key={key} className={styles.groupCard}>
                      <div className={styles.groupHeader}>
                        {renamingGroupKey === key ? (
                          <input
                            ref={renameRef}
                            className={styles.renameInput}
                            defaultValue={group.label}
                            onKeyDown={(e) => {
                              if (e.key === "Enter")
                                handleRenameConfirm(sec.worktreeId, group.id, e.currentTarget.value);
                              if (e.key === "Escape") setRenamingGroupKey(null);
                            }}
                            onBlur={(e) =>
                              handleRenameConfirm(sec.worktreeId, group.id, e.currentTarget.value)
                            }
                          />
                        ) : (
                          <span className={styles.groupLabel}>{group.label}</span>
                        )}
                        <div className={styles.groupHeaderActions}>
                          <button
                            className={`${styles.mBtn} ${styles.mBtnSm}`}
                            onClick={() => setRenamingGroupKey(key)}
                          >
                            Rename
                          </button>
                          <button
                            className={`${styles.mBtn} ${styles.mBtnSm} ${styles.mBtnDanger}`}
                            onClick={() => handleDeleteGroup(sec.worktreeId, group.id)}
                          >
                            {confirmDeleteGroup === key ? "Confirm?" : "Delete"}
                          </button>
                        </div>
                      </div>

                      {group.services.length === 0 ? (
                        <div className={styles.emptyGroup}>No services yet</div>
                      ) : (
                        group.services.map((svc) => (
                          <div key={svc.id} className={styles.si}>
                            <div className={styles.siInfo}>
                              <div className={styles.siLabel}>
                                {svc.label}
                                <span className={styles.svcBadge}>
                                  {svc.service_type}
                                </span>
                              </div>
                              <div className={styles.siMeta}>
                                {svc.command} {svc.args.join(" ")}
                              </div>
                            </div>
                            <div className={styles.siActions}>
                              <button
                                className={`${styles.mBtn} ${styles.mBtnSm}`}
                                onClick={() => openEditForm(sec.worktreeId, group.id, svc)}
                              >
                                Edit
                              </button>
                              <button
                                className={`${styles.mBtn} ${styles.mBtnSm} ${styles.mBtnDanger}`}
                                onClick={() =>
                                  handleDeleteService(sec.worktreeId, group.id, svc.id)
                                }
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ---- Service form modal ---- */}
      {formOpen && (
        <div
          className={styles.formOverlay}
          onMouseDown={(e) => { mouseDownOnFormOverlay.current = e.target === e.currentTarget; }}
          onMouseUp={(e) => {
            if (mouseDownOnFormOverlay.current && e.target === e.currentTarget) closeForm();
          }}
        >
          <div className={styles.formModal}>
            <div className={styles.formTitle}>
              {editing ? "Edit Service" : "New Service"}
            </div>

            <div className={styles.formModalScroll}>
              <div className={styles.fgRow}>
                <div className={styles.fg}>
                  <label>Name</label>
                  <input
                    value={form.label}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, label: e.target.value }))
                    }
                    placeholder="e.g. Docker Compose"
                    autoFocus
                  />
                </div>
                <div className={styles.fg}>
                  <label>Group</label>
                  <select
                    value={form.target}
                    onChange={(e) =>
                      handleGroupSelectChange(e.target.value)
                    }
                  >
                    {sections.map((sec) => (
                      <optgroup
                        key={sec.worktreeId ?? "main"}
                        label={sec.worktreeId === null ? `${sec.label} (main)` : sec.label}
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
                    <option value="__new__">+ New Group...</option>
                  </select>
                </div>
              </div>

              <div className={styles.fgRow}>
                <div className={styles.fg}>
                  <label>Command</label>
                  <input
                    value={form.command}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, command: e.target.value }))
                    }
                    placeholder="e.g. docker"
                  />
                </div>
                <div className={styles.fg}>
                  <label>Arguments</label>
                  <input
                    value={form.args}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, args: e.target.value }))
                    }
                    placeholder="e.g. compose up"
                  />
                </div>
              </div>

              <div className={styles.fg}>
                <label>Working Directory</label>
                <input
                  value={form.cwd}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, cwd: e.target.value }))
                  }
                  placeholder="/path/to/project"
                />
              </div>

              <div className={styles.fgRow}>
                <div className={styles.fg}>
                  <label>Type</label>
                  <select
                    value={form.serviceType}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        serviceType: e.target.value,
                      }))
                    }
                  >
                    <option value="service">Service</option>
                    <option value="task">Task</option>
                  </select>
                </div>
                <div className={styles.fg}>
                  <label>Stop Command</label>
                  <input
                    value={form.stopCommand}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        stopCommand: e.target.value,
                      }))
                    }
                    placeholder="Optional"
                  />
                </div>
              </div>

              <div className={styles.fg}>
                <label>Description</label>
                <input
                  value={form.description}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      description: e.target.value,
                    }))
                  }
                  placeholder="Optional"
                />
              </div>
            </div>

            <div className={styles.formActions}>
              <button className={styles.mBtn} onClick={closeForm}>
                Cancel
              </button>
              <button
                className={`${styles.mBtn} ${styles.mBtnPrimary}`}
                onClick={handleSave}
              >
                {editing ? "Save Changes" : "Add Service"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

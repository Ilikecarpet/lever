import { useState, useRef, useEffect } from "react";
import { useConfigStore } from "../../stores/configStore";
import type { ServiceDef } from "../../types";
import styles from "./ConfigModal.module.css";

interface Props {
  open: boolean;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

interface FormState {
  groupId: string;
  label: string;
  command: string;
  args: string;
  cwd: string;
  serviceType: string;
  stopCommand: string;
  description: string;
}

const emptyForm: FormState = {
  groupId: "",
  label: "",
  command: "",
  args: "",
  cwd: "",
  serviceType: "service",
  stopCommand: "",
  description: "",
};

// ---------------------------------------------------------------------------
// ConfigModal
// ---------------------------------------------------------------------------

export default function ConfigModal({ open, onClose }: Props) {
  const groups = useConfigStore((s) => s.groups);
  const addGroup = useConfigStore((s) => s.addGroup);
  const removeGroup = useConfigStore((s) => s.removeGroup);
  const updateGroup = useConfigStore((s) => s.updateGroup);
  const addService = useConfigStore((s) => s.addService);
  const updateService = useConfigStore((s) => s.updateService);
  const moveService = useConfigStore((s) => s.moveService);
  const removeService = useConfigStore((s) => s.removeService);
  const saveConfig = useConfigStore((s) => s.saveConfig);

  const [editing, setEditing] = useState<{
    groupId: string;
    serviceId: string;
  } | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);

  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState<string | null>(null);

  useEffect(() => {
    if (renamingGroupId && renameRef.current) {
      renameRef.current.focus();
    }
  }, [renamingGroupId]);

  useEffect(() => {
    if (!confirmDeleteGroup) return;
    const timer = setTimeout(() => setConfirmDeleteGroup(null), 2000);
    return () => clearTimeout(timer);
  }, [confirmDeleteGroup]);

  if (!open) return null;

  const handleDone = () => onClose();

  const openAddForm = () => {
    setEditing(null);
    setForm({ ...emptyForm, groupId: groups[0]?.id ?? "" });
    setFormOpen(true);
  };

  const openEditForm = (groupId: string, svc: ServiceDef) => {
    setEditing({ groupId, serviceId: svc.id });
    setForm({
      groupId,
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

    const targetGroupId = form.groupId;
    if (targetGroupId === "__new__") return;

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

      if (editing.groupId === targetGroupId) {
        updateService(editing.groupId, editing.serviceId, svc);
      } else {
        updateService(editing.groupId, editing.serviceId, svc);
        moveService(editing.serviceId, editing.groupId, targetGroupId);
      }
    } else {
      const allIds = groups.flatMap((g) => g.services.map((s) => s.id));
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
      addService(targetGroupId, svc);
    }

    saveConfig();
    closeForm();
  };

  const handleDeleteService = (groupId: string, serviceId: string) => {
    removeService(groupId, serviceId);
    saveConfig();
  };

  const handleDeleteGroup = (groupId: string) => {
    const g = groups.find((gr) => gr.id === groupId);
    if (g && g.services.length > 0 && confirmDeleteGroup !== groupId) {
      setConfirmDeleteGroup(groupId);
      return;
    }
    removeGroup(groupId);
    saveConfig();
    setConfirmDeleteGroup(null);
  };

  const handleRenameConfirm = (groupId: string, value: string) => {
    const name = value.trim();
    if (name) {
      updateGroup(groupId, { label: name });
      saveConfig();
    }
    setRenamingGroupId(null);
  };

  const handleGroupSelectChange = (value: string) => {
    if (value === "__new__") {
      const name = window.prompt("New group name:");
      if (!name) {
        setForm((f) => ({ ...f, groupId: groups[0]?.id ?? "" }));
        return;
      }
      const gid = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      if (!groups.find((g) => g.id === gid)) {
        addGroup({ id: gid, label: name, services: [] });
      }
      setForm((f) => ({ ...f, groupId: gid }));
    } else {
      setForm((f) => ({ ...f, groupId: value }));
    }
  };

  return (
    <>
      {/* ---- Service list modal ---- */}
      <div
        className={styles.overlay}
        onClick={(e) => {
          if (e.target === e.currentTarget) handleDone();
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
            {groups.map((group) => (
              <div key={group.id} className={styles.groupCard}>
                <div className={styles.groupHeader}>
                  {renamingGroupId === group.id ? (
                    <input
                      ref={renameRef}
                      className={styles.renameInput}
                      defaultValue={group.label}
                      onKeyDown={(e) => {
                        if (e.key === "Enter")
                          handleRenameConfirm(group.id, e.currentTarget.value);
                        if (e.key === "Escape") setRenamingGroupId(null);
                      }}
                      onBlur={(e) =>
                        handleRenameConfirm(group.id, e.currentTarget.value)
                      }
                    />
                  ) : (
                    <span className={styles.groupLabel}>{group.label}</span>
                  )}
                  <div className={styles.groupHeaderActions}>
                    <button
                      className={`${styles.mBtn} ${styles.mBtnSm}`}
                      onClick={() => setRenamingGroupId(group.id)}
                    >
                      Rename
                    </button>
                    <button
                      className={`${styles.mBtn} ${styles.mBtnSm} ${styles.mBtnDanger}`}
                      onClick={() => handleDeleteGroup(group.id)}
                    >
                      {confirmDeleteGroup === group.id ? "Confirm?" : "Delete"}
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
                          onClick={() => openEditForm(group.id, svc)}
                        >
                          Edit
                        </button>
                        <button
                          className={`${styles.mBtn} ${styles.mBtnSm} ${styles.mBtnDanger}`}
                          onClick={() =>
                            handleDeleteService(group.id, svc.id)
                          }
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ---- Service form modal ---- */}
      {formOpen && (
        <div
          className={styles.formOverlay}
          onClick={(e) => {
            if (e.target === e.currentTarget) closeForm();
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
                    value={form.groupId}
                    onChange={(e) =>
                      handleGroupSelectChange(e.target.value)
                    }
                  >
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.label}
                      </option>
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

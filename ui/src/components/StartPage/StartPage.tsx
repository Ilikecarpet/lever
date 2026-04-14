import { useEffect, useState, useRef, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import type { ProjectMeta } from "../../types";
import * as api from "../../lib/tauri";
import styles from "./StartPage.module.css";

function timeAgo(unix: number): string {
  const diff = Math.floor(Date.now() / 1000) - unix;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(unix * 1000).toLocaleDateString();
}

export default function StartPage() {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    project: ProjectMeta;
  } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);

  const refresh = useCallback(async () => {
    const list = await api.listProjects();
    list.sort((a, b) => b.last_opened - a.last_opened);
    setProjects(list);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [contextMenu]);

  const handleOpen = async (id: string) => {
    await api.openProject(id);
    await getCurrentWindow().close();
  };

  const handleContextMenu = (e: React.MouseEvent, project: ProjectMeta) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, project });
  };

  const handleRename = (project: ProjectMeta) => {
    setContextMenu(null);
    setRenamingId(project.id);
    setRenameValue(project.name);
  };

  const handleRenameSubmit = async () => {
    if (renamingId && renameValue.trim()) {
      await api.renameProject(renamingId, renameValue.trim());
      setRenamingId(null);
      refresh();
    }
  };

  const handleDelete = async (project: ProjectMeta) => {
    setContextMenu(null);
    if (confirm(`Delete project "${project.name}"? This cannot be undone.`)) {
      await api.deleteProject(project.id);
      refresh();
    }
  };

  const handleClone = async (project: ProjectMeta) => {
    setContextMenu(null);
    const name = prompt("Name for the cloned project:", `${project.name} (copy)`);
    if (name) {
      await api.cloneProject(project.id, name);
      refresh();
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.title}>Lever</div>
        <div className={styles.subtitle}>Select a project or create a new one</div>
      </div>

      <div className={styles.actions}>
        <button className={styles.btnPrimary} onClick={() => setShowCreateModal(true)}>
          + New Project
        </button>
        <button className={styles.btnSecondary} onClick={() => setShowImportModal(true)}>
          Import Config
        </button>
      </div>

      <div className={styles.grid}>
        {projects.map((p) => (
          <div
            key={p.id}
            className={styles.card}
            onClick={() => {
              if (renamingId !== p.id) handleOpen(p.id);
            }}
            onContextMenu={(e) => handleContextMenu(e, p)}
          >
            <div className={styles.cardHeader}>
              {renamingId === p.id ? (
                <input
                  className={styles.renameInput}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={handleRenameSubmit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRenameSubmit();
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  autoFocus
                />
              ) : (
                <div className={styles.cardName}>{p.name}</div>
              )}
              <span className={styles.cardMeta}>
                {p.group_count} group{p.group_count !== 1 ? "s" : ""}
              </span>
            </div>
            <div className={styles.cardInfo}>
              {p.service_count} service{p.service_count !== 1 ? "s" : ""} · Last opened {timeAgo(p.last_opened)}
            </div>
            {p.service_names.length > 0 && (
              <div className={styles.tags}>
                {p.service_names.slice(0, 4).map((name) => (
                  <span key={name} className={styles.tag}>{name}</span>
                ))}
                {p.service_names.length > 4 && (
                  <span className={styles.tag}>+{p.service_names.length - 4}</span>
                )}
              </div>
            )}
          </div>
        ))}

        <div className={styles.emptyCard} onClick={() => setShowCreateModal(true)}>
          <div className={styles.emptyCardContent}>
            <div className={styles.emptyCardPlus}>+</div>
            <div className={styles.emptyCardLabel}>New Project</div>
          </div>
        </div>
      </div>

      <div className={styles.hint}>Right-click a project for options</div>

      {contextMenu && (
        <div
          className={styles.contextMenu}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button className={styles.contextMenuItem} onClick={() => handleRename(contextMenu.project)}>
            Rename
          </button>
          <button className={styles.contextMenuItem} onClick={() => handleClone(contextMenu.project)}>
            Clone
          </button>
          <button className={styles.contextMenuDanger} onClick={() => handleDelete(contextMenu.project)}>
            Delete
          </button>
        </div>
      )}

      {showCreateModal && (
        <CreateModal
          onClose={() => setShowCreateModal(false)}
          onCreated={(id) => {
            setShowCreateModal(false);
            refresh();
            handleOpen(id);
          }}
        />
      )}

      {showImportModal && (
        <ImportModal
          onClose={() => setShowImportModal(false)}
          onImported={() => {
            setShowImportModal(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function CreateModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [folderPath, setFolderPath] = useState("");
  const [name, setName] = useState("");
  const [isGitRepo, setIsGitRepo] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const mouseDownOnOverlay = useRef(false);

  const handlePickFolder = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (!selected) return;
    const path = selected as string;
    setFolderPath(path);
    setError("");

    // Auto-suggest name from folder name
    const folderName = path.split(/[/\\]/).filter(Boolean).pop() || "";
    if (!name) setName(folderName);

    // Check if it's a git repo
    try {
      const git = await api.checkIsGitRepo(path);
      setIsGitRepo(git);
    } catch {
      setIsGitRepo(false);
    }

    // Focus the name input so user can adjust
    setTimeout(() => nameRef.current?.focus(), 50);
  };

  const handleSubmit = async () => {
    if (!folderPath) {
      setError("Please select a folder");
      return;
    }
    if (!name.trim()) {
      setError("Please enter a project name");
      return;
    }
    try {
      const meta = await api.createProject(name.trim(), folderPath);
      onCreated(meta.id);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div
      className={styles.modalOverlay}
      onMouseDown={(e) => { mouseDownOnOverlay.current = e.target === e.currentTarget; }}
      onMouseUp={(e) => { if (mouseDownOnOverlay.current && e.target === e.currentTarget) onClose(); }}
    >
      <div className={styles.modal}>
        <div className={styles.modalTitle}>New Project</div>

        <label className={styles.fieldLabel}>Folder</label>
        <button
          className={styles.folderPicker}
          onClick={handlePickFolder}
          type="button"
        >
          {folderPath ? (
            <span className={styles.folderPath}>{folderPath}</span>
          ) : (
            <span className={styles.folderPlaceholder}>Choose a folder...</span>
          )}
          <span className={styles.folderBtn}>Browse</span>
        </button>

        {isGitRepo !== null && (
          <div className={isGitRepo ? styles.gitBadge : styles.gitBadgeNone}>
            {isGitRepo ? "Git repository detected" : "Not a git repository"}
          </div>
        )}

        <label className={styles.fieldLabel}>Project Name</label>
        <input
          ref={nameRef}
          className={styles.modalInput}
          placeholder="Project name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
            if (e.key === "Escape") onClose();
          }}
        />
        {error && <div className={styles.modalError}>{error}</div>}
        <div className={styles.modalActions}>
          <button className={styles.btnSecondary} onClick={onClose}>
            Cancel
          </button>
          <button className={styles.btnPrimary} onClick={handleSubmit}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

function ImportModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mouseDownOnOverlay = useRef(false);

  const handleFileSelect = async () => {
    const file = fileInputRef.current?.files?.[0];
    if (!file || !name.trim()) {
      setError("Please enter a name and select a file");
      return;
    }
    try {
      const text = await file.text();
      JSON.parse(text);
      await api.importProject(name.trim(), text);
      onImported();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div
      className={styles.modalOverlay}
      onMouseDown={(e) => { mouseDownOnOverlay.current = e.target === e.currentTarget; }}
      onMouseUp={(e) => { if (mouseDownOnOverlay.current && e.target === e.currentTarget) onClose(); }}
    >
      <div className={styles.modal}>
        <div className={styles.modalTitle}>Import Config</div>
        <input
          className={styles.modalInput}
          placeholder="Project name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          style={{ marginBottom: 12 }}
        />
        {error && <div className={styles.modalError}>{error}</div>}
        <div className={styles.modalActions}>
          <button className={styles.btnSecondary} onClick={onClose}>
            Cancel
          </button>
          <button className={styles.btnPrimary} onClick={handleFileSelect}>
            Import
          </button>
        </div>
      </div>
    </div>
  );
}

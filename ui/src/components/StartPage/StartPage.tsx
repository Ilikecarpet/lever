import { useEffect, useState, useRef, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppConfig, ProjectExport, ProjectMeta } from "../../types";
import * as api from "../../lib/tauri";
import { useClampToViewport } from "../../hooks/useClampToViewport";
import { usePresence } from "../../hooks/usePresence";
import { Wordmark } from "../Wordmark";
import { LeverMark } from "../Chat/LeverMark";
import { IconPlus } from "../Icons";
import menuStyles from "../ContextMenu/ContextMenu.module.css";
import styles from "./StartPage.module.css";

function timeAgo(unix: number): string {
  const diff = Math.floor(Date.now() / 1000) - unix;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(unix * 1000).toLocaleDateString();
}

/** Cards past this many all land together; a longer cascade just feels slow. */
const MAX_STAGGER = 8;

/** Holds on to the last non-null value, so something can keep drawing it while
 *  it animates out after the live value has already gone. */
function useLast<T>(value: T | null): T | null {
  const last = useRef(value);
  if (value !== null) last.current = value;
  return last.current;
}

function parseImportFile(text: string): {
  configJson: string;
  suggestedName?: string;
  suggestedRepoPath?: string;
  isNewFormat: boolean;
} {
  const parsed = JSON.parse(text);
  if (parsed && typeof parsed === "object" && "version" in parsed && "config" in parsed) {
    const wrapper = parsed as ProjectExport;
    if (wrapper.version !== 1) {
      throw new Error(`Unsupported export version ${wrapper.version}. Please update Lever.`);
    }
    return {
      configJson: JSON.stringify(wrapper.config),
      suggestedName: typeof wrapper.name === "string" ? wrapper.name : undefined,
      suggestedRepoPath: typeof wrapper.repo_path === "string" ? wrapper.repo_path : undefined,
      isNewFormat: true,
    };
  }
  const legacy = parsed as AppConfig;
  return { configJson: JSON.stringify(legacy), isNewFormat: false };
}

export default function StartPage() {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  /** Until the first list arrives, an empty `projects` means "not yet", not
   *  "none" — so the first-run copy must not show. */
  const [loaded, setLoaded] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    project: ProjectMeta;
  } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProjectMeta | null>(null);
  const [cloneTarget, setCloneTarget] = useState<ProjectMeta | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Everything that pops up keeps its last contents while it animates away.
  const menu = usePresence(!!contextMenu);
  const shownMenu = useLast(contextMenu);
  const createModal = usePresence(showCreateModal);
  const importModal = usePresence(showImportModal);
  const deleteModal = usePresence(!!deleteTarget);
  const shownDelete = useLast(deleteTarget);
  const cloneModal = usePresence(!!cloneTarget);
  const shownClone = useLast(cloneTarget);

  useClampToViewport(contextMenuRef, shownMenu?.x ?? 0, shownMenu?.y ?? 0);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listProjects();
      list.sort((a, b) => b.last_opened - a.last_opened);
      setProjects(list);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    refresh();
    // `lever init` adds a project while this page is open.
    const unlisten = api.tauriListen("projects-changed", () => refresh());
    return () => {
      unlisten.then((fn) => fn());
    };
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

  const handleOpenTerminal = useCallback(async () => {
    await api.openScratchTerminal();
    await getCurrentWindow().close();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== " " && e.code !== "Space") return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) return;
      if (showCreateModal || showImportModal || renamingId || deleteTarget || cloneTarget) return;
      e.preventDefault();
      handleOpenTerminal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleOpenTerminal, showCreateModal, showImportModal, renamingId, deleteTarget, cloneTarget]);

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

  const handleDelete = (project: ProjectMeta) => {
    setContextMenu(null);
    setDeleteTarget(project);
  };

  const handleClone = (project: ProjectMeta) => {
    setContextMenu(null);
    setCloneTarget(project);
  };

  const handleChangeRepoPath = async (project: ProjectMeta) => {
    setContextMenu(null);
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: project.repo_path || undefined,
    });
    if (!selected) return;
    await api.setRepoPath(project.id, selected as string);
    refresh();
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.title}>
          {/* The mark at work, as it is whenever an agent is — the start page
              is the one place it plays just for being Lever. */}
          <LeverMark size={44} working className={styles.titleMark} />
          <Wordmark height={38} />
        </div>
        {/* Holds its line while loading, so nothing below jumps when it fills. */}
        <div className={`${styles.subtitle}${loaded ? " lv-rise" : ""}`}>
          {!loaded
            ? null
            : projects.length === 0
              ? "A project points Lever at a repository and remembers its services, groups, and worktrees"
              : "Select a project or create a new one"}
        </div>
      </div>

      <div className={styles.actions}>
        <button className={`${styles.btnPrimary} lv-press`} onClick={() => setShowCreateModal(true)}>
          <IconPlus size={14} /> New project
        </button>
        <button className={`${styles.btnSecondary} lv-press`} onClick={() => setShowImportModal(true)}>
          Import config
        </button>
        <button
          className={`${styles.btnSecondary} lv-press`}
          onClick={handleOpenTerminal}
          title="Open a standalone terminal (Space)"
        >
          Open terminal <span className={styles.kbd}>Space</span>
        </button>
      </div>

      <div className={styles.grid}>
        {/* Placeholders the size of a card. They only fade in if the list is
            slow to arrive, so a quick load goes straight to the real cards. */}
        {!loaded &&
          [0, 1, 2].map((i) => (
            <div key={i} className={styles.skeleton} style={{ "--j": i } as React.CSSProperties}>
              <span />
              <span />
              <span />
            </div>
          ))}

        {loaded && projects.map((p, i) => (
          <div
            key={p.id}
            className={`${styles.card} lv-rise`}
            style={{ "--i": Math.min(i, MAX_STAGGER) } as React.CSSProperties}
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

        {loaded && (
          <div
            className={`${styles.emptyCard} lv-rise`}
            style={{ "--i": Math.min(projects.length, MAX_STAGGER) } as React.CSSProperties}
            onClick={() => setShowCreateModal(true)}
          >
            <div className={styles.emptyCardContent}>
              <IconPlus size={20} className={styles.emptyCardPlus} />
              <div className={styles.emptyCardLabel}>
                {projects.length === 0 ? "Create your first project" : "New project"}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className={styles.hint}>
        Right-click a project for options · Press <span className={styles.kbd}>Space</span> for a quick terminal
      </div>

      {menu.mounted && shownMenu && (
        <div
          ref={contextMenuRef}
          className={`${menuStyles.menu} ${styles.contextMenu} lv-pop${menu.closing ? " lv-closing" : ""}`}
        >
          <button className={menuStyles.item} onClick={() => handleRename(shownMenu.project)}>
            Rename
          </button>
          <button className={menuStyles.item} onClick={() => handleClone(shownMenu.project)}>
            Clone
          </button>
          <button className={menuStyles.item} onClick={() => handleChangeRepoPath(shownMenu.project)}>
            Change repo path…
          </button>
          <button className={`${menuStyles.item} ${menuStyles.danger}`} onClick={() => handleDelete(shownMenu.project)}>
            Delete
          </button>
        </div>
      )}

      {createModal.mounted && (
        <CreateModal
          closing={createModal.closing}
          onClose={() => setShowCreateModal(false)}
          onCreated={(id) => {
            setShowCreateModal(false);
            refresh();
            handleOpen(id);
          }}
        />
      )}

      {importModal.mounted && (
        <ImportModal
          closing={importModal.closing}
          onClose={() => setShowImportModal(false)}
          onImported={() => {
            setShowImportModal(false);
            refresh();
          }}
        />
      )}

      {deleteModal.mounted && shownDelete && (
        <ConfirmDeleteModal
          project={shownDelete}
          closing={deleteModal.closing}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => {
            setDeleteTarget(null);
            refresh();
          }}
        />
      )}

      {cloneModal.mounted && shownClone && (
        <CloneModal
          project={shownClone}
          closing={cloneModal.closing}
          onClose={() => setCloneTarget(null)}
          onCloned={() => {
            setCloneTarget(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

/** Scrim and card shared by every modal here. A click only dismisses when it
 *  both starts and ends on the scrim, so a drag out of a text field doesn't. */
function ModalFrame({
  closing,
  onClose,
  children,
}: {
  closing: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const mouseDownOnOverlay = useRef(false);
  const leaving = closing ? " lv-closing" : "";
  return (
    <div
      className={`${styles.modalOverlay} lv-scrim${leaving}`}
      onMouseDown={(e) => { mouseDownOnOverlay.current = e.target === e.currentTarget; }}
      onMouseUp={(e) => { if (mouseDownOnOverlay.current && e.target === e.currentTarget) onClose(); }}
    >
      <div className={`${styles.modal} lv-modal${leaving}`}>{children}</div>
    </div>
  );
}

function ConfirmDeleteModal({
  project,
  onClose,
  onDeleted,
  closing,
}: {
  closing: boolean;
  project: ProjectMeta;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleDelete = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.deleteProject(project.id);
      onDeleted();
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalFrame closing={closing} onClose={onClose}>
      <div className={styles.modalTitle}>Delete “{project.name}”?</div>
      <div className={styles.modalBody}>
        This removes the project and its Lever configuration (services,
        groups, worktree list). Your repository on disk is not affected.
        This cannot be undone.
      </div>
      <div className={styles.modalActions}>
        <button className={`${styles.btnSecondary} lv-press`} onClick={onClose} autoFocus>
          Cancel
        </button>
        <button className={`${styles.btnDanger} lv-press`} onClick={handleDelete} disabled={busy}>
          {busy ? "Deleting…" : "Delete project"}
        </button>
      </div>
    </ModalFrame>
  );
}

function CloneModal({
  project,
  onClose,
  onCloned,
  closing,
}: {
  closing: boolean;
  project: ProjectMeta;
  onClose: () => void;
  onCloned: () => void;
}) {
  const [name, setName] = useState(`${project.name} (copy)`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const handleClone = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    try {
      await api.cloneProject(project.id, name.trim());
      onCloned();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <ModalFrame closing={closing} onClose={onClose}>
      <div className={styles.modalTitle}>Clone “{project.name}”</div>
      <label className={styles.fieldLabel}>Name for the clone</label>
      <input
        className={styles.modalInput}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleClone();
          if (e.key === "Escape") onClose();
        }}
        autoFocus
        onFocus={(e) => e.target.select()}
      />
      {error && <div className={styles.modalError}>{error}</div>}
      <div className={styles.modalActions}>
        <button className={`${styles.btnSecondary} lv-press`} onClick={onClose}>
          Cancel
        </button>
        <button className={`${styles.btnPrimary} lv-press`} onClick={handleClone} disabled={busy || !name.trim()}>
          {busy ? "Cloning…" : "Clone"}
        </button>
      </div>
    </ModalFrame>
  );
}

function CreateModal({
  onClose,
  onCreated,
  closing,
}: {
  closing: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [folderPath, setFolderPath] = useState("");
  const [name, setName] = useState("");
  const [isGitRepo, setIsGitRepo] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
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
    <ModalFrame closing={closing} onClose={onClose}>
      <div className={styles.modalTitle}>New project</div>

      <label className={styles.fieldLabel}>Folder</label>
      <button
        className={styles.folderPicker}
        onClick={handlePickFolder}
        type="button"
      >
        {folderPath ? (
          <span className={styles.folderPath}>{folderPath}</span>
        ) : (
          <span className={styles.folderPlaceholder}>Choose a folder…</span>
        )}
        <span className={styles.folderBtn}>Browse</span>
      </button>

      {isGitRepo !== null && (
        <div className={isGitRepo ? styles.gitBadge : styles.gitBadgeNone}>
          {isGitRepo ? "Git repository detected" : "Not a git repository"}
        </div>
      )}

      <label className={styles.fieldLabel}>Project name</label>
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
        <button className={`${styles.btnSecondary} lv-press`} onClick={onClose}>
          Cancel
        </button>
        <button className={`${styles.btnPrimary} lv-press`} onClick={handleSubmit}>
          Create
        </button>
      </div>
    </ModalFrame>
  );
}

function ImportModal({
  onClose,
  onImported,
  closing,
}: {
  closing: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [parsedConfigJson, setParsedConfigJson] = useState<string | null>(null);
  const [isNewFormat, setIsNewFormat] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handleFileChange = async () => {
    setError("");
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setParsedConfigJson(null);
      setIsNewFormat(false);
      return;
    }
    try {
      const text = await file.text();
      const result = parseImportFile(text);
      setParsedConfigJson(result.configJson);
      setIsNewFormat(result.isNewFormat);
      if (result.suggestedName) setName(result.suggestedName);
      if (result.suggestedRepoPath !== undefined) setRepoPath(result.suggestedRepoPath);
    } catch (e) {
      setParsedConfigJson(null);
      setIsNewFormat(false);
      setError(String(e));
    }
  };

  const handlePickRepoPath = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: repoPath || undefined,
    });
    if (selected) setRepoPath(selected as string);
  };

  const handleImport = async () => {
    if (!parsedConfigJson) {
      setError("Please select a valid config file");
      return;
    }
    if (!name.trim()) {
      setError("Please enter a project name");
      return;
    }
    try {
      const repoArg = isNewFormat ? repoPath : undefined;
      await api.importProject(name.trim(), parsedConfigJson, repoArg);
      onImported();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <ModalFrame closing={closing} onClose={onClose}>
      <div className={styles.modalTitle}>Import config</div>

      <label className={styles.fieldLabel}>Config file</label>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        style={{ marginBottom: 12 }}
        onChange={handleFileChange}
      />

      <label className={styles.fieldLabel}>Project name</label>
      <input
        className={styles.modalInput}
        placeholder="Project name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />

      {isNewFormat && (
        <>
          <label className={styles.fieldLabel}>Repository path</label>
          <button
            className={styles.folderPicker}
            onClick={handlePickRepoPath}
            type="button"
          >
            {repoPath ? (
              <span className={styles.folderPath}>{repoPath}</span>
            ) : (
              <span className={styles.folderPlaceholder}>Choose a folder…</span>
            )}
            <span className={styles.folderBtn}>Browse</span>
          </button>
        </>
      )}

      {error && <div className={styles.modalError}>{error}</div>}
      <div className={styles.modalActions}>
        <button className={`${styles.btnSecondary} lv-press`} onClick={onClose}>
          Cancel
        </button>
        <button className={`${styles.btnPrimary} lv-press`} onClick={handleImport}>
          Import
        </button>
      </div>
    </ModalFrame>
  );
}

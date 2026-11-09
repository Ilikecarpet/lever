import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useConfigStore } from "../../stores/configStore";
import { usePanelStore } from "../../stores/panelStore";
import { useUiStore } from "../../stores/uiStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { useDbStore } from "../../stores/dbStore";
import { usePresence } from "../../hooks/usePresence";
import * as api from "../../lib/tauri";
import { ENGINE_LABEL, ENGINE_PORT, buildUrl, getParam, parseUrl, setParam, type UrlParts } from "../../lib/sql";
import type { DbColor, DbConnectionDef, DbEngine } from "../../types";
import { IconCheck, IconDatabase, IconFolder, IconLock } from "../Icons";
import shell from "../Modals/Panel.module.css";
import form from "../Modals/ServiceInspector.module.css";
import rows from "../Modals/SettingsPanel.module.css";
import styles from "./DbConnectionPanel.module.css";

type Mode = "details" | "url";

interface Draft {
  name: string;
  engine: DbEngine;
  mode: Mode;
  url: string;
  parts: UrlParts;
  /** Typed this session; empty keeps whatever the Keychain holds. */
  password: string;
  readOnly: boolean;
  caCert: string;
  agentAccess: boolean;
  color: DbColor | null;
}

const emptyParts: UrlParts = { user: "", password: "", host: "localhost", port: "", database: "", params: "" };

const emptyDraft: Draft = {
  name: "",
  engine: "postgres",
  mode: "details",
  url: "",
  parts: emptyParts,
  password: "",
  readOnly: false,
  caCert: "",
  agentAccess: true,
  color: null,
};

/** Postgres sslmode, in the order of how much they check. */
const SSL_MODES: { id: string | null; label: string; hint: string }[] = [
  { id: null, label: "Default", hint: "Encrypts when the server offers it; the certificate isn't checked. Right for local databases." },
  { id: "disable", label: "Off", hint: "Never encrypts." },
  { id: "require", label: "Require", hint: "Always encrypts; the certificate isn't checked." },
  { id: "verify-ca", label: "Verify CA", hint: "The certificate must come from a trusted authority — macOS's, or the CA file below." },
  { id: "verify-full", label: "Verify full", hint: "As Verify CA, and the certificate must name this host. The setting for production." },
];

const COLORS: { id: DbColor | null; label: string }[] = [
  { id: null, label: "None" },
  { id: "green", label: "Local" },
  { id: "blue", label: "Staging" },
  { id: "yellow", label: "Shared" },
  { id: "red", label: "Production" },
];

function draftFor(def: DbConnectionDef): Draft {
  const parts = def.engine !== "sqlite" ? parseUrl(def.url) : null;
  // A URL the fields can round-trip opens as fields; anything else (a
  // ${VAR}, a key=value string) stays a URL.
  const roundTrips = parts && !def.url.includes("${") && buildUrl(def.engine, parts) === def.url;
  return {
    name: def.name,
    engine: def.engine,
    mode: roundTrips ? "details" : "url",
    url: def.url,
    parts: parts ?? emptyParts,
    password: "",
    readOnly: def.read_only,
    caCert: def.ca_cert ?? "",
    agentAccess: def.agent_access,
    color: def.color,
  };
}

/** The URL the draft describes. */
function urlOf(d: Draft): string {
  if (d.engine === "sqlite" || d.mode === "url") return d.url.trim();
  return buildUrl(d.engine, { ...d.parts, password: "" });
}

function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "db";
}

type TestState = { phase: "idle" } | { phase: "testing" } | { phase: "ok"; version: string } | { phase: "fail"; message: string; hint: string | null };

// ---------------------------------------------------------------------------
// DbConnectionPanel — the editor for one connection, flown out of the
// sidebar's edge like the service inspector, and sharing its shell.
// ---------------------------------------------------------------------------

export default function DbConnectionPanel() {
  const target = usePanelStore((s) => s.target);
  const close = usePanelStore((s) => s.close);
  const editDatabase = usePanelStore((s) => s.editDatabase);
  const databases = useConfigStore((s) => s.databases);
  const putDatabase = useConfigStore((s) => s.putDatabase);
  const removeDatabase = useConfigStore((s) => s.removeDatabase);
  const saveConfig = useConfigStore((s) => s.saveConfig);
  const activeWorktreeId = useWorktreeStore((s) => s.activeWorktreeId);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const hinge = sidebarCollapsed ? 0 : sidebarWidth;

  const open = target?.kind === "db";
  const { mounted, closing } = usePresence(open);
  const lastShown = useRef<{ connId: string | null } | null>(null);
  if (target?.kind === "db") lastShown.current = { connId: target.connId };

  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [baseline, setBaseline] = useState<Draft>(emptyDraft);
  const [hasPassword, setHasPassword] = useState(false);
  const [clearPassword, setClearPassword] = useState(false);
  const [movedPassword, setMovedPassword] = useState(false);
  const [test, setTest] = useState<TestState>({ phase: "idle" });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const mouseDownOnOverlay = useRef(false);

  const connId = target?.kind === "db" ? target.connId : null;
  const existing = connId ? databases.find((d) => d.id === connId) ?? null : null;

  useEffect(() => {
    if (target?.kind !== "db") return;
    setConfirmDelete(false);
    setTest({ phase: "idle" });
    setClearPassword(false);
    setMovedPassword(false);
    if (target.connId) {
      const def = useConfigStore.getState().databases.find((d) => d.id === target.connId);
      if (!def) {
        close();
        return;
      }
      const d = draftFor(def);
      setDraft(d);
      setBaseline(d);
      api.dbHasPassword(def.id).then(setHasPassword).catch(() => setHasPassword(false));
    } else {
      setDraft(emptyDraft);
      setBaseline(emptyDraft);
      setHasPassword(false);
      window.setTimeout(() => nameRef.current?.focus(), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline) || clearPassword;
  const url = urlOf(draft);
  const valid = draft.name.trim() !== "" && url !== "";

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleDone();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!mounted || !lastShown.current) return null;
  const isNew = lastShown.current.connId === null;

  const set = (p: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...p }));
    setTest({ phase: "idle" });
  };
  const setPart = (p: Partial<UrlParts>) => set({ parts: { ...draft.parts, ...p } });

  const switchEngine = (engine: DbEngine) => {
    if (engine === draft.engine) return;
    // The default port follows the engine unless one was typed.
    const port = draft.parts.port === String(ENGINE_PORT[draft.engine] ?? "") ? "" : draft.parts.port;
    set({ engine, parts: { ...draft.parts, port } });
  };

  const switchMode = (mode: Mode) => {
    if (mode === draft.mode) return;
    if (mode === "url") {
      set({ mode, url: buildUrl(draft.engine, { ...draft.parts, password: "" }) });
    } else {
      const parts = parseUrl(draft.url);
      set({ mode, parts: parts ? { ...parts, password: "" } : draft.parts });
      if (parts?.password) {
        setDraft((d) => ({ ...d, password: parts.password }));
        setMovedPassword(true);
      }
    }
  };

  /** A pasted URL with a password in it gives the password up to the
   *  Keychain field, so config.json never holds it. */
  const absorbPassword = () => {
    if (draft.engine === "sqlite") return;
    const parts = parseUrl(draft.url);
    if (!parts?.password || draft.url.includes("${")) return;
    const stripped = draft.url.replace(/^([a-z][a-z0-9+.-]*:\/\/[^:@/]*):[^@/]*@/i, "$1@");
    setDraft((d) => ({ ...d, url: stripped, password: parts.password }));
    setMovedPassword(true);
  };

  const defFromDraft = (id: string): DbConnectionDef => ({
    id,
    name: draft.name.trim(),
    engine: draft.engine,
    url,
    read_only: draft.readOnly,
    ca_cert: draft.caCert.trim() || null,
    agent_access: draft.agentAccess,
    color: draft.color,
  });

  const handleTest = async () => {
    setTest({ phase: "testing" });
    try {
      const version = await api.dbTest(defFromDraft(connId ?? "__test__"), draft.password || null, activeWorktreeId);
      setTest({ phase: "ok", version });
    } catch (e) {
      const err = api.toDbError(e);
      setTest({ phase: "fail", message: err.message, hint: err.hint });
    }
  };

  const commit = async (): Promise<string | null> => {
    if (!valid) return null;
    setSaving(true);
    try {
      let id = connId;
      if (!id) {
        const base = slug(draft.name);
        id = base;
        let n = 1;
        while (useConfigStore.getState().databases.some((d) => d.id === id)) id = `${base}-${++n}`;
      }
      if (draft.password) await api.dbSetPassword(id, draft.password);
      else if (clearPassword) await api.dbSetPassword(id, null);
      putDatabase(defFromDraft(id));
      await saveConfig();
      await api.dbDisconnect(id);
      useDbStore.getState().forgetConnection(id);
      useWorkspaceStore.getState().renameDatabase(id, draft.name.trim());
      const saved = { ...draft, password: "" };
      setDraft(saved);
      setBaseline(saved);
      if (draft.password) setHasPassword(true);
      if (clearPassword) setHasPassword(false);
      setClearPassword(false);
      return id;
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    const id = await commit();
    if (!id) return;
    if (isNew) {
      close();
      useWorkspaceStore.getState().openDatabase(id, draft.name.trim(), activeWorktreeId);
    } else {
      editDatabase(id);
    }
  };

  const handleDone = () => {
    if (dirty && !isNew && valid) commit();
    close();
  };

  const handleDelete = async () => {
    if (!connId) return;
    removeDatabase(connId);
    await saveConfig();
    await api.dbDisconnect(connId, true);
    useDbStore.getState().forgetConnection(connId);
    useWorkspaceStore.getState().closeDatabase(connId);
    close();
  };

  const browse = async () => {
    const picked = await openDialog({
      title: "Choose a SQLite database",
      multiple: false,
      directory: false,
      filters: [{ name: "SQLite", extensions: ["sqlite", "sqlite3", "db", "db3", "s3db"] }, { name: "All files", extensions: ["*"] }],
    });
    if (typeof picked === "string") set({ url: picked });
  };

  const browseCa = async () => {
    const picked = await openDialog({
      title: "Choose the CA certificate",
      multiple: false,
      directory: false,
      filters: [{ name: "Certificates", extensions: ["pem", "crt", "cer", "der"] }, { name: "All files", extensions: ["*"] }],
    });
    if (typeof picked === "string") set({ caCert: picked });
  };

  const sslMode = draft.engine === "postgres" ? getParam(draft.mode === "url" ? draft.url.split("?")[1] ?? "" : draft.parts.params, "sslmode") : null;
  const sslHint = SSL_MODES.find((m) => m.id === sslMode)?.hint;

  const heading = draft.name.trim() || (isNew ? "New database" : "Untitled");
  const passwordPlaceholder = clearPassword
    ? "Will be removed"
    : hasPassword
      ? "Saved in Keychain — type to replace"
      : draft.mode === "url"
        ? "If the URL needs one"
        : "Optional";

  return (
    <div
      className={`${shell.overlay}${closing ? ` ${shell.closing}` : ""}`}
      style={{ ["--hinge" as string]: `${hinge}px` }}
      onMouseDown={(e) => {
        mouseDownOnOverlay.current = e.target === e.currentTarget;
      }}
      onMouseUp={(e) => {
        if (mouseDownOnOverlay.current && e.target === e.currentTarget) handleDone();
      }}
    >
      <div className={`${shell.scrim} lv-scrim${closing ? " lv-closing" : ""}`} />
      <div className={shell.panel}>
        <div className={shell.header}>
          <span className={shell.title}>{isNew ? "New database" : "Edit database"}</span>
          <span className={shell.spacer} />
          <button className={shell.btn} onClick={handleDone}>
            Done
          </button>
        </div>

        <div className={shell.scroll}>
          <div className={styles.hero}>
            <span className={styles.heroIcon} data-color={draft.color ?? undefined}>
              <IconDatabase size={20} />
            </span>
            <div className={styles.heroText}>
              <div className={form.detailName}>{heading}</div>
              <div className={styles.heroUrl}>{url || <span className={styles.heroEmpty}>{draft.engine === "sqlite" ? "database file" : "connection"}</span>}</div>
            </div>
          </div>

          <div className={form.fieldSet}>
            <div className={shell.sectionHead}>
              <span className={shell.sectionName}>Database</span>
              <span className={shell.sectionRule} />
            </div>
            <div className={form.f}>
              <label htmlFor="db-name">Name</label>
              <input
                id="db-name"
                ref={nameRef}
                value={draft.name}
                onChange={(e) => set({ name: e.target.value })}
                placeholder="e.g. App database"
              />
            </div>
            <div className={form.f}>
              <label>Engine</label>
              <div className={form.seg} role="radiogroup" aria-label="Engine">
                {(["postgres", "mysql", "sqlite"] as const).map((e) => (
                  <button
                    key={e}
                    type="button"
                    role="radio"
                    aria-checked={draft.engine === e}
                    className={`${form.segBtn}${draft.engine === e ? ` ${form.segBtnOn}` : ""}`}
                    onClick={() => switchEngine(e)}
                  >
                    {ENGINE_LABEL[e]}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className={form.fieldSet}>
            <div className={`${shell.sectionHead} ${styles.sectionWithAction}`}>
              <span className={shell.sectionName}>Connection</span>
              <span className={shell.sectionRule} />
              {draft.engine !== "sqlite" && (
                <div className={styles.modeSwitch}>
                  {(["details", "url"] as const).map((m) => (
                    <button key={m} className={draft.mode === m ? styles.modeOn : ""} onClick={() => switchMode(m)}>
                      {m === "details" ? "Fields" : "URL"}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {draft.engine === "sqlite" ? (
              <div className={form.f}>
                <label htmlFor="db-file">File</label>
                <div className={styles.fileRow}>
                  <input
                    id="db-file"
                    className={form.mono}
                    value={draft.url}
                    onChange={(e) => set({ url: e.target.value })}
                    placeholder="./prisma/dev.db"
                  />
                  <button className={`${shell.btn} ${shell.btnSm}`} onClick={browse}>
                    <IconFolder size={12} /> Choose…
                  </button>
                </div>
                <div className={shell.hint}>A relative path is read from each checkout's root, so a worktree opens its own copy.</div>
              </div>
            ) : draft.mode === "details" ? (
              <>
                <div className={form.fRow}>
                  <div className={form.f} style={{ flex: 3 }}>
                    <label htmlFor="db-host">Host</label>
                    <input id="db-host" className={form.mono} value={draft.parts.host} onChange={(e) => setPart({ host: e.target.value })} placeholder="localhost" />
                  </div>
                  <div className={form.f} style={{ flex: 1 }}>
                    <label htmlFor="db-port">Port</label>
                    <input
                      id="db-port"
                      className={form.mono}
                      value={draft.parts.port}
                      onChange={(e) => setPart({ port: e.target.value.replace(/\D/g, "") })}
                      placeholder={String(ENGINE_PORT[draft.engine])}
                    />
                  </div>
                </div>
                <div className={form.fRow}>
                  <div className={form.f}>
                    <label htmlFor="db-user">User</label>
                    <input id="db-user" className={form.mono} value={draft.parts.user} onChange={(e) => setPart({ user: e.target.value })} placeholder={draft.engine === "mysql" ? "root" : "postgres"} />
                  </div>
                  <div className={form.f}>
                    <label htmlFor="db-pass">Password</label>
                    <input
                      id="db-pass"
                      type="password"
                      className={form.mono}
                      value={draft.password}
                      onChange={(e) => {
                        set({ password: e.target.value });
                        setClearPassword(false);
                      }}
                      placeholder={passwordPlaceholder}
                    />
                  </div>
                </div>
                <div className={form.f}>
                  <label htmlFor="db-name-db">Database</label>
                  <input id="db-name-db" className={form.mono} value={draft.parts.database} onChange={(e) => setPart({ database: e.target.value })} placeholder={draft.engine === "mysql" ? "app" : "postgres"} />
                </div>
                {draft.engine === "postgres" && (
                  <div className={form.f}>
                    <label>Encryption</label>
                    <div className={form.seg} role="radiogroup" aria-label="Encryption">
                      {SSL_MODES.map((m) => (
                        <button
                          key={m.label}
                          type="button"
                          role="radio"
                          aria-checked={sslMode === m.id}
                          className={`${form.segBtn}${sslMode === m.id ? ` ${form.segBtnOn}` : ""}`}
                          onClick={() => setPart({ params: setParam(draft.parts.params, "sslmode", m.id) })}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                    <div className={shell.hint}>{sslHint ?? `sslmode=${sslMode} — set in the URL.`}</div>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className={form.f}>
                  <label htmlFor="db-url">URL</label>
                  <input
                    id="db-url"
                    className={form.mono}
                    value={draft.url}
                    onChange={(e) => set({ url: e.target.value })}
                    onBlur={absorbPassword}
                    placeholder={draft.engine === "mysql" ? "mysql://root@localhost:3306/app" : "postgres://postgres@localhost:5432/app"}
                  />
                  <div className={shell.hint}>
                    <button className={styles.inlineLink} onClick={() => set({ url: "${DATABASE_URL}" })}>
                      Use <code>{"${DATABASE_URL}"}</code>
                    </button>{" "}
                    to read it from each checkout's <code>.env</code> — worktrees then reach their own database.
                  </div>
                </div>
                <div className={form.f}>
                  <label htmlFor="db-pass-url">Password</label>
                  <input
                    id="db-pass-url"
                    type="password"
                    className={form.mono}
                    value={draft.password}
                    onChange={(e) => {
                      set({ password: e.target.value });
                      setClearPassword(false);
                    }}
                    placeholder={passwordPlaceholder}
                  />
                </div>
              </>
            )}

            {draft.engine !== "sqlite" && (
              <div className={form.f}>
                <label htmlFor="db-ca">CA certificate</label>
                <div className={styles.fileRow}>
                  <input
                    id="db-ca"
                    className={form.mono}
                    value={draft.caCert}
                    onChange={(e) => set({ caCert: e.target.value })}
                    placeholder="Optional — macOS's trusted authorities are used without one"
                  />
                  <button className={`${shell.btn} ${shell.btnSm}`} onClick={browseCa}>
                    <IconFolder size={12} /> Choose…
                  </button>
                </div>
                <div className={shell.hint}>
                  {draft.engine === "postgres"
                    ? "For a provider's own authority — AWS RDS's global-bundle.pem, Supabase's CA. Checked when encryption is Verify CA or Verify full."
                    : "For a server with its own authority. Setting one turns on TLS, checked against it."}
                </div>
              </div>
            )}

            {draft.engine !== "sqlite" && (
              <div className={styles.keychainNote}>
                <IconLock size={10} />
                {movedPassword
                  ? "The password was taken out of the URL; it will be saved to your Keychain, not the project config."
                  : "Passwords are kept in your macOS Keychain, never in the project config."}
                {hasPassword && !draft.password && !clearPassword && (
                  <button className={styles.inlineLink} onClick={() => setClearPassword(true)}>
                    Remove saved password
                  </button>
                )}
              </div>
            )}

            <div className={styles.testRow}>
              <button className={`${shell.btn} ${shell.btnSm}`} onClick={handleTest} disabled={!url || test.phase === "testing"}>
                {test.phase === "testing" ? "Testing…" : "Test connection"}
              </button>
              {test.phase === "ok" && (
                <span className={`${styles.testOk} lv-rise`}>
                  <IconCheck size={12} /> Connected · {test.version}
                </span>
              )}
              {test.phase === "fail" && (
                <span className={`${styles.testFail} lv-rise`}>
                  {test.message}
                  {test.hint && <span className={styles.testHint}>{test.hint}</span>}
                </span>
              )}
            </div>
          </div>

          <div className={form.fieldSet}>
            <div className={shell.sectionHead}>
              <span className={shell.sectionName}>Access</span>
              <span className={shell.sectionRule} />
            </div>
            <Toggle
              label="Agents can read it"
              sub="Coding agents can browse the schema and run read-only queries through Lever's MCP server. Writes are refused by the database."
              on={draft.agentAccess}
              onChange={(v) => set({ agentAccess: v })}
            />
            <Toggle
              label="Read-only"
              sub="Refuse writes from the console as well — for a database you only ever look at."
              on={draft.readOnly}
              onChange={(v) => set({ readOnly: v })}
            />
            <div className={rows.row}>
              <div className={rows.rowText}>
                <div className={rows.rowLabel}>Colour</div>
                <div className={rows.rowSub}>Marks the pane's edge, so production never looks like local.</div>
              </div>
              <div className={styles.swatches} role="radiogroup" aria-label="Colour">
                {COLORS.map((c) => (
                  <button
                    key={c.label}
                    role="radio"
                    aria-checked={draft.color === c.id}
                    className={`${styles.swatch}${draft.color === c.id ? ` ${styles.swatchOn}` : ""}`}
                    data-color={c.id ?? "none"}
                    onClick={() => set({ color: c.id })}
                    title={c.label}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className={shell.footer}>
          {!isNew && (
            <button className={`${shell.btn} ${shell.btnDanger} ${shell.btnSm}`} onClick={() => setConfirmDelete((v) => !v)}>
              Delete database
            </button>
          )}
          <span className={shell.spacer} />
          {dirty && !isNew && (
            <button
              className={`${shell.btn} ${shell.btnGhost}`}
              onClick={() => {
                setDraft(baseline);
                setClearPassword(false);
              }}
            >
              Revert
            </button>
          )}
          <button className={`${shell.btn} ${shell.btnPrimary}`} onClick={handleSave} disabled={!valid || saving || (!isNew && !dirty)}>
            {isNew ? "Add and open" : dirty ? "Save" : "Saved"}
          </button>
        </div>

        <div className={form.confirm} data-open={confirmDelete ? "1" : "0"}>
          <div className={form.confirmInner}>
            <div className={form.confirmBox}>
              <div className={form.confirmMsg}>
                Remove <b>{draft.name.trim() || "this connection"}</b> from Lever and forget its saved password. The database itself is not touched.
              </div>
              <div className={form.confirmActions}>
                <button className={form.confirmNo} onClick={() => setConfirmDelete(false)}>
                  Cancel
                </button>
                <button className={form.confirmYes} onClick={handleDelete}>
                  Remove
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Toggle({ label, sub, on, onChange }: { label: string; sub: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className={rows.row}>
      <div className={rows.rowText}>
        <div className={rows.rowLabel}>{label}</div>
        <div className={rows.rowSub}>{sub}</div>
      </div>
      <button
        role="switch"
        aria-checked={on}
        aria-label={label}
        className={`${rows.lever}${on ? ` ${rows.leverOn}` : ""}`}
        onClick={() => onChange(!on)}
      >
        <span className={rows.leverKnob} />
      </button>
    </div>
  );
}

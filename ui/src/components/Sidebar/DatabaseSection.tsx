import { useEffect, useRef, useState } from "react";
import { useConfigStore } from "../../stores/configStore";
import { usePanelStore } from "../../stores/panelStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { useServiceStore } from "../../stores/serviceStore";
import { useDbStore } from "../../stores/dbStore";
import { useClampToViewport } from "../../hooks/useClampToViewport";
import { ENGINE_LABEL } from "../../lib/sql";
import type { DbConnectionDef } from "../../types";
import { IconDatabase, IconGear, IconPlus, IconTable } from "../Icons";
import { useMenuPresence } from "./motion";
import menuStyles from "../ContextMenu/ContextMenu.module.css";
import sidebar from "./Sidebar.module.css";
import styles from "./DatabaseSection.module.css";

/** The project's databases. A row opens its connection in the context you are
 *  in — so with a worktree selected, `${DATABASE_URL}` is that worktree's. */
export default function DatabaseSection() {
  const databases = useConfigStore((s) => s.databases);
  const editDatabase = usePanelStore((s) => s.editDatabase);

  return (
    <>
      <div className={sidebar.sectionEyebrow}>
        <span>Databases</span>
        <button
          className={`${sidebar.eyebrowAction} lv-press`}
          onClick={() => editDatabase(null)}
          title="Add database"
          aria-label="Add database"
        >
          <IconPlus size={11} />
        </button>
      </div>
      {databases.length === 0 && (
        <button className={styles.emptyRow} onClick={() => editDatabase(null)}>
          <IconDatabase size={12} /> Connect a database
        </button>
      )}
      {databases.map((db) => (
        <DatabaseRow key={db.id} db={db} />
      ))}
    </>
  );
}

function DatabaseRow({ db }: { db: DbConnectionDef }) {
  const editDatabase = usePanelStore((s) => s.editDatabase);
  const activeWorktreeId = useWorktreeStore((s) => s.activeWorktreeId);
  const openDatabase = useWorkspaceStore((s) => s.openDatabase);
  const isOpenHere = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
    return !!ws && ws.worktreeId === activeWorktreeId && ws.root.type === "leaf" && ws.root.dbConnId === db.id;
  });
  const lastAgent = useDbStore((s) => s.agentActivity.find((a) => a.connId === db.id));
  const [live, setLive] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const presence = useMenuPresence(menu);
  useClampToViewport(menuRef, presence.pos.x, presence.pos.y);

  // An agent reading this database lights the row for a moment.
  useEffect(() => {
    if (!lastAgent || Date.now() - lastAgent.at > 4000) return;
    setLive(true);
    const t = window.setTimeout(() => setLive(false), 4000 - (Date.now() - lastAgent.at));
    return () => window.clearTimeout(t);
  }, [lastAgent]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenu(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);

  const open = () => {
    openDatabase(db.id, db.name, activeWorktreeId);
    useServiceStore.getState().setActiveService(null);
  };

  return (
    <>
      <div
        className={`${styles.row}${isOpenHere ? ` ${styles.rowOpen}` : ""}`}
        onClick={open}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        title={`${db.name} · ${ENGINE_LABEL[db.engine]}`}
      >
        <span className={styles.icon} data-color={db.color ?? undefined}>
          <IconDatabase size={13} />
        </span>
        <span className={styles.name}>{db.name}</span>
        {live && <span className={styles.agentDot} title="An agent is reading this database" />}
        <span className={styles.engine}>{ENGINE_LABEL[db.engine]}</span>
        <button
          className={`${styles.gear} lv-press`}
          onClick={(e) => {
            e.stopPropagation();
            editDatabase(db.id);
          }}
          title="Edit connection"
          aria-label="Edit connection"
        >
          <IconGear size={12} />
        </button>
      </div>
      {presence.mounted && (
        <div
          ref={menuRef}
          className={`${menuStyles.menu} ${styles.menu} lv-pop${presence.closing ? " lv-closing" : ""}`}
        >
          <div className={menuStyles.header}>{db.name}</div>
          <button
            className={menuStyles.item}
            onClick={() => {
              setMenu(null);
              open();
            }}
          >
            <IconTable size={12} /> Open
          </button>
          <button
            className={menuStyles.item}
            onClick={() => {
              setMenu(null);
              editDatabase(db.id);
            }}
          >
            <IconGear size={12} /> Edit connection
          </button>
        </div>
      )}
    </>
  );
}

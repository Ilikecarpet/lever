/** A terminal runs a shell; a chat talks to a coding agent over ACP; a
 *  database pane browses and queries one of the project's connections. */
export type PaneKind = "terminal" | "chat" | "db";

export interface PaneLeaf {
  type: "leaf";
  id: string;
  kind: PaneKind;
  ptyId: string | null;
  title: string | null;
  /** The connection a database pane is open on. */
  dbConnId?: string;
}

export interface PaneSplit {
  type: "split";
  id: string;
  direction: "horizontal" | "vertical";
  ratio: number;
  children: [PaneNode, PaneNode];
}

export type PaneNode = PaneLeaf | PaneSplit;

export interface Workspace {
  id: string;
  label: string;
  root: PaneNode;
  activePaneId: string;
  worktreeId: string | null;
}

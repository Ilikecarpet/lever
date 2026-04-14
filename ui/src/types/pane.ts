export interface PaneLeaf {
  type: "leaf";
  id: string;
  ptyId: string | null;
  title: string | null;
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

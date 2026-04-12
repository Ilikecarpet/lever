import type { PaneLeaf, PaneNode, PaneSplit } from "../types/pane";

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let counter = 0;

export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export function resetCounter(val = 0): void {
  counter = val;
}

// ---------------------------------------------------------------------------
// Leaf factory
// ---------------------------------------------------------------------------

export function makeLeaf(): PaneLeaf {
  return { type: "leaf", id: nextId("pane"), ptyId: null, title: null };
}

// ---------------------------------------------------------------------------
// Tree operations (all immutable — return new objects, never mutate)
// ---------------------------------------------------------------------------

/**
 * Replace the leaf identified by `targetId` with a split containing
 * the original leaf and a new leaf. Returns `{ root, newLeafId }` or
 * `null` if `targetId` was not found.
 */
export function splitNode(
  root: PaneNode,
  targetId: string,
  direction: "horizontal" | "vertical",
): { root: PaneNode; newLeafId: string } | null {
  const result = splitInner(root, targetId, direction);
  if (result === null) return null;
  return { root: result.node, newLeafId: result.newLeafId };
}

function splitInner(
  node: PaneNode,
  targetId: string,
  direction: "horizontal" | "vertical",
): { node: PaneNode; newLeafId: string } | null {
  if (node.type === "leaf") {
    if (node.id !== targetId) return null;
    const originalLeaf: PaneLeaf = { ...node };
    const newLeaf = makeLeaf();
    const split: PaneSplit = {
      type: "split",
      id: nextId("split"),
      direction,
      ratio: 0.5,
      children: [originalLeaf, newLeaf],
    };
    return { node: split, newLeafId: newLeaf.id };
  }

  // node is a split — recurse into children
  const leftResult = splitInner(node.children[0], targetId, direction);
  if (leftResult !== null) {
    return {
      node: {
        ...node,
        children: [leftResult.node, node.children[1]],
      },
      newLeafId: leftResult.newLeafId,
    };
  }

  const rightResult = splitInner(node.children[1], targetId, direction);
  if (rightResult !== null) {
    return {
      node: {
        ...node,
        children: [node.children[0], rightResult.node],
      },
      newLeafId: rightResult.newLeafId,
    };
  }

  return null;
}

/**
 * Remove the leaf identified by `targetId` and promote its sibling.
 * Returns the new root, or `null` if the target was not found or is
 * the root leaf itself (cannot remove the last pane).
 */
export function removeNode(
  root: PaneNode,
  targetId: string,
): PaneNode | null {
  // If the root is the target leaf, we can't remove it
  if (root.type === "leaf") return null;

  return removeInner(root, targetId);
}

function removeInner(
  node: PaneNode,
  targetId: string,
): PaneNode | null {
  if (node.type === "leaf") return null;

  const [left, right] = node.children;

  // Check if either direct child is the target
  if (left.type === "leaf" && left.id === targetId) return right;
  if (right.type === "leaf" && right.id === targetId) return left;

  // Recurse into children
  const leftResult = removeInner(left, targetId);
  if (leftResult !== null) {
    return { ...node, children: [leftResult, right] };
  }

  const rightResult = removeInner(right, targetId);
  if (rightResult !== null) {
    return { ...node, children: [left, rightResult] };
  }

  return null;
}

/**
 * Update the ratio of the split identified by `splitId`.
 * Ratio is clamped to the range [0.1, 0.9].
 * Returns a new tree, or null if the split was not found.
 */
export function updateRatio(
  root: PaneNode,
  splitId: string,
  ratio: number,
): PaneNode | null {
  const clamped = Math.min(0.9, Math.max(0.1, ratio));
  return updateRatioInner(root, splitId, clamped);
}

function updateRatioInner(
  node: PaneNode,
  splitId: string,
  ratio: number,
): PaneNode | null {
  if (node.type === "leaf") return null;

  if (node.id === splitId) {
    return { ...node, ratio };
  }

  const leftResult = updateRatioInner(node.children[0], splitId, ratio);
  if (leftResult !== null) {
    return { ...node, children: [leftResult, node.children[1]] };
  }

  const rightResult = updateRatioInner(node.children[1], splitId, ratio);
  if (rightResult !== null) {
    return { ...node, children: [node.children[0], rightResult] };
  }

  return null;
}

/**
 * Find a node by ID anywhere in the tree.
 */
export function findNode(root: PaneNode, id: string): PaneNode | null {
  if (root.id === id) return root;
  if (root.type === "leaf") return null;

  return findNode(root.children[0], id) ?? findNode(root.children[1], id);
}

/**
 * Collect all leaves in left-to-right order.
 */
export function collectLeaves(root: PaneNode): PaneLeaf[] {
  if (root.type === "leaf") return [root];
  return [
    ...collectLeaves(root.children[0]),
    ...collectLeaves(root.children[1]),
  ];
}

/**
 * Set `ptyId` on the leaf identified by `paneId`.
 * Returns a new tree, or null if the leaf was not found.
 */
export function setPtyIdInTree(
  root: PaneNode,
  paneId: string,
  ptyId: string,
): PaneNode | null {
  if (root.type === "leaf") {
    if (root.id === paneId) return { ...root, ptyId };
    return null;
  }

  const leftResult = setPtyIdInTree(root.children[0], paneId, ptyId);
  if (leftResult !== null) {
    return { ...root, children: [leftResult, root.children[1]] };
  }

  const rightResult = setPtyIdInTree(root.children[1], paneId, ptyId);
  if (rightResult !== null) {
    return { ...root, children: [root.children[0], rightResult] };
  }

  return null;
}

/**
 * Set `title` on the leaf identified by `paneId`.
 * Returns a new tree, or null if the leaf was not found.
 */
export function setTitleInTree(
  root: PaneNode,
  paneId: string,
  title: string,
): PaneNode | null {
  if (root.type === "leaf") {
    if (root.id === paneId) return { ...root, title };
    return null;
  }

  const leftResult = setTitleInTree(root.children[0], paneId, title);
  if (leftResult !== null) {
    return { ...root, children: [leftResult, root.children[1]] };
  }

  const rightResult = setTitleInTree(root.children[1], paneId, title);
  if (rightResult !== null) {
    return { ...root, children: [root.children[0], rightResult] };
  }

  return null;
}


export type SelectionNodeKind = "note" | "folder";
export interface SelectionNode {
  kind: SelectionNodeKind;
  id: string;
}

export function selectionKey(node: SelectionNode): string {
  return `${node.kind}:${node.id}`;
}

/** Focus goes here after leaving selection mode (drawer Esc in `AppShell`, exit paths of the trash/select bars). */
export const SIDEBAR_SELECT_BUTTON = "[data-sidebar-header] button[data-sidebar-select]";

export interface SidebarSelection {
  active: boolean;
  keys: ReadonlySet<string>;
  anchor: string | null;
}

export const EMPTY_SELECTION: SidebarSelection = { active: false, keys: new Set(), anchor: null };

export type SelectionOp =
  | { type: "start" }
  | { type: "end" }
  | { type: "toggle"; key: string }
  | { type: "range"; key: string; order: readonly string[] }
  | { type: "setAll"; keys: readonly string[] }
  | { type: "clear" };

function toggle(state: SidebarSelection, key: string): SidebarSelection {
  const keys = new Set(state.keys);
  if (keys.has(key)) keys.delete(key);
  else keys.add(key);
  return { ...state, keys, anchor: key };
}

export function reduceSelection(state: SidebarSelection, op: SelectionOp): SidebarSelection {
  if (op.type === "start") return { active: true, keys: new Set(), anchor: null };
  if (!state.active) return state;
  switch (op.type) {
    case "end":
      return EMPTY_SELECTION;
    case "toggle":
      return toggle(state, op.key);
    case "range": {
      // The anchor or key may have vanished after a refetch: degrade to a single-row toggle.
      const from = state.anchor === null ? -1 : op.order.indexOf(state.anchor);
      const to = op.order.indexOf(op.key);
      if (from === -1 || to === -1) return toggle(state, op.key);
      const keys = new Set(state.keys);
      for (const key of op.order.slice(Math.min(from, to), Math.max(from, to) + 1)) keys.add(key);
      return { ...state, keys };
    }
    case "setAll":
      return { ...state, keys: new Set(op.keys) };
    case "clear":
      return { ...state, keys: new Set(), anchor: null };
    default: {
      const exhaustive: never = op;
      return exhaustive;
    }
  }
}

export type SelectAllState = "all" | "some" | "none";

/** Looks only at visible rows, not at keys selected inside collapsed subtrees. */
export function selectAllState(visible: readonly string[], keys: ReadonlySet<string>): SelectAllState {
  if (visible.length === 0) return "none";
  let hit = 0;
  for (const key of visible) if (keys.has(key)) hit += 1;
  if (hit === 0) return "none";
  return hit === visible.length ? "all" : "some";
}

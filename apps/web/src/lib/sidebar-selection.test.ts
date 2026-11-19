import { describe, expect, it } from "vitest";
import { EMPTY_SELECTION, reduceSelection, selectAllState, selectionKey, SIDEBAR_SELECT_BUTTON, type SelectionOp, type SidebarSelection } from "./sidebar-selection";

const ORDER = ["a", "b", "c", "d", "e"] as const;

function run(ops: SelectionOp[], from: SidebarSelection = EMPTY_SELECTION): SidebarSelection {
  return ops.reduce(reduceSelection, from);
}

describe("selectAllState", () => {
  it("only visible rows count: empty -> none; all present -> all; partial -> some; only in a collapsed subtree -> none", () => {
    expect(selectAllState([], new Set(["a"]))).toBe("none");
    expect(selectAllState(["a", "b"], new Set(["a", "b"]))).toBe("all");
    expect(selectAllState(["a", "b"], new Set(["a"]))).toBe("some");
    expect(selectAllState(["a", "b"], new Set(["c"]))).toBe("none");
  });
});

const keysOf = (state: SidebarSelection) => [...state.keys].sort();

describe("reduceSelection", () => {
  it("start / end: start enters, end returns EMPTY_SELECTION; end while not selecting returns the original state", () => {
    const started = run([{ type: "start" }]);
    expect(started.active).toBe(true);
    expect(started.keys.size).toBe(0);
    expect(started.anchor).toBeNull();
    expect(reduceSelection(run([{ type: "toggle", key: "a" }], started), { type: "end" })).toBe(EMPTY_SELECTION);

    const idle: SidebarSelection = { active: false, keys: new Set(), anchor: null };
    expect(reduceSelection(idle, { type: "end" })).toBe(idle);
  });

  it("toggle: adds, toggling again removes; anchor is the last toggled key", () => {
    const added = run([{ type: "start" }, { type: "toggle", key: "a" }]);
    expect(keysOf(added)).toEqual(["a"]);
    expect(added.anchor).toBe("a");
    const both = reduceSelection(added, { type: "toggle", key: "b" });
    expect(keysOf(both)).toEqual(["a", "b"]);
    expect(both.anchor).toBe("b");
    const removed = reduceSelection(both, { type: "toggle", key: "a" });
    expect(keysOf(removed)).toEqual(["b"]);
    expect(removed.anchor).toBe("a");
  });

  it("range: adds everything between the anchor and key, does not deselect outside the range, anchor stays", () => {
    const first = run([{ type: "start" }, { type: "toggle", key: "b" }, { type: "range", key: "d", order: ORDER }]);
    expect(keysOf(first)).toEqual(["b", "c", "d"]);
    expect(first.anchor).toBe("b");
    const second = reduceSelection(first, { type: "range", key: "a", order: ORDER });
    expect(keysOf(second)).toEqual(["a", "b", "c", "d"]);
    expect(second.anchor).toBe("b");
  });

  it("range degenerates into a single-row toggle: no anchor, anchor not in order, key not in order", () => {
    const noAnchor = run([{ type: "start" }, { type: "range", key: "d", order: ORDER }]);
    expect(keysOf(noAnchor)).toEqual(["d"]);
    expect(noAnchor.anchor).toBe("d");

    const staleAnchor = run([{ type: "start" }, { type: "toggle", key: "x" }, { type: "range", key: "d", order: ORDER }]);
    expect(keysOf(staleAnchor)).toEqual(["d", "x"]);
    expect(staleAnchor.anchor).toBe("d");

    const outside = run([{ type: "start" }, { type: "toggle", key: "b" }, { type: "range", key: "z", order: ORDER }]);
    expect(keysOf(outside)).toEqual(["b", "z"]);
    expect(outside.anchor).toBe("z");
  });

  it("setAll / clear: setAll replaces with the given keys, anchor unchanged; clear empties and anchor is null", () => {
    const all = run([{ type: "start" }, { type: "toggle", key: "e" }, { type: "setAll", keys: ["a", "c"] }]);
    expect(keysOf(all)).toEqual(["a", "c"]);
    expect(all.anchor).toBe("e");
    const cleared = reduceSelection(all, { type: "clear" });
    expect(cleared.keys.size).toBe(0);
    expect(cleared.anchor).toBeNull();
    expect(cleared.active).toBe(true);
  });

  it("while not selecting, toggle / range / setAll / clear all return the original state", () => {
    const idle = EMPTY_SELECTION;
    expect(reduceSelection(idle, { type: "toggle", key: "a" })).toBe(idle);
    expect(reduceSelection(idle, { type: "range", key: "c", order: ORDER })).toBe(idle);
    expect(reduceSelection(idle, { type: "setAll", keys: ["a", "b"] })).toBe(idle);
    expect(reduceSelection(idle, { type: "clear" })).toBe(idle);
  });

  it("selectionKey is kind:id", () => {
    expect(selectionKey({ kind: "note", id: "x" })).toBe("note:x");
  });

  it("SIDEBAR_SELECT_BUTTON: the button in the title row carrying data-sidebar-select", () => {
    expect(SIDEBAR_SELECT_BUTTON).toBe("[data-sidebar-header] button[data-sidebar-select]");
  });
});

describe("folder keys", () => {
  it("folder:a and note:a are two keys, toggling one does not affect the other", () => {
    expect(selectionKey({ kind: "folder", id: "a" })).toBe("folder:a");
    const state = run([{ type: "start" }, { type: "toggle", key: selectionKey({ kind: "folder", id: "a" }) }, { type: "toggle", key: selectionKey({ kind: "note", id: "a" }) }]);
    expect(keysOf(state)).toEqual(["folder:a", "note:a"]);
    expect(keysOf(run([{ type: "toggle", key: "folder:a" }], state))).toEqual(["note:a"]);
  });
});

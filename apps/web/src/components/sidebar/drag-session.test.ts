import { act, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetCollapseForTests } from "./collapse";
import {
  __resetDragSessionForTests,
  beginDrag,
  endDrag,
  getDragSource,
  setCreating,
  setPreview,
  takeDropZone,
  applyDragOver,
  useDragView,
  type StackPreviewState,
} from "./drag-session";
import { DRAG_HOVER_DELAY_MS, type DragOverResult, type DragSource, type DropZone, type HoldAction } from "./drag-zone";
import { __resetFolderSortForTests } from "./folder-sort";

afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
  __resetFolderSortForTests();
  __resetDragSessionForTests();
  vi.useRealTimers();
});

/**
 * DragOverResults are hand-built; containers follow the real DOM shape: `[data-sidebar-list]` inside `[data-sidebar-instance]` (beginDrag receives the former).
 */

const SOURCE: DragSource = { noteId: "A", space: "personal", folderId: null, title: "Alpha" };
const springF: HoldAction = { kind: "spring", folderId: "F" };
const springG: HoldAction = { kind: "spring", folderId: "G" };
const stackX: HoldAction = { kind: "stack", anchorNoteId: "X", parentFolderId: null };
const zoneF: DropZone = { kind: "place", folderId: "F", scope: { kind: "folder", folderId: "F" } };
const zoneG: DropZone = { kind: "place", folderId: "G", scope: { kind: "folder", folderId: "G" } };
const zoneList: DropZone = { kind: "place", folderId: null, scope: { kind: "list" } };
const zoneStack: DropZone = { kind: "stack", scope: { kind: "preview" } };
const overF: DragOverResult = { zone: zoneF, row: "folder:F", hold: springF };
const overG: DragOverResult = { zone: zoneG, row: "folder:G", hold: springG };
const PREVIEW_B: StackPreviewState = { anchorNoteId: "B", parentFolderId: null, name: "New folder", sourceTitle: "Alpha" };

function mountSidebar(): { list: HTMLElement; row: HTMLElement } {
  const instance = document.createElement("div");
  instance.setAttribute("data-sidebar-instance", "");
  const list = document.createElement("div");
  list.setAttribute("data-sidebar-list", "");
  const row = document.createElement("li");
  row.setAttribute("data-node-kind", "folder");
  row.setAttribute("data-node-id", "F");
  list.append(row);
  instance.append(list);
  document.body.append(instance);
  return { list, row };
}

function outsideEl(): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-sidebar-header", "");
  document.body.append(el);
  return el;
}

/** Current dragover listener count on document, replayed from the add/remove calls; `capture` counts those added with capture. */
function trackDragoverListeners(): () => { capture: number; bubble: number } {
  const add = vi.spyOn(document, "addEventListener");
  const remove = vi.spyOn(document, "removeEventListener");
  const isCapture = (opts: unknown) => opts === true || (typeof opts === "object" && opts !== null && (opts as { capture?: boolean }).capture === true);
  return () => {
    const ops = [
      ...add.mock.calls.map((c, i) => ({ order: add.mock.invocationCallOrder[i] ?? 0, on: true, call: c })),
      ...remove.mock.calls.map((c, i) => ({ order: remove.mock.invocationCallOrder[i] ?? 0, on: false, call: c })),
    ].sort((a, b) => a.order - b.order);
    const live = new Set<string>();
    const ids = new Map<unknown, number>();
    for (const { on, call } of ops) {
      if (call[0] !== "dragover") continue;
      if (!ids.has(call[1])) ids.set(call[1], ids.size);
      const key = `${ids.get(call[1])}:${isCapture(call[2])}`;
      if (on) live.add(key);
      else live.delete(key);
    }
    const all = [...live];
    return { capture: all.filter((k) => k.endsWith(":true")).length, bubble: all.filter((k) => k.endsWith(":false")).length };
  };
}

function setup() {
  vi.useFakeTimers();
  const { list, row } = mountSidebar();
  const hook = renderHook(() => useDragView());
  const onHold = vi.fn<(hold: HoldAction) => void>();
  act(() => beginDrag(SOURCE, list));
  const over = (result: DragOverResult) => {
    let accepted = false;
    act(() => {
      accepted = applyDragOver(result, onHold);
    });
    return accepted;
  };
  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
  return { list, row, hook, onHold, over, advance, view: () => hook.result.current };
}

describe("drag-session", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("beginDrag: active is true and the source is recorded; takeDropZone clears the source", () => {
    const { view } = setup();
    expect(view().active).toBe(true);
    expect(getDragSource()).toEqual(SOURCE);
    act(() => {
      takeDropZone();
    });
    expect(getDragSource()).toBeNull();
  });

  it("the first hold starts the timer: not called at DELAY-1, called once 1 later, with the spring F argument", () => {
    const { over, advance, onHold } = setup();
    over(overF);
    advance(DRAG_HOVER_DELAY_MS - 1);
    expect(onHold).not.toHaveBeenCalled();
    advance(1);
    expect(onHold).toHaveBeenCalledTimes(1);
    expect(onHold).toHaveBeenCalledWith(springF);
  });

  it("still fires on time without further dragovers", () => {
    const { over, advance, onHold } = setup();
    over(overF);
    advance(DRAG_HOVER_DELAY_MS);
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it("a second event on the same row mid-wait does not restart the timer: fires DELAY after the first", () => {
    const { over, advance, onHold } = setup();
    over(overF);
    advance(DRAG_HOVER_DELAY_MS / 2);
    over(overF);
    advance(DRAG_HOVER_DELAY_MS / 2);
    expect(onHold).toHaveBeenCalledTimes(1);
    expect(onHold).toHaveBeenCalledWith(springF);
  });

  it("moving to a row whose hold is null -> never fires; moving to another row with a hold -> timer restarts from that event", () => {
    const { over, advance, onHold } = setup();
    over(overF);
    advance(DRAG_HOVER_DELAY_MS - 1);
    over({ zone: zoneList, row: null, hold: null });
    advance(DRAG_HOVER_DELAY_MS * 4);
    expect(onHold).not.toHaveBeenCalled();

    over(overF);
    advance(DRAG_HOVER_DELAY_MS - 1);
    over(overG);
    advance(DRAG_HOVER_DELAY_MS - 1);
    expect(onHold).not.toHaveBeenCalled();
    advance(1);
    expect(onHold).toHaveBeenCalledTimes(1);
    expect(onHold).toHaveBeenCalledWith(springG);
  });

  it("document dragover outside the container -> scope null, timer cancelled, preview collapsed; inside the container -> nothing cleared", () => {
    const { over, advance, onHold, row, view } = setup();
    over(overF);
    act(() => setPreview(PREVIEW_B));
    act(() => {
      fireEvent.dragOver(row);
    });
    expect(view().scope).toBe("folder:F");
    expect(view().preview).toBe(PREVIEW_B);

    act(() => {
      fireEvent.dragOver(document.body);
    });
    expect(view().scope).toBeNull();
    expect(view().preview).toBeNull();
    expect(view().active).toBe(true);
    advance(DRAG_HOVER_DELAY_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });

  it("takeDropZone returns the zone of the last accepted event and clears state, timer and document listener", () => {
    const listeners = trackDragoverListeners();
    const { over, advance, onHold, row, view } = setup();
    expect(listeners()).toEqual({ capture: 1, bubble: 0 });
    over(overF);
    act(() => setPreview(PREVIEW_B));
    let zone: DropZone | null = null;
    act(() => {
      zone = takeDropZone();
    });
    expect(zone).toEqual(zoneF);
    expect(view()).toMatchObject({ active: false, scope: null, preview: null });
    advance(DRAG_HOVER_DELAY_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
    expect(listeners()).toEqual({ capture: 0, bubble: 0 });
    const snapshot = view();
    act(() => {
      fireEvent.dragOver(document.body);
      fireEvent.dragOver(row);
    });
    expect(view()).toBe(snapshot);
  });

  it("endDrag is idempotent, clears state and listeners, leaves creating alone", () => {
    const listeners = trackDragoverListeners();
    const { over, advance, onHold, view } = setup();
    over(overF);
    act(() => setPreview(PREVIEW_B));
    act(() => setCreating(PREVIEW_B));
    act(() => endDrag());
    expect(() => endDrag()).not.toThrow();
    expect(view()).toEqual({ active: false, scope: null, preview: null, creating: PREVIEW_B });
    expect(getDragSource()).toBeNull();
    expect(listeners()).toEqual({ capture: 0, bubble: 0 });
    advance(DRAG_HOVER_DELAY_MS * 2);
    expect(onHold).not.toHaveBeenCalled();

    act(() => beginDrag(SOURCE, mountSidebar().list));
    act(() => {
      takeDropZone();
    });
    expect(() => endDrag()).not.toThrow();
    expect(view().creating).toBe(PREVIEW_B);
    act(() => setCreating(null));
    expect(view().creating).toBeNull();
  });

  it("while previewing, an event on another row collapses the preview; DELAY after that event onHold(stack X) is called once", () => {
    const { over, advance, onHold, view } = setup();
    over({ zone: zoneStack, row: "preview", hold: null });
    act(() => setPreview(PREVIEW_B));
    advance(DRAG_HOVER_DELAY_MS);
    expect(over({ zone: zoneList, row: "note:X", hold: stackX })).toBe(true);
    expect(view().preview).toBeNull();
    advance(DRAG_HOVER_DELAY_MS - 1);
    expect(onHold).not.toHaveBeenCalled();
    advance(1);
    expect(onHold).toHaveBeenCalledTimes(1);
    expect(onHold).toHaveBeenCalledWith(stackX);
  });

  it("while previewing, one event on row preview and one on row note:B -> preview kept, returns true", () => {
    const { over, view } = setup();
    act(() => setPreview(PREVIEW_B));
    expect(over({ zone: zoneStack, row: "preview", hold: null })).toBe(true);
    expect(view().preview).toBe(PREVIEW_B);
    expect(over({ zone: zoneStack, row: "note:B", hold: null })).toBe(true);
    expect(view().preview).toBe(PREVIEW_B);
    expect(view().scope).toBe("preview");
  });

  it("null zone -> false and scope null; non-null zone -> true and scope is dropScopeKey", () => {
    const { over, view } = setup();
    expect(over(overF)).toBe(true);
    expect(view().scope).toBe("folder:F");
    expect(over({ zone: null, row: "note:Q", hold: null })).toBe(false);
    expect(view().scope).toBeNull();
    expect(over({ zone: { kind: "place", folderId: null, scope: { kind: "group", groupId: "g1" } }, row: null, hold: null })).toBe(true);
    expect(view().scope).toBe("group:g1");
    expect(over({ zone: zoneList, row: null, hold: null })).toBe(true);
    expect(view().scope).toBe("list");
  });

  it("two consecutive identical results -> snapshot is Object.is-equal, render count unchanged", () => {
    vi.useFakeTimers();
    const { list } = mountSidebar();
    let renders = 0;
    const hook = renderHook(() => {
      renders += 1;
      return useDragView();
    });
    const onHold = vi.fn<(hold: HoldAction) => void>();
    act(() => beginDrag(SOURCE, list));
    act(() => {
      applyDragOver(overF, onHold);
    });
    const before = hook.result.current;
    const rendersBefore = renders;
    act(() => {
      applyDragOver({ zone: { kind: "place", folderId: "F", scope: { kind: "folder", folderId: "F" } }, row: "folder:F", hold: springF }, onHold);
    });
    expect(Object.is(hook.result.current, before)).toBe(true);
    expect(renders).toBe(rendersBefore);
  });

  it("two containers: an event inside the other container (c2) counts as leaving; inside the originating container (c1) clears nothing", () => {
    vi.useFakeTimers();
    const c1 = mountSidebar();
    const c2 = mountSidebar();
    const hook = renderHook(() => useDragView());
    const onHold = vi.fn<(hold: HoldAction) => void>();
    act(() => beginDrag(SOURCE, c1.list));
    act(() => {
      applyDragOver(overF, onHold);
    });
    act(() => {
      fireEvent.dragOver(c1.row);
    });
    expect(hook.result.current.scope).toBe("folder:F");
    act(() => {
      fireEvent.dragOver(c2.row);
    });
    expect(hook.result.current.scope).toBeNull();
    act(() => vi.advanceTimersByTime(DRAG_HOVER_DELAY_MS * 2));
    expect(onHold).not.toHaveBeenCalled();
  });

  it("takeDropZone uses the last event: later one rejected -> null; later left the tree -> null; only one accepted -> that zone", () => {
    const { over } = setup();
    over(overF);
    over({ zone: null, row: "note:Q", hold: null });
    let zone: DropZone | null = zoneF;
    act(() => {
      zone = takeDropZone();
    });
    expect(zone).toBeNull();

    const second = mountSidebar();
    act(() => beginDrag(SOURCE, second.list));
    over(overF);
    act(() => {
      fireEvent.dragOver(outsideEl());
    });
    zone = zoneF;
    act(() => {
      zone = takeDropZone();
    });
    expect(zone).toBeNull();

    act(() => beginDrag(SOURCE, mountSidebar().list));
    over(overG);
    act(() => {
      zone = takeDropZone();
    });
    expect(zone).toEqual(zoneG);
  });

  it("the document listener is capture: an element outside the container calling stopPropagation still clears the marker", () => {
    const { over, view } = setup();
    over(overF);
    const blocker = outsideEl();
    blocker.addEventListener("dragover", (event) => event.stopPropagation());
    act(() => {
      fireEvent.dragOver(blocker);
    });
    expect(view().scope).toBeNull();
  });

  it("leaving the tree and returning to the same row -> DELAY counted from the last event, onHold called once", () => {
    const { over, advance, onHold } = setup();
    over(overF);
    advance(DRAG_HOVER_DELAY_MS / 2);
    act(() => {
      fireEvent.dragOver(document.body);
    });
    advance(DRAG_HOVER_DELAY_MS / 2);
    over(overF);
    advance(DRAG_HOVER_DELAY_MS - 1);
    expect(onHold).not.toHaveBeenCalled();
    advance(1);
    expect(onHold).toHaveBeenCalledTimes(1);
    advance(DRAG_HOVER_DELAY_MS * 2);
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it("setPreview and setCreating are independent; takeDropZone collapses the preview but leaves creating alone", () => {
    const { view } = setup();
    act(() => setPreview(PREVIEW_B));
    act(() => setCreating(PREVIEW_B));
    expect(view()).toEqual({ active: true, scope: null, preview: PREVIEW_B, creating: PREVIEW_B });
    act(() => {
      takeDropZone();
    });
    expect(view()).toEqual({ active: false, scope: null, preview: null, creating: PREVIEW_B });
  });

  it("beginDrag while already dragging -> old timer, marker, preview and listeners are cleared, leaving one capture listener", () => {
    const listeners = trackDragoverListeners();
    const { over, advance, onHold, view } = setup();
    over(overF);
    act(() => setPreview(PREVIEW_B));
    act(() => beginDrag(SOURCE, mountSidebar().list));
    expect(view()).toMatchObject({ active: true, scope: null, preview: null });
    expect(listeners()).toEqual({ capture: 1, bubble: 0 });
    advance(DRAG_HOVER_DELAY_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });

  it("applyDragOver without a drag returns false, starts no timer and leaves the view alone", () => {
    vi.useFakeTimers();
    const hook = renderHook(() => useDragView());
    const onHold = vi.fn<(hold: HoldAction) => void>();
    const before = hook.result.current;
    let accepted = true;
    act(() => {
      accepted = applyDragOver(overF, onHold);
    });
    expect(accepted).toBe(false);
    expect(hook.result.current).toBe(before);
    act(() => vi.advanceTimersByTime(DRAG_HOVER_DELAY_MS * 2));
    expect(onHold).not.toHaveBeenCalled();
  });
});

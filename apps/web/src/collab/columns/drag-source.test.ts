/* eslint-disable @typescript-eslint/no-explicit-any -- tests reach into PM's view directly (types unavailable in apps/web) */
import { afterEach, describe, expect, it, vi } from "vitest";
import { P, mountEditor, row, startBlockDrag, type PartialBlockLike } from "@/test/columns-fixtures";
import * as dragSource from "./drag-source";
import { clearDraggedBlocks, draggedBlocksOf } from "./drag-source";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.reverse()) c();
  cleanups = [];
  vi.restoreAllMocks();
});

/** Mounts an editor. The recorder is attached by the row layout extension on mount (every editor using `noteSchema` has it) and removed on unmount. */
function mount(content: PartialBlockLike[]) {
  const mounted = mountEditor(content);
  cleanups.push(mounted.destroy);
  return { ...mounted, view: mounted.editor.prosemirrorView as any };
}

const fire = (target: EventTarget, type: string) => target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));

describe("drag-source recorder", () => {
  it("drag handle drags a single block -> records node", () => {
    const { editor, view } = mount([P("x", "x1"), P("y", "y1")]);
    startBlockDrag(editor, "x1");
    expect(view.dragging).toBeTruthy(); // precondition: core treats it as a block drag
    expect(draggedBlocksOf(view)).toEqual({ ids: ["x1"], kind: "node", hasRows: false });
  });

  it("multi-selection containing a top-level row -> hasRows", () => {
    const { editor, view } = mount([P("p", "p1"), row([[P("a", "a1")], [P("b", "b1")]], "r"), P("y", "y1")]);
    startBlockDrag(editor, "p1", { range: ["p1", "a1"] });
    expect(draggedBlocksOf(view)).toEqual({ ids: ["p1", "r"], kind: "multi", hasRows: true });
  });

  it("multi-selection of two top-level blocks -> multi, ids in document order", () => {
    const { editor, view } = mount([P("x", "x1"), P("y", "y1"), P("z", "z1")]);
    startBlockDrag(editor, "z1", { range: ["y1", "z1"] });
    expect(draggedBlocksOf(view)).toEqual({ ids: ["y1", "z1"], kind: "multi", hasRows: false });
  });

  it("the record is still there after a capture drop on document; cleared after dragend", () => {
    const { editor, view } = mount([P("x", "x1"), P("y", "y1")]);
    startBlockDrag(editor, "y1");
    let seenInCapture: unknown = "not-called";
    document.addEventListener("drop", () => (seenInCapture = draggedBlocksOf(view)), { capture: true, once: true });
    fire(document, "drop");
    expect(seenInCapture).toEqual({ ids: ["y1"], kind: "node", hasRows: false });
    expect(draggedBlocksOf(view)).toEqual({ ids: ["y1"], kind: "node", hasRows: false });
    fire(document, "dragend");
    expect(draggedBlocksOf(view)).toBeNull();
  });

  it("clearDraggedBlocks clears the record", () => {
    const { editor, view } = mount([P("x", "x1"), P("y", "y1")]);
    startBlockDrag(editor, "y1");
    clearDraggedBlocks(view);
    expect(draggedBlocksOf(view)).toBeNull();
  });

  it("dragstart on a read-only editor records null (overwriting the earlier record)", () => {
    const { editor, view } = mount([P("x", "x1"), P("y", "y1")]);
    startBlockDrag(editor, "x1");
    expect(draggedBlocksOf(view)).not.toBeNull(); // control: recorded when editable
    editor.isEditable = false;
    startBlockDrag(editor, "y1");
    expect(draggedBlocksOf(view)).toBeNull();
  });

  it("the recorder's document listeners carry mount's signal; after unmount the signal is aborted and dragstart no longer records", () => {
    // Core has other dragstart/dragend listeners on document; only look at the ones registered during the recorder's own call.
    const add = vi.spyOn(document, "addEventListener");
    const original = dragSource.attachDragSourceRecorder;
    let mountSignal: AbortSignal | undefined;
    let registered: Array<[string, AddEventListenerOptions | undefined]> = [];
    vi.spyOn(dragSource, "attachDragSourceRecorder").mockImplementation((editor, dom, signal) => {
      const before = add.mock.calls.length;
      original(editor, dom, signal);
      mountSignal = signal;
      registered = add.mock.calls.slice(before).map(([type, , options]) => [type, options as AddEventListenerOptions | undefined]);
    });
    const mounted = mountEditor([P("x", "x1"), P("y", "y1")]);
    const { editor } = mounted;
    const view = editor.prosemirrorView as any;
    const host = editor.domElement!.parentElement!;
    expect(mountSignal).toBeInstanceOf(AbortSignal); // precondition: the recorder was attached on mount
    expect(registered.map(([type]) => type)).toEqual(["dragstart", "dragend", "dragend"]);
    for (const [, options] of registered) expect(options?.signal).toBe(mountSignal);
    startBlockDrag(editor, "x1");
    expect(draggedBlocksOf(view)).not.toBeNull(); // control: recorded while mounted
    clearDraggedBlocks(view);
    mounted.destroy();
    expect(mountSignal!.aborted).toBe(true);
    // After unmount `editor.domElement` is gone, so this line alone would pass vacuously; the signal assertion above is what carries weight.
    const source = document.createElement("div");
    host.appendChild(source);
    cleanups.push(() => source.remove());
    expect(source.isConnected).toBe(true);
    fire(source, "dragstart");
    expect(draggedBlocksOf(view)).toBeNull();
  });

  it("dragstart with preventDefault -> records null (overwriting the earlier record)", () => {
    const { editor, view } = mount([P("x", "x1"), P("y", "y1")]);
    startBlockDrag(editor, "x1");
    expect(draggedBlocksOf(view)).not.toBeNull(); // control: recorded when not cancelled
    const { event } = startBlockDrag(editor, "y1", { prevent: true });
    expect(event.defaultPrevented).toBe(true);
    expect(view.dragging).toBeTruthy(); // a cancelled dragstart still makes core set view.dragging
    expect(draggedBlocksOf(view)).toBeNull();
  });

  it("dragstart outside the editor container -> records null", () => {
    const { editor, view } = mount([P("x", "x1"), P("y", "y1")]);
    startBlockDrag(editor, "x1");
    const outside = document.createElement("div");
    document.documentElement.appendChild(outside);
    cleanups.push(() => outside.remove());
    expect(editor.domElement!.parentElement!.contains(outside)).toBe(false); // precondition
    fire(outside, "dragstart");
    expect(draggedBlocksOf(view)).toBeNull();
  });
});

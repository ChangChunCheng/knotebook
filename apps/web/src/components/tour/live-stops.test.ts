import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import * as Y from "yjs";
import { BlockNoteEditor, SuggestionMenu } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { collabUndoManager } from "@/collab/undo";
import { noteSchema } from "@/collab/schema";
import { isTourTransactionFilterOn } from "@/collab/tour-filter-flag";
import { createTourTransactionFilterExtension } from "@/collab/tour-transaction-filter";
import { getTourNoteEditor, registerEditor, type TourEditor } from "@/lib/tour-bridge";
import { TourEngine, type TourStopEntry } from "./engine";
import {
  canRunLiveStop,
  installLiveStopInput,
  isTriggerMenuShown,
  startTourTrigger,
  startLiveTrigger,
  stopTourTrigger,
  stopLiveTrigger,
  liveSelectionTarget,
  liveTriggerTarget,
  startLiveSelection,
  stopLiveSelection,
} from "./live-stops";
import { tourLayout } from "@/lib/tour-find";
import { stubLayoutTier, type LayoutTier } from "@/test/layout-tier";
import { prepareStop, STOPS, stopTarget, type StopContext } from "./stops";

const NOTE_ID = "11111111-1111-1111-1111-111111111111";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

/** Real editor with Y.Doc collaboration (the transaction-filter plugin attached and mounted), registered as the sample note's editor. */
async function setup(
  blocks: unknown[] = [{ type: "paragraph", content: "intro" }, { type: "paragraph" }],
): Promise<{ doc: Y.Doc; editor: TourEditor }> {
  const doc = new Y.Doc();
  cleanups.push(() => doc.destroy());
  const editor = BlockNoteEditor.create(
    withCollaboration({
      schema: noteSchema,
      collaboration: {
        provider: { awareness: undefined },
        fragment: doc.getXmlFragment(YDOC_FRAGMENT),
        user: { id: "u1", name: "User 1", color: "hsl(0 65% 45%)" },
      },
      _tiptapOptions: { extensions: [createTourTransactionFilterExtension()] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration's options type requires the full schema triple
    } as any),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
  ) as any as TourEditor;
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor.mount(el);
  cleanups.push(() => {
    editor.unmount();
    el.remove();
  });
  await tick();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- block input for tests
  editor.replaceBlocks(editor.document, blocks as any);
  cleanups.push(registerEditor(NOTE_ID, editor));
  return { doc, editor };
}

function snapshot(doc: Y.Doc, editor: TourEditor) {
  return {
    blocks: JSON.stringify(editor.document),
    update: Array.from(Y.encodeStateAsUpdate(doc)),
    undo: collabUndoManager(editor)?.undoStack.length ?? 0,
  };
}

const menuOf = (editor: TourEditor) => editor.getExtension(SuggestionMenu)!;

describe("canRunLiveStop", () => {
  it("editor registered, editable and ending with an empty paragraph -> holds", async () => {
    await setup();
    expect(canRunLiveStop(NOTE_ID)).toBe(true);
  });

  it("no registered editor (or id mismatch) -> does not hold", async () => {
    await setup();
    expect(canRunLiveStop("other")).toBe(false);
  });

  it("the last paragraph has text -> does not hold", async () => {
    await setup([{ type: "paragraph" }, { type: "paragraph", content: "typed" }]);
    expect(canRunLiveStop(NOTE_ID)).toBe(false);
  });

  it("the last block is not a paragraph, or the paragraph has child blocks -> does not hold", async () => {
    await setup([{ type: "paragraph" }, { type: "heading", props: { level: 2 } }]);
    expect(canRunLiveStop(NOTE_ID)).toBe(false);
    cleanups.pop()!();
    const { editor } = await setup([{ type: "paragraph", children: [{ type: "paragraph", content: "child" }] }]);
    expect(editor.document.at(-1)!.children).toHaveLength(1);
    expect(canRunLiveStop(NOTE_ID)).toBe(false);
  });

  it("read-only -> does not hold", async () => {
    const { editor } = await setup();
    editor.isEditable = false;
    expect(canRunLiveStop(NOTE_ID)).toBe(false);
  });

  it("reading the document throws -> does not hold and does not rethrow", async () => {
    const { editor } = await setup();
    vi.spyOn(editor, "document", "get").mockImplementation(() => {
      throw new Error("boom");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(canRunLiveStop(NOTE_ID)).toBe(false);
  });
});

describe("startTourTrigger / stopTourTrigger (real editor with Y.Doc)", () => {
  it("opening the [[ menu: the menu is open and the document, Y state and undo stack are unchanged", async () => {
    const { doc, editor } = await setup();
    const before = snapshot(doc, editor);
    expect(startTourTrigger(editor, "[[")).toBe(true);
    expect(isTriggerMenuShown(editor, "[[")).toBe(true);
    expect(snapshot(doc, editor)).toEqual(before);
    expect(editor._tiptapEditor.state.doc.textContent).toBe("intro");
  });

  it("opening the / menu works the same", async () => {
    const { doc, editor } = await setup();
    const before = snapshot(doc, editor);
    expect(startTourTrigger(editor, "/")).toBe(true);
    expect(isTriggerMenuShown(editor, "/")).toBe(true);
    expect(snapshot(doc, editor)).toEqual(before);
  });

  it("the cursor is placed in the last empty paragraph", async () => {
    const { editor } = await setup();
    startTourTrigger(editor, "[[");
    expect(editor.getTextCursorPosition().block.id).toBe(editor.document.at(-1)!.id);
  });

  it("after stopping the menu is closed, the document is identical and the selection is restored", async () => {
    const { doc, editor } = await setup();
    editor._tiptapEditor.commands.setTextSelection({ from: 3, to: 5 });
    const before = snapshot(doc, editor);
    startTourTrigger(editor, "[[");
    stopTourTrigger(editor);
    expect(isTriggerMenuShown(editor, "[[")).toBe(false);
    expect(snapshot(doc, editor)).toEqual(before);
    const { from, to } = editor._tiptapEditor.state.selection;
    expect([from, to]).toEqual([3, 5]);
  });

  it("the menu is closed by someone else before stopping: no throw and the document is unchanged", async () => {
    const { doc, editor } = await setup();
    const before = snapshot(doc, editor);
    startTourTrigger(editor, "[[");
    menuOf(editor).closeMenu();
    expect(() => stopTourTrigger(editor)).not.toThrow();
    expect(isTriggerMenuShown(editor, "[[")).toBe(false);
    expect(snapshot(doc, editor)).toEqual(before);
  });

  it("opening repeatedly does not treat a cursor position that has since moved as the selection to restore", async () => {
    const { editor } = await setup();
    editor._tiptapEditor.commands.setTextSelection({ from: 3, to: 5 });
    startTourTrigger(editor, "[[");
    startTourTrigger(editor, "[[");
    stopTourTrigger(editor);
    const { from, to } = editor._tiptapEditor.state.selection;
    expect([from, to]).toEqual([3, 5]);
  });

  it("repeated open, repeated close and closing without opening are all no-ops", async () => {
    const { doc, editor } = await setup();
    const before = snapshot(doc, editor);
    expect(() => stopTourTrigger(editor)).not.toThrow();
    startTourTrigger(editor, "[[");
    expect(startTourTrigger(editor, "[[")).toBe(true);
    stopTourTrigger(editor);
    expect(() => stopTourTrigger(editor)).not.toThrow();
    expect(snapshot(doc, editor)).toEqual(before);
  });

  it("while the menu is open, typing by the user is blocked (the filter is on) and the document is unchanged", async () => {
    const { doc, editor } = await setup();
    startLiveTrigger(NOTE_ID, "[[");
    const before = snapshot(doc, editor);
    const view = editor._tiptapEditor.view;
    view.dispatch(view.state.tr.insertText("x", view.state.selection.from));
    view.dispatch(view.state.tr.insertText("測", view.state.selection.from).setMeta("composition", 1));
    expect(snapshot(doc, editor)).toEqual(before);
    stopLiveTrigger(NOTE_ID);
    view.dispatch(view.state.tr.insertText("y", view.state.selection.from));
    expect(editor._tiptapEditor.state.doc.textContent).toBe("introy");
  });
});

describe("startLiveTrigger / stopLiveTrigger (for stops)", () => {
  it("entering: filter on, menu open; leaving: menu closed, filter off", async () => {
    const { editor } = await setup();
    startLiveTrigger(NOTE_ID, "[[");
    expect(isTourTransactionFilterOn(editor._tiptapEditor)).toBe(true);
    expect(isTriggerMenuShown(editor, "[[")).toBe(true);
    stopLiveTrigger(NOTE_ID);
    expect(isTourTransactionFilterOn(editor._tiptapEditor)).toBe(false);
    expect(isTriggerMenuShown(editor, "[[")).toBe(false);
  });

  it("an error while closing the menu: the filter is still turned off (the error is rethrown for the engine to log)", async () => {
    const { editor } = await setup();
    startLiveTrigger(NOTE_ID, "[[");
    expect(isTourTransactionFilterOn(editor._tiptapEditor)).toBe(true);
    vi.spyOn(menuOf(editor), "closeMenu").mockImplementation(() => {
      throw new Error("Attempting to update uninitialized suggestions menu");
    });
    expect(() => stopLiveTrigger(NOTE_ID)).toThrow("uninitialized");
    expect(isTourTransactionFilterOn(editor._tiptapEditor)).toBe(false);
  });

  it("no registered editor: does nothing and does not throw", () => {
    expect(getTourNoteEditor(NOTE_ID)).toBeNull();
    expect(() => startLiveTrigger(NOTE_ID, "[[")).not.toThrow();
    expect(() => stopLiveTrigger(NOTE_ID)).not.toThrow();
  });

  it("toggling does not register or unregister any plugin", async () => {
    const { editor } = await setup();
    const tiptap = editor._tiptapEditor;
    const register = vi.spyOn(tiptap, "registerPlugin");
    const unregister = vi.spyOn(tiptap, "unregisterPlugin");
    const plugins = tiptap.state.plugins;
    startLiveTrigger(NOTE_ID, "[[");
    stopLiveTrigger(NOTE_ID);
    expect(register).not.toHaveBeenCalled();
    expect(unregister).not.toHaveBeenCalled();
    expect(tiptap.state.plugins).toBe(plugins);
  });
});

/** An element with a size carrying the tour target attribute (unit tests have no real menu UI, so it stands in as the menu root). */
function fakeTargetEl(id: string, parent: Element = document.body): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-kb-tour-target", id);
  parent.appendChild(el);
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 10, 100, 40));
  return el;
}

describe("isTriggerMenuShown: depends on which trigger's menu it is", () => {
  it("when / is open [[ does not count as open, and when [[ is open / does not", async () => {
    const { editor } = await setup();
    startTourTrigger(editor, "/");
    expect(isTriggerMenuShown(editor, "/")).toBe(true);
    expect(isTriggerMenuShown(editor, "[[")).toBe(false);
    stopTourTrigger(editor);
    startTourTrigger(editor, "[[");
    expect(isTriggerMenuShown(editor, "[[")).toBe(true);
    expect(isTriggerMenuShown(editor, "/")).toBe(false);
  });

  it("with the menu closed neither counts", async () => {
    const { editor } = await setup();
    startTourTrigger(editor, "/");
    stopTourTrigger(editor);
    expect(isTriggerMenuShown(editor, "/")).toBe(false);
    expect(isTriggerMenuShown(editor, "[[")).toBe(false);
  });
});

describe("liveTriggerTarget: / menu", () => {
  it("live and the / menu open: points at the / menu; a [[ menu left on screen by the previous stop does not count", async () => {
    const { editor } = await setup();
    const oldMenu = fakeTargetEl("wikilinkMenu");
    startTourTrigger(editor, "/");
    expect(liveTriggerTarget(NOTE_ID, "/", "slashMenu", "flowchart")).toEqual([]);
    const menu = fakeTargetEl("slashMenu");
    expect(liveTriggerTarget(NOTE_ID, "/", "slashMenu", "flowchart")).toEqual([menu]);
    expect(oldMenu).not.toBe(menu);
  });

  it("when the open menu is the [[ menu, the / stop is not treated as live (it points at the diagram instead)", async () => {
    const { editor } = await setup();
    const chart = fakeTargetEl("flowchart", editor.domElement);
    fakeTargetEl("slashMenu");
    startTourTrigger(editor, "[[");
    expect(isTriggerMenuShown(editor, "[[")).toBe(true);
    expect(liveTriggerTarget(NOTE_ID, "/", "slashMenu", "flowchart")).toEqual([chart]);
  });

  it("/ menu closed: points at the ready-made diagram in the note", async () => {
    const { editor } = await setup();
    const chart = fakeTargetEl("flowchart", editor.domElement);
    fakeTargetEl("slashMenu");
    startTourTrigger(editor, "/");
    menuOf(editor).closeMenu();
    expect(liveTriggerTarget(NOTE_ID, "/", "slashMenu", "flowchart")).toEqual([chart]);
  });
});

describe("liveTriggerTarget", () => {
  it("live with the menu open: points at the menu; when the menu UI has not appeared yet it returns an empty array (the engine waits)", async () => {
    const { editor } = await setup();
    const link = fakeTargetEl("wikilink", editor.domElement);
    startTourTrigger(editor, "[[");
    expect(liveTriggerTarget(NOTE_ID, "[[", "wikilinkMenu", "wikilink")).toEqual([]);
    const menu = fakeTargetEl("wikilinkMenu");
    expect(liveTriggerTarget(NOTE_ID, "[[", "wikilinkMenu", "wikilink")).toEqual([menu]);
    expect(link).not.toBe(menu);
  });

  it("the menu closed for some reason: points at the ready-made result in the note", async () => {
    const { editor } = await setup();
    const link = fakeTargetEl("wikilink", editor.domElement);
    fakeTargetEl("wikilinkMenu");
    startTourTrigger(editor, "[[");
    menuOf(editor).closeMenu();
    expect(liveTriggerTarget(NOTE_ID, "[[", "wikilinkMenu", "wikilink")).toEqual([link]);
  });

  it("a menu not opened by the tour (opened by the user): not treated as live, points at the ready-made result", async () => {
    const { editor } = await setup();
    const link = fakeTargetEl("wikilink", editor.domElement);
    fakeTargetEl("wikilinkMenu");
    menuOf(editor).openSuggestionMenu("[[", { deleteTriggerCharacter: false });
    expect(isTriggerMenuShown(editor, "[[")).toBe(true);
    expect(liveTriggerTarget(NOTE_ID, "[[", "wikilinkMenu", "wikilink")).toEqual([link]);
  });

  it("not live (static stop): points at the ready-made result, ignoring the menu; with no ready-made result it returns an empty array", async () => {
    const { editor } = await setup();
    expect(liveTriggerTarget(NOTE_ID, "[[", "wikilinkMenu", "wikilink")).toEqual([]);
    fakeTargetEl("wikilinkMenu");
    const link = fakeTargetEl("wikilink", editor.domElement);
    expect(liveTriggerTarget(NOTE_ID, "[[", "wikilinkMenu", "wikilink")).toEqual([link]);
  });

  it("the fallback looks only inside the sample note's editor (same-id elements elsewhere do not count); a found element is scrolled into view the first time and not again", async () => {
    const { editor } = await setup();
    fakeTargetEl("wikilink"); // a same-id element outside the editor (e.g. a version preview)
    expect(liveTriggerTarget(NOTE_ID, "[[", "wikilinkMenu", "wikilink")).toEqual([]);
    const link = fakeTargetEl("wikilink", editor.domElement);
    const scroll = vi.fn();
    link.scrollIntoView = scroll;
    expect(liveTriggerTarget(NOTE_ID, "[[", "wikilinkMenu", "wikilink")).toEqual([link]);
    expect(liveTriggerTarget(NOTE_ID, "[[", "wikilinkMenu", "wikilink")).toEqual([link]);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
  });
});

describe("wikilink stop wired into the engine", () => {
  const CTX_BASE: StopContext = { searchQuery: "", aiActions: [], sampleNoteId: NOTE_ID, liveStops: true };
  /** A regular stop following the live stop in the sequence: its target is an element with a size, so the engine enters it at once. */
  function lastStop(): TourStopEntry {
    const el = fakeTargetEl("userMenu");
    return { stop: { id: "userMenu", titleKey: "x", bodyKey: "x", target: () => [el] } };
  }

  async function runStops(ctx: StopContext, editor: TourEditor) {
    fakeTargetEl("wikilink", editor.domElement);
    const engine = new TourEngine([{ stop: STOPS.wikilink }, lastStop()], ctx);
    await engine.begin();
    return engine;
  }

  it("entering opens the menu and filter; next, finish and unmount all clean up and the document is unchanged", async () => {
    const { doc, editor } = await setup();
    const before = snapshot(doc, editor);
    const menu = fakeTargetEl("wikilinkMenu");
    for (const leaveBy of ["next", "close", "unmount"] as const) {
      const engine = await runStops(CTX_BASE, editor);
      expect(engine.getSnapshot().entry?.stop.id).toBe("wikilink");
      expect(engine.getSnapshot().index).toBe(0);
      expect(isTriggerMenuShown(editor, "[[")).toBe(true);
      expect(isTourTransactionFilterOn(editor._tiptapEditor)).toBe(true);
      expect(liveTriggerTarget(NOTE_ID, "[[", "wikilinkMenu", "wikilink")).toEqual([menu]);
      if (leaveBy === "next") engine.next();
      else engine.end(leaveBy);
      await vi.waitFor(() => {
        expect(isTriggerMenuShown(editor, "[["), leaveBy).toBe(false);
        expect(isTourTransactionFilterOn(editor._tiptapEditor), leaveBy).toBe(false);
      });
      expect(snapshot(doc, editor), leaveBy).toEqual(before);
    }
  });

  it("Back to the live stop: the menu opens again", async () => {
    const { editor } = await setup();
    fakeTargetEl("wikilinkMenu");
    const engine = await runStops(CTX_BASE, editor);
    engine.next();
    await vi.waitFor(() => expect(engine.getSnapshot().index).toBe(1));
    expect(isTriggerMenuShown(editor, "[[")).toBe(false);
    engine.back();
    await vi.waitFor(() => expect(engine.getSnapshot().index).toBe(0));
    expect(isTriggerMenuShown(editor, "[[")).toBe(true);
    engine.end("close");
  });

  it("cannot go live (liveStops is false): no menu and no filter, points at the ready-made link", async () => {
    const { editor } = await setup();
    const engine = await runStops({ ...CTX_BASE, liveStops: false }, editor);
    expect(engine.getSnapshot().index).toBe(0);
    expect(isTriggerMenuShown(editor, "[[")).toBe(false);
    expect(isTourTransactionFilterOn(editor._tiptapEditor)).toBe(false);
    expect(STOPS.wikilink.live?.({ ...CTX_BASE, liveStops: false })).toBe(false);
    expect(STOPS.wikilink.live?.(CTX_BASE)).toBe(true);
    engine.end("close");
  });

  it.each([
    ["wikilink", "[[", "overlay", "floating"],
    ["slash", "/", "overlay", "floating"],
    ["wikilink", "[[", "phone", "phone"],
    ["slash", "/", "phone", "phone"],
  ] as const)("prepare also runs outside the wide window (%s stop, %s): menu and filter on; a regular stop does not run it on a floating sidebar", async (stopId, trigger, tier: LayoutTier, layout) => {
    const { editor } = await setup();
    stubLayoutTier(tier);
    expect(tourLayout()).toBe(layout);
    prepareStop(STOPS[stopId], CTX_BASE);
    expect(isTriggerMenuShown(editor, trigger)).toBe(true);
    expect(isTourTransactionFilterOn(editor._tiptapEditor)).toBe(true);
    stopLiveTrigger(NOTE_ID);
    const plain = vi.fn();
    prepareStop({ id: "tabs", titleKey: "x", bodyKey: "x", target: () => [], prepare: plain }, CTX_BASE);
    // Switching tabs on a floating sidebar opens the drawer, so regular stops do not run there; phones have no drawer, so they do.
    expect(plain).toHaveBeenCalledTimes(layout === "phone" ? 1 : 0);
  });
});

describe("slash stop wired into the engine", () => {
  const CTX_BASE: StopContext = { searchQuery: "", aiActions: [], sampleNoteId: NOTE_ID, liveStops: true };
  function lastStop(): TourStopEntry {
    const el = fakeTargetEl("userMenu");
    return { stop: { id: "userMenu", titleKey: "x", bodyKey: "x", target: () => [el] } };
  }

  /** Two live stops chained ([[ first, / second), with a fake element standing in for the menu UI. */
  async function run(ctx: StopContext, editor: TourEditor) {
    // The editor's own DOM is repainted by ProseMirror after a transaction, which would wipe the foreign fake element: point "the editor's DOM" at another fixed container instead.
    const host = document.createElement("div");
    document.body.appendChild(host);
    vi.spyOn(editor, "domElement", "get").mockReturnValue(host);
    const chart = fakeTargetEl("flowchart", host);
    fakeTargetEl("wikilinkMenu");
    fakeTargetEl("wikilink", host);
    const slashMenu = fakeTargetEl("slashMenu");
    const engine = new TourEngine([{ stop: STOPS.wikilink }, { stop: STOPS.slash }, lastStop()], ctx);
    await engine.begin();
    return { engine, chart, slashMenu };
  }

  it("going from the [[ stop to the / stop: the [[ menu closes, the / menu opens, the menu and the diagram are highlighted, and the document is unchanged", async () => {
    const { doc, editor } = await setup();
    const before = snapshot(doc, editor);
    const { engine, chart, slashMenu } = await run(CTX_BASE, editor);
    expect(isTriggerMenuShown(editor, "[[")).toBe(true);
    engine.next();
    await vi.waitFor(() => expect(engine.getSnapshot().entry?.stop.id).toBe("slash"));
    expect(isTriggerMenuShown(editor, "/")).toBe(true);
    expect(isTriggerMenuShown(editor, "[[")).toBe(false);
    expect(isTourTransactionFilterOn(editor._tiptapEditor)).toBe(true);
    expect(stopTarget(STOPS.slash, CTX_BASE)).toEqual([slashMenu, chart]);
    expect(snapshot(doc, editor)).toEqual(before);
  });

  it("leaving the / stop (next, finish, unmount): menu and filter are cleaned up and the document is unchanged", async () => {
    const { doc, editor } = await setup();
    const before = snapshot(doc, editor);
    for (const leaveBy of ["next", "close", "unmount"] as const) {
      const { engine } = await run(CTX_BASE, editor);
      engine.next();
      await vi.waitFor(() => expect(engine.getSnapshot().entry?.stop.id).toBe("slash"));
      if (leaveBy === "next") engine.next();
      else engine.end(leaveBy);
      await vi.waitFor(() => {
        expect(isTriggerMenuShown(editor, "/"), leaveBy).toBe(false);
        expect(isTourTransactionFilterOn(editor._tiptapEditor), leaveBy).toBe(false);
      });
      expect(snapshot(doc, editor), leaveBy).toEqual(before);
    }
  });

  it("Back to the / stop: the menu opens again", async () => {
    const { editor } = await setup();
    const { engine } = await run(CTX_BASE, editor);
    engine.next();
    await vi.waitFor(() => expect(engine.getSnapshot().index).toBe(1));
    engine.next();
    await vi.waitFor(() => expect(engine.getSnapshot().index).toBe(2));
    expect(isTriggerMenuShown(editor, "/")).toBe(false);
    engine.back();
    await vi.waitFor(() => expect(engine.getSnapshot().index).toBe(1));
    expect(isTriggerMenuShown(editor, "/")).toBe(true);
    engine.end("close");
  });

  it("cannot go live (liveStops is false): no menu, only the ready-made diagram is highlighted and the card is not in live mode", async () => {
    const { editor } = await setup();
    const ctx = { ...CTX_BASE, liveStops: false };
    const { engine, chart } = await run(ctx, editor);
    engine.next();
    await vi.waitFor(() => expect(engine.getSnapshot().entry?.stop.id).toBe("slash"));
    expect(isTriggerMenuShown(editor, "/")).toBe(false);
    expect(stopTarget(STOPS.slash, ctx)).toEqual([chart]);
    expect(STOPS.slash.live?.(ctx)).toBe(false);
    expect(STOPS.slash.live?.(CTX_BASE)).toBe(true);
    engine.end("close");
  });

  it("the / menu is closed midway: only the diagram remains", async () => {
    const { editor } = await setup();
    const { engine, chart } = await run(CTX_BASE, editor);
    engine.next();
    await vi.waitFor(() => expect(engine.getSnapshot().entry?.stop.id).toBe("slash"));
    menuOf(editor).closeMenu();
    expect(stopTarget(STOPS.slash, CTX_BASE)).toEqual([chart]);
    engine.end("close");
  });

  it("the note has no diagram (deleted by the user): with the menu open only the menu is highlighted", async () => {
    const { editor } = await setup();
    const slashMenu = fakeTargetEl("slashMenu");
    startLiveTrigger(NOTE_ID, "/");
    expect(stopTarget(STOPS.slash, CTX_BASE)).toEqual([slashMenu]);
    stopLiveTrigger(NOTE_ID);
    expect(stopTarget(STOPS.slash, CTX_BASE)).toEqual([]);
    expect(isTriggerMenuShown(editor, "/")).toBe(false);
  });
});

describe("installLiveStopInput", () => {
  const handlers = { next: vi.fn(), back: vi.fn() };
  let editorSide: ReturnType<typeof vi.fn>;
  let uninstall: () => void;

  beforeEach(() => {
    handlers.next.mockReset();
    handlers.back.mockReset();
    editorSide = vi.fn();
    // The editor-side listener: it only gets its turn after the window capture phase.
    document.body.addEventListener("keydown", editorSide);
    document.body.addEventListener("click", editorSide);
    uninstall = installLiveStopInput(handlers);
  });

  afterEach(() => {
    uninstall();
    document.body.removeEventListener("keydown", editorSide);
    document.body.removeEventListener("click", editorSide);
  });

  function press(init: KeyboardEventInit & { keyCode?: number }): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    if (init.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: init.keyCode });
    document.body.dispatchEvent(event);
    return event;
  }

  it("right arrow and Enter go to the next stop, left arrow goes back; none of them reaches the editor", () => {
    for (const key of ["ArrowRight", "Enter"]) {
      const event = press({ key });
      expect(event.defaultPrevented, key).toBe(true);
    }
    expect(handlers.next).toHaveBeenCalledTimes(2);
    const left = press({ key: "ArrowLeft" });
    expect(left.defaultPrevented).toBe(true);
    expect(handlers.back).toHaveBeenCalledTimes(1);
    expect(editorSide).not.toHaveBeenCalled();
  });

  it("other keys (arrows, characters, Tab, Backspace) are blocked and do not change the stop", () => {
    for (const key of ["ArrowDown", "ArrowUp", "a", "Tab", "Backspace", "/", "["]) {
      expect(press({ key }).defaultPrevented, key).toBe(true);
    }
    expect(handlers.next).not.toHaveBeenCalled();
    expect(handlers.back).not.toHaveBeenCalled();
    expect(editorSide).not.toHaveBeenCalled();
  });

  it("Esc is not handled here: it propagates as usual (the overlay takes it at the same level)", () => {
    const event = press({ key: "Escape" });
    expect(event.defaultPrevented).toBe(false);
    expect(editorSide).toHaveBeenCalledTimes(1);
    expect(handlers.next).not.toHaveBeenCalled();
  });

  it("keys during IME composition are blocked but do not change the stop", () => {
    const event = press({ key: "Process", keyCode: 229, isComposing: true });
    expect(event.defaultPrevented).toBe(true);
    press({ key: "Enter", isComposing: true });
    expect(handlers.next).not.toHaveBeenCalled();
    expect(editorSide).not.toHaveBeenCalled();
  });

  it("holding a key does not skip stops repeatedly", () => {
    press({ key: "ArrowRight", repeat: true });
    expect(handlers.next).not.toHaveBeenCalled();
  });

  it("function keys pass through (even the editor receives them)", () => {
    for (const key of ["F5", "F12"]) expect(press({ key }).defaultPrevented, key).toBe(false);
    expect(editorSide).toHaveBeenCalledTimes(2);
  });

  it("Ctrl / Meta / Alt combinations never reach the editor; browser shortcuts are not preventDefault-ed so they still work", () => {
    for (const init of [{ key: "r", ctrlKey: true }, { key: "l", metaKey: true }, { key: "c", ctrlKey: true }, { key: "ArrowLeft", altKey: true }, { key: "I", ctrlKey: true, shiftKey: true }]) {
      expect(press(init).defaultPrevented, JSON.stringify(init)).toBe(false);
    }
    expect(editorSide).not.toHaveBeenCalled();
  });

  it("Ctrl / Meta + z, y, v, x, a and Ctrl / Alt / Meta + Enter are additionally preventDefault-ed and do not change the stop", () => {
    const combos = [
      { key: "z", ctrlKey: true },
      { key: "Z", metaKey: true, shiftKey: true },
      { key: "y", ctrlKey: true },
      { key: "v", ctrlKey: true },
      { key: "x", metaKey: true },
      { key: "a", ctrlKey: true },
      { key: "Enter", ctrlKey: true },
      { key: "Enter", altKey: true },
      { key: "Enter", metaKey: true },
    ];
    for (const init of combos) expect(press(init).defaultPrevented, JSON.stringify(init)).toBe(true);
    expect(editorSide).not.toHaveBeenCalled();
    expect(handlers.next).not.toHaveBeenCalled();
    expect(handlers.back).not.toHaveBeenCalled();
  });

  it.each(["wikilinkMenu", "slashMenu"])("clicks on %s are blocked; clicks elsewhere pass through", (menuId) => {
    const menu = fakeTargetEl(menuId);
    const item = document.createElement("button");
    menu.appendChild(item);
    const onItem = vi.fn();
    item.addEventListener("click", onItem);
    item.click();
    expect(onItem).not.toHaveBeenCalled();
    const other = document.createElement("button");
    document.body.appendChild(other);
    const onOther = vi.fn();
    other.addEventListener("click", onOther);
    other.click();
    expect(onOther).toHaveBeenCalledTimes(1);
  });

  it("clicks on the format toolbar are blocked (the AI box does not really open)", () => {
    const popover = document.createElement("div");
    popover.setAttribute("data-kb-formatting-toolbar-popover", "");
    const button = document.createElement("button");
    popover.appendChild(button);
    document.body.appendChild(popover);
    const onButton = vi.fn();
    button.addEventListener("click", onButton);
    button.click();
    expect(onButton).not.toHaveBeenCalled();
  });

  it("everything passes through after teardown", () => {
    uninstall();
    expect(press({ key: "a" }).defaultPrevented).toBe(false);
    expect(press({ key: "ArrowRight" }).defaultPrevented).toBe(false);
    expect(handlers.next).not.toHaveBeenCalled();
    uninstall = installLiveStopInput(handlers);
  });
});

describe("startLiveSelection / stopLiveSelection (AI stop)", () => {
  const SENTENCE = i18n.t("tourGuide.sample.aiSentence");
  const BLOCKS = [{ type: "paragraph", content: "intro" }, { type: "paragraph", content: SENTENCE }, { type: "paragraph" }];
  const AI_CTX: StopContext = {
    searchQuery: "",
    aiActions: [{ id: "rewrite", name: "Rewrite", applyMode: "preview", kind: "quick" }],
    sampleNoteId: NOTE_ID,
    liveStops: false,
  };

  const selectedText = (editor: TourEditor) => {
    const { state } = editor._tiptapEditor;
    return state.doc.textBetween(state.selection.from, state.selection.to);
  };

  /** Fake floating layer of the format toolbar: contains a sized button named AI. */
  function fakeToolbar(): HTMLButtonElement {
    const popover = document.createElement("div");
    popover.setAttribute("data-kb-formatting-toolbar-popover", "");
    const button = document.createElement("button");
    button.setAttribute("aria-label", i18n.t("ai.toolbar.trigger"));
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 10, 40, 30));
    popover.appendChild(button);
    document.body.appendChild(popover);
    return button;
  }

  it("entering: the selection is exactly that sentence; leaving: the selection collapses and the filter is turned off", async () => {
    const { editor } = await setup(BLOCKS);
    startLiveSelection(NOTE_ID);
    expect(selectedText(editor)).toBe(SENTENCE);
    expect(isTourTransactionFilterOn(editor._tiptapEditor)).toBe(true);
    stopLiveSelection(NOTE_ID);
    expect(editor._tiptapEditor.state.selection.empty).toBe(true);
    expect(isTourTransactionFilterOn(editor._tiptapEditor)).toBe(false);
  });

  it("document, Y state and undo stack are unchanged before and after", async () => {
    const { doc, editor } = await setup(BLOCKS);
    const before = snapshot(doc, editor);
    startLiveSelection(NOTE_ID);
    expect(snapshot(doc, editor)).toEqual(before);
    stopLiveSelection(NOTE_ID);
    expect(snapshot(doc, editor)).toEqual(before);
  });

  it("the sentence is gone (changed by the user): selects the first non-empty paragraph", async () => {
    const { editor } = await setup([
      { type: "paragraph" },
      { type: "heading", props: { level: 2 }, content: "title" },
      { type: "paragraph", content: "first filled" },
      { type: "paragraph", content: "second" },
    ]);
    startLiveSelection(NOTE_ID);
    expect(selectedText(editor)).toBe("first filled");
    stopLiveSelection(NOTE_ID);
  });

  it("no non-empty paragraph: nothing is selected, no throw, and the filter can still be turned off", async () => {
    const { editor } = await setup([{ type: "paragraph" }]);
    expect(() => startLiveSelection(NOTE_ID)).not.toThrow();
    expect(editor._tiptapEditor.state.selection.empty).toBe(true);
    stopLiveSelection(NOTE_ID);
    expect(isTourTransactionFilterOn(editor._tiptapEditor)).toBe(false);
  });

  it("with the filter on: a transaction replacing the selection is blocked, and the sentence is still there and selected", async () => {
    const { doc, editor } = await setup(BLOCKS);
    startLiveSelection(NOTE_ID);
    const before = snapshot(doc, editor);
    const view = editor._tiptapEditor.view;
    view.dispatch(view.state.tr.insertText("x"));
    view.dispatch(view.state.tr.insertText("測").setMeta("composition", 1));
    expect(snapshot(doc, editor)).toEqual(before);
    expect(selectedText(editor)).toBe(SENTENCE);
    stopLiveSelection(NOTE_ID);
  });

  it("call order: focus first, then set the selection with a transaction carrying scrollIntoView", async () => {
    const { editor } = await setup(BLOCKS);
    const order: string[] = [];
    vi.spyOn(editor, "focus").mockImplementation(() => {
      order.push("focus");
    });
    const view = editor._tiptapEditor.view;
    const dispatch = view.dispatch.bind(view);
    vi.spyOn(view, "dispatch").mockImplementation((tr) => {
      order.push(`dispatch selection=${tr.selection.empty ? "empty" : "range"} scroll=${tr.scrolledIntoView}`);
      dispatch(tr);
    });
    startLiveSelection(NOTE_ID);
    expect(order).toEqual(["focus", "dispatch selection=range scroll=true"]);
    stopLiveSelection(NOTE_ID);
  });

  it("entering repeatedly does not set the selection again; leaving without starting and leaving repeatedly are no-ops", async () => {
    const { editor } = await setup(BLOCKS);
    expect(() => stopLiveSelection(NOTE_ID)).not.toThrow();
    startLiveSelection(NOTE_ID);
    const dispatch = vi.spyOn(editor._tiptapEditor.view, "dispatch");
    startLiveSelection(NOTE_ID);
    expect(dispatch).not.toHaveBeenCalled();
    stopLiveSelection(NOTE_ID);
    stopLiveSelection(NOTE_ID);
    expect(editor._tiptapEditor.state.selection.empty).toBe(true);
  });

  it("no registered editor: does nothing and does not throw", () => {
    expect(() => startLiveSelection(NOTE_ID)).not.toThrow();
    expect(() => stopLiveSelection(NOTE_ID)).not.toThrow();
  });

  it("target: the button named AI inside the toolbar layer; no toolbar, or a same-named button outside the layer, does not count", () => {
    expect(liveSelectionTarget()).toEqual([]);
    const outside = document.createElement("button");
    outside.setAttribute("aria-label", i18n.t("ai.toolbar.trigger"));
    document.body.appendChild(outside);
    expect(liveSelectionTarget()).toEqual([]);
    const ai = fakeToolbar();
    expect(liveSelectionTarget()).toEqual([ai]);
  });

  it("wired into the engine: entering selects the sentence and highlights the AI button; next, finish and unmount collapse the selection and turn the filter off, and the document is unchanged", async () => {
    const { doc, editor } = await setup(BLOCKS);
    const before = snapshot(doc, editor);
    const ai = fakeToolbar();
    for (const leaveBy of ["next", "close", "unmount"] as const) {
      const last = fakeTargetEl("userMenu");
      const lastStop: TourStopEntry = { stop: { id: "userMenu", titleKey: "x", bodyKey: "x", target: () => [last] } };
      const engine = new TourEngine([{ stop: STOPS.ai }, lastStop], AI_CTX);
      await engine.begin();
      expect(engine.getSnapshot().entry?.stop.id, leaveBy).toBe("ai");
      expect(stopTarget(STOPS.ai, AI_CTX), leaveBy).toEqual([ai]);
      expect(selectedText(editor), leaveBy).toBe(SENTENCE);
      expect(isTourTransactionFilterOn(editor._tiptapEditor), leaveBy).toBe(true);
      expect(STOPS.ai.live?.(AI_CTX)).toBe(true);
      if (leaveBy === "next") engine.next();
      else engine.end(leaveBy);
      await vi.waitFor(() => {
        expect(editor._tiptapEditor.state.selection.empty, leaveBy).toBe(true);
        expect(isTourTransactionFilterOn(editor._tiptapEditor), leaveBy).toBe(false);
      });
      expect(snapshot(doc, editor), leaveBy).toEqual(before);
    }
  });

  it("prepare also runs on a floating sidebar; without the sample note's editor it is not live", async () => {
    const { editor } = await setup(BLOCKS);
    stubLayoutTier("overlay");
    prepareStop(STOPS.ai, AI_CTX);
    expect(selectedText(editor)).toBe(SENTENCE);
    stopLiveSelection(NOTE_ID);
    expect(STOPS.ai.live?.({ ...AI_CTX, sampleNoteId: "other" })).toBe(false);
  });

  it("does not run on phones: no selection, no filter and no target (selecting text on a phone does not raise the format toolbar)", async () => {
    const { editor } = await setup(BLOCKS);
    stubLayoutTier("phone");
    const before = editor._tiptapEditor.state.selection.toJSON();
    prepareStop(STOPS.ai, AI_CTX);
    expect(editor._tiptapEditor.state.selection.toJSON()).toEqual(before);
    expect(isTourTransactionFilterOn(editor._tiptapEditor)).toBe(false);
    expect(stopTarget(STOPS.ai, AI_CTX)).toEqual([]);
  });
});

describe("live stops do not raise the on-screen keyboard (the editor's inputmode)", () => {
  const CTX_LIVE: StopContext = { searchQuery: "", aiActions: [], sampleNoteId: NOTE_ID, liveStops: true };
  const SENTENCE = i18n.t("tourGuide.sample.aiSentence");
  const view = (editor: TourEditor) => editor._tiptapEditor.view.dom;

  it("[[ and / stops: inputmode is set to none before focusing and the menu still opens; on leaving it is removed (it was absent) and the editor blurs", async () => {
    const { editor } = await setup();
    const dom = view(editor);
    let atFocus: string | null = "unset";
    dom.addEventListener("focus", () => (atFocus = dom.getAttribute("inputmode")), true);
    for (const trigger of ["[[", "/"] as const) {
      expect(dom.hasAttribute("inputmode")).toBe(false);
      startLiveTrigger(NOTE_ID, trigger);
      expect(dom.getAttribute("inputmode"), trigger).toBe("none");
      expect(isTriggerMenuShown(editor, trigger)).toBe(true);
      // Transactions dispatched while live (e.g. a state update before the menu closes) must not wipe the attribute.
      editor._tiptapEditor.view.dispatch(editor._tiptapEditor.state.tr.setMeta("probe", true));
      expect(dom.getAttribute("inputmode"), trigger).toBe("none");
      stopLiveTrigger(NOTE_ID);
      expect(dom.hasAttribute("inputmode"), trigger).toBe(false);
      expect(dom.contains(document.activeElement), trigger).toBe(false);
    }
    expect(atFocus).toBe("none");
  });

  it("an existing value is restored to its original; repeated start and repeated stop never lose it", async () => {
    const { editor } = await setup();
    const dom = view(editor);
    dom.setAttribute("inputmode", "text");
    startLiveTrigger(NOTE_ID, "[[");
    startLiveTrigger(NOTE_ID, "[[");
    expect(dom.getAttribute("inputmode")).toBe("none");
    stopLiveTrigger(NOTE_ID);
    stopLiveTrigger(NOTE_ID);
    expect(dom.getAttribute("inputmode")).toBe("text");
  });

  it("the editor was already removed from the registry or reports destroyed (temporary unmount) on leaving: it is still restored on the original element", async () => {
    const { editor } = await setup();
    const dom = view(editor);
    startLiveTrigger(NOTE_ID, "[[");
    expect(dom.getAttribute("inputmode")).toBe("none");
    // The registry is swapped to another note, so stopLiveTrigger cannot get this note's editor from it.
    const unregister = registerEditor("another-note", editor);
    stopLiveTrigger(NOTE_ID);
    expect(dom.hasAttribute("inputmode")).toBe(false);
    unregister();

    cleanups.push(registerEditor(NOTE_ID, editor));
    startLiveSelection(NOTE_ID);
    startLiveTrigger(NOTE_ID, "/");
    expect(dom.getAttribute("inputmode")).toBe("none");
    vi.spyOn(editor._tiptapEditor, "isDestroyed", "get").mockReturnValue(true);
    stopLiveTrigger(NOTE_ID);
    expect(dom.hasAttribute("inputmode")).toBe(false);
  });

  it("the AI stop (selecting the sample sentence) is the same: set to none and restored on leaving", async () => {
    const { editor } = await setup([{ type: "paragraph", content: SENTENCE }, { type: "paragraph" }]);
    const dom = view(editor);
    startLiveSelection(NOTE_ID);
    expect(dom.getAttribute("inputmode")).toBe("none");
    stopLiveSelection(NOTE_ID);
    expect(dom.hasAttribute("inputmode")).toBe(false);
  });

  it("through the engine: next, back, finish (close / Esc / Skip) and unmount all restore on leaving", async () => {
    const { editor } = await setup();
    const dom = view(editor);
    fakeTargetEl("wikilinkMenu");
    fakeTargetEl("slashMenu");
    const after = fakeTargetEl("userMenu");
    const entries = [{ stop: STOPS.wikilink }, { stop: { id: "userMenu" as const, titleKey: "x", bodyKey: "x", target: () => [after] } }];
    for (const leaveBy of ["next", "close", "unmount"] as const) {
      const engine = new TourEngine(entries, CTX_LIVE);
      await engine.begin();
      expect(dom.getAttribute("inputmode"), leaveBy).toBe("none");
      if (leaveBy === "next") engine.next();
      else engine.end(leaveBy);
      await vi.waitFor(() => expect(dom.hasAttribute("inputmode"), leaveBy).toBe(false));
      if (leaveBy === "next") {
        await vi.waitFor(() => expect(engine.getSnapshot().index).toBe(1));
        engine.back();
        await vi.waitFor(() => expect(engine.getSnapshot().index).toBe(0));
        expect(dom.getAttribute("inputmode")).toBe("none");
        engine.end("close");
        expect(dom.hasAttribute("inputmode")).toBe(false);
      }
    }
  });
});

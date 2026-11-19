import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { noteSchema } from "./schema";
import { createCursorScroller, cursorHeadPosition } from "./cursor-scroll";
import { PHONE_PAGE_SCROLL_ATTR, STICKY_TOP_VAR } from "@/lib/page-scroll";
import { stubLayoutTier } from "@/test/layout-tier";

// Real editor + real Y.Doc (`collabEditor` as in `undo.test.tsx`, mounting as in `code-block-caret.test.ts`): the conversion uses ySync's binding.mapping, which exists only after the view is mounted and the Y content has been drawn into PM; a mock can't measure it.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple, repo convention
type AnyEditor = BlockNoteEditor<any, any, any>;

function collabEditor(): { doc: Y.Doc; editor: AnyEditor } {
  const doc = new Y.Doc();
  const editor = BlockNoteEditor.create(
    withCollaboration({
      schema: noteSchema,
      collaboration: {
        provider: { awareness: undefined },
        fragment: doc.getXmlFragment(YDOC_FRAGMENT),
        user: { id: "u1", name: "User 1", color: "hsl(0 65% 45%)" },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration's option type requires the full schema triple
    } as any),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
  ) as any as AnyEditor;
  return { doc, editor };
}

/** Reads the size of ySync binding's mapping the same way `cursor-scroll.ts` does. */
function mappingSize(editor: AnyEditor): number {
  const plugin = editor.getExtension("ySync")?.prosemirrorPlugins?.[0];
  const state = plugin?.getState(editor.prosemirrorState) as { binding?: { mapping: Map<unknown, unknown> } | null } | undefined;
  return state?.binding?.mapping.size ?? 0;
}

function findXmlText(node: Y.XmlFragment | Y.XmlElement, text: string): Y.XmlText | null {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) {
      if (child.toString() === text) return child;
    } else if (child instanceof Y.XmlElement) {
      const hit = findXmlText(child, text);
      if (hit) return hit;
    }
  }
  return null;
}

const rel = (text: Y.XmlText, index: number) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, index));

const THREE = [
  { type: "paragraph", content: "第一段" },
  { type: "paragraph", content: "第二段落文字" },
  { type: "paragraph", content: "第三段" },
];

describe("cursor-scroll: remote cursor conversion and scrolling (#293)", () => {
  let editor: AnyEditor;
  let doc: Y.Doc;
  let div: HTMLDivElement;

  async function mountWithThree(): Promise<Y.XmlText> {
    ({ doc, editor } = collabEditor());
    div = document.createElement("div");
    document.body.appendChild(div);
    editor.mount(div);
    editor.replaceBlocks(editor.document, THREE as never);
    await waitFor(() => expect(mappingSize(editor)).toBeGreaterThan(0));
    const text = findXmlText(doc.getXmlFragment(YDOC_FRAGMENT), "第二段落文字");
    expect(text).not.toBeNull();
    return text!;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    editor?.unmount();
    div?.remove();
    editor = undefined as never;
    div = undefined as never;
  });

  it("head converts to a local PM position", async () => {
    const text = await mountWithThree();
    const pos = cursorHeadPosition(editor, { anchor: rel(text, 0), head: rel(text, 2) });
    expect(pos).not.toBeNull();
    let textStart = -1;
    editor.prosemirrorState.doc.descendants((node, at) => {
      if (node.isText && node.text === "第二段落文字") textStart = at;
    });
    expect(pos).toBe(textStart + 2);
    expect(editor.prosemirrorState.doc.textBetween(pos!, pos! + 2)).toBe("段落");
  });

  it("the paragraph at the position is deleted -> no error, returns null or lands inside the document", async () => {
    const text = await mountWithThree();
    const cursor = { anchor: rel(text, 0), head: rel(text, 2) };
    editor.removeBlocks([editor.document[1]!]);
    let pos: number | null = -1;
    expect(() => {
      pos = cursorHeadPosition(editor, cursor);
    }).not.toThrow();
    if (pos !== null) {
      expect(pos).toBeGreaterThanOrEqual(0);
      expect(pos).toBeLessThanOrEqual(editor.prosemirrorState.doc.content.size);
    }
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ['"x"', "x"],
    ["{}", {}],
    ["{ head: null }", { head: null }],
    ['{ head: "x" }', { head: "x" }],
    ['{ head: { type: 1, item: "bad" } }', { head: { type: 1, item: "bad" } }],
  ])("garbage value %s -> null, no error", async (_label, cursor) => {
    await mountWithThree();
    let pos: number | null = -1;
    expect(() => {
      pos = cursorHeadPosition(editor, cursor);
    }).not.toThrow();
    expect(pos).toBeNull();
  });

  it("unmounted editor -> conversion returns null, scroller returns false, no error", () => {
    const made = collabEditor();
    const other = new Y.Doc();
    const t = other.getXmlFragment(YDOC_FRAGMENT);
    const xml = new Y.XmlText("abc");
    t.insert(0, [xml]);
    const cursor = { anchor: rel(xml, 0), head: rel(xml, 1) };
    const root = document.createElement("div");
    root.scrollTo = vi.fn();
    let pos: number | null = -1;
    let scrolled: boolean | null = null;
    expect(() => {
      pos = cursorHeadPosition(made.editor, cursor);
      scrolled = createCursorScroller({ editor: made.editor, getRoot: () => root })(cursor);
    }).not.toThrow();
    expect(pos).toBeNull();
    expect(scrolled).toBe(false);
    expect(root.scrollTo).not.toHaveBeenCalled();
  });

  it("editor mounted then unmounted (ySync state still there, view gone) -> scroller returns false, no error", async () => {
    const text = await mountWithThree();
    const cursor = { anchor: rel(text, 0), head: rel(text, 2) };
    const unmounted = editor;
    unmounted.unmount();
    editor = undefined as never; // so afterEach doesn't unmount again
    const root = document.createElement("div");
    root.scrollTo = vi.fn();
    let scrolled: boolean | null = null;
    expect(() => {
      scrolled = createCursorScroller({ editor: unmounted, getRoot: () => root })(cursor);
    }).not.toThrow();
    expect(scrolled).toBe(false);
    expect(root.scrollTo).not.toHaveBeenCalled();
  });

  describe("scrolling", () => {
    function makeRoot(scrollTop: number): HTMLDivElement & { scrollTo: ReturnType<typeof vi.fn> } {
      const root = document.createElement("div") as HTMLDivElement & { scrollTo: ReturnType<typeof vi.fn> };
      Object.defineProperty(root, "clientHeight", { value: 300 });
      root.scrollTop = scrollTop;
      vi.spyOn(root, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 50, 400, 300));
      root.scrollTo = vi.fn();
      document.body.appendChild(root);
      return root;
    }

    it("the line scrolls to 1/3 of the container height, smooth; selection unchanged, focus not taken", async () => {
      const text = await mountWithThree();
      const cursor = { anchor: rel(text, 0), head: rel(text, 2) };
      const expectedPos = cursorHeadPosition(editor, cursor);
      expect(expectedPos).not.toBeNull();
      const root = makeRoot(100);
      const coordsAtPos = vi
        .spyOn(editor.prosemirrorView!, "coordsAtPos")
        .mockReturnValue({ top: 450, bottom: 470, left: 0, right: 0 });

      editor.setTextCursorPosition(editor.document[2]!, "end");
      const button = document.createElement("button");
      document.body.appendChild(button);
      button.focus();
      const before = editor.prosemirrorState.selection;
      expect(document.activeElement).toBe(button);

      expect(createCursorScroller({ editor, getRoot: () => root })(cursor)).toBe(true);
      expect(root.scrollTo).toHaveBeenCalledTimes(1);
      expect(root.scrollTo.mock.calls[0]![0]).toEqual({ top: 400, behavior: "smooth" });
      expect(coordsAtPos).toHaveBeenCalledWith(expectedPos);
      expect(editor.prosemirrorState.selection.eq(before)).toBe(true);
      expect(document.activeElement).toBe(button);
      button.remove();
      root.remove();
    });

    it("a negative result is clamped to 0", async () => {
      const text = await mountWithThree();
      const root = makeRoot(0);
      vi.spyOn(editor.prosemirrorView!, "coordsAtPos").mockReturnValue({ top: 60, bottom: 80, left: 0, right: 0 });
      expect(createCursorScroller({ editor, getRoot: () => root })({ anchor: rel(text, 0), head: rel(text, 2) })).toBe(true);
      // 0 + (60 - 50) - 100 = -90
      expect(root.scrollTo.mock.calls[0]![0]).toEqual({ top: 0, behavior: "smooth" });
      root.remove();
    });

    it("on a phone where the document scrolls (container inside the data-phone-page-scroll frame) -> scrolls the document to 1/3 of the visible height below the page header, the container doesn't scroll", async () => {
      stubLayoutTier("phone");
      const text = await mountWithThree();
      const frame = document.createElement("div");
      frame.setAttribute(PHONE_PAGE_SCROLL_ATTR, "");
      document.body.appendChild(frame);
      const root = makeRoot(0);
      frame.appendChild(root);
      document.documentElement.style.setProperty(STICKY_TOP_VAR, "100px");
      vi.stubGlobal("innerHeight", 700);
      vi.stubGlobal("scrollY", 1000);
      const windowScroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
      vi.spyOn(editor.prosemirrorView!, "coordsAtPos").mockReturnValue({ top: 500, bottom: 520, left: 0, right: 0 });
      try {
        expect(createCursorScroller({ editor, getRoot: () => root })({ anchor: rel(text, 0), head: rel(text, 2) })).toBe(true);
        // 1000 + 500 - 100 - (700 - 100) / 3 = 1200
        expect(windowScroll).toHaveBeenCalledWith({ top: 1200, behavior: "smooth" });
        expect(root.scrollTo).not.toHaveBeenCalled();
      } finally {
        document.documentElement.style.removeProperty(STICKY_TOP_VAR);
        frame.remove();
        vi.unstubAllGlobals();
      }
    });

    it("inside the same frame but not phone width -> the container scrolls as before", async () => {
      stubLayoutTier("overlay");
      const text = await mountWithThree();
      const frame = document.createElement("div");
      frame.setAttribute(PHONE_PAGE_SCROLL_ATTR, "");
      document.body.appendChild(frame);
      const root = makeRoot(100);
      frame.appendChild(root);
      const windowScroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
      vi.spyOn(editor.prosemirrorView!, "coordsAtPos").mockReturnValue({ top: 450, bottom: 470, left: 0, right: 0 });
      try {
        expect(createCursorScroller({ editor, getRoot: () => root })({ anchor: rel(text, 0), head: rel(text, 2) })).toBe(true);
        expect(root.scrollTo.mock.calls[0]![0]).toEqual({ top: 400, behavior: "smooth" });
        expect(windowScroll).not.toHaveBeenCalled();
      } finally {
        frame.remove();
        vi.unstubAllGlobals();
      }
    });

    it("getRoot returns null -> false, no scroll", async () => {
      const text = await mountWithThree();
      const root = makeRoot(100);
      const coordsAtPos = vi.spyOn(editor.prosemirrorView!, "coordsAtPos");
      expect(createCursorScroller({ editor, getRoot: () => null })({ anchor: rel(text, 0), head: rel(text, 2) })).toBe(false);
      expect(root.scrollTo).not.toHaveBeenCalled();
      expect(coordsAtPos).not.toHaveBeenCalled();
      root.remove();
    });
  });
});

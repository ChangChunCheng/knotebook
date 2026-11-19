import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { SuggestionMenu } from "@blocknote/core";
import { FilePanelExtension, FormattingToolbarExtension } from "@blocknote/core/extensions";
import { REWRITE_ACTION_ID, type AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { useAiSession, type AiSessionValue } from "@/components/ai/AiSession";
import { contentStart, createTestEditor, placeCursor, renderAiHost, selectInBlock, stubAiFetch, type AnyEditor } from "@/test/ai-host";
import { CB, IMG, P } from "@/test/columns-fixtures";
import { STICKY_TOP_VAR } from "@/lib/page-scroll";
import { MobileEditToolbar } from "./MobileEditToolbar";
import { MobileToolbarButton } from "./MobileToolbarButton";
import { MobileToolbarSpacer } from "./MobileToolbarSpacer";

const REWRITE: AiActionDto = { id: REWRITE_ACTION_ID, name: "Rewrite", applyMode: "direct", kind: "quick" };

let session!: AiSessionValue;
function Probe() {
  session = useAiSession();
  return null;
}

let editor: AnyEditor;

let rerenderHost!: ReturnType<typeof renderAiHost>["rerenderHost"];

async function mount(opts: { actions?: AiActionDto[]; editable?: boolean; doc?: unknown[] } = {}) {
  const actions = opts.actions ?? [REWRITE];
  editor = createTestEditor(opts.doc ?? [P("hello world", "a"), P("second", "b")]);
  stubAiFetch({ actions });
  ({ rerenderHost } = renderAiHost({
    editor,
    editable: opts.editable,
    children: (
      <>
        <MobileEditToolbar editor={editor} />
        <Probe />
      </>
    ),
  }));
  await waitFor(() => expect(session.actions).toHaveLength(actions.length));
}

const mountWith = (doc: unknown[]) => mount({ doc });

const root_ = () => document.querySelector("[data-mobile-edit-toolbar]");
const root = () => document.querySelector<HTMLElement>("[data-mobile-edit-toolbar]")!;
const button = (name: string) => within(root()).getByRole("button", { name });
const labels = () => within(root()).getAllByRole("button").map((b) => b.getAttribute("aria-label"));

const MAIN_ROW = ["AI", "Insert block", "Text formatting", "Insert image", "Change block type", "Undo", "Redo", "Hide keyboard"];

describe("MobileEditToolbar", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("main row items in order: AI, insert, Aa, image, convert block, undo, redo, collapse keyboard", async () => {
    await mount();
    expect(labels()).toEqual(MAIN_ROW);
    expect(root()).toHaveAttribute("data-mobile-toolbar-mode", "main");
    expect(root()).toHaveAttribute("role", "toolbar");
  });

  it("while mounted <html> carries data-has-mobile-edit-toolbar (index.css uses it to block pull-to-refresh), removed after unmount", async () => {
    await mount();
    expect(document.documentElement).toHaveAttribute("data-has-mobile-edit-toolbar");
    rerenderHost({ editor, children: null });
    await waitFor(() => expect(root_()).toBeNull());
    expect(document.documentElement).not.toHaveAttribute("data-has-mobile-edit-toolbar");
  });

  it("without an AI action: no AI button, the rest unchanged", async () => {
    await mount({ actions: [] });
    expect(labels()).toEqual(MAIN_ROW.slice(1));
  });

  it("not editable: no AI button", async () => {
    await mount({ editable: false });
    expect(labels()).toEqual(MAIN_ROW.slice(1));
  });

  it("every button is 44x44 (class)", async () => {
    await mount();
    for (const b of within(root()).getAllByRole("button")) expect(b).toHaveClass("size-11");
  });

  it("pressing: mousedown is blocked (the editor keeps focus), pointerdown is not (WebKit sends no click if it is blocked); the collapse-keyboard button too", async () => {
    await mount();
    for (const name of MAIN_ROW) {
      expect(fireEvent.mouseDown(button(name)), `${name} mousedown`).toBe(false);
      expect(fireEvent.pointerDown(button(name)), `${name} pointerdown`).toBe(true);
    }
  });

  it("collapse keyboard: focus leaves the editor", async () => {
    await mount();
    act(() => editor.focus());
    expect(editor.domElement!.contains(document.activeElement)).toBe(true);
    fireEvent.mouseDown(button("Hide keyboard"));
    expect(editor.domElement!.contains(document.activeElement)).toBe(true);
    fireEvent.click(button("Hide keyboard"));
    expect(editor.domElement!.contains(document.activeElement)).toBe(false);
  });

  it("AI: no selection -> aria-disabled, clicking does not open the box; text selected -> pressable, clicking opens the box", async () => {
    await mount();
    placeCursor(editor, "a", 2);
    expect(button("AI")).toHaveAttribute("aria-disabled", "true");
    expect(button("AI")).not.toBeDisabled();
    fireEvent.click(button("AI"));
    expect(session.state.phase).toBe("idle");
    selectInBlock(editor, "a", 0, 5);
    expect(button("AI")).not.toHaveAttribute("aria-disabled");
    fireEvent.click(button("AI"));
    expect(session.state.phase).toBe("input");
  });

  describe("insert (+)", () => {
    it("caret in a paragraph with text: inserts an empty paragraph after it, moves the caret there and opens the slash menu; the existing text is untouched", async () => {
      await mount();
      placeCursor(editor, "a", 5);
      const menu = editor.getExtension(SuggestionMenu)!;
      expect(menu.shown()).toBe(false);
      fireEvent.click(button("Insert block"));
      expect(menu.shown()).toBe(true);
      expect(editor.document).toHaveLength(3);
      expect(editor.document[0]!.id).toBe("a");
      expect(JSON.stringify(editor.document[0]!.content)).toContain("hello world");
      expect(editor.document[1]!.content).toEqual([]);
      expect(editor.getTextCursorPosition().block.id).toBe(editor.document[1]!.id);
    });

    it("caret in an empty paragraph: opens right there, inserting no extra block and no text", async () => {
      await mountWith([P("", "e"), P("second", "b")]);
      placeCursor(editor, "e", 0);
      fireEvent.click(button("Insert block"));
      expect(editor.getExtension(SuggestionMenu)!.shown()).toBe(true);
      expect(editor.document).toHaveLength(2);
      expect(editor.document[0]!.content).toEqual([]);
    });

    it("pressing with text selected: the selected text stays (not replaced by /)", async () => {
      await mount();
      selectInBlock(editor, "a", 0, 5);
      fireEvent.click(button("Insert block"));
      expect(JSON.stringify(editor.document[0]!.content)).toContain("hello world");
      expect(JSON.stringify(editor.document)).not.toContain('"/"');
    });

    it("pressing with an image selected: the image stays and an empty paragraph is added after it", async () => {
      await mountWith([P("x", "x"), IMG("img"), P("z", "z")]);
      act(() => {
        editor._tiptapEditor.commands.setNodeSelection(contentStart(editor, "img") - 1);
      });
      fireEvent.click(button("Insert block"));
      expect(editor.document.map((block) => block.type)).toEqual(["paragraph", "image", "paragraph", "paragraph"]);
      expect(editor.document[1]!.id).toBe("img");
      expect(editor.document[2]!.content).toEqual([]);
    });

    it("pressing in an empty code block: an empty paragraph is added after it, the caret is in the new paragraph and the menu opens (the menu would not open inside code)", async () => {
      await mountWith([CB("c"), P("z", "z")]);
      placeCursor(editor, "c", 0);
      fireEvent.click(button("Insert block"));
      expect(editor.document.map((block) => block.type)).toEqual(["codeBlock", "paragraph", "paragraph"]);
      expect(editor.getTextCursorPosition().block.id).toBe(editor.document[1]!.id);
      expect(editor.getExtension(SuggestionMenu)!.shown()).toBe(true);
    });

    it("pressing inside a code block: no literal /, an empty paragraph is added after it and the menu opens", async () => {
      await mountWith([{ id: "c", type: "codeBlock", content: "let x" } as never, P("z", "z")]);
      placeCursor(editor, "c", 3);
      fireEvent.click(button("Insert block"));
      expect(JSON.stringify(editor.document[0]!.content)).not.toContain("/");
      expect(editor.document[1]!.type).toBe("paragraph");
      expect(editor.getExtension(SuggestionMenu)!.shown()).toBe(true);
    });
  });

  it("image: inserts an image block after the caret's block, opens the file panel and collapses the floating formatting toolbar", async () => {
    await mount();
    placeCursor(editor, "a", 3);
    const formatting = editor.getExtension(FormattingToolbarExtension)!;
    fireEvent.click(button("Insert image"));
    const images = editor.document.filter((block) => block.type === "image");
    expect(images).toHaveLength(1);
    expect(editor.document[1]!.type).toBe("image");
    expect(editor.getExtension(FilePanelExtension)!.store.state).toBe(images[0]!.id);
    expect(formatting.store.state).toBe(false);
  });

  it("image: pressing with an image selected inserts after it and the original image stays", async () => {
    await mountWith([P("x", "x"), IMG("img"), P("z", "z")]);
    act(() => {
      editor._tiptapEditor.commands.setNodeSelection(contentStart(editor, "img") - 1);
    });
    fireEvent.click(button("Insert image"));
    expect(editor.document.map((block) => block.type)).toEqual(["paragraph", "image", "image", "paragraph"]);
    expect(editor.document[1]!.id).toBe("img");
    expect(editor.getExtension(FilePanelExtension)!.store.state).toBe(editor.document[2]!.id);
  });

  it("undo and redo call the editor's undo/redo", async () => {
    await mount();
    const undo = vi.spyOn(editor, "undo");
    const redo = vi.spyOn(editor, "redo");
    fireEvent.click(button("Undo"));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).not.toHaveBeenCalled();
    fireEvent.click(button("Redo"));
    expect(redo).toHaveBeenCalledTimes(1);
  });

  describe("modes", () => {
    it("Aa -> format mode: only Back plus the format buttons remain; Back -> main row", async () => {
      await mount();
      fireEvent.click(button("Text formatting"));
      expect(root()).toHaveAttribute("data-mobile-toolbar-mode", "format");
      expect(labels()[0]).toBe("Back");
      expect(labels()).not.toContain("Insert block");
      fireEvent.click(button("Back"));
      expect(root()).toHaveAttribute("data-mobile-toolbar-mode", "main");
      expect(labels()).toEqual(MAIN_ROW);
    });

    it("the block type (pilcrow) button -> blockType mode: begins with Back", async () => {
      await mount();
      fireEvent.click(button("Change block type"));
      expect(root()).toHaveAttribute("data-mobile-toolbar-mode", "blockType");
      expect(labels()[0]).toBe("Back");
      fireEvent.click(button("Back"));
      expect(root()).toHaveAttribute("data-mobile-toolbar-mode", "main");
    });

    it("sub-mode buttons also do not steal focus (mousedown is blocked)", async () => {
      await mount();
      fireEvent.click(button("Text formatting"));
      for (const b of within(root()).getAllByRole("button")) expect(fireEvent.mouseDown(b)).toBe(false);
    });

    it("the bold button in format mode applies to the selection", async () => {
      await mount();
      selectInBlock(editor, "a", 0, 5);
      fireEvent.click(button("Text formatting"));
      fireEvent.click(button("Bold"));
      expect(editor.getActiveStyles().bold).toBe(true);
    });
  });

  describe("follows the keyboard", () => {
    let viewport: EventTarget & { height: number; offsetTop: number; scale: number };
    let frames: Array<() => void>;

    function setKeyboard(inset: number) {
      viewport.height = 800 - inset;
      act(() => {
        viewport.dispatchEvent(new Event("resize"));
        frames.splice(0).forEach((run) => run());
      });
    }

    beforeEach(() => {
      viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
      vi.stubGlobal("innerHeight", 800);
      frames = [];
      vi.stubGlobal("requestAnimationFrame", (cb: () => void) => frames.push(cb));
      Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true, writable: true });
    });
    afterEach(() => {
      Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true, writable: true });
    });

    it("bottom equals the keyboard height; when the keyboard collapses the safe-area bottom padding is added", async () => {
      await mount();
      expect(root().style.bottom).toBe("0px");
      expect(root().className).toContain("pb-[calc(0.5rem+env(safe-area-inset-bottom))]");
      setKeyboard(300);
      expect(root().style.bottom).toBe("300px");
      expect(root().className).not.toContain("safe-area-inset-bottom");
      expect(root().className).toContain("pb-2");
      setKeyboard(0);
      expect(root().style.bottom).toBe("0px");
    });

    it("the editor scroll's bottom edge reserves keyboard height plus toolbar outer height, other edges keep their original values; after unmount it equals the value before mounting", async () => {
      editor = createTestEditor([P("hello world", "a")]);
      stubAiFetch({ actions: [] });
      ({ rerenderHost } = renderAiHost({ editor, children: <Probe /> }));
      const props = () => editor.prosemirrorView!.props as { scrollMargin?: Partial<Record<string, number>>; scrollThreshold?: Partial<Record<string, number>> };
      const before = { scrollMargin: props().scrollMargin, scrollThreshold: props().scrollThreshold };
      rerenderHost({
        children: (
          <>
            <MobileEditToolbar editor={editor} />
            <Probe />
          </>
        ),
      });
      expect(props().scrollMargin).toEqual({ top: 72, right: 0, bottom: 68, left: 0 });
      setKeyboard(300);
      expect(props().scrollMargin?.bottom).toBe(368);
      expect(props().scrollMargin?.top).toBe(before.scrollMargin?.top);
      expect(props().scrollThreshold?.bottom).toBe(368);
      rerenderHost({ children: <Probe /> });
      expect(root_()).toBeNull();
      expect({ scrollMargin: props().scrollMargin, scrollThreshold: props().scrollThreshold }).toEqual(before);
    });

    it("header pinned to the top of the page (on phones the document scrolls): the top margin and threshold both add the header height; restored after unmount", async () => {
      document.documentElement.style.setProperty(STICKY_TOP_VAR, "90px");
      try {
        editor = createTestEditor([P("hello world", "a")]);
        stubAiFetch({ actions: [] });
        ({ rerenderHost } = renderAiHost({ editor, children: <Probe /> }));
        const props = () => editor.prosemirrorView!.props as { scrollMargin?: Partial<Record<string, number>>; scrollThreshold?: Partial<Record<string, number>> };
        const before = { scrollMargin: props().scrollMargin, scrollThreshold: props().scrollThreshold };
        rerenderHost({
          children: (
            <>
              <MobileEditToolbar editor={editor} />
              <Probe />
            </>
          ),
        });
        expect(props().scrollMargin).toEqual({ top: 162, right: 0, bottom: 68, left: 0 });
        expect(props().scrollThreshold?.top).toBe(90);
        rerenderHost({ children: <Probe /> });
        expect({ scrollMargin: props().scrollMargin, scrollThreshold: props().scrollThreshold }).toEqual(before);
      } finally {
        document.documentElement.style.removeProperty(STICKY_TOP_VAR);
      }
    });

    it("keyboard up and the editor focused: scrolls to the caret once more; with no focus, or when the keyboard collapses, it does not", async () => {
      await mount();
      const dispatch = vi.spyOn(editor.prosemirrorView!, "dispatch");
      const scrolled = () => dispatch.mock.calls.filter(([tr]) => (tr as { scrolledIntoView: boolean }).scrolledIntoView).length;
      setKeyboard(300);
      expect(scrolled()).toBe(0);
      setKeyboard(0);
      act(() => editor.focus());
      setKeyboard(300);
      expect(scrolled()).toBe(1);
      setKeyboard(0);
      expect(scrolled()).toBe(1);
    });
  });
});

describe("MobileToolbarButton", () => {
  it("disabled uses aria-disabled: no native disabled, a click does not call onClick, mousedown is still blocked", () => {
    const onClick = vi.fn();
    const view = render(
      <MobileToolbarButton label="Stuck" disabled onClick={onClick}>
        x
      </MobileToolbarButton>,
    );
    const stuck = view.getByRole("button", { name: "Stuck" });
    expect(stuck).not.toBeDisabled();
    expect(stuck).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(stuck);
    expect(onClick).not.toHaveBeenCalled();
    expect(fireEvent.mouseDown(stuck)).toBe(false);
  });
});

describe("MobileToolbarSpacer", () => {
  let viewport: EventTarget & { height: number; offsetTop: number; scale: number };
  beforeEach(() => {
    viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      cb();
      return 1;
    });
    Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true, writable: true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true, writable: true });
  });

  it("aria-hidden; height = keyboard height plus toolbar outer height (the safe area is supplied by the content card's bottom padding, not added here)", () => {
    const view = render(<MobileToolbarSpacer />);
    const spacer = () => view.container.querySelector<HTMLElement>("[data-mobile-toolbar-spacer]")!;
    expect(spacer()).toHaveAttribute("aria-hidden", "true");
    expect(spacer().style.height).toBe("60px");
    viewport.height = 500;
    act(() => {
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(spacer().style.height).toBe("360px");
  });
});

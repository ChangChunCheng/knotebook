import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { LinkDialog } from "@/components/LinkDialog";
import { useLinkMenuState } from "@/components/NoteEditor";
import { editorHasBlockWithType } from "@blocknote/core";
import { blockTypeSelectItems } from "@blocknote/react";
import i18n from "@/i18n";
import { resetCustomColorsForTest } from "@/lib/custom-colors";
import { resetRecentColorsForTest } from "@/lib/recent-colors";
import { createTestEditor, placeCursor, renderAiHost, selectInBlock, selectWholeBlocks, stubAiFetch, type AnyEditor } from "@/test/ai-host";
import { CB, P, textPos } from "@/test/columns-fixtures";
import { ShowSelectionExtension } from "@blocknote/core/extensions";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { DEFAULT_KNOWLEDGE_FIELD_VIEW } from "@knotebook/shared";
import { AiSessionProvider, SELECTION_AI_HIGHLIGHT_KEY } from "@/components/ai/AiSession";
import { KnowledgeFieldsContext } from "@/components/knowledge/fields-context";
import { NoteEditorView } from "@/components/NoteEditor";
import { ThemeProvider } from "@/theme";
import { MobileEditToolbar, MOBILE_COLOR_PANEL_HIGHLIGHT_KEY, MOBILE_COLOR_PANEL_OPEN_ATTR } from "./MobileEditToolbar";
import { MobileToolbarSpacer } from "./MobileToolbarSpacer";
import { resetRememberedKeyboardInsetForTest } from "./toolbar-footprint";

let editor: AnyEditor;
let onCreateLink: ReturnType<typeof vi.fn>;

async function mount(doc: unknown[] = [P("hello world", "a"), P("second", "b")], extra?: React.ReactNode) {
  editor = createTestEditor(doc);
  onCreateLink = vi.fn();
  stubAiFetch({ actions: [] });
  renderAiHost({
    editor,
    children: (
      <>
        <MobileEditToolbar editor={editor} onCreateLink={onCreateLink} />
        {extra}
      </>
    ),
  });
}

const root = () => document.querySelector<HTMLElement>("[data-mobile-edit-toolbar]")!;
const button = (name: string) => within(root()).getByRole("button", { name });
const labels = () => within(root()).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
const dict = () => editor.dictionary;
const formatMode = () => fireEvent.click(button("Text formatting"));
const inEditor = () => editor.domElement!.contains(document.activeElement);

beforeEach(async () => {
  localStorage.clear();
  resetRecentColorsForTest();
  resetRememberedKeyboardInsetForTest();
  await i18n.changeLanguage("en");
});
afterEach(() => {
  resetCustomColorsForTest();
  vi.unstubAllGlobals();
});

describe("format row", () => {
  it("order: Back, bold, italic, underline, strikethrough, code, link, align left, center, right, indent, outdent, color", async () => {
    await mount();
    formatMode();
    const f = dict().formatting_toolbar;
    expect(labels()).toEqual([
      "Back",
      f.bold.tooltip,
      f.italic.tooltip,
      f.underline.tooltip,
      f.strike.tooltip,
      f.code.tooltip,
      f.link.tooltip,
      f.align_left.tooltip,
      f.align_center.tooltip,
      f.align_right.tooltip,
      f.nest.tooltip,
      f.unnest.tooltip,
      f.colors.tooltip,
    ]);
  });

  it.each([
    ["bold", "Bold"],
    ["italic", "Italic"],
    ["underline", "Underline"],
    ["strike", "Strike"],
    ["code", "Code"],
  ] as const)("%s button applies to the selection, the pressed state follows the actual style, pressing again cancels", async (style, label) => {
    await mount();
    selectInBlock(editor, "a", 0, 5);
    formatMode();
    expect(button(label)).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(button(label));
    expect(editor.getActiveStyles()[style]).toBe(true);
    expect(button(label)).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button(label));
    expect(editor.getActiveStyles()[style]).toBeUndefined();
    expect(button(label)).toHaveAttribute("aria-pressed", "false");
  });

  it("moving the caret to styled text changes the pressed state accordingly", async () => {
    await mount([{ id: "a", type: "paragraph", content: [{ type: "text", text: "bold", styles: { bold: true } }, { type: "text", text: " plain", styles: {} }] } as never]);
    formatMode();
    placeCursor(editor, "a", 2);
    expect(button("Bold")).toHaveAttribute("aria-pressed", "true");
    placeCursor(editor, "a", 7);
    expect(button("Bold")).toHaveAttribute("aria-pressed", "false");
  });

  it("the link button calls onCreateLink; with the caret in a link it is pressed", async () => {
    await mount([{ id: "a", type: "paragraph", content: [{ type: "link", href: "https://example.com", content: [{ type: "text", text: "site", styles: {} }] }, { type: "text", text: " tail", styles: {} }] } as never]);
    formatMode();
    expect(button("Create link")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(button("Create link"));
    expect(onCreateLink).toHaveBeenCalledTimes(1);
    placeCursor(editor, "a", 2);
    expect(button("Create link")).toHaveAttribute("aria-pressed", "true");
  });

  describe("alignment", () => {
    it("three separate buttons: they act on the block at the caret and leave other blocks alone", async () => {
      await mount();
      placeCursor(editor, "b", 2);
      formatMode();
      fireEvent.click(button("Align text center"));
      expect(editor.getBlock("b")!.props.textAlignment).toBe("center");
      expect(editor.getBlock("a")!.props.textAlignment).toBe("left");
      fireEvent.click(button("Align text right"));
      expect(editor.getBlock("b")!.props.textAlignment).toBe("right");
      fireEvent.click(button("Align text left"));
      expect(editor.getBlock("b")!.props.textAlignment).toBe("left");
    });

    it("selection spanning two blocks: both are applied", async () => {
      await mount();
      selectWholeBlocks(editor, "a", "b");
      formatMode();
      fireEvent.click(button("Align text right"));
      expect(editor.getBlock("a")!.props.textAlignment).toBe("right");
      expect(editor.getBlock("b")!.props.textAlignment).toBe("right");
    });

    it("pressed state follows the block's alignment", async () => {
      await mount();
      placeCursor(editor, "a", 1);
      formatMode();
      expect(button("Align text left")).toHaveAttribute("aria-pressed", "true");
      expect(button("Align text center")).toHaveAttribute("aria-pressed", "false");
      fireEvent.click(button("Align text center"));
      expect(button("Align text center")).toHaveAttribute("aria-pressed", "true");
      expect(button("Align text left")).toHaveAttribute("aria-pressed", "false");
      placeCursor(editor, "b", 1);
      expect(button("Align text left")).toHaveAttribute("aria-pressed", "true");
    });
  });

  describe("indent", () => {
    it("the second block can be indented but not outdented, and after indenting it swaps; the first block has both disabled", async () => {
      await mount();
      placeCursor(editor, "b", 1);
      formatMode();
      expect(button("Nest block")).not.toHaveAttribute("aria-disabled");
      expect(button("Unnest block")).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(button("Nest block"));
      expect(editor.document).toHaveLength(1);
      expect(editor.document[0]!.children.map((child) => child.id)).toEqual(["b"]);
      expect(button("Nest block")).toHaveAttribute("aria-disabled", "true");
      expect(button("Unnest block")).not.toHaveAttribute("aria-disabled");
      fireEvent.click(button("Unnest block"));
      expect(editor.document.map((block) => block.id)).toEqual(["a", "b"]);
      placeCursor(editor, "a", 1);
      expect(button("Nest block")).toHaveAttribute("aria-disabled", "true");
      expect(button("Unnest block")).toHaveAttribute("aria-disabled", "true");
    });
  });

  it("color button: looks like the desktop \"A\", text color is the current text color, the small square is the current background color", async () => {
    await mount([{ id: "a", type: "paragraph", content: [{ type: "text", text: "tint", styles: { textColor: "red", backgroundColor: "yellow" } }] } as never]);
    placeCursor(editor, "a", 2);
    formatMode();
    const icon = button("Colors").querySelector(".bn-color-icon")!;
    expect(icon).toHaveTextContent("A");
    expect(icon).toHaveAttribute("data-text-color", "red");
    expect(icon).toHaveAttribute("data-background-color", "yellow");
    expect(icon.closest(".bn-root")).not.toBeNull();
  });

  it("every button except link does not steal focus (mousedown is blocked)", async () => {
    await mount();
    formatMode();
    for (const b of within(root()).getAllByRole("button")) expect(fireEvent.mouseDown(b)).toBe(false);
  });
});

describe("block type row", () => {
  const blockTypeMode = () => fireEvent.click(button("Change block type"));
  const expectedNames = () =>
    blockTypeSelectItems(editor.dictionary)
      .filter((item) =>
        editorHasBlockWithType(editor, item.type, Object.fromEntries(Object.entries(item.props ?? {}).map(([name, value]) => [name, typeof value])) as never),
      )
      .map((item) => item.name);

  it("items are the same list as the desktop block type menu (same order, same set), preceded by Back", async () => {
    await mount();
    blockTypeMode();
    const names = expectedNames();
    expect(names.length).toBeGreaterThan(8);
    expect(labels()).toEqual(["Back", ...names]);
  });

  it("pressing an item: the block at the caret changes type and other blocks stay; the current type is pressed", async () => {
    await mount();
    placeCursor(editor, "b", 2);
    blockTypeMode();
    expect(button(dict().slash_menu.paragraph.title)).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button(dict().slash_menu.heading_2.title));
    expect(editor.getBlock("b")!.type).toBe("heading");
    expect(editor.getBlock("b")!.props.level).toBe(2);
    expect(editor.getBlock("a")!.type).toBe("paragraph");
    expect(button(dict().slash_menu.heading_2.title)).toHaveAttribute("aria-pressed", "true");
    expect(button(dict().slash_menu.heading.title)).toHaveAttribute("aria-pressed", "false");
    expect(button(dict().slash_menu.toggle_heading_2.title)).toHaveAttribute("aria-pressed", "false");
    expect(button(dict().slash_menu.paragraph.title)).toHaveAttribute("aria-pressed", "false");
  });

  it("a collapsible heading and an ordinary heading are two different items", async () => {
    await mount();
    placeCursor(editor, "a", 1);
    blockTypeMode();
    fireEvent.click(button(dict().slash_menu.toggle_heading.title));
    expect(editor.getBlock("a")!.props).toMatchObject({ level: 1, isToggleable: true });
    expect(button(dict().slash_menu.toggle_heading.title)).toHaveAttribute("aria-pressed", "true");
    expect(button(dict().slash_menu.heading.title)).toHaveAttribute("aria-pressed", "false");
  });

  it("selection spanning two blocks: both change type", async () => {
    await mount();
    selectWholeBlocks(editor, "a", "b");
    blockTypeMode();
    fireEvent.click(button(dict().slash_menu.bullet_list.title));
    expect(editor.getBlock("a")!.type).toBe("bulletListItem");
    expect(editor.getBlock("b")!.type).toBe("bulletListItem");
  });

  const TABLE = { id: "t", type: "table", content: { type: "tableContent", rows: [{ cells: ["x", "y"] }, { cells: ["z", "w"] }] } } as never;

  describe("current block cannot change type (table, code block)", () => {
    it("caret in a table cell: the main row's block type button is disabled and pressing does not enter the mode; inside a paragraph it can be pressed", async () => {
      await mount([P("hello", "a"), TABLE]);
      placeCursor(editor, "a", 1);
      expect(button("Change block type")).not.toHaveAttribute("aria-disabled");
      act(() => editor._tiptapEditor.commands.setTextSelection(textPos(editor, "x", 0)));
      expect(button("Change block type")).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(button("Change block type"));
      expect(root()).toHaveAttribute("data-mobile-toolbar-mode", "main");
    });

    it("caret in a code block: the block type button is disabled", async () => {
      await mount([{ id: "c", type: "codeBlock", content: "line1\nline2" } as never, P("z", "z")]);
      placeCursor(editor, "c", 2);
      expect(button("Change block type")).toHaveAttribute("aria-disabled", "true");
    });

    it("caret moves into a table while the mode is open: all items are disabled and pressing leaves the content alone", async () => {
      await mount([P("hello", "a"), TABLE]);
      placeCursor(editor, "a", 1);
      blockTypeMode();
      expect(button(dict().slash_menu.heading.title)).not.toHaveAttribute("aria-disabled");
      act(() => editor._tiptapEditor.commands.setTextSelection(textPos(editor, "x", 0)));
      for (const b of within(root()).getAllByRole("button").slice(1)) expect(b).toHaveAttribute("aria-disabled", "true");
      const before = JSON.stringify(editor.document);
      fireEvent.click(button(dict().slash_menu.heading.title));
      expect(JSON.stringify(editor.document)).toBe(before);
    });

    it("paragraph + table selected together: only the paragraph changes, the table content stays", async () => {
      await mount([P("hello", "a"), TABLE]);
      act(() => editor._tiptapEditor.commands.setTextSelection({ from: textPos(editor, "hello", 0), to: textPos(editor, "w", 1) }));
      expect(editor.getSelection()!.blocks.map((block) => block.type)).toEqual(["paragraph", "table"]);
      const tableBefore = JSON.stringify(editor.getBlock("t")!.content);
      blockTypeMode();
      fireEvent.click(button(dict().slash_menu.heading_2.title));
      expect(editor.getBlock("a")!.type).toBe("heading");
      expect(editor.getBlock("t")!.type).toBe("table");
      expect(JSON.stringify(editor.getBlock("t")!.content)).toBe(tableBefore);
    });

    it("paragraph + code block selected together: the code block's content is not cleared", async () => {
      await mount([P("hello", "a"), CB("c", "keep me")]);
      act(() => editor._tiptapEditor.commands.setTextSelection({ from: textPos(editor, "hello", 0), to: textPos(editor, "keep me", 3) }));
      blockTypeMode();
      fireEvent.click(button(dict().slash_menu.heading.title));
      expect(editor.getBlock("a")!.type).toBe("heading");
      expect(editor.getBlock("c")!.type).toBe("codeBlock");
      expect(JSON.stringify(editor.getBlock("c")!.content)).toContain("keep me");
    });
  });

  it("no button steals focus", async () => {
    await mount();
    blockTypeMode();
    for (const b of within(root()).getAllByRole("button")) expect(fireEvent.mouseDown(b)).toBe(false);
  });
});

describe("palette", () => {
  const colorsButton = () => button("Colors");
  const panel = () => document.querySelector<HTMLElement>("[data-mobile-color-panel]");
  const row = (section: "Text" | "Background") => within(panel()!).getByRole("group", { name: section });
  const swatch = (section: "Text" | "Background", name: string) => within(row(section)).getByRole("button", { name });
  const openColors = () => fireEvent.click(colorsButton());

  async function mountSelected() {
    await mount();
    act(() => editor.focus());
    selectInBlock(editor, "a", 0, 5);
    formatMode();
  }

  it("opening the palette: mode is color, the palette is a separate block under the capsule, the color button is pressed", async () => {
    await mountSelected();
    expect(panel()).toBeNull();
    openColors();
    expect(root()).toHaveAttribute("data-mobile-toolbar-mode", "color");
    expect(panel()).not.toBeNull();
    expect(panel()!.closest("[data-mobile-edit-toolbar]")).toBe(root());
    expect(panel()!.closest(".bn-root")).not.toBeNull();
    expect(colorsButton()).toHaveAttribute("aria-pressed", "true");
    expect(within(root()).getByRole("button", { name: "Back" })).toBeInTheDocument();
  });

  it("opening the palette: focus moves from the editor into the toolbar and the toolbar does not unmount", async () => {
    await mountSelected();
    expect(inEditor()).toBe(true);
    openColors();
    expect(inEditor()).toBe(false);
    expect(root().contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
    // NotePage decides "still editing" from whether focus is still inside the toolbar: wait one more round to confirm focus did not fall to body
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
    expect(root().contains(document.activeElement)).toBe(true);
    expect(root().isConnected).toBe(true);
  });

  it("two rows: text colors in one, background colors in the other; the first cell is default, then nine built-in colors, last is \"Custom...\"", async () => {
    await mountSelected();
    openColors();
    const names = dict().color_picker.colors;
    for (const section of ["Text", "Background"] as const) {
      const cells = within(row(section)).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
      expect(cells).toEqual([names.default, names.gray, names.brown, names.red, names.orange, names.yellow, names.green, names.blue, names.purple, names.pink, "Custom…"]);
    }
    const groups = within(panel()!).getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    expect(groups).toEqual(["Text", "Background"]);
  });

  it("swatches are 32 visually with a 44 hit area", async () => {
    await mountSelected();
    openColors();
    const cell = swatch("Text", "Red");
    expect(cell).toHaveClass("size-11");
    expect(cell.querySelector(".bn-color-icon")).toHaveClass("size-8");
  });

  it("choosing a text color applies to the original selection (the editor has lost focus) and the current cell has an outer ring (aria-pressed)", async () => {
    await mountSelected();
    openColors();
    fireEvent.click(swatch("Text", "Red"));
    const content = editor.getBlock("a")!.content as { text: string; styles: Record<string, string> }[];
    expect(content.find((c) => c.styles.textColor === "red")!.text).toBe("hello");
    expect(content.filter((c) => c.styles.textColor === "red")).toHaveLength(1);
    expect(swatch("Text", "Red")).toHaveAttribute("aria-pressed", "true");
    expect(swatch("Text", "Auto")).toHaveAttribute("aria-pressed", "false");
    expect(colorsButton().querySelector(".bn-color-icon")).toHaveAttribute("data-text-color", "red");
    expect(inEditor()).toBe(false);
  });

  it("choosing a background color applies to the selection; default (Auto) clears it", async () => {
    await mountSelected();
    openColors();
    fireEvent.click(swatch("Background", "Yellow"));
    expect(editor.getActiveStyles().backgroundColor).toBe("yellow");
    expect(swatch("Background", "Yellow")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(swatch("Background", "Auto"));
    expect(editor.getActiveStyles().backgroundColor).toBeUndefined();
    expect(swatch("Background", "Auto")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(swatch("Text", "Blue"));
    fireEvent.click(swatch("Text", "Auto"));
    expect(editor.getActiveStyles().textColor).toBeUndefined();
  });

  it("\"Custom...\" flips the palette to another page; entering a hex and applying returns to the swatch page and the color is written to the selection", async () => {
    await mountSelected();
    openColors();
    fireEvent.click(within(row("Background")).getByRole("button", { name: "Custom…" }));
    const input = await waitFor(() => within(panel()!).getByLabelText("Hex color"));
    expect(root().contains(document.activeElement)).toBe(true);
    expect(root().isConnected).toBe(true);
    fireEvent.change(input, { target: { value: "#123456" } });
    fireEvent.click(within(panel()!).getByRole("button", { name: "Apply" }));
    expect(editor.getActiveStyles().backgroundColor).toBe("#123456");
    expect(within(panel()!).queryByLabelText("Hex color")).toBeNull();
    expect(row("Background")).toBeInTheDocument();
    expect(root().contains(document.activeElement)).toBe(true);
  });

  it("the custom page's Back returns to the swatch page without applying", async () => {
    await mountSelected();
    openColors();
    fireEvent.click(within(row("Text")).getByRole("button", { name: "Custom…" }));
    await waitFor(() => within(panel()!).getByLabelText("Hex color"));
    fireEvent.click(within(panel()!).getByRole("button", { name: "Back" }));
    expect(row("Text")).toBeInTheDocument();
    expect(editor.getActiveStyles().textColor).toBeUndefined();
  });

  it.each([
    ["pressing the color button again", () => fireEvent.click(colorsButton())],
    ["pressing Back", () => fireEvent.click(within(root()).getByRole("button", { name: "Back" }))],
  ])("%s: returns to format mode, focus returns to the editor, the selection is kept as it was", async (_name, leave) => {
    await mountSelected();
    const before = { from: editor.prosemirrorState.selection.from, to: editor.prosemirrorState.selection.to };
    openColors();
    fireEvent.click(swatch("Text", "Red"));
    leave();
    expect(root()).toHaveAttribute("data-mobile-toolbar-mode", "format");
    expect(panel()).toBeNull();
    expect(inEditor()).toBe(true);
    expect({ from: editor.prosemirrorState.selection.from, to: editor.prosemirrorState.selection.to }).toEqual(before);
    expect(colorsButton()).toHaveAttribute("aria-pressed", "false");
  });

  describe("palette height", () => {
    let viewport: EventTarget & { height: number; offsetTop: number; scale: number };
    let frames: Array<() => void>;
    const setKeyboard = (inset: number) => {
      viewport.height = 800 - inset;
      act(() => {
        viewport.dispatchEvent(new Event("resize"));
        frames.splice(0).forEach((run) => run());
      });
    };
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
    const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 260)));

    it("the height is remembered while the keyboard is stably open; after the keyboard collapses the palette uses the remembered height and the toolbar sits right above the palette", async () => {
      await mount([P("hello world", "a")], <MobileToolbarSpacer />);
      act(() => editor.focus());
      selectInBlock(editor, "a", 0, 5);
      setKeyboard(310);
      await settle();
      formatMode();
      openColors();
      setKeyboard(0);
      expect(panel()!.style.minHeight).toBe("310px");
      expect(root().style.bottom).toBe("0px");
      // the palette's height must also be left free at the end of the document: 370 = 310 palette + 60 toolbar clearance (PHONE_EDIT_TOOLBAR_CLEARANCE_PX)
      expect(document.querySelector<HTMLElement>("[data-mobile-toolbar-spacer]")!.style.height).toBe("370px");
      fireEvent.click(colorsButton());
      expect(panel()).toBeNull();
      expect(document.querySelector<HTMLElement>("[data-mobile-toolbar-spacer]")!.style.height).toBe("60px");
    });

    it("a keyboard height that is still changing (mid collapse animation) is not remembered", async () => {
      await mount([P("hello world", "a")]);
      act(() => editor.focus());
      setKeyboard(310);
      await settle();
      setKeyboard(200);
      setKeyboard(120);
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
      setKeyboard(0);
      await settle();
      selectInBlock(editor, "a", 0, 5);
      formatMode();
      openColors();
      expect(panel()!.style.minHeight).toBe("310px");
    });

    it("with no remembered height the default height is used", async () => {
      await mountSelected();
      openColors();
      expect(panel()!.style.minHeight).toBe("280px");
    });
  });

  it("clicking body text while the palette is open (the editor regains focus): returns to format mode and the palette collapses", async () => {
    await mountSelected();
    openColors();
    expect(panel()).not.toBeNull();
    act(() => editor.focus());
    expect(root()).toHaveAttribute("data-mobile-toolbar-mode", "format");
    expect(panel()).toBeNull();
  });

  it("while the palette is open the selection has a highlight decoration, removed after closing; the AI box's key is unaffected", async () => {
    await mountSelected();
    const extension = editor.getExtension(ShowSelectionExtension)!;
    act(() => extension.showSelection(true, SELECTION_AI_HIGHLIGHT_KEY));
    expect(editor.domElement!.hasAttribute(MOBILE_COLOR_PANEL_OPEN_ATTR)).toBe(false);
    openColors();
    expect(editor.domElement!.hasAttribute(MOBILE_COLOR_PANEL_OPEN_ATTR)).toBe(true);
    expect([...extension.store.state.enabledSet].sort()).toEqual([MOBILE_COLOR_PANEL_HIGHLIGHT_KEY, SELECTION_AI_HIGHLIGHT_KEY].sort());
    const shown = Array.from(editor.domElement!.querySelectorAll("[data-show-selection]")).map((node) => node.textContent);
    expect(shown.join("")).toBe("hello");
    fireEvent.click(colorsButton());
    expect(editor.domElement!.hasAttribute(MOBILE_COLOR_PANEL_OPEN_ATTR)).toBe(false);
    expect([...extension.store.state.enabledSet]).toEqual([SELECTION_AI_HIGHLIGHT_KEY]);
  });

  it("leaving the palette with Back: its own highlight key and attributes are turned off", async () => {
    await mountSelected();
    const extension = editor.getExtension(ShowSelectionExtension)!;
    openColors();
    expect(extension.store.state.enabledSet.size).toBe(1);
    fireEvent.click(button("Back"));
    expect(extension.store.state.enabledSet.size).toBe(0);
    expect(editor.domElement!.hasAttribute(MOBILE_COLOR_PANEL_OPEN_ATTR)).toBe(false);
  });

  it("while the palette is open, caret avoidance reserves at the bottom the palette height plus toolbar outer height", async () => {
    await mountSelected();
    const margin = () => (editor.prosemirrorView!.props as { scrollMargin?: { bottom?: number } }).scrollMargin?.bottom;
    expect(margin()).toBe(68);
    openColors();
    expect(margin()).toBe(280 + 68);
    fireEvent.click(colorsButton());
    expect(margin()).toBe(68);
  });

  it("the \"Custom...\" page is taller than the remembered height: the spacer and caret avoidance use the measured height", async () => {
    let report: () => void = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          report = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    await mount([P("hello world", "a")], <MobileToolbarSpacer />);
    act(() => editor.focus());
    selectInBlock(editor, "a", 0, 5);
    formatMode();
    openColors();
    Object.defineProperty(panel()!, "offsetHeight", { value: 420, configurable: true });
    act(() => report());
    expect(document.querySelector<HTMLElement>("[data-mobile-toolbar-spacer]")!.style.height).toBe("480px");
    expect((editor.prosemirrorView!.props as { scrollMargin?: { bottom?: number } }).scrollMargin?.bottom).toBe(488);
  });

  it("minHeight does not exceed the visible height minus the toolbar; recomputed after rotation", async () => {
    vi.stubGlobal("innerHeight", 800);
    await mountSelected();
    openColors();
    expect(panel()!.style.minHeight).toBe("280px");
    vi.stubGlobal("innerHeight", 300);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(panel()!.style.minHeight).toBe("188px");
  });

  it("focus moved into the toolbar must be an element inside the toolbar", async () => {
    await mountSelected();
    openColors();
    expect(document.activeElement!.closest("[data-mobile-edit-toolbar]")).toBe(root());
  });
});

describe("link (real dialog)", () => {
  function LinkHost({ target }: { target: AnyEditor }) {
    const { t } = useTranslation();
    const ref = useRef(target);
    const state = useLinkMenuState(ref, t);
    return (
      <>
        <MobileEditToolbar editor={target} onCreateLink={state.openLinkDialog} />
        <LinkDialog
          editor={target}
          open={state.linkDialogOpen}
          onOpenChange={state.setLinkDialogOpen}
          onSubmit={state.handleLinkInsert}
          initialText={state.linkPrefill.text}
          initialUrl={state.linkPrefill.url}
        />
      </>
    );
  }

  async function mountLinkHost() {
    editor = createTestEditor([P("hello world", "a")]);
    stubAiFetch({ actions: [] });
    renderAiHost({ editor, children: <LinkHost target={editor} /> });
  }

  it("selecting text then pressing link: the dialog is prefilled with that text; submitting (text unchanged) only adds the link, keeps bold and the selection and returns focus to the editor", async () => {
    await mountLinkHost();
    act(() => editor.focus());
    selectInBlock(editor, "a", 0, 5);
    formatMode();
    fireEvent.click(button("Bold"));
    fireEvent.click(button("Create link"));
    const textField = await screen.findByLabelText(i18n.t("note.link.textLabel"));
    expect(textField).toHaveValue("hello");
    fireEvent.change(screen.getByLabelText(i18n.t("note.link.urlLabel")), { target: { value: "https://example.com" } });
    fireEvent.submit(textField.closest("form")!);
    const content = editor.getBlock("a")!.content as { type: string; href?: string; content?: { text: string; styles: Record<string, unknown> }[] }[];
    const link = content.find((item) => item.type === "link")!;
    expect(link.href).toBe("https://example.com");
    expect(link.content).toEqual([{ type: "text", text: "hello", styles: { bold: true } }]);
    await waitFor(() => expect(inEditor()).toBe(true));
    expect(editor.getSelectedText()).toBe("hello");
  });

  it("caret inside a link: the URL is prefilled with that link's URL", async () => {
    editor = createTestEditor([{ id: "a", type: "paragraph", content: [{ type: "link", href: "https://example.com", content: [{ type: "text", text: "site", styles: {} }] }] } as never]);
    stubAiFetch({ actions: [] });
    renderAiHost({ editor, children: <LinkHost target={editor} /> });
    act(() => editor.focus());
    placeCursor(editor, "a", 2);
    formatMode();
    fireEvent.click(button("Create link"));
    expect(await screen.findByLabelText(i18n.t("note.link.urlLabel"))).toHaveValue("https://example.com");
  });
});

describe("BlockNoteScope (toolbar outside BlockNoteView, same position as production)", () => {
  it("the color button's A and the palette are under their own .bn-root, not the editor's", async () => {
    editor = createTestEditor([P("hello world", "a")]);
    stubAiFetch({ actions: [] });
    render(
      <MemoryRouter>
        <ThemeProvider>
          <QueryClientProvider client={new QueryClient()}>
            <KnowledgeFieldsContext.Provider value={{ view: DEFAULT_KNOWLEDGE_FIELD_VIEW, status: "ready" }}>
              <AiSessionProvider editor={editor} noteId="n" editable>
                <NoteEditorView editor={editor} editable theme="light" noteId="n" getItems={() => Promise.resolve([])} getSlashItems={() => Promise.resolve([])} />
                <MobileEditToolbar editor={editor} />
              </AiSessionProvider>
            </KnowledgeFieldsContext.Provider>
          </QueryClientProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );
    act(() => editor.focus());
    selectInBlock(editor, "a", 0, 5);
    formatMode();
    const editorScope = editor.domElement!.closest(".bn-root");
    expect(editorScope).not.toBeNull();
    const iconScope = button("Colors").querySelector(".bn-color-icon")!.closest(".bn-root");
    expect(iconScope).not.toBeNull();
    expect(iconScope).not.toBe(editorScope);
    expect(root().contains(iconScope)).toBe(true);
    fireEvent.click(button("Colors"));
    const panelScope = document.querySelector("[data-mobile-color-panel]")!.closest(".bn-root");
    expect(panelScope).not.toBeNull();
    expect(panelScope).not.toBe(editorScope);
    expect(panelScope!.getAttribute("data-color-scheme")).toBe("light");
  });
});

describe("link (editing an existing link, whitespace)", () => {
  function LinkHost2({ target }: { target: AnyEditor }) {
    const { t } = useTranslation();
    const ref = useRef(target);
    const state = useLinkMenuState(ref, t);
    return (
      <>
        <MobileEditToolbar editor={target} onCreateLink={state.openLinkDialog} />
        <LinkDialog
          editor={target}
          open={state.linkDialogOpen}
          onOpenChange={state.setLinkDialogOpen}
          onSubmit={state.handleLinkInsert}
          initialText={state.linkPrefill.text}
          initialUrl={state.linkPrefill.url}
        />
      </>
    );
  }
  const submit = async (url: string) => {
    const field = await screen.findByLabelText(i18n.t("note.link.urlLabel"));
    fireEvent.change(field, { target: { value: url } });
    fireEvent.submit(field.closest("form")!);
  };
  const flatten = (content: { type: string; href?: string; text?: string; content?: { text: string }[] }[]) =>
    content.map((item) => (item.type === "link" ? `link(${item.href}):${item.content!.map((c) => c.text).join("")}` : item.text));

  it("caret in an existing link, editing the URL: text unchanged, only href changes, no extra characters appear", async () => {
    editor = createTestEditor([
      { id: "a", type: "paragraph", content: [{ type: "link", href: "https://old.example", content: [{ type: "text", text: "site", styles: {} }] }, { type: "text", text: " tail", styles: {} }] } as never,
    ]);
    stubAiFetch({ actions: [] });
    renderAiHost({ editor, children: <LinkHost2 target={editor} /> });
    act(() => editor.focus());
    placeCursor(editor, "a", 2);
    formatMode();
    fireEvent.click(button("Create link"));
    expect(await screen.findByLabelText(i18n.t("note.link.textLabel"))).toHaveValue("site");
    await submit("https://new.example");
    expect(flatten(editor.getBlock("a")!.content as never)).toEqual(["link(https://new.example):site", " tail"]);
  });

  it("selection with trailing whitespace and text unchanged: the whole text is verbatim unchanged", async () => {
    editor = createTestEditor([P("hello world", "a")]);
    stubAiFetch({ actions: [] });
    renderAiHost({ editor, children: <LinkHost2 target={editor} /> });
    act(() => editor.focus());
    selectInBlock(editor, "a", 0, 6);
    formatMode();
    fireEvent.click(button("Create link"));
    await submit("https://example.com");
    expect(flatten(editor.getBlock("a")!.content as never)).toEqual(["link(https://example.com):hello ", "world"]);
  });
  const LINK_DOC = [
    { id: "a", type: "paragraph", content: [{ type: "text", text: "x ", styles: {} }, { type: "link", href: "https://old.example", content: [{ type: "text", text: "site", styles: {} }] }, { type: "text", text: " tail", styles: {} }] } as never,
  ];

  it("selection is exactly the whole link: text and URL are both prefilled and the link button is pressed", async () => {
    editor = createTestEditor(LINK_DOC);
    stubAiFetch({ actions: [] });
    renderAiHost({ editor, children: <LinkHost2 target={editor} /> });
    act(() => editor.focus());
    selectInBlock(editor, "a", 2, 6);
    formatMode();
    expect(button("Create link")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button("Create link"));
    expect(await screen.findByLabelText(i18n.t("note.link.textLabel"))).toHaveValue("site");
    expect(screen.getByLabelText(i18n.t("note.link.urlLabel"))).toHaveValue("https://old.example");
  });

  it("link at the start of a paragraph and the selection is exactly the whole link: prefilled the same way, button pressed", async () => {
    editor = createTestEditor([
      { id: "a", type: "paragraph", content: [{ type: "link", href: "https://old.example", content: [{ type: "text", text: "site", styles: {} }] }, { type: "text", text: " tail", styles: {} }] } as never,
    ]);
    stubAiFetch({ actions: [] });
    renderAiHost({ editor, children: <LinkHost2 target={editor} /> });
    act(() => editor.focus());
    selectInBlock(editor, "a", 0, 4);
    formatMode();
    expect(button("Create link")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button("Create link"));
    expect(await screen.findByLabelText(i18n.t("note.link.urlLabel"))).toHaveValue("https://old.example");
  });

  it("caret before or after a link: not counted as inside the link (button not lit)", async () => {
    editor = createTestEditor(LINK_DOC);
    stubAiFetch({ actions: [] });
    renderAiHost({ editor, children: <LinkHost2 target={editor} /> });
    act(() => editor.focus());
    formatMode();
    placeCursor(editor, "a", 2);
    expect(button("Create link")).toHaveAttribute("aria-pressed", "false");
    placeCursor(editor, "a", 6);
    expect(button("Create link")).toHaveAttribute("aria-pressed", "false");
    placeCursor(editor, "a", 4);
    expect(button("Create link")).toHaveAttribute("aria-pressed", "true");
  });

  it("selection dragged from the middle of a link to outside it: treated as an ordinary selection, the new link covers exactly the selected text", async () => {
    editor = createTestEditor(LINK_DOC);
    stubAiFetch({ actions: [] });
    renderAiHost({ editor, children: <LinkHost2 target={editor} /> });
    act(() => editor.focus());
    selectInBlock(editor, "a", 4, 8);
    formatMode();
    expect(button("Create link")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(button("Create link"));
    expect(await screen.findByLabelText(i18n.t("note.link.textLabel"))).toHaveValue("te t");
    await submit("https://new.example");
    expect(flatten(editor.getBlock("a")!.content as never)).toEqual(["x ", "link(https://old.example):si", "link(https://new.example):te t", "ail"]);
  });
});

describe("scrolling the selection into view when the palette grows", () => {
  it("palette actual height grows (e.g. entering the \"Custom...\" page): sends a scrollIntoView, even when the editor has no focus", async () => {
    let report: () => void = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          report = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    await mount([P("hello world", "a")]);
    act(() => editor.focus());
    selectInBlock(editor, "a", 0, 5);
    formatMode();
    const dispatch = vi.spyOn(editor.prosemirrorView!, "dispatch");
    const scrolled = () => dispatch.mock.calls.filter(([tr]) => (tr as { scrolledIntoView: boolean }).scrolledIntoView).length;
    fireEvent.click(button("Colors"));
    expect(editor.domElement!.contains(document.activeElement)).toBe(false);
    const afterOpen = scrolled();
    expect(afterOpen).toBeGreaterThan(0);
    const panel = document.querySelector<HTMLElement>("[data-mobile-color-panel]")!;
    Object.defineProperty(panel, "offsetHeight", { value: 420, configurable: true });
    act(() => report());
    expect(scrolled()).toBe(afterOpen + 1);
    Object.defineProperty(panel, "offsetHeight", { value: 300, configurable: true });
    act(() => report());
    expect(scrolled()).toBe(afterOpen + 1);
  });
});

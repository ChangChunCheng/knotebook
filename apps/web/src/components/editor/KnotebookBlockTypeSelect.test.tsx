import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import i18n from "@/i18n";
import { createTestEditor, renderAiHost, selectInBlock, selectWholeBlocks, stubAiFetch, type AnyEditor } from "@/test/ai-host";
import { IMG, P } from "@/test/columns-fixtures";
import { SelectionAiController } from "@/components/ai/SelectionAiController";

// Block type menu of the desktop formatting toolbar: with a multi-block selection only blocks that are themselves item types change (#464). Mounted like `ai/AiToolbar.test.tsx`.

const TABLE = { id: "t", type: "table", content: { type: "tableContent", rows: [{ cells: ["x", "y"] }, { cells: ["z", "w"] }] } } as never;

const toolbar = () => document.querySelector(".bn-formatting-toolbar");
// Trigger of the block type menu: picked as the dropdown button without an aria-label (the color button and other dropdowns have one).
const SELECT_TRIGGER = ".bn-formatting-toolbar button[aria-haspopup]:not([aria-label])";
const selectTrigger = () => document.querySelector<HTMLElement>(SELECT_TRIGGER);

function mount(doc: unknown[]): AnyEditor {
  const editor = createTestEditor(doc);
  stubAiFetch({ actions: [] });
  renderAiHost({ editor, children: <SelectionAiController /> });
  return editor;
}

async function chooseItem(name: string) {
  await waitFor(() => expect(selectTrigger()).not.toBeNull());
  fireEvent.click(selectTrigger()!);
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}

describe("KnotebookBlockTypeSelect", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("multi-block selection (paragraph + table): applying Heading 1 turns the paragraph into a heading and leaves the table content unchanged", async () => {
    const editor = mount([P("alice", "a"), TABLE, P("bob", "b")]);
    const tableBefore = JSON.stringify(editor.getBlock("t")!.content);
    act(() => selectWholeBlocks(editor, "a", "b"));
    await chooseItem("Heading 1");
    await waitFor(() => expect(editor.getBlock("a")!.type).toBe("heading"));
    expect((editor.getBlock("a")!.props as { level: number }).level).toBe(1);
    expect(editor.getBlock("b")!.type).toBe("heading");
    expect(editor.getBlock("t")!.type).toBe("table");
    expect(JSON.stringify(editor.getBlock("t")!.content)).toBe(tableBefore);
  });

  // When the selection spans a code block BlockNote hides the whole formatting toolbar, so this path is unreachable; an image stands in for the same kind of non-convertible block.
  it("multi-block selection (paragraph + image): the image is unchanged", async () => {
    const editor = mount([P("alice", "a"), IMG("img"), P("bob", "b")]);
    const imageBefore = JSON.stringify(editor.getBlock("img")!.props);
    act(() => selectWholeBlocks(editor, "a", "b"));
    await chooseItem("Heading 1");
    await waitFor(() => expect(editor.getBlock("a")!.type).toBe("heading"));
    expect(editor.getBlock("b")!.type).toBe("heading");
    expect(editor.getBlock("img")!.type).toBe("image");
    expect(JSON.stringify(editor.getBlock("img")!.props)).toBe(imageBefore);
  });

  it("selection starting in a table: the menu is absent and the toolbar's other buttons remain", async () => {
    const editor = mount([TABLE, P("alice", "a")]);
    act(() => selectWholeBlocks(editor, "a", "a"));
    await waitFor(() => expect(toolbar()).not.toBeNull());
    const withParagraphButtons = toolbar()!.querySelectorAll("button").length;
    expect(selectTrigger()).not.toBeNull();
    act(() => editor.setSelection("t", "a"));
    expect(editor.getSelection()!.blocks[0]!.type).toBe("table");
    await waitFor(() => expect(selectTrigger()).toBeNull());
    expect(toolbar()!.querySelectorAll("button").length).toBeGreaterThan(0);
    expect(withParagraphButtons).toBeGreaterThan(0);
  });

  it("single paragraph: the menu appears and switching to Heading 2 works, the adjacent paragraph is unchanged", async () => {
    const editor = mount([P("alice", "a"), P("bob", "b")]);
    act(() => selectInBlock(editor, "a", 0, 3));
    await chooseItem("Heading 2");
    await waitFor(() => expect(editor.getBlock("a")!.type).toBe("heading"));
    expect((editor.getBlock("a")!.props as { level: number }).level).toBe(2);
    expect(editor.getBlock("b")!.type).toBe("paragraph");
  });

  it("single paragraph: the menu's current item is Paragraph", async () => {
    const editor = mount([P("alice", "a")]);
    act(() => selectInBlock(editor, "a", 0, 3));
    await waitFor(() => expect(selectTrigger()).not.toBeNull());
    expect(selectTrigger()!.textContent).toContain("Paragraph");
  });

  it("read-only editor: the menu is absent", async () => {
    const editor = mount([P("alice", "a")]);
    act(() => selectInBlock(editor, "a", 0, 3));
    await waitFor(() => expect(selectTrigger()).not.toBeNull());
    act(() => {
      editor.isEditable = false;
    });
    await waitFor(() => expect(selectTrigger()).toBeNull());
  });
});

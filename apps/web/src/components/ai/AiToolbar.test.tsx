import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { REWRITE_ACTION_ID, type AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { contentStart, createTestEditor, renderAiHost, selectInBlock, stubAiFetch, type AnyEditor } from "@/test/ai-host";
import { IMG, P, row, shape, withChildren } from "@/test/columns-fixtures";
import { useAiSession, type AiSessionValue } from "./AiSession";
import { SelectionAiController } from "./SelectionAiController";

// The toolbar's file-delete button is replaced by our own (`KnotebookFileDeleteButton`) so deleting an image inside a column does not collapse the column. Mounted like `SelectionAiController.test.tsx`.

const REWRITE: AiActionDto = { id: REWRITE_ACTION_ID, name: "Rewrite", applyMode: "direct", kind: "quick" };

let session!: AiSessionValue;
function Probe() {
  session = useAiSession();
  return null;
}

const deleteButtons = () => document.querySelectorAll("[data-kb-file-delete]");
const toolbar = () => document.querySelector(".bn-formatting-toolbar");

async function mount(doc: unknown[]): Promise<AnyEditor> {
  const editor = createTestEditor(doc);
  stubAiFetch({ actions: [REWRITE] });
  renderAiHost({
    editor,
    children: (
      <>
        <SelectionAiController />
        <Probe />
      </>
    ),
  });
  await waitFor(() => expect(session.actions).toHaveLength(1));
  return editor;
}

describe("AiToolbar file delete button", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("selecting an image inside a column gives a single own delete button; clicking it deletes the image and the row and both columns stay", async () => {
    const editor = await mount([P("x", "x"), row([[P("a", "a")], [IMG("img")]], "r"), P("z", "z")]);
    act(() => {
      editor._tiptapEditor.commands.setNodeSelection(contentStart(editor, "img") - 1);
    });
    await waitFor(() => expect(deleteButtons()).toHaveLength(1));
    // The native delete button must be gone too (same tooltip string): if it stayed next to ours, pressing the native one would still collapse the column.
    const label = deleteButtons()[0]!.getAttribute("aria-label")!;
    expect(toolbar()!.querySelectorAll(`[aria-label="${label}"]`)).toHaveLength(1);
    fireEvent.click(deleteButtons()[0]!);
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  paragraph:z");
  });

  it("selecting paragraph text: toolbar present, no delete button", async () => {
    const editor = await mount([P("x", "x"), row([[P("abc", "a")], [IMG("img")]], "r"), P("z", "z")]);
    selectInBlock(editor, "a", 0, 2);
    await waitFor(() => expect(toolbar()).not.toBeNull());
    expect(deleteButtons()).toHaveLength(0);
  });

  it("selecting from an image across to the next paragraph (two blocks): toolbar present, no delete button", async () => {
    const editor = await mount([P("x", "x"), IMG("img"), P("qq", "q")]);
    act(() => {
      editor._tiptapEditor.commands.setTextSelection({ from: contentStart(editor, "img") - 1, to: contentStart(editor, "q") + 2 });
    });
    expect(editor.getSelection()!.blocks.map((b) => b.id)).toEqual(["img", "q"]);
    await waitFor(() => expect(toolbar()).not.toBeNull());
    expect(deleteButtons()).toHaveLength(0);
  });
});

// Columns: a selection across columns or including a whole row still shows the AI button, and `open()` expands the anchor to the whole row (see the columns cases in AiSession.test.tsx).
const TWO = () => [P("x", "x"), row([[P("a", "a1")], [P("b", "b1"), P("q", "q1")]], "r"), P("z", "z")];
const THREE = () => [P("x", "x"), row([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")]], "r"), P("z", "z")];
const NESTED = () => [P("x", "x"), row([[P("a", "a1")], [withChildren(P("p", "p1"), [P("c", "c1")])]], "r"), P("z", "z")];

describe("AiToolbar AI button and columns (expanding to the whole row)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each<[string, () => unknown[], string, string, string]>([
    ["across columns a..b", TWO, "a1", "b1", "a1:paragraph, rc1:column"],
    ["three columns a..c", THREE, "a1", "c1", "a1:paragraph, rc1:column, rc2:column"],
    ["from outside the row (x) into the row", TWO, "x", "b1", "x:paragraph, r:columnList"],
    ["from inside a column to outside the row (z) (no column node in the list)", TWO, "b1", "z", "b1:paragraph, q1:paragraph, z:paragraph"],
    ["from a nested child block of the last column to outside the row (z) (the column is the grandparent node)", NESTED, "c1", "z", "c1:paragraph, z:paragraph"],
  ])("%s: AI button appears and opens the box when pressed", async (_name, doc, from, to, blocks) => {
    const editor = await mount(doc());
    act(() => {
      editor.setSelection(from, to);
    });
    // Fact pinned: core's selection list (the first thing to fail when core is upgraded).
    expect(editor.getSelection()!.blocks.map((b) => `${b.id}:${b.type}`).join(", ")).toBe(blocks);
    fireEvent.click(await screen.findByRole("button", { name: "AI" }));
    expect(session.state.phase).toBe("input");
  });

  it("entirely inside a single column (b..q): the AI button still appears and opens the box when pressed", async () => {
    const editor = await mount(TWO());
    act(() => {
      editor.setSelection("b1", "q1");
    });
    fireEvent.click(await screen.findByRole("button", { name: "AI" }));
    expect(session.state.phase).toBe("input");
  });
});

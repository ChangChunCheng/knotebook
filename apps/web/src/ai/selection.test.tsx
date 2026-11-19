import { describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { BlockNoteEditor, getNodeById } from "@blocknote/core";
import { FormattingToolbarExtension } from "@blocknote/core/extensions";
import { BlockNoteView } from "@blocknote/mantine";
import { noteSchema } from "@/collab/schema";
import { anchorRange, blockRange, leafText, selectionFocus, selectionInsideAnchor, toolbarWouldShow } from "./selection";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple, repo convention
type AnyEditor = BlockNoteEditor<any, any, any>;

function createEditor(initialContent: unknown[]): AnyEditor {
  return BlockNoteEditor.create({ schema: noteSchema, initialContent: initialContent as never }) as AnyEditor;
}

/** Bare mount (as in `ai/apply.test.ts`): wikilink uses toExternalHTML, so a one-line elementRenderer shim suffices. For pure-function cases only. */
function bareMounted(initialContent: unknown[]): AnyEditor {
  const editor = createEditor(initialContent);
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor.mount(el);
  editor.elementRenderer = (node: unknown, container: HTMLElement) => flushSync(() => createRoot(container).render(node as never));
  return editor;
}

const start = (editor: AnyEditor, id: string) => getNodeById(id, editor.prosemirrorState.doc)!.posBeforeNode + 2;
const end = (editor: AnyEditor, id: string) => {
  const info = getNodeById(id, editor.prosemirrorState.doc)!;
  return info.posBeforeNode + 2 + info.node.firstChild!.content.size;
};
const select = (editor: AnyEditor, from: number, to: number) => act(() => void editor._tiptapEditor.commands.setTextSelection({ from, to }));
const read = <T,>(editor: AnyEditor, fn: (tr: Parameters<Parameters<AnyEditor["transact"]>[0]>[0]) => T): T => editor.transact(fn);

const DOC = [
  { id: "p1", type: "paragraph", content: "alpha beta gamma" },
  { id: "p2", type: "paragraph", content: "second" },
  { id: "p3", type: "paragraph", content: "third" },
];

describe("toolbarWouldShow (#263: copy of upstream FormattingToolbarExtension.shouldShow)", () => {
  it("matches the upstream store case by case: empty selection false, TextSelection without text false, across code false, NodeSelection true, plain text true, select-all with code false", () => {
    const editor = createEditor([
      { id: "p1", type: "paragraph", content: "alpha" },
      { id: "p2", type: "paragraph", content: "beta" },
      { id: "code", type: "codeBlock", content: "const x = 1;" },
      { id: "img", type: "image", props: { url: "https://example.com/a.png" } },
    ]);
    render(<BlockNoteView editor={editor} />);
    const store = editor.getExtension(FormattingToolbarExtension)!.store;
    const cmd = editor._tiptapEditor.commands;
    const cases: Array<[string, () => void, boolean]> = [
      ["空選取", () => void cmd.setTextSelection(start(editor, "p1") + 1), false],
      ["跨段界、沒有文字的 TextSelection", () => void cmd.setTextSelection({ from: end(editor, "p1"), to: start(editor, "p2") }), false],
      ["從段落拉進 code block", () => void cmd.setTextSelection({ from: start(editor, "p2") + 1, to: start(editor, "code") + 3 }), false],
      ["NodeSelection（圖片）", () => void cmd.setNodeSelection(getNodeById("img", editor.prosemirrorState.doc)!.posBeforeNode + 1), true],
      ["一般文字", () => void cmd.setTextSelection({ from: start(editor, "p1"), to: start(editor, "p1") + 3 }), true],
      ["全選（文件含 code block）", () => void cmd.selectAll(), false],
    ];
    for (const [name, apply, expected] of cases) {
      act(apply);
      expect({ name, ours: read(editor, (tr) => toolbarWouldShow(tr)) }).toEqual({ name, ours: expected });
      expect({ name, upstream: store.state }).toEqual({ name, upstream: expected });
    }
  });
});

describe("selectionInsideAnchor (#263: shared with toolbar suppression)", () => {
  it("true when inside the range; false for partial overlap, outside, or anchor block gone", () => {
    const editor = bareMounted(DOC);
    select(editor, start(editor, "p1") + 1, start(editor, "p1") + 4);
    expect(read(editor, (tr) => selectionInsideAnchor(tr, ["p1"]))).toBe(true);
    select(editor, start(editor, "p1") + 1, start(editor, "p2") + 2);
    expect(read(editor, (tr) => selectionInsideAnchor(tr, ["p1"]))).toBe(false);
    expect(read(editor, (tr) => selectionInsideAnchor(tr, ["p1", "p2"]))).toBe(true);
    select(editor, start(editor, "p3"), start(editor, "p3") + 2);
    expect(read(editor, (tr) => selectionInsideAnchor(tr, ["p1", "p2"]))).toBe(false);
    expect(read(editor, (tr) => selectionInsideAnchor(tr, ["gone"]))).toBe(false);
  });

  it("Ctrl+A (AllSelection, from=0, to=doc.content.size) counts as inside an anchor of all top-level blocks; not when only the first block is anchored", () => {
    const editor = bareMounted(DOC);
    act(() => void editor._tiptapEditor.commands.selectAll());
    expect(read(editor, (tr) => [tr.selection.from, tr.selection.to])).toEqual([0, editor.prosemirrorState.doc.content.size]);
    expect(read(editor, (tr) => selectionInsideAnchor(tr, ["p1", "p2", "p3"]))).toBe(true);
    expect(read(editor, (tr) => selectionInsideAnchor(tr, ["p1"]))).toBe(false);
  });

  it("blockRange/anchorRange: posBefore..posAfter; null when either end isn't found", () => {
    const editor = bareMounted(DOC);
    const doc = editor.prosemirrorState.doc;
    const p1 = getNodeById("p1", doc)!;
    const p3 = getNodeById("p3", doc)!;
    expect(blockRange(doc, "p1")).toEqual({ from: p1.posBeforeNode, to: p1.posBeforeNode + p1.node.nodeSize });
    expect(anchorRange(doc, ["p1", "p2", "p3"])).toEqual({ from: p1.posBeforeNode, to: p3.posBeforeNode + p3.node.nodeSize });
    expect(anchorRange(doc, ["p1", "gone"])).toBeNull();
  });
});

describe("selectionFocus (#263 open())", () => {
  it("whole-block selection (first block start to last block end) -> empty string; Ctrl+A over all blocks -> empty string", () => {
    const editor = bareMounted(DOC);
    select(editor, start(editor, "p1"), end(editor, "p2"));
    expect(read(editor, (tr) => selectionFocus(tr, ["p1", "p2"]))).toBe("");
    act(() => void editor._tiptapEditor.commands.selectAll());
    expect(read(editor, (tr) => selectionFocus(tr, ["p1", "p2", "p3"]))).toBe("");
  });

  it("partial selection yields the substring; across blocks joined by newlines", () => {
    const editor = bareMounted(DOC);
    select(editor, start(editor, "p1") + 6, start(editor, "p1") + 10);
    expect(read(editor, (tr) => selectionFocus(tr, ["p1"]))).toBe("beta");
    select(editor, start(editor, "p1") + 6, start(editor, "p2") + 3);
    expect(read(editor, (tr) => selectionFocus(tr, ["p1", "p2"]))).toBe("beta gamma\nsec");
  });

  it("#269 wikilink (leaf node) is written as [label](/notes/<id>), matching the sent markdown; with titleOf an empty label takes the current title", () => {
    const editor = bareMounted([
      { id: "w", type: "paragraph", content: ["see ", { type: "wikilink", props: { targetNoteId: "x", snapshotTitle: "Plan" } }, " end"] },
      { id: "z", type: "paragraph", content: "zz" },
    ]);
    // A wikilink is an atom occupying 1 position in PM: "see " (4) + wikilink (1) = 5
    select(editor, start(editor, "w"), start(editor, "w") + 5);
    expect(read(editor, (tr) => selectionFocus(tr, ["w"]))).toBe("see [Plan](/notes/x)");
    expect(read(editor, (tr) => selectionFocus(tr, ["w"], (id) => (id === "x" ? "Live" : undefined)))).toBe("see [Live](/notes/x)");
  });

  it("#269: leafText - label first, anchor into href, all empty falls back to href", () => {
    const node = (attrs: Record<string, string>) => ({ type: { name: "wikilink" }, attrs: { targetNoteId: "x", snapshotTitle: "", label: "", anchorBlockId: "", ...attrs }, textContent: "" }) as never;
    expect(leafText(node({ label: "L", anchorBlockId: "b1" }))).toBe("[L](/notes/x#b-b1)");
    expect(leafText(node({ snapshotTitle: "S" }), () => "Live")).toBe("[Live](/notes/x)");
    expect(leafText(node({}))).toBe("[/notes/x](/notes/x)");
  });

  it("#269: leafText link text is markdown-escaped (same form as the sent markdown, so an AI write-back can restore the original string)", () => {
    const node = (attrs: Record<string, string>) => ({ type: { name: "wikilink" }, attrs: { targetNoteId: "x", snapshotTitle: "", label: "", anchorBlockId: "", ...attrs }, textContent: "" }) as never;
    expect(leafText(node({ label: "[Draft] Plan *v2*" }))).toBe("[\\[Draft\\] Plan \\*v2\\*](/notes/x)");
    expect(leafText(node({ label: "a]b\\" }))).toBe("[a\\]b\\\\](/notes/x)");
    expect(leafText(node({}), () => "`c`_~")).toBe("[\\`c\\`\\_\\~](/notes/x)");
  });

  it("truncates to 2000 code points without splitting an emoji", () => {
    const editor = bareMounted([{ id: "e", type: "paragraph", content: `${"😀".repeat(2100)}x` }]);
    // An emoji takes 2 positions in PM (UTF-16); the selection ends before the x
    select(editor, start(editor, "e"), start(editor, "e") + 4200);
    const focus = read(editor, (tr) => selectionFocus(tr, ["e"]));
    expect(Array.from(focus)).toHaveLength(2000);
    expect(focus).toBe("😀".repeat(2000));
  });
});

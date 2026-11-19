import { describe, expect, it } from "vitest";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { BlockNoteEditor } from "@blocknote/core";
import { noteSchema } from "@/collab/schema";
import type { DiffBlock } from "@/lib/version-diff";
import { buildPreview, isNoChange, normalizeMarkdown, stripTextWrapper } from "./preview";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple, repo convention
function mounted(initialContent: unknown[]): BlockNoteEditor<any, any, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
  const editor = BlockNoteEditor.create({ schema: noteSchema, initialContent: initialContent as never }) as BlockNoteEditor<any, any, any>;
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor.mount(el);
  editor.elementRenderer = (node: unknown, container: HTMLElement) => flushSync(() => createRoot(container).render(node as never));
  return editor;
}

function ids(blocks: readonly DiffBlock[]): string[] {
  return blocks.flatMap((b) => [b.id ?? "?", ...ids(b.children ?? [])]);
}

const AFTER: DiffBlock[] = [{ id: "new-1", type: "paragraph", props: {}, content: [{ type: "text", text: "ONE", styles: {} }], children: [] }];

describe("stripTextWrapper (#263)", () => {
  it("strips only when the whole text starts with <text> and ends with </text> (surrounding whitespace ignored); one newline right inside the markers is removed too", () => {
    expect(stripTextWrapper("<text>\nA\n\nB\n</text>")).toBe("A\n\nB");
    expect(stripTextWrapper("  <text>A</text>\n")).toBe("A");
    expect(stripTextWrapper("<text></text>")).toBe("");
  });
  it("only an opening or only a closing tag, or other text before it -> unchanged", () => {
    expect(stripTextWrapper("<text>A")).toBe("<text>A");
    expect(stripTextWrapper("A</text>")).toBe("A</text>");
    expect(stripTextWrapper("B <text>A</text>")).toBe("B <text>A</text>");
  });
});

describe("isNoChange (#263)", () => {
  it("equal after trimming both ends and normalizing newlines -> true", () => {
    expect(normalizeMarkdown("\r\nA\r\nB  \r\n")).toBe("A\nB");
    expect(isNoChange("alpha beta  \r\n", "alpha beta\n")).toBe(true);
    expect(isNoChange("A\r\nB", "A\nB\n")).toBe(true);
  });
  it("different content -> false", () => {
    expect(isNoChange("alpha", "beta")).toBe(false);
  });
});

describe("buildPreview (#263: only the changed blocks, no surrounding context)", () => {
  const DOC = [
    { id: "p0", type: "paragraph", content: "zero" },
    { id: "p1", type: "paragraph", content: "one" },
    { id: "p2", type: "paragraph", content: "two", children: [
      { id: "c1", type: "paragraph", content: "kid one" },
      { id: "c2", type: "paragraph", content: "kid two" },
    ] },
    { id: "p3", type: "paragraph", content: "three" },
    { id: "p4", type: "paragraph", content: "four" },
  ];

  it("flat: before has only the anchor blocks, after only the passed blocks (same object); sibling p0/p2 absent; no surroundIds field", () => {
    const editor = mounted(DOC);
    const preview = buildPreview(editor, ["p1"], AFTER, false);
    expect(ids(preview.before)).toEqual(["p1"]);
    expect(ids(preview.after)).toEqual(["new-1"]);
    expect(preview.after[0]).toBe(AFTER[0]);
    expect(Object.keys(preview).sort()).toEqual(["after", "before", "noChange"]);
    expect(preview.noChange).toBe(false);
  });

  it("nested (selection from child c2 to p3, getSelection returns [c2, p3]): before is [c2, p3]; same-level c1, p4 and ancestor p2 absent", () => {
    const editor = mounted(DOC);
    const preview = buildPreview(editor, ["c2", "p3"], AFTER, true);
    expect(ids(preview.before)).toEqual(["c2", "p3"]);
    expect(ids(preview.after)).toEqual(["new-1"]);
    expect(preview.noChange).toBe(true);
  });

  it("anchor block with a subtree: before includes the child blocks via getBlock (the changed range includes the subtree)", () => {
    const editor = mounted(DOC);
    const preview = buildPreview(editor, ["p2"], AFTER, false);
    expect(ids(preview.before)).toEqual(["p2", "c1", "c2"]);
  });

  it("ids not found in the anchor (already deleted) are skipped, the rest kept", () => {
    const editor = mounted(DOC);
    editor.removeBlocks(["p3"]);
    const preview = buildPreview(editor, ["p1", "p3"], AFTER, false);
    expect(ids(preview.before)).toEqual(["p1"]);
  });

  it("before is the value at call time: later document edits don't change an already produced preview (the caller owns freezing this object)", () => {
    const editor = mounted(DOC);
    const preview = buildPreview(editor, ["p1"], AFTER, false);
    editor.updateBlock("p1", { content: "changed later" });
    expect(JSON.stringify(preview.before)).toContain("one");
    expect(JSON.stringify(preview.before)).not.toContain("changed later");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { noteSchema } from "./schema";

// BlockNote's paste sync goes through `view.pasteHTML/pasteText`; the tiptap Link `handlePaste` (URL pasted over a selection) and the paste rule both finish within the same dispatch, so the document is already in its final shape when the call returns. The paste conversion relies on this; a form that turned out not to be synchronous would need its own detection there.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple, repo convention
type AnyEditor = BlockNoteEditor<any, any, any>;

const ORIGIN = window.location.origin;
const HREF = `${ORIGIN}/n/alice/target`;

function mounted(content: unknown[] = [{ type: "paragraph", content: "hello world" }]): { editor: AnyEditor; container: HTMLElement } {
  const editor = BlockNoteEditor.create({ schema: noteSchema, initialContent: content as never }) as AnyEditor;
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor.mount(container);
  return { editor, container };
}

function links(editor: AnyEditor): Array<{ href: string; text: string }> {
  const out: Array<{ href: string; text: string }> = [];
  for (const block of editor.document as Array<{ content?: unknown }>) {
    if (!Array.isArray(block.content)) continue;
    for (const node of block.content as Array<{ type: string; href?: string; content?: Array<{ text: string }> }>) {
      if (node.type === "link") out.push({ href: String(node.href), text: (node.content ?? []).map((c) => c.text).join("") });
    }
  }
  return out;
}

describe("#269 fact: a paste is in its final shape when the call returns", () => {
  let editor: AnyEditor;
  let container: HTMLElement;
  afterEach(() => {
    editor.unmount();
    container.remove();
  });

  it("HTML <a> (pasteHTML)", () => {
    ({ editor, container } = mounted());
    editor.setTextCursorPosition(editor.document[0]!.id, "end");
    editor.pasteHTML(`<a href="${HREF}">x</a>`);
    expect(links(editor)).toEqual([{ href: HREF, text: "x" }]);
  });

  it("markdown [x](url) (pasteMarkdown; the 0.52.1 type returns void, called synchronously without await)", () => {
    ({ editor, container } = mounted());
    editor.setTextCursorPosition(editor.document[0]!.id, "end");
    editor.pasteMarkdown(`[x](${HREF})`);
    expect(links(editor)).toEqual([{ href: HREF, text: "x" }]);
  });

  it("empty selection pasting a same-origin absolute URL (pasteText; autolink's paste rule)", () => {
    ({ editor, container } = mounted());
    editor.setTextCursorPosition(editor.document[0]!.id, "end");
    editor.pasteText(` ${HREF} `);
    expect(links(editor)).toEqual([{ href: HREF, text: HREF }]);
  });

  it("URL pasted over selected text (tiptap Link's handlePaste)", () => {
    ({ editor, container } = mounted());
    const view = editor._tiptapEditor.view;
    let from = -1;
    view.state.doc.descendants((node: { isText: boolean; text?: string }, pos: number) => {
      if (from === -1 && node.isText && String(node.text).includes("world")) from = pos + String(node.text).indexOf("world");
      return from === -1;
    });
    editor._tiptapEditor.commands.setTextSelection({ from, to: from + 5 });
    editor.pasteText(HREF);
    expect(links(editor)).toEqual([{ href: HREF, text: "world" }]);
  });

  it("in-site copy and paste (blocksToHTMLLossy's <a>, via pasteHTML)", () => {
    ({ editor, container } = mounted([{ type: "paragraph", content: [{ type: "link", href: HREF, content: "y" }] }, { type: "paragraph", content: "" }]));
    const html = editor.blocksToHTMLLossy([editor.document[0]!]);
    editor.setTextCursorPosition(editor.document[1]!.id, "end");
    editor.pasteHTML(html);
    expect(links(editor).filter((l) => l.text === "y")).toHaveLength(2);
  });
});

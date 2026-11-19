import { afterEach, describe, expect, it } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { noteSchema } from "./schema";
import { CARET_INSIDE_ATTR, createCodeBlockCaretExtension } from "./code-block-caret";

// Mount a real editor (same approach as `site-link-convert.test.tsx`): the decoration must really land on the block content DOM for `index.css`'s `[data-caret-inside]` to apply; testing only the return value of `caretCodeBlockDecorations` can't prove that part.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple, repo convention
type AnyEditor = BlockNoteEditor<any, any, any>;

function mount(withExtension = true): { editor: AnyEditor; container: HTMLElement } {
  const editor = BlockNoteEditor.create({
    schema: noteSchema,
    initialContent: [
      { type: "paragraph", content: "above" },
      { type: "codeBlock", props: { language: "typescript" }, content: "const a = 1;" },
      { type: "paragraph", content: "below" },
    ],
    _tiptapOptions: { extensions: withExtension ? [createCodeBlockCaretExtension()] : [] },
  } as never) as AnyEditor;
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor.mount(container);
  return { editor, container };
}

const codeBlockEl = (container: HTMLElement) => container.querySelector('.bn-block-content[data-content-type="codeBlock"]')!;
/** Tiptap's focusEvents plugin listens to DOM focus/blur: set `editor.isFocused` and dispatch a tr (so decorations recompute). */
const focus = (editor: AnyEditor) => editor._tiptapEditor.view.dom.dispatchEvent(new FocusEvent("focus"));
const blur = (editor: AnyEditor) => editor._tiptapEditor.view.dom.dispatchEvent(new FocusEvent("blur"));

describe("code block caret signal (data-caret-inside)", () => {
  let editor: AnyEditor;
  let container: HTMLElement;
  afterEach(() => {
    editor.unmount();
    container.remove();
  });

  it("caret in a code block with editor focus -> that block content gets the attribute; moving to another block removes it", () => {
    ({ editor, container } = mount());
    focus(editor);
    expect(codeBlockEl(container).hasAttribute(CARET_INSIDE_ATTR), "游標還在第一段，不該掛").toBe(false);

    editor.setTextCursorPosition(editor.document[1]!.id, "end");
    expect(codeBlockEl(container).hasAttribute(CARET_INSIDE_ATTR), "游標進了程式碼，語言下拉要叫得出來").toBe(true);

    editor.setTextCursorPosition(editor.document[2]!.id, "start");
    expect(codeBlockEl(container).hasAttribute(CARET_INSIDE_ATTR), "游標離開了，控制項不該留在那塊程式碼上").toBe(false);
    expect(container.querySelectorAll(`[${CARET_INSIDE_ATTR}]`), "段落不是 code block，不該被標記").toHaveLength(0);
  });

  it("editor blurs -> removed (caret stays where it was, but the controls shouldn't stay floating over that code block)", () => {
    ({ editor, container } = mount());
    focus(editor);
    editor.setTextCursorPosition(editor.document[1]!.id, "end");
    expect(codeBlockEl(container).hasAttribute(CARET_INSIDE_ATTR)).toBe(true);

    blur(editor);
    expect(codeBlockEl(container).hasAttribute(CARET_INSIDE_ATTR)).toBe(false);
  });

  it("read-only -> not attached (the dropdown is a disabled plain-text label, nothing to bring up)", () => {
    ({ editor, container } = mount());
    focus(editor);
    editor.setTextCursorPosition(editor.document[1]!.id, "end");
    editor.isEditable = false;
    expect(codeBlockEl(container).hasAttribute(CARET_INSIDE_ATTR)).toBe(false);
  });

  it("control: without the extension the attribute is absent (so the attribute comes from this plugin, not from BlockNote itself)", () => {
    ({ editor, container } = mount(false));
    focus(editor);
    editor.setTextCursorPosition(editor.document[1]!.id, "end");
    expect(codeBlockEl(container).hasAttribute(CARET_INSIDE_ATTR)).toBe(false);
  });
});

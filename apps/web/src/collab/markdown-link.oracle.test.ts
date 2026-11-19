import { describe, expect, it } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { noteSchema } from "./schema";
import { createMarkdownLinkExtension } from "./markdown-link";
import type { EditorRef } from "@/components/wikilink/menu";

/**
 * Oracle comparison (guard that hand-typed and pasted end states are equal): like `paste.subset.test.ts`, BlockNote itself is the oracle: for the same input, compare the end state after typing character by character with the end state of `pasteMarkdown`, whole document equal.
 *
 * ⚠ **The input set is enumerated explicitly, each entry with one sentence on why it's included or excluded; no open criterion filters it.** Counter-example: `![a](…) [b](…)` has a tail restoration that is equal character for character (an open criterion like "exclude if the restoration doesn't return to the original text" would keep it in the set), but the parser silently drops the inline image **entirely** while the typed side only swaps the tail, so the result is a false red. **The criterion looks only at the tail while the end state is decided by the whole paragraph**: the `EXCLUDED` group below holds the named members of this family and of the title/scheme family.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ProseMirror EditorView, same reason as markdown-link.rule.test.tsx
type AnyView = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple, repo convention
type AnyEditor = BlockNoteEditor<any, any, any>;

function typeChar(view: AnyView, ch: string): void {
  const { from, to } = view.state.selection;
  const handled = view.someProp("handleTextInput", (f: (v: AnyView, f: number, t: number, c: string) => boolean | void) =>
    f(view, from, to, ch),
  );
  if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
}

function typeString(view: AnyView, s: string): void {
  for (const ch of s) typeChar(view, ch);
}

function mountedEditor(): { editor: AnyEditor; container: HTMLElement } {
  const editorRef: EditorRef = { current: null };
  const editor = BlockNoteEditor.create({
    schema: noteSchema,
    _tiptapOptions: { extensions: [createMarkdownLinkExtension({ editorRef })] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNoteEditorOptions's full type requires the full schema triple
  } as any) as AnyEditor;
  editorRef.current = editor;
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor.mount(container);
  return { editor, container };
}

function typedContent(input: string): unknown {
  const { editor, container } = mountedEditor();
  try {
    typeString(editor._tiptapEditor.view, input);
    return editor.document[0]!.content;
  } finally {
    editor.unmount();
    container.remove();
  }
}

function pastedContent(input: string): unknown {
  const { editor, container } = mountedEditor();
  try {
    editor.pasteMarkdown(input);
    return editor.document[0]!.content;
  } finally {
    editor.unmount();
    container.remove();
  }
}

/** Applicable set: typed and pasted end states are equal character for character. Each entry has a sentence on why it's included. */
const MATCHING: Array<[string, string]> = [
  ["basic case: a lone link", "[a](https://x.com)"],
  ["href with paired parentheses: the parser keeps the parentheses intact on both sides", "[水星](https://zh.wikipedia.org/wiki/水星_(行星))"],
  ["ordinary text prefix before the link with no markdown-significant characters: both sides keep it as is", "前面有字 [a](https://x.com)"],
  ["two links in one paragraph: both sides turn each into its own link node (with plain text between)", "[a](https://x.com) 然後 [b](https://y.com)"],
  ["unescaped ) inside the URL: both sides end the link at the first ) leaving a short link plus residual plain text", "[a](https://x.com/foo)bar)"],
  ["relative-path href: both sides keep it as is (the safeMediaUrl criteria don't apply)", "[區域](/n/my-note)"],
  ["mailto scheme: both sides allow it (the scheme is deliberately not narrowed)", "[寄信](mailto:me@example.com)"],
];

/**
 * Members that are known to differ and are **deliberately excluded** (not in the equality assertion above). Each has a sentence on why it's excluded, and an assertion that the two sides really differ pins that the reason isn't imagined, so this list can't drift from the facts unnoticed.
 */
describe("markdown-link oracle: applicable set (whole-document end states equal)", () => {
  it.each(MATCHING)("%s: %s", (_reason, input) => {
    expect(typedContent(input)).toEqual(pastedContent(input));
  });
});

describe("markdown-link oracle: deliberately excluded members (the two sides really differ, reasons in comments)", () => {
  it("![a](https://x.com/i.png) [b](https://y.com): tail restoration is equal character for character, but the parser silently drops the inline image entirely while the typed side only swaps the tail -> the prefixes differ", () => {
    const typed = typedContent("![a](https://x.com/i.png) [b](https://y.com)");
    const pasted = pastedContent("![a](https://x.com/i.png) [b](https://y.com)");
    expect(typed).not.toEqual(pasted);
  });

  it('[a](https://x.com "title"): on the paste side the parser drops the title but still makes a link; on the typed side the restoration comparison is unequal (recon has no title) so the rule never fires and it stays plain text', () => {
    const typed = typedContent('[a](https://x.com "標題")');
    const pasted = pastedContent('[a](https://x.com "標題")');
    expect(typed).not.toEqual(pasted);
  });

  it("[bad](javascript:alert(1)): on the paste side the parser swallows the dangerous scheme whole and degrades to plain text, on the typed side the decision function returns null and the rule never fires, so the whole string stays as typed", () => {
    const typed = typedContent("[壞](javascript:alert(1))");
    const pasted = pastedContent("[壞](javascript:alert(1))");
    expect(typed).not.toEqual(pasted);
  });
});

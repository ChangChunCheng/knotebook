import { afterEach, describe, expect, it } from "vitest";
import { BlockNoteEditor, SuggestionMenu } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { collabUndoManager } from "./undo";
import { noteSchema } from "./schema";
import { createMarkdownLinkExtension, MAX_LINK_SCAN } from "./markdown-link";
import type { EditorRef } from "@/components/wikilink/menu";
import type { SiteLinkEnv, SiteLinkEnvRef } from "./site-link-convert";
import type { SiteLinkCandidate } from "@knotebook/shared";
import { attachTestElementRenderer } from "@/test/element-renderer";

/**
 * ProseMirror EditorView: importing these `@tiptap/pm` paths directly from apps/web gives MODULE_NOT_FOUND, and Vite/vitest blows up at the transform stage (not at run time). (`prosemirror-view` has been a direct dependency of apps/web since `collab/code-block-caret.ts` and is no longer in that group; its type isn't used here.) So `any` is used, following the repo's existing interop convention (same as `AnyEditor`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see the comment above
type AnyView = any;

/**
 * ⚠ **Don't reuse `NoteEditor.test.ts`'s `typeInput`**: it's a local function inside that file's `describe`, not exported, and it calls `buildNoteEditorOptions`'s `editorProps.handleTextInput` directly, which bypasses the input rule plugin chain entirely (the rule hangs on `inputRulesPlugin`'s `props.handleTextInput`). A test written that way can never exercise the rule tested here.
 *
 * This one drives it correctly, giving editorProps and all plugins a chance in order: through `view.someProp("handleTextInput", ...)`, with coordinates always taken from `view.state.selection` (positions aren't passed in by hand: not syncing the selection once led this repo to a wrong conclusion that made it into the CHANGELOG).
 */
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple, repo convention
type AnyEditor = BlockNoteEditor<any, any, any>;

/**
 * Mounts a **non-collab** real editor with the markdown link extension under test. Headless, `SuggestionMenu.openSuggestionMenu` returns early (the suggestion-menu case below needs it mounted), so always `mount()`.
 *
 * ⚠ This helper is **also a run-time guard**: if `@tiptap/core` resolves to a different instance than BlockNote's, the `Extension`/`InputRule` built by `createMarkdownLinkExtension` are foreign objects to the mechanism BlockNote uses internally to register `addInputRules`: the rule silently never fires with zero type errors, and only the tests that mount a real editor, really type and assert a real conversion go red.
 */
function mountedEditor(siteLinks?: SiteLinkEnvRef): { editor: AnyEditor; editorRef: EditorRef; container: HTMLElement } {
  const editorRef: EditorRef = { current: null };
  const editor = BlockNoteEditor.create({
    schema: noteSchema,
    _tiptapOptions: { extensions: [createMarkdownLinkExtension({ editorRef, siteLinks })] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNoteEditorOptions's full type requires the full schema triple
  } as any) as AnyEditor;
  editorRef.current = editor;
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor.mount(container);
  attachTestElementRenderer(editor); // #269: wikilink's toDOM needs it (see the helper's file header)
  return { editor, editorRef, container };
}

/** Mounts a **collab** real editor (withCollaboration + its own Y.Doc): measuring undo semantics needs the real Yjs `UndoManager`, which non-collab doesn't have (no `history` extension). */
function mountedCollabEditor(siteLinks?: SiteLinkEnvRef): { doc: Y.Doc; editor: AnyEditor; container: HTMLElement } {
  const doc = new Y.Doc();
  const editorRef: EditorRef = { current: null };
  const editor = BlockNoteEditor.create(
    withCollaboration({
      schema: noteSchema,
      collaboration: {
        provider: { awareness: undefined },
        fragment: doc.getXmlFragment(YDOC_FRAGMENT),
        user: { id: "u1", name: "User 1", color: "hsl(0 65% 45%)" },
      },
      _tiptapOptions: { extensions: [createMarkdownLinkExtension({ editorRef, siteLinks })] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration's option type requires the full schema triple
    } as any),
  ) as AnyEditor;
  editorRef.current = editor;
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor.mount(container);
  attachTestElementRenderer(editor); // #269: wikilink's toDOM needs it (see the helper's file header)
  return { doc, editor, container };
}

describe("createMarkdownLinkExtension: input rule firing (real editor, simulated character by character)", () => {
  let editor: AnyEditor;
  let container: HTMLElement;

  afterEach(() => {
    editor.unmount();
    container.remove();
  });

  it("hello [a](https://x.com) -> exact assertion on the whole document (not just whether a link appears, so an off-by-one is caught)", () => {
    ({ editor, container } = mountedEditor());
    const view = editor._tiptapEditor.view;

    typeString(view, "hello [a](https://x.com)");

    // ⚠ Whole-document exact assertion: if the handler used matchedLength to work back the position (instead of the range given by `run()`), the space in "hello " would be eaten one position too far, giving `[{"text":"hello"},{link}]`; this assertion catches that off-by-one.
    expect(editor.document).toHaveLength(1);
    expect(editor.document[0]!.content).toEqual([
      { type: "text", text: "hello ", styles: {} },
      {
        type: "link",
        href: "https://x.com",
        content: [{ type: "text", text: "a", styles: {} }],
      },
    ]);
  });
});

describe("document-side guard: a mark inside the range prevents firing, a mark outside the range doesn't", () => {
  let editor: AnyEditor;
  let container: HTMLElement;

  afterEach(() => {
    editor.unmount();
    container.remove();
  });

  it("reject: '[ + bold a + ](https://x.com' then typing ) -> not converted, bold stays (a mark inside the range)", () => {
    ({ editor, container } = mountedEditor());
    const view = editor._tiptapEditor.view;
    editor.insertInlineContent(["[", { type: "text", text: "a", styles: { bold: true } }, "](https://x.com"]);
    typeChar(view, ")");

    expect(editor.document[0]!.content).toEqual([
      { type: "text", text: "[", styles: {} },
      { type: "text", text: "a", styles: { bold: true } },
      { type: "text", text: "](https://x.com)", styles: {} },
    ]);
  });

  it("reject: an orphan [ + an existing link then typing ](https://z.com) -> not converted (the guard blocks it even though resolveTrailingMarkdownLink would return a match and run()'s position validation would pass)", () => {
    ({ editor, container } = mountedEditor());
    const view = editor._tiptapEditor.view;
    typeString(view, "[[c](https://x.com)");
    // Intermediate state: SuggestionMenu's built-in detection eats the first [ at block start and opens the menu, the second [ stays in the document, forming an "orphan [ + link(c)" shape.
    expect(editor.document[0]!.content).toEqual([
      { type: "text", text: "[", styles: {} },
      { type: "link", href: "https://x.com", content: [{ type: "text", text: "c", styles: {} }] },
    ]);

    typeString(view, "](https://z.com)");

    expect(editor.document[0]!.content).toEqual([
      { type: "text", text: "[", styles: {} },
      { type: "link", href: "https://x.com", content: [{ type: "text", text: "c", styles: {} }] },
      { type: "text", text: "](https://z.com)", styles: {} },
    ]);
  });

  it("positive: bold right next to the range but outside it (editor.replaceBlocks writes two explicit nodes) -> must still fire", () => {
    ({ editor, container } = mountedEditor());
    const view = editor._tiptapEditor.view;
    // ⚠ How this case is built matters, and it can't be made by literally typing: text typed after bold is itself bold (stored marks), which puts the whole syntax inside the range and the guard correctly rejects it. Several constructions can reproduce this; this is one of them (the `unsetMark` case next is closer to real user action: type bold, press Ctrl+B to turn it off, then type the link).
    editor.replaceBlocks(
      [editor.document[0]!],
      [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "粗", styles: { bold: true } },
            { type: "text", text: "[a](https://x.com", styles: {} },
          ],
        } as never,
      ],
    );
    editor._tiptapEditor.commands.setTextSelection(view.state.doc.content.size - 1);

    typeChar(view, ")");

    expect(editor.document[0]!.content).toEqual([
      { type: "text", text: "粗", styles: { bold: true } },
      { type: "link", href: "https://x.com", content: [{ type: "text", text: "a", styles: {} }] },
    ]);
  });

  it("positive (closer to a real user): type bold, press Ctrl+B to turn it off (unsetMark), then type the link character by character -> must still fire", () => {
    ({ editor, container } = mountedEditor());
    const view = editor._tiptapEditor.view;
    // After `insertInlineContent` of a bold text, `unsetMark("bold")` turns off the stored mark (same as the user pressing Ctrl+B after typing bold), then the link syntax is typed character by character: closer to the real input path than the previous case's `replaceBlocks` construction.
    editor.insertInlineContent([{ type: "text", text: "粗", styles: { bold: true } }]);
    editor._tiptapEditor.commands.unsetMark("bold");

    typeString(view, "[a](https://x.com)");

    expect(editor.document[0]!.content).toEqual([
      { type: "text", text: "粗", styles: { bold: true } },
      { type: "link", href: "https://x.com", content: [{ type: "text", text: "a", styles: {} }] },
    ]);
  });
});

describe("MAX_LINK_SCAN and the left-boundary re-guard after truncation", () => {
  let editor: AnyEditor;
  let container: HTMLElement;

  afterEach(() => {
    editor.unmount();
    container.remove();
  });

  it("paragraph far longer than MAX_LINK_SCAN with a valid link at the end -> still fires", () => {
    ({ editor, container } = mountedEditor());
    const view = editor._tiptapEditor.view;
    const filler = "x".repeat(600);

    typeString(view, `${filler}[a](https://x.com)`);

    expect(editor.document[0]!.content).toEqual([
      { type: "text", text: filler, styles: {} },
      { type: "link", href: "https://x.com", content: [{ type: "text", text: "a", styles: {} }] },
    ]);
  });

  it("after truncation recon reaches exactly the left boundary -> must not fire (the left-boundary blind spot that truncation recreates)", () => {
    ({ editor, container } = mountedEditor());
    const view = editor._tiptapEditor.view;
    // ⚠ Derived from `MAX_LINK_SCAN`, not a hard-coded number: with a hard-coded 483/500, changing the constant to 400 would stay green (the boundary case silently degrades to "no link can be parsed anyway", because pad doesn't shrink with the constant, markdown length no longer equals the new constant, and what is tested is no longer this left-boundary blind spot). "[" + pad + "](https://x.com)" is pad.length + 17 characters; to make the markdown exactly MAX_LINK_SCAN long, the pad length is `MAX_LINK_SCAN - 17`.
    const pad = "a".repeat(MAX_LINK_SCAN - 17);
    const prefix = "b".repeat(51);
    const markdown = `[${pad}](https://x.com)`;
    expect(markdown.length).toBe(MAX_LINK_SCAN);

    typeString(view, `${prefix}${markdown}`);

    expect(editor.document[0]!.content).toEqual([{ type: "text", text: `${prefix}${markdown}`, styles: {} }]);
  });
});

describe("doesn't fire while the suggestion menu is open", () => {
  let editor: AnyEditor;
  let container: HTMLElement;

  afterEach(() => {
    editor.unmount();
    container.remove();
  });

  it("after openSuggestionMenu(\"[[\") typing the whole string -> no link appears in the document", () => {
    ({ editor, container } = mountedEditor());
    const view = editor._tiptapEditor.view;

    editor.getExtension(SuggestionMenu)!.openSuggestionMenu("[[");
    expect(editor.getExtension(SuggestionMenu)!.shown()).toBe(true);

    typeString(view, "[a](https://x.com)");

    const hasLink = (editor.document[0]!.content as Array<{ type: string }>).some((n) => n.type === "link");
    expect(hasLink).toBe(false);
  });
});

describe("shape: unescaped ) inside the URL", () => {
  let editor: AnyEditor;
  let container: HTMLElement;

  afterEach(() => {
    editor.unmount();
    container.remove();
  });

  it("[a](https://x.com/foo)bar) -> short link + plain text bar), and the end state equals pasteMarkdown's for the same string", () => {
    ({ editor, container } = mountedEditor());
    const view = editor._tiptapEditor.view;
    const input = "[a](https://x.com/foo)bar)";

    typeString(view, input);

    const typedContent = editor.document[0]!.content;
    expect(typedContent).toEqual([
      { type: "link", href: "https://x.com/foo", content: [{ type: "text", text: "a", styles: {} }] },
      { type: "text", text: "bar)", styles: {} },
    ]);

    const pasted = mountedEditor();
    try {
      pasted.editor.pasteMarkdown(input);
      expect(pasted.editor.document[0]!.content).toEqual(typedContent);
    } finally {
      pasted.editor.unmount();
      pasted.container.remove();
    }
  });
});

/**
 * Runs "fire -> Backspace -> Ctrl+Z" on our own rule and sets the results beside the existing behaviour of an ordinary input rule:
 *
 * | Scenario | After Backspace | 1st Ctrl+Z | 2nd Ctrl+Z |
 * |---|---|---|---|
 * | continuous typing (no pause) | back to plain text `hello [a](https://x.com)` | **whole paragraph cleared** (not back to plain text) | still empty (nothing left to undo) |
 * | pause >= 500ms after typing, then Backspace | same | **link reappears** | cleared directly (see below) |
 *
 * Backspace behaves like an ordinary input rule in both scenarios (back to the full plain text), and the Ctrl+Z step splitting follows the same mechanism as an ordinary input rule (the Yjs `captureTimeout` merge window), so our rule has no semantically reversed behaviour of its own.
 *
 * In the "pause" scenario the second Ctrl+Z clears directly instead of going back to plain text: the three-stage result needs a pause > 500ms between the prefix and the trigger character as well; here `stopCapturing()` is called once after typing, so the whole input stays merged in one Yjs stack item and the second Ctrl+Z undoes that whole item. That is normal merge-window behaviour, not a new behaviour of our rule.
 */
describe("undo semantics of our rule (fire -> Backspace -> Ctrl+Z, alongside the control)", () => {
  it("continuous typing (no pause, real typing rhythm): Backspace returns to plain text, one Ctrl+Z clears the whole paragraph", () => {
    const { doc, editor, container } = mountedCollabEditor();
    const view = editor._tiptapEditor.view;
    const manager = collabUndoManager(editor)!;
    try {
      typeString(view, "hello [a](https://x.com)");
      expect((editor.document[0]!.content as Array<{ type: string }>).some((n) => n.type === "link")).toBe(true);

      editor._tiptapEditor.commands.undoInputRule();
      expect(editor.document[0]!.content).toEqual([{ type: "text", text: "hello [a](https://x.com)", styles: {} }]);

      manager.undo();
      expect(editor.document[0]!.content).toEqual([]);
    } finally {
      editor.unmount();
      container.remove();
      doc.destroy();
    }
  });

  it("pause >= 500ms after typing, then Backspace: the first Ctrl+Z makes the link reappear (not back to plain text)", () => {
    const { doc, editor, container } = mountedCollabEditor();
    const view = editor._tiptapEditor.view;
    const manager = collabUndoManager(editor)!;
    try {
      typeString(view, "hello [a](https://x.com)");
      manager.stopCapturing(); // equivalent to the user pausing > 500ms
      editor._tiptapEditor.commands.undoInputRule();
      expect(editor.document[0]!.content).toEqual([{ type: "text", text: "hello [a](https://x.com)", styles: {} }]);

      manager.undo();
      expect((editor.document[0]!.content as Array<{ type: string }>).some((n) => n.type === "link")).toBe(true);
    } finally {
      editor.unmount();
      container.remove();
      doc.destroy();
    }
  });
});

const ALPHA: SiteLinkCandidate = { id: "11111111-1111-4111-8111-111111111111", title: "Alpha", slug: "alpha", groupId: null, ownerHandle: "alice" };
function siteEnv(notes: SiteLinkCandidate[]): SiteLinkEnvRef & { requests: unknown[][] } {
  const requests: unknown[][] = [];
  const env: SiteLinkEnv = { origin: window.location.origin, notes: () => notes, schedule: (r) => void requests.push(r) };
  return { current: env, requests };
}

describe("#269 input rule: on-site link -> wikilink", () => {
  let editor: AnyEditor;
  let container: HTMLElement;
  afterEach(() => {
    editor.unmount();
    container.remove();
  });

  it("cache hit: inserts a wikilink directly (label rule: text equal to the title -> empty; the anchor goes into a prop); exact assertion on the whole document", () => {
    ({ editor, container } = mountedEditor(siteEnv([ALPHA])));
    typeString(editor._tiptapEditor.view, "see [Alpha](/n/alice/alpha#b-h1)");
    expect(editor.document[0]!.content).toEqual([
      { type: "text", text: "see ", styles: {} },
      { type: "wikilink", props: { targetNoteId: ALPHA.id, snapshotTitle: "Alpha", label: "", anchorBlockId: "h1" } },
    ]);
  });

  it("cache miss: inserts an ordinary link and queues a fallback (one entry, carrying the containing block id)", async () => {
    const env = siteEnv([]);
    ({ editor, container } = mountedEditor(env));
    typeString(editor._tiptapEditor.view, "see [x](/n/bob/secret)");
    expect((editor.document[0]!.content as Array<{ type: string; href?: string }>).find((n) => n.type === "link")?.href).toBe("/n/bob/secret");
    await Promise.resolve();
    expect(env.requests).toEqual([[{ blockIds: [editor.document[0]!.id], href: "/n/bob/secret", text: "x", parsed: { path: { kind: "n", handle: "bob", slug: "secret" }, anchorBlockId: "" } }]]);
  });

  it("external link: inserts an ordinary link as before, no fallback queued", async () => {
    const env = siteEnv([ALPHA]);
    ({ editor, container } = mountedEditor(env));
    typeString(editor._tiptapEditor.view, "see [x](https://example.com/n/alice/alpha)");
    expect((editor.document[0]!.content as Array<{ type: string }>).some((n) => n.type === "link")).toBe(true);
    await Promise.resolve();
    expect(env.requests).toEqual([]);
  });

  it("mark guard as before: an orphan [ + an existing link then typing ](on-site URL) -> not converted, no wikilink inserted", () => {
    ({ editor, container } = mountedEditor(siteEnv([ALPHA])));
    const view = editor._tiptapEditor.view;
    typeString(view, "[[c](https://x.com)");
    typeString(view, "](/n/alice/alpha)");
    expect((editor.document[0]!.content as Array<{ type: string }>).some((n) => n.type === "wikilink")).toBe(false);
  });
});

/**
 * Input-rule row of the undo-after-wikilink conversion (collab configuration, no fake timers): does an immediate Backspace (undoInputRule) go back to the `[text](url)` plain text; and what the first Ctrl+Z gives with or without a pause. MEASURED is the expected value (same shape as the ordinary-link control).
 */
const MEASURED_RULE = { backspaceRestoresText: true, continuousUndoClears: true, pausedUndoRestoresWikilink: true } as const;

describe("#269 undo of an input rule converting to a wikilink (the measured results are the assertions)", () => {
  it(`continuous typing: Backspace back to plain text =${String(MEASURED_RULE.backspaceRestoresText)}; first Ctrl+Z clears the whole paragraph =${String(MEASURED_RULE.continuousUndoClears)}`, () => {
    const { doc, editor, container } = mountedCollabEditor(siteEnv([ALPHA]));
    const manager = collabUndoManager(editor)!;
    try {
      typeString(editor._tiptapEditor.view, "hello [Alpha](/n/alice/alpha)");
      expect((editor.document[0]!.content as Array<{ type: string }>).some((n) => n.type === "wikilink")).toBe(true);
      editor._tiptapEditor.commands.undoInputRule();
      expect(JSON.stringify(editor.document[0]!.content) === JSON.stringify([{ type: "text", text: "hello [Alpha](/n/alice/alpha)", styles: {} }])).toBe(MEASURED_RULE.backspaceRestoresText);
      manager.undo();
      expect((editor.document[0]!.content as unknown[]).length === 0).toBe(MEASURED_RULE.continuousUndoClears);
    } finally {
      editor.unmount();
      container.remove();
      doc.destroy();
    }
  });

  it(`pause after typing then Backspace: first Ctrl+Z makes the wikilink reappear =${String(MEASURED_RULE.pausedUndoRestoresWikilink)}`, () => {
    const { doc, editor, container } = mountedCollabEditor(siteEnv([ALPHA]));
    const manager = collabUndoManager(editor)!;
    try {
      typeString(editor._tiptapEditor.view, "hello [Alpha](/n/alice/alpha)");
      manager.stopCapturing();
      editor._tiptapEditor.commands.undoInputRule();
      manager.undo();
      expect((editor.document[0]!.content as Array<{ type: string }>).some((n) => n.type === "wikilink")).toBe(MEASURED_RULE.pausedUndoRestoresWikilink);
    } finally {
      editor.unmount();
      container.remove();
      doc.destroy();
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { QueryClient } from "@tanstack/react-query";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import { collabUndoManager } from "@/collab/undo";
import { attachTestElementRenderer } from "@/test/element-renderer";
import type { AnyEditor } from "@/test/columns-fixtures";
import { buildSampleBlocks, createSampleNote, seedSampleNote } from "./sample-note";

const t = i18n.getFixedT("en");
const NOTE = { id: "11111111-1111-4111-8111-111111111111", title: t("tourGuide.sample.title") };

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.unstubAllGlobals();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

/** Real editor with `Y.Doc` collaboration (no provider needed); an editor without collaboration uses prosemirror-history, not the production path. */
function mountCollab(doc: Y.Doc): AnyEditor {
  const editor = BlockNoteEditor.create(
    withCollaboration({
      schema: noteSchema,
      collaboration: {
        provider: { awareness: undefined },
        fragment: doc.getXmlFragment(YDOC_FRAGMENT),
        user: { id: "u1", name: "User 1", color: "hsl(0 65% 45%)" },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration's options type requires the full schema triple
    } as any),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
  ) as any as AnyEditor;
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor.mount(el);
  attachTestElementRenderer(editor); // the link's toDOM needs it
  cleanups.push(() => {
    editor.unmount();
    el.remove();
    doc.destroy();
  });
  return editor;
}

/** A fresh empty note: document synced, one empty paragraph. */
async function mountEmptyNote(): Promise<{ editor: AnyEditor; doc: Y.Doc }> {
  const doc = new Y.Doc();
  const editor = mountCollab(doc);
  await tick();
  return { editor, doc };
}

const types = (editor: AnyEditor) => (editor.document as { type: string }[]).map((b) => b.type);

const BLOCK_TYPES_WITH_AI = [
  "paragraph",
  "heading",
  "bulletListItem",
  "bulletListItem",
  "numberedListItem",
  "numberedListItem",
  "checkListItem",
  "checkListItem",
  "quote",
  "codeBlock",
  "paragraph",
  "columnList",
  "mermaid",
  "table",
  "paragraph",
  "paragraph",
];
// without AI the second-to-last block (the AI sentence) is omitted
const BLOCK_TYPES = BLOCK_TYPES_WITH_AI.filter((_, i) => i !== BLOCK_TYPES_WITH_AI.length - 2);

describe("createSampleNote", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: () => Promise.resolve({ ...NOTE }) } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
  });

  it("sends one POST /api/notes whose body has only title; the note list is refetched after success", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const note = await createSampleNote(queryClient, t);
    expect(note.id).toBe(NOTE.id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/notes");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ title: t("tourGuide.sample.title") });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["notes"] });
  });

  it("title follows the current UI language", async () => {
    const tZh = i18n.getFixedT("zh-TW");
    await createSampleNote(new QueryClient(), tZh);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ title: tZh("tourGuide.sample.title") });
    expect(tZh("tourGuide.sample.title")).not.toBe(t("tourGuide.sample.title"));
  });

  it("POST failure -> throws and does not refetch the list", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }),
    } as unknown as Response);
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await expect(createSampleNote(queryClient, t)).rejects.toMatchObject({ status: 500 });
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("seedSampleNote", () => {
  it("empty note -> writes, returns true, block types are as expected in order", async () => {
    const { editor } = await mountEmptyNote();
    expect(seedSampleNote(editor, NOTE, t, true)).toBe(true);
    expect(types(editor)).toEqual(BLOCK_TYPES_WITH_AI);
  });

  it("document already has content -> does nothing, returns false", async () => {
    const { editor } = await mountEmptyNote();
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "已經有字" }]);
    const before = JSON.stringify(editor.document);
    expect(seedSampleNote(editor, NOTE, t, true)).toBe(false);
    expect(JSON.stringify(editor.document)).toBe(before);
  });

  it("AI off -> the write omits the AI sentence, the rest is unchanged, and the last block is still an empty paragraph", async () => {
    const { editor } = await mountEmptyNote();
    expect(seedSampleNote(editor, NOTE, t, false)).toBe(true);
    expect(types(editor)).toEqual(BLOCK_TYPES);
    expect(JSON.stringify(editor.document)).not.toContain(t("tourGuide.sample.aiSentence"));
    const withAi = buildSampleBlocks(t, NOTE, true);
    const withoutAi = buildSampleBlocks(t, NOTE, false);
    expect(withoutAi).toEqual(withAi.filter((_, i) => i !== withAi.length - 2));
    expect(withoutAi[withoutAi.length - 1]).toEqual({ type: "paragraph" });
  });

  it.each([
    ["a diagram only", [{ type: "mermaid", props: { code: "graph LR\n  A --> B" } }]],
    ["an empty heading only", [{ type: "heading", props: { level: 2 } }]],
  ])("document with %s (non-paragraph block without text) -> counts as having content, nothing written", async (_name, blocks) => {
    const { editor } = await mountEmptyNote();
    editor.replaceBlocks(editor.document, blocks);
    const before = JSON.stringify(editor.document);
    expect(seedSampleNote(editor, NOTE, t, true)).toBe(false);
    expect(JSON.stringify(editor.document)).toBe(before);
  });

  it("the link points at the note itself", async () => {
    const { editor } = await mountEmptyNote();
    seedSampleNote(editor, NOTE, t, true);
    const links = (editor.document as { content?: { type: string; props?: Record<string, string> }[] }[])
      .flatMap((b) => (Array.isArray(b.content) ? b.content : []))
      .filter((c) => c.type === "wikilink");
    expect(links).toHaveLength(1);
    expect(links[0]!.props).toMatchObject({ targetNoteId: NOTE.id, snapshotTitle: NOTE.title });
  });

  it("the sentence selected by the AI stop is in the second-to-last paragraph and the last block is an empty paragraph", async () => {
    const blocks = buildSampleBlocks(t, NOTE, true);
    const last = blocks[blocks.length - 1]!;
    const sentence = blocks[blocks.length - 2]!;
    expect(last).toEqual({ type: "paragraph" });
    expect(sentence).toMatchObject({ type: "paragraph", content: [{ text: t("tourGuide.sample.aiSentence") }] });
  });

  it("the write is not undoable: undo after writing leaves the document unchanged", async () => {
    const { editor } = await mountEmptyNote();
    const manager = collabUndoManager(editor)!;
    expect(manager).toBeDefined();
    seedSampleNote(editor, NOTE, t, true);
    expect(manager.undoStack).toHaveLength(0);
    manager.undo();
    expect(types(editor)).toEqual(BLOCK_TYPES_WITH_AI);
  });

  it("the write is one transaction and one Y update", async () => {
    const { editor, doc } = await mountEmptyNote();
    await tick();
    const updates: number[] = [];
    doc.on("update", (u: Uint8Array) => updates.push(u.length));
    const view = editor.prosemirrorView!;
    const dispatch = vi.spyOn(view, "dispatch");
    seedSampleNote(editor, NOTE, t, true);
    expect(dispatch.mock.calls.filter(([tr]) => tr.docChanged)).toHaveLength(1);
    expect(updates).toHaveLength(1);
  });

  it("text from another tab syncs after the decision to write but before the transaction starts -> nothing is written and that text stays", async () => {
    const docA = new Y.Doc();
    const a = mountCollab(docA);
    await tick();
    // Both sides start from the same empty document, so their default paragraphs do not merge into two paragraphs.
    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const b = mountCollab(docB);
    await tick();
    b.setTextCursorPosition(b.document[0]!.id, "end");
    b.prosemirrorView!.dispatch(b.prosemirrorView!.state.tr.insertText("typed elsewhere"));
    await tick();

    // The remote text arrives after `seedSampleNote` has started but before the transaction begins.
    const original = a.transact.bind(a);
    vi.spyOn(a, "transact").mockImplementation(((fn: Parameters<typeof original>[0]) => {
      Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));
      return original(fn);
    }) as typeof a.transact);

    expect(seedSampleNote(a, NOTE, t, true)).toBe(false);
    expect(types(a)).toEqual(["paragraph"]);
    expect(a.prosemirrorState.doc.textContent).toBe("typed elsewhere");
  });
});

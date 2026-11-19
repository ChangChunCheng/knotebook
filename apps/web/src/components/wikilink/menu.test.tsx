import { createRef, forwardRef, useImperativeHandle, useState, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { BlockNoteEditor, SuggestionMenu } from "@blocknote/core";
import type { NoteDto } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import { buildWikilinkMenuItems, type EditorRef } from "./menu";
import { OWNER_PERMS } from "@/test/fixtures";

// **mount harness** (see the section of the same name in NoteEditor.test.ts): after `BlockNoteEditor.create` the editor must be
// `editor.mount(an element attached to document.body)`: when headless, `openSuggestionMenu` returns early (`SuggestionMenu.ts`: `if (editor.headless) return;`),
// and the plugin view of `SuggestionMenu` (where `closeMenu` / `clearQuery` really take effect) is built only on a real mount;
// the case "[[+query is consumed after a candidate is chosen" needs both.
//
// **elementRenderer**: once a `[[` completion candidate is clicked, `menu.ts` calls `insertWikilink`, which inserts a real wikilink inline node into a
// mounted, non-headless editor; `@blocknote/react`'s `ReactRenderUtil.renderToDOMSpec` then either uses `editor.elementRenderer`
// (set only by `<BlockNoteView>`) to render the node's React content, or (when `editor.headless` is true) opens a temporary root of its own;
// with neither it throws `elementRenderer not available, expected headless editor`. No `<BlockNoteView>` is mounted here, so BlockNote's own
// non-exported `ElementRenderer.tsx` is copied (it is short; see `@blocknote/react/src/editor/ElementRenderer.tsx`) into a React tree
// with `QueryClientProvider` / `MemoryRouter` (`WikilinkInline` needs `useNotes` / `useNavigate`), and its imperative handle is connected
// to `editor.elementRenderer`.
type ElementRendererHandle = (node: ReactNode, container: HTMLElement) => void;

const TestElementRenderer = forwardRef<ElementRendererHandle>((_props, ref) => {
  const [singleRenderData, setSingleRenderData] = useState<{ node: ReactNode; container: HTMLElement } | undefined>();

  useImperativeHandle(
    ref,
    () => (node: ReactNode, container: HTMLElement) => {
      flushSync(() => setSingleRenderData({ node, container }));
      setSingleRenderData(undefined);
    },
    [],
  );

  return singleRenderData ? createPortal(singleRenderData.node, singleRenderData.container) : null;
});
TestElementRenderer.displayName = "TestElementRenderer";

function mountedEditor() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor generic triple; any per repo convention (same as spec.tsx)
  const editor = BlockNoteEditor.create({ schema: noteSchema }) as BlockNoteEditor<any, any, any>;
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor.mount(container);

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // WikilinkInline's three-state rendering relies on the `useNotes()` cache; no candidate note needs to be resolved here (this file does not assert the DOM),
  // so an empty array lands in the "resolved, no hit" state and does not hang in pending.
  queryClient.setQueryData(["notes"], []);

  const rendererRef = createRef<ElementRendererHandle>();
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <TestElementRenderer ref={rendererRef} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  editor.elementRenderer = rendererRef.current!;

  return { editor, container };
}

function note(overrides: Partial<NoteDto> = {}): NoteDto {
  return {
    id: "n1",
    title: "Meeting Notes",
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slug: "meeting-notes",
    slugIsCustom: false,
    prevSlug: null,
    ownerHandle: "tester",
    lastEdited: null,
    group: null,
    groupId: null,
    folderId: null,
    permissions: OWNER_PERMS,
    ...overrides,
  };
}

const translate = (key: string) => `t:${key}`;

interface WikilinkProps {
  targetNoteId: string;
  snapshotTitle: string;
  label: string;
  anchorBlockId: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor generic triple; any per repo convention (same as spec.tsx)
function wikilinkIn(editor: BlockNoteEditor<any, any, any>): WikilinkProps | undefined {
  const content: unknown = editor.document[0]?.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const found = content.find(
    (item): item is { type: "wikilink"; props: WikilinkProps } =>
      typeof item === "object" && item !== null && "type" in item && (item as { type: unknown }).type === "wikilink",
  );
  return found?.props;
}

describe("buildWikilinkMenuItems", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor generic triple; any per repo convention (same as spec.tsx)
  let editor: BlockNoteEditor<any, any, any>;
  let container: HTMLElement;
  let editorRef: EditorRef;
  let toast: ReturnType<typeof vi.fn>;
  let createNote: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // A background refetch of useNotes() (default staleTime 0) must not hit the network: it is blocked, same as spec.test.tsx's beforeEach.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    ({ editor, container } = mountedEditor());
    editorRef = { current: editor };
    toast = vi.fn();
    createNote = vi.fn();
  });

  afterEach(() => {
    editor.unmount();
    container.remove();
    vi.unstubAllGlobals();
  });

  it("candidates: title substring filter, case-insensitive; a non-empty query adds the create-and-link item", () => {
    const notes = [note({ id: "1", title: "Meeting Notes" }), note({ id: "2", title: "Grocery List" })];

    const items = buildWikilinkMenuItems({ query: "meet", notes, createNote, editorRef, translate, toast });

    expect(items.map((item) => item.title)).toEqual(["Meeting Notes", "t:note.wikilink.createAndLink"]);
  });

  it("empty query: the create-and-link item is not shown", () => {
    const items = buildWikilinkMenuItems({ query: "", notes: [note()], createNote, editorRef, translate, toast });

    expect(items.map((item) => item.title)).toEqual(["Meeting Notes"]);
  });

  it("editorRef.current is null (not mounted yet): an existing-note item's onItemClick neither throws nor inserts", () => {
    editorRef.current = null;
    const items = buildWikilinkMenuItems({
      query: "meet",
      notes: [note()],
      createNote,
      editorRef,
      translate,
      toast,
    });

    expect(() => items[0]!.onItemClick()).not.toThrow();
  });

  it("clicking an existing-note candidate -> inserts a wikilink at the current selection (insertWikilink)", () => {
    const items = buildWikilinkMenuItems({
      query: "meet",
      notes: [note({ id: "n1", title: "Meeting Notes" })],
      createNote,
      editorRef,
      translate,
      toast,
    });

    items[0]!.onItemClick();

    expect(wikilinkIn(editor)).toEqual({ targetNoteId: "n1", snapshotTitle: "Meeting Notes", label: "", anchorBlockId: "" });
  });

  it("create-and-link succeeds: after createNote resolves, inserts the new note's wikilink at the tracked position", async () => {
    const created = note({ id: "new-1", title: "Brand New" });
    createNote.mockResolvedValue(created);
    const items = buildWikilinkMenuItems({ query: "brand new", notes: [], createNote, editorRef, translate, toast });
    const item = items.find((i) => i.title === "t:note.wikilink.createAndLink")!;

    item.onItemClick();

    expect(createNote).toHaveBeenCalledWith("brand new");
    await vi.waitFor(() => {
      expect(wikilinkIn(editor)).toEqual({ targetNoteId: "new-1", snapshotTitle: "Brand New", label: "", anchorBlockId: "" });
    });
    expect(toast).not.toHaveBeenCalled();
  });

  it("create-and-link succeeds but the document drifts before the insertion point while waiting (someone else or the user typing): the landing position is re-mapped through trackPosition, not the absolute position at click time", async () => {
    // This case specifically probes whether `trackPosition` is really used: if the implementation lazily used the fixed absolute position read at click time
    // (instead of re-mapping with the getter `trackPosition` returns after resolve), the exact-position assertion below fails.
    //
    // Layout: type "Keep this" first, with the cursor (the insertion point at click time) after it. While createNote is still pending, insert "PREFIX-" at the very
    // start of the same block (simulating drift from someone else typing, or the user moving elsewhere to keep editing): an absolute position read at click time
    // (never re-mapped) would land at the old coordinate that the drift pushed away from, right in the middle of "Keep this" and split it in two;
    // the position re-mapped through `trackPosition` still lands exactly after "Keep this" and the text is not split.
    //
    // The insertion point is deliberately computed as "current selection position - 'Keep this'.length" (not a hard-coded magic number): BlockNote's document structure is
    // doc > blockGroup > blockContainer > paragraph, so where the text actually starts in absolute terms varies with nesting depth, and a hard-coded number runs into
    // the schema boundary (`insertText(..., 1)` was tried: that position is on the blockContainer boundary, not inside the paragraph's inline content, so after the insert
    // ProseMirror wraps it into a separate new paragraph to satisfy the schema and "Keep this" is not split, which makes the case meaningless).
    editor.insertInlineContent(["Keep this"]);
    const paragraphStart = editor.transact((tr) => tr.selection.from) - "Keep this".length;

    let resolveCreateNote!: (value: NoteDto) => void;
    createNote.mockReturnValue(
      new Promise<NoteDto>((resolve) => {
        resolveCreateNote = resolve;
      }),
    );
    const created = note({ id: "new-1", title: "Brand New" });
    const items = buildWikilinkMenuItems({ query: "brand new", notes: [], createNote, editorRef, translate, toast });
    const item = items.find((i) => i.title === "t:note.wikilink.createAndLink")!;

    item.onItemClick();

    editor.transact((tr) => tr.insertText("PREFIX-", paragraphStart));

    resolveCreateNote(created);
    await vi.waitFor(() => {
      expect(wikilinkIn(editor)).toEqual({ targetNoteId: "new-1", snapshotTitle: "Brand New", label: "", anchorBlockId: "" });
    });

    expect(editor.transact((tr) => tr.doc.textContent)).toBe("PREFIX-Keep this ");
  });

  it("create-and-link fails: plain-text [[query]] is put back and a toast is shown", async () => {
    createNote.mockRejectedValue(new Error("network down"));
    const items = buildWikilinkMenuItems({ query: "brand new", notes: [], createNote, editorRef, translate, toast });
    const item = items.find((i) => i.title === "t:note.wikilink.createAndLink")!;

    item.onItemClick();

    await vi.waitFor(() => {
      expect(editor.transact((tr) => tr.doc.textContent)).toBe("[[brand new]]");
    });
    expect(toast).toHaveBeenCalledWith({ title: "t:note.wikilink.createFailed" });
    expect(wikilinkIn(editor)).toBeUndefined();
  });

  it("after a candidate is chosen (replicating the two steps of React onItemClickCloseMenu): closeMenu -> clearQuery -> handler, and [[+query disappears from the document and is replaced by a wikilink node", () => {
    // Simulates "[[ has been triggered and the user then typed query text": not through NoteEditor's handleTextInput, but by driving the SuggestionMenu extension directly
    // (menu.ts's contract does not depend on how it is triggered).
    const suggestionMenu = editor.getExtension(SuggestionMenu)!;
    suggestionMenu.openSuggestionMenu("[[", { deleteTriggerCharacter: true });
    editor.insertInlineContent(["meet"]);

    const items = buildWikilinkMenuItems({
      query: "meet",
      notes: [note({ id: "n1", title: "Meeting Notes" })],
      createNote,
      editorRef,
      translate,
      toast,
    });
    const item = items.find((i) => i.title === "Meeting Notes")!;

    // React side SuggestionMenuWrapper.onItemClickCloseMenu: closeMenu() first, then clearQuery(), and only then the item's onItemClick; the order must not be reversed:
    // without closeMenu the plugin would still be active during the handler, and insertWikilink's transaction would be taken to recompute the query.
    suggestionMenu.closeMenu();
    suggestionMenu.clearQuery();
    item.onItemClick();

    const text = editor.transact((tr) => tr.doc.textContent);
    expect(text).not.toContain("[[");
    expect(text).not.toContain("meet");
    expect(wikilinkIn(editor)).toEqual({ targetNoteId: "n1", snapshotTitle: "Meeting Notes", label: "", anchorBlockId: "" });
  });
});

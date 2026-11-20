import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { getTourNoteEditor, onEditorEditable, setTourTransactionFilter, type TourEditor } from "@/lib/tour-bridge";
import { isTourTransactionFilterOn } from "@/collab/tour-filter-flag";
import { NoteEditor } from "./NoteEditor";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

// NoteEditor's wiring to the feature-tour registry: mounts a real `<NoteEditor>` (Host as in `NoteEditor.cursor.test.tsx`).

function fakeResponse(json: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(json) } as unknown as Response;
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/ai/actions" && method === "GET") return Promise.resolve(fakeResponse({ actions: [] }));
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse([]));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

const provider = { awareness: null } as never;
const user = { id: "u1", name: "Ann" };

function Host({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>{children}</ThemeProvider>
    </QueryClientProvider>
  );
}

function renderEditor(props: { doc: Y.Doc; noteId: string; editable: boolean }) {
  const tree = (p: typeof props) => (
    <Host>
      <NoteEditor doc={p.doc} provider={provider} editable={p.editable} user={user} noteId={p.noteId} />
    </Host>
  );
  const view = render(tree(props));
  return { ...view, rerenderWith: (p: typeof props) => view.rerender(tree(p)) };
}

describe("NoteEditor: feature-tour registry", () => {
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubFetch();
  });

  afterEach(() => {
    while (disposers.length > 0) disposers.pop()!();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("after mount the registry returns this editor by noteId; another id gets nothing; after unmount nothing", async () => {
    const doc = new Y.Doc();
    const { unmount } = renderEditor({ doc, noteId: "note-1", editable: true });
    await screen.findByTestId("note-editor");
    const editor = getTourNoteEditor("note-1");
    expect(editor).not.toBeNull();
    expect(getTourNoteEditor("note-2")).toBeNull();
    unmount();
    expect(getTourNoteEditor("note-1")).toBeNull();
    doc.destroy();
  });

  it("doc swap (editor rebuilt): the registry switches to the new one; cleared after unmount", async () => {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();
    const { rerenderWith, unmount } = renderEditor({ doc: doc1, noteId: "note-1", editable: true });
    await screen.findByTestId("note-editor");
    const first = getTourNoteEditor("note-1");
    expect(first).not.toBeNull();
    rerenderWith({ doc: doc2, noteId: "note-1", editable: true });
    const second = getTourNoteEditor("note-1");
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    unmount();
    expect(getTourNoteEditor("note-1")).toBeNull();
    doc1.destroy();
    doc2.destroy();
  });

  it("editable false->true calls once (isEditable is already true by then); afterwards true->false->true doesn't call again", async () => {
    const calls: Array<{ noteId: string; editor: TourEditor; isEditable: boolean }> = [];
    disposers.push(onEditorEditable((noteId, editor) => calls.push({ noteId, editor, isEditable: editor.isEditable })));
    const doc = new Y.Doc();
    const { rerenderWith, unmount } = renderEditor({ doc, noteId: "note-1", editable: false });
    await screen.findByTestId("note-editor");
    expect(calls).toEqual([]);
    // Contrast: when read-only isEditable is false, which is what makes "already true at notification time" below meaningful.
    expect(getTourNoteEditor("note-1")!.isEditable).toBe(false);

    rerenderWith({ doc, noteId: "note-1", editable: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.noteId).toBe("note-1");
    expect(calls[0]!.editor).toBe(getTourNoteEditor("note-1"));
    expect(calls[0]!.isEditable).toBe(true);

    rerenderWith({ doc, noteId: "note-1", editable: false });
    rerenderWith({ doc, noteId: "note-1", editable: true });
    expect(calls).toHaveLength(1);
    unmount();
    doc.destroy();
  });

  it("always read-only -> not called", async () => {
    const fn = vi.fn();
    disposers.push(onEditorEditable(fn));
    const doc = new Y.Doc();
    const { rerenderWith, unmount } = renderEditor({ doc, noteId: "note-1", editable: false });
    await screen.findByTestId("note-editor");
    rerenderWith({ doc, noteId: "note-1", editable: false });
    expect(fn).not.toHaveBeenCalled();
    unmount();
    doc.destroy();
  });

  it("editable from the first mount -> called once (already registered at that moment); doc swap (new instance) and editable -> called once more for the new instance", async () => {
    const seen: TourEditor[] = [];
    const registeredAtCall: Array<TourEditor | null> = [];
    disposers.push(
      onEditorEditable((noteId, editor) => {
        seen.push(editor);
        registeredAtCall.push(getTourNoteEditor(noteId));
      }),
    );
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();
    const { rerenderWith, unmount } = renderEditor({ doc: doc1, noteId: "note-1", editable: true });
    await screen.findByTestId("note-editor");
    const first = getTourNoteEditor("note-1");
    expect(seen).toEqual([first]);
    rerenderWith({ doc: doc2, noteId: "note-1", editable: true });
    const second = getTourNoteEditor("note-1");
    expect(seen).toEqual([first, second]);
    // When notified, the tour must be able to get the same editor immediately via getTourNoteEditor: registration must come before notification.
    expect(registeredAtCall).toEqual([first, second]);
    unmount();
    doc1.destroy();
    doc2.destroy();
  });

  it("transaction filter switched on via the registry: typing in the real editor is blocked; after switching off it writes as usual", async () => {
    const doc = new Y.Doc();
    const { unmount } = renderEditor({ doc, noteId: "note-1", editable: true });
    await screen.findByTestId("note-editor");
    const editor = getTourNoteEditor("note-1")!;
    const view = editor._tiptapEditor.view;
    const typeX = () => view.dispatch(view.state.tr.insertText("x", 1 + firstTextblockOffset(view.state.doc)));
    const firstText = () => (editor.document[0]!.content as Array<{ text?: string }>).map((n) => n.text ?? "").join("");

    expect(setTourTransactionFilter("note-1", true)).toBe(true);
    typeX();
    expect(firstText()).toBe("");
    setTourTransactionFilter("note-1", false);
    typeX();
    expect(firstText()).toBe("x");
    unmount();
    doc.destroy();
  });

  it("unmounting NoteEditor (deregisters) -> the switch is off", async () => {
    const doc = new Y.Doc();
    const { unmount } = renderEditor({ doc, noteId: "note-1", editable: true });
    await screen.findByTestId("note-editor");
    const editor = getTourNoteEditor("note-1")!;
    setTourTransactionFilter("note-1", true);
    expect(isTourTransactionFilterOn(editor._tiptapEditor)).toBe(true);
    unmount();
    expect(isTourTransactionFilterOn(editor._tiptapEditor)).toBe(false);
    doc.destroy();
  });
});

/** Position of the first textblock node itself (just before its content). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ProseMirror node types aren't available at value level in apps/web
function firstTextblockOffset(doc: any): number {
  let at = -1;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
  doc.descendants((node: any, pos: number) => {
    if (at !== -1) return false;
    if (node.isTextblock) {
      at = pos;
      return false;
    }
    return true;
  });
  return at;
}

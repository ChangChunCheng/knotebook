import { useState, type ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT, collabUserColor } from "@knotebook/shared";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import { hslToHex } from "@/collab/remote-states";
import type { CursorScroller } from "@/collab/cursor-scroll";
import { ThemeProvider } from "@/theme";
import { setRemote } from "@/components/presence/test-awareness";
import { NoteEditor } from "./NoteEditor";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

// The column-divider overlay is replaced by a stand-in: this only checks that NoteEditor mounts or doesn't mount it depending on editable (the overlay's own behaviour is in editor/ColumnDividers.test.tsx).
vi.mock("@/components/editor/ColumnDividers", async () => {
  const { createElement } = await import("react");
  return { ColumnDividers: () => createElement("div", { "data-testid": "column-dividers-probe" }) };
});

// #293: `NoteEditor`'s `onCursorScroller` wiring. Mounts a real `<NoteEditor>` (Host as in `NoteEditor.layout.test.tsx`).

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple; repo convention
type AnyEditor = BlockNoteEditor<any, any, any>;

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

/** As `collabEditor()` in `collab/undo.test.tsx`: first write the content into the Y.Doc with it, then hand the same doc to `<NoteEditor>`. */
function collabEditor(): { doc: Y.Doc; editor: AnyEditor } {
  const doc = new Y.Doc();
  const editor = BlockNoteEditor.create(
    withCollaboration({
      schema: noteSchema,
      collaboration: {
        provider: { awareness: undefined },
        fragment: doc.getXmlFragment(YDOC_FRAGMENT),
        user: { id: "u1", name: "User 1", color: "hsl(0 65% 45%)" },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration's option type requires the full schema triple
    } as any),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
  ) as any as AnyEditor;
  return { doc, editor };
}

async function seededDoc(): Promise<Y.Doc> {
  const { doc, editor } = collabEditor();
  const div = document.createElement("div");
  document.body.appendChild(div);
  editor.mount(div);
  editor.replaceBlocks(editor.document, [
    { type: "paragraph", content: "第一段" },
    { type: "paragraph", content: "第二段落文字" },
    { type: "paragraph", content: "第三段" },
  ] as never);
  await waitFor(() => expect(findXmlText(doc.getXmlFragment(YDOC_FRAGMENT), "第二段落文字")).not.toBeNull());
  editor.unmount();
  div.remove();
  return doc;
}

function findXmlText(node: Y.XmlFragment | Y.XmlElement, text: string): Y.XmlText | null {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) {
      if (child.toString() === text) return child;
    } else if (child instanceof Y.XmlElement) {
      const hit = findXmlText(child, text);
      if (hit) return hit;
    }
  }
  return null;
}

const rel = (text: Y.XmlText, index: number) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, index));

const provider = { awareness: null } as never;

function Host({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>{children}</ThemeProvider>
    </QueryClientProvider>
  );
}

describe("NoteEditor: onCursorScroller (#293)", () => {
  // jsdom's HTMLElement doesn't always have scrollTo; shim one first so the spy has something to cover.
  let addedScrollTo = false;
  beforeAll(() => {
    if (typeof HTMLElement.prototype.scrollTo !== "function") {
      HTMLElement.prototype.scrollTo = () => {};
      addedScrollTo = true;
    }
  });
  afterAll(() => {
    if (addedScrollTo) delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  });

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubFetch();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("after the editor is built it hands out a function once; after unmount the last handed value is null", async () => {
    const onCursorScroller = vi.fn();
    const doc = new Y.Doc();
    const { unmount } = render(
      <Host>
        <NoteEditor doc={doc} provider={provider} editable user={{ id: "u1", name: "Ann" }} noteId="note-1" onCursorScroller={onCursorScroller} />
      </Host>,
    );
    await screen.findByTestId("note-editor");
    expect(onCursorScroller).toHaveBeenCalledTimes(1);
    expect(typeof onCursorScroller.mock.calls[0]![0]).toBe("function");
    unmount();
    expect(onCursorScroller.mock.calls.at(-1)![0]).toBeNull();
    doc.destroy();
  });

  it("a real relative position: scrolls without a preview; doesn't scroll during version preview", async () => {
    const doc = await seededDoc();
    const onCursorScroller = vi.fn();
    const props = { doc, provider, editable: true, user: { id: "u1", name: "Ann" }, noteId: "note-1", onCursorScroller };
    const { rerender } = render(
      <Host>
        <NoteEditor {...props} />
      </Host>,
    );
    await screen.findByText("第二段落文字");
    const text = findXmlText(doc.getXmlFragment(YDOC_FRAGMENT), "第二段落文字");
    expect(text).not.toBeNull();
    const cursor = { anchor: rel(text!, 0), head: rel(text!, 2) };
    const scrollTo = vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(() => {});
    const scroller = onCursorScroller.mock.calls[0]![0] as CursorScroller;

    expect(scroller(cursor)).toBe(true);
    expect(scrollTo).toHaveBeenCalledTimes(1);

    rerender(
      <Host>
        <NoteEditor {...props} previewSlot={<div />} />
      </Host>,
    );
    expect(scroller(cursor)).toBe(false);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    doc.destroy();
  });

  it("onScrollRoot still receives the scroll container", async () => {
    const onScrollRoot = vi.fn();
    const doc = new Y.Doc();
    render(
      <Host>
        <NoteEditor doc={doc} provider={provider} editable user={{ id: "u1", name: "Ann" }} noteId="note-1" onScrollRoot={onScrollRoot} />
      </Host>,
    );
    const column = await screen.findByTestId("article-column");
    const el = onScrollRoot.mock.calls.find(([arg]) => arg !== null)?.[0] as HTMLElement | undefined;
    expect(el).toBeDefined();
    expect(el).toHaveClass("overflow-y-auto");
    // Outside the columns there is one more flow wrapper (it produces no box), and only outside that is the scroll container.
    expect(column.parentElement?.parentElement).toBe(el);
    doc.destroy();
  });

  it("changing only the identity of onCursorScroller doesn't hand it out again", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const doc = new Y.Doc();
    const base = { doc, provider, editable: true, user: { id: "u1", name: "Ann" }, noteId: "note-1" };
    const { rerender } = render(
      <Host>
        <NoteEditor {...base} onCursorScroller={first} />
      </Host>,
    );
    await screen.findByTestId("note-editor");
    rerender(
      <Host>
        <NoteEditor {...base} onCursorScroller={second} />
      </Host>,
    );
    expect(second).not.toHaveBeenCalled();
    expect(first).toHaveBeenCalledTimes(1);
    doc.destroy();
  });
});

// #293: a read-only viewer doesn't send a cursor from this tab. Real y-prosemirror cursor plugin + real Awareness.
// In jsdom `.ProseMirror` carries the tabIndex=0 that BlockNote gives unconditionally, so `focus()` makes `view.hasFocus()` true,
// the same path as a viewer clicking into the body in a browser.
describe("NoteEditor: read-only users don't send a cursor (#293)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubFetch();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mount(editable: boolean) {
    const doc = await seededDoc();
    const awareness = new Awareness(doc);
    const base = { doc, provider: { awareness } as never, user: { id: "u1", name: "Ann" }, noteId: "note-1" };
    const { rerender } = render(
      <Host>
        <NoteEditor {...base} editable={editable} />
      </Host>,
    );
    await screen.findByText("第二段落文字");
    const setEditable = (next: boolean) =>
      rerender(
        <Host>
          <NoteEditor {...base} editable={next} />
        </Host>,
      );
    return { doc, awareness, setEditable };
  }

  // When editable flips, BlockNoteView remounts the PM view; look it up again each time.
  function pmDom(): HTMLElement {
    const el = screen.getByTestId("note-editor").querySelector<HTMLElement>(".ProseMirror");
    if (!el) throw new Error("no .ProseMirror");
    return el;
  }

  function focusAndSelect() {
    const dom = pmDom();
    act(() => {
      dom.focus();
    });
    const tiptap = (dom as unknown as { editor: { commands: { setTextSelection(range: { from: number; to: number }): boolean } } }).editor;
    act(() => {
      tiptap.commands.setTextSelection({ from: 3, to: 5 });
    });
    expect(document.activeElement).toBe(dom);
  }

  const localCursor = (awareness: Awareness): unknown => (awareness.getLocalState() as { cursor?: unknown } | null)?.cursor ?? null;

  it("editable: after focus + selection awareness has a cursor", async () => {
    const { doc, awareness } = await mount(true);
    focusAndSelect();
    expect(localCursor(awareness)).not.toBeNull();
    awareness.destroy();
    doc.destroy();
  });

  it("read-only: the editing area is still focusable, but after focus + selection awareness has no cursor and sends no extra update; user is still written; other people's cursors are still drawn", async () => {
    const { doc, awareness } = await mount(false);
    expect(pmDom()).toHaveAttribute("contenteditable", "false");
    expect((awareness.getLocalState() as { user?: { name?: string } } | null)?.user?.name).toBe("Ann");
    let updates = 0;
    const onUpdate = () => {
      updates += 1;
    };
    awareness.on("update", onUpdate);
    focusAndSelect();
    awareness.off("update", onUpdate);
    expect(localCursor(awareness)).toBeNull();
    expect(updates).toBe(0);

    const text = findXmlText(doc.getXmlFragment(YDOC_FRAGMENT), "第二段落文字")!;
    act(() => {
      setRemote(awareness, 4242, { user: { name: "Bob", color: "#ff0000" }, cursor: { anchor: rel(text, 0), head: rel(text, 2) } });
    });
    await waitFor(() => expect(screen.getByText("Bob")).toBeInTheDocument());
    awareness.destroy();
    doc.destroy();
  });

  it("read-only -> editable: sending starts once focused afterwards", async () => {
    const { doc, awareness, setEditable } = await mount(false);
    focusAndSelect();
    expect(localCursor(awareness)).toBeNull();
    setEditable(true);
    focusAndSelect();
    expect(localCursor(awareness)).not.toBeNull();
    awareness.destroy();
    doc.destroy();
  });

  it("the column divider overlay is mounted only when editable; switching to read-only removes it, switching back mounts it again", async () => {
    const { doc, awareness, setEditable } = await mount(true);
    expect(screen.getByTestId("column-dividers-probe")).toBeInTheDocument();
    expect(screen.getByTestId("article-column")).toContainElement(screen.getByTestId("column-dividers-probe"));
    setEditable(false);
    expect(screen.queryByTestId("column-dividers-probe")).toBeNull();
    setEditable(true);
    expect(screen.getByTestId("column-dividers-probe")).toBeInTheDocument();
    awareness.destroy();
    doc.destroy();
  });

  it("editable -> read-only: an already sent cursor is cleared at once, and focusing + selecting afterwards doesn't send", async () => {
    const { doc, awareness, setEditable } = await mount(true);
    focusAndSelect();
    expect(localCursor(awareness)).not.toBeNull();
    setEditable(false);
    expect(localCursor(awareness)).toBeNull();
    focusAndSelect();
    expect(localCursor(awareness)).toBeNull();
    awareness.destroy();
    doc.destroy();
  });
});

describe("NoteEditor: remote awareness is sanitised before drawing (#312)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubFetch();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mount() {
    const doc = await seededDoc();
    const awareness = new Awareness(doc);
    render(
      <Host>
        <NoteEditor doc={doc} provider={{ awareness } as never} user={{ id: "u1", name: "Ann" }} noteId="note-1" editable />
      </Host>,
    );
    await screen.findByText("第二段落文字");
    const text = findXmlText(doc.getXmlFragment(YDOC_FRAGMENT), "第二段落文字")!;
    return { doc, awareness, text };
  }

  it("a malformed remote cursor doesn't make the editor throw", async () => {
    const { doc, awareness, text } = await mount();
    expect(() => {
      act(() => {
        setRemote(awareness, 4243, { user: { id: "u3", name: "Eve", color: "#00ff00" }, cursor: {} });
      });
    }).not.toThrow();
    act(() => {
      setRemote(awareness, 4242, { user: { id: "u2", name: "Bob", color: "#ff0000" }, cursor: { anchor: rel(text, 0), head: rel(text, 2) } });
    });
    await waitFor(() => expect(screen.getByText("Bob")).toBeInTheDocument());
    expect(screen.queryByText("Eve")).toBeNull();
    awareness.destroy();
    doc.destroy();
  });

  it("an injected color doesn't reach the cursor and selection style, the selection has a valid background", async () => {
    const { doc, awareness, text } = await mount();
    act(() => {
      setRemote(awareness, 4244, {
        user: { id: "u2", name: "Bob", color: "red; background-image: url(https://example.invalid/x)" },
        cursor: { anchor: rel(text, 0), head: rel(text, 2) },
      });
    });
    await waitFor(() => expect(screen.getByText("Bob")).toBeInTheDocument());
    const label = screen.getByText("Bob");
    const caret = label.parentElement!;
    const hex = hslToHex(collabUserColor("u2"))!;
    for (const el of [label, caret]) {
      const style = el.getAttribute("style") ?? "";
      expect(style).not.toContain("url(");
      expect(style).toContain(hex);
    }
    const selections = document.querySelectorAll(".ProseMirror-yjs-selection");
    expect(selections.length).toBeGreaterThan(0);
    for (const el of selections) {
      const style = el.getAttribute("style") ?? "";
      expect(style).not.toContain("url(");
      // A 6-digit hex followed by alpha is valid CSS; jsdom normalises it to rgba(...), and an invalid value is dropped entirely.
      expect(style).toMatch(/background-color:\s*rgba\(\d+, \d+, \d+, [\d.]+\)/);
    }
    awareness.destroy();
    doc.destroy();
  });
});

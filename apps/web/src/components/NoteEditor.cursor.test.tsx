import { useState, type ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import type { CursorScroller } from "@/collab/cursor-scroll";
import { ThemeProvider } from "@/theme";
import { NoteEditor } from "./NoteEditor";

// #293 §9.4：`NoteEditor` 的 `onCursorScroller` 接線。掛真 `<NoteEditor>`（Host 照 `NoteEditor.layout.test.tsx`）。

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，repo 慣例
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
      if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse([]));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

/** 照 `collab/undo.test.tsx` 的 `collabEditor()`：先用它把內容寫進 Y.Doc，再把同一個 doc 交給 `<NoteEditor>`。 */
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration 的選項型別要求完整的 schema 三元組
    } as any),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
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

describe("NoteEditor：onCursorScroller（#293 §9.4）", () => {
  // jsdom 的 HTMLElement 不一定有 scrollTo；缺就先墊一支，好讓 spy 有東西可蓋。
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

  it("NE1：editor 建好後交出一次函式；卸載後最後一次交出 null", async () => {
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

  it("NE2：真的 relative position——無預覽時捲動；版本預覽中不捲", async () => {
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

  it("NE3：onScrollRoot 照舊收到捲動容器", async () => {
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
    expect(column.parentElement).toBe(el);
    doc.destroy();
  });

  it("NE4：只換 onCursorScroller 的 identity 不重交", async () => {
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

/* eslint-disable @typescript-eslint/no-explicit-any -- 測試直接摸 PM 的 view／selection（型別在 apps/web 拿不到） */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { NoteEditor } from "./NoteEditor";

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/ai/actions") return Promise.resolve(new Response(JSON.stringify({ actions: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes") return Promise.resolve(new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }));
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

describe("NoteEditor 點空白處的選取處理", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  async function mountWithNodeSelection() {
    const doc = new Y.Doc();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <NoteEditor doc={doc} provider={{ awareness: null } as never} editable user={{ id: "u1", name: "Ann" }} noteId="note-1" />
        </ThemeProvider>
      </QueryClientProvider>,
    );
    const root = await screen.findByTestId("note-editor");
    const dom = root.querySelector<HTMLElement>(".bn-editor")!;
    const view = (dom as any).editor.view;
    view.posAtCoords = () => ({ pos: 2 });
    (dom as any).editor.commands.setNodeSelection(1);
    expect(view.state.selection.node, "前提：NodeSelection").toBeDefined();
    return { view, column: screen.getByTestId("article-column"), doc };
  }

  it("沒按 Shift：點文章欄空白 → 換成游標", async () => {
    const { view, column, doc } = await mountWithNodeSelection();
    fireEvent.mouseDown(column, { button: 0 });
    expect(view.state.selection.node).toBeUndefined();
    doc.destroy();
  });

  it("按著 Shift：不處理（讓 Shift＋點擊與空白處拖曳框選照常延伸選取）", async () => {
    const { view, column, doc } = await mountWithNodeSelection();
    fireEvent.mouseDown(column, { button: 0, shiftKey: true });
    expect(view.state.selection.node).toBeDefined();
    doc.destroy();
  });
});

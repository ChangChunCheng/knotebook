import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import type { AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ARTICLE_COLUMN, ARTICLE_COLUMN_PADDING, articleColumn } from "@/components/ui/article-column";
import { setNoteWidth } from "@/components/note-width";
import { ThemeProvider } from "@/theme";
import { NoteEditor } from "./NoteEditor";
import { NoteWidthToggle } from "./NoteWidthToggle";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { stubLayoutTier } from "@/test/layout-tier";

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const AI_ACTION: AiActionDto = { id: "action-1", name: "Rewrite", applyMode: "direct", kind: "quick" };

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/ai/actions" && method === "GET") {
        return Promise.resolve(
          fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ actions: [AI_ACTION] }) }),
        );
      }
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

/**
 * 卡片版面：三層 flex class 漏掉任何一個都是
 * 「畫面在 jsdom 快照/一般互動測試裡看起來完全正常，只有真的有滾動內容、真的有
 * flex 容器擠壓時才會露餡」的靜默失敗——這裡延續同一個精神，直接斷言 class 字串
 * 本身，改測 slot 化後的新節點鏈：
 *
 *   根 row（relative flex h-full min-h-0 min-w-0 flex-1 gap-3；relative＝640-1279 浮動版本面板的定位基準，守衛在 `NoteEditor.versions-floating.test.tsx`）
 *     內文卡（flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl
 *             border border-border bg-card）
 *       {headerSlot}
 *       捲動容器（min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-clip——
 *                 `overflow-x-clip`＝#162，見 `NoteEditor.tsx` :423 附近的註解：裁掉
 *                 寬表格 hover 時「新增列」按鈕超出右緣的部分，不讓它變成這層的橫向
 *                 可捲溢出）
 *         置中 wrapper（articleColumn(width) ＋ ARTICLE_COLUMN_PADDING ＋ relative flex
 *                        min-h-full flex-col py-6——標準欄寬＝捲動容器 85%，下限 680px
 *                        （改版前的固定值，中等視窗承重）、上限 1056px；#297 的寬／全寬
 *                        不會比標準窄（92.5%、上限 1408px／不設上限），下限不變。#115 起
 *                        欄寬／內距是 `ui/article-column.ts` 的常數且內文是唯一
 *                        消費端（頁首/頁尾滿卡寬）；理由見該檔。`relative`＝#160：
 *                        BlockNote 表格 hover 浮層的 containing block，收在這層
 *                        擋掉全頁滾軸，別搬去捲動容器）
 *           note-editor（BlockNoteView，className 加 flex-1：wrapper
 *             的 min-h-full 無法把百分比高度傳給孫層，必須讓 BlockNoteView 自己
 *             成為置中 wrapper 的成長項。**兩者都要斷言，缺一即假守衛**）
 *       {previewSlot}（有值時才渲染，data-testid="preview-slot"；此時捲動容器多一個 hidden）
 *       {footerSlot}
 *     VersionsPanel（panelOpen 時，經 VersionsLazyBoundary；本檔無 provider＝恆不渲染）
 *     CornerStack
 *
 * 這裡刻意掛**真正的** `<NoteEditor>`（不是 `NotePage.test.tsx`/`NoteEditorView.test.tsx`
 * 用的 mock 或只測 `NoteEditorView` 半層），驗證 `NoteEditor.tsx` 實際渲染出來的容器
 * class 與要求的逐字一致。
 */
describe("NoteEditor 佈局（slot 化：節點鏈 + 雙層 class smoke）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("根/內文卡/捲動容器/置中 wrapper/BlockNoteView 五層 class 逐一斷言；headerSlot/footerSlot 落在正確位置", async () => {
    const doc = new Y.Doc();
    const provider = { awareness: null } as never;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <NoteEditor
            doc={doc}
            provider={provider}
            editable
            user={{ id: "u1", name: "Ann" }}
            noteId="note-1"
            headerSlot={<div data-testid="header-slot-marker">header</div>}
            footerSlot={<div data-testid="footer-slot-marker">footer</div>}
          />
        </ThemeProvider>
      </QueryClientProvider>,
    );

    const editorRoot = await screen.findByTestId("note-editor");
    const centerWrapper = editorRoot.parentElement;
    // 欄外一層是 display: contents 的流程包裝（手機頁尾在捲動容器時才變成直欄），不產生盒子。
    const flow = centerWrapper?.parentElement;
    expect(flow).toHaveAttribute("data-article-flow");
    expect(flow).toHaveClass("contents");
    const scrollWrapper = flow?.parentElement;
    const contentCard = scrollWrapper?.parentElement;
    const root = contentCard?.parentElement;

    expect(centerWrapper).not.toBeNull();
    expect(scrollWrapper).not.toBeNull();
    expect(contentCard).not.toBeNull();
    expect(root).not.toBeNull();

    expect(root).toHaveClass("relative", "flex", "h-full", "min-h-0", "min-w-0", "flex-1", "gap-3");
    // #274：版本面板與其錯誤外框共用的寬度來源——列容器設 CSS 變數（預設 320）。拿掉 style 則兩者寬度失效。
    expect(root!.style.getPropertyValue("--versions-panel-width")).toBe("320px");
    expect(contentCard).toHaveClass(
      "flex",
      "min-h-0",
      "min-w-0",
      "flex-1",
      "flex-col",
      "overflow-hidden",
      "rounded-xl",
      "border",
      "border-border",
      "bg-card",
    );
    // 手機（< 640）內容卡貼齊螢幕：沒有圓角與框；640 起的 rounded-xl／border 仍在（上面）。
    expect(contentCard).toHaveClass("max-sm:rounded-none", "max-sm:border-0");
    expect(scrollWrapper).toHaveClass("min-h-0", "min-w-0", "flex-1", "overflow-y-auto", "overflow-x-clip");
    // 欄寬與內距取自 `ui/article-column.ts`（#115：內文是唯一消費端，頁首/頁尾
    // 滿卡寬）。結構守衛在 `ui/article-column.guard.test.ts`。
    // issue #160：`relative` 是置中 wrapper 必須承重的一根——BlockNote 表格 hover
    // 浮層（`bn-extend-button` 等）走 FloatingPortal + `position: absolute`，往上找
    // 不到 positioned 祖先就會以 `<html>` 當 containing block，撐出全頁滾軸。缺了
    // 拿掉 JSX 的 `relative` 只有本案會紅。
    expect(centerWrapper).toHaveClass(
      ...ARTICLE_COLUMN.split(" "),
      ARTICLE_COLUMN_PADDING,
      "relative",
      "flex",
      "min-h-full",
      "flex-col",
      "py-6",
    );
    // 雙層斷言（缺一即假守衛）：置中 wrapper 的 min-h-full/flex-col **與** BlockNoteView
    // 的 flex-1，兩者都要在——高度鏈只有兩者同時存在才成立。
    expect(editorRoot).toHaveClass("min-h-full", "flex-1");

    // headerSlot/footerSlot 落在內文卡內、分別在捲動容器的前後（不是巢狀在裡面）。
    expect(contentCard).toContainElement(screen.getByTestId("header-slot-marker"));
    expect(contentCard).toContainElement(screen.getByTestId("footer-slot-marker"));
    expect(scrollWrapper).not.toContainElement(screen.getByTestId("header-slot-marker"));
    expect(scrollWrapper).not.toContainElement(screen.getByTestId("footer-slot-marker"));

    doc.destroy();
  });

  it("previewSlot：捲動容器加 hidden、slot 渲染在同一張卡內（捲動容器之後、footer 之前），活編輯器仍在 DOM", async () => {
    const doc = new Y.Doc();
    const provider = { awareness: null } as never;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <NoteEditor
            doc={doc}
            provider={provider}
            editable
            user={{ id: "u1", name: "Ann" }}
            noteId="note-1"
            footerSlot={<div data-testid="footer-slot-marker">footer</div>}
            previewSlot={<div data-testid="preview-marker">preview</div>}
          />
        </ThemeProvider>
      </QueryClientProvider>,
    );
    const editorRoot = await screen.findByTestId("note-editor");
    const scrollWrapper = editorRoot.parentElement!.parentElement!.parentElement!;
    const contentCard = scrollWrapper.parentElement!;
    expect(scrollWrapper).toHaveClass("hidden", "overflow-y-auto");
    const slot = screen.getByTestId("preview-slot");
    expect(slot).toContainElement(screen.getByTestId("preview-marker"));
    expect(slot.parentElement).toBe(contentCard);
    const order = Array.from(contentCard.children);
    expect(order.indexOf(slot)).toBe(order.indexOf(scrollWrapper) + 1);
    expect(order.indexOf(slot)).toBeLessThan(order.indexOf(screen.getByTestId("footer-slot-marker")));
    expect(editorRoot).toBeInTheDocument();
    doc.destroy();
  });

  it("沒有 previewSlot → 捲動容器沒有 hidden、沒有 preview-slot 節點", async () => {
    const doc = new Y.Doc();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <NoteEditor doc={doc} provider={{ awareness: null } as never} editable user={{ id: "u1", name: "Ann" }} noteId="note-1" />
        </ThemeProvider>
      </QueryClientProvider>,
    );
    const editorRoot = await screen.findByTestId("note-editor");
    expect(editorRoot.parentElement!.parentElement!.parentElement).not.toHaveClass("hidden");
    expect(screen.queryByTestId("preview-slot")).not.toBeInTheDocument();
    doc.destroy();
  });

  it("活編輯器不重掛：previewSlot 進出時 BlockNoteView 根節點是同一個 DOM 元素", async () => {
    const doc = new Y.Doc();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (slot?: ReactNode) => (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <NoteEditor doc={doc} provider={{ awareness: null } as never} editable user={{ id: "u1", name: "Ann" }} noteId="note-1" previewSlot={slot} />
        </ThemeProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(tree());
    const before = await screen.findByTestId("note-editor");
    rerender(tree(<div>preview</div>));
    rerender(tree());
    expect(screen.getByTestId("note-editor")).toBe(before);
    doc.destroy();
  });
});

/** #297：內文欄跟著這篇的站內寬度（`useNoteWidth(noteId)`），換寬度不重建編輯器。 */
describe("NoteEditor 內文寬度（#297）", () => {
  const STANDARD_MAX = "max-w-[clamp(42.5rem,85%,66rem)]";

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    localStorage.clear();
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // L3／L5 會留下 note.width.note-1，不帶到後面的檔案。
    localStorage.clear();
  });

  function renderEditor(noteId: string, doc: Y.Doc, headerSlot?: ReactNode) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (id: string, d: Y.Doc) => (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <NoteEditor
            doc={d}
            provider={{ awareness: null } as never}
            editable
            user={{ id: "u1", name: "Ann" }}
            noteId={id}
            headerSlot={headerSlot}
          />
        </ThemeProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(tree(noteId, doc));
    return { rerender: (id: string, d: Y.Doc) => rerender(tree(id, d)) };
  }

  it("L1 預設：欄是標準寬", async () => {
    const doc = new Y.Doc();
    renderEditor("note-1", doc);
    await screen.findByTestId("note-editor");
    expect(screen.getByTestId("article-column")).toHaveClass(...articleColumn("standard").split(" "));
    doc.destroy();
  });

  it("L2 localStorage 已存 wide → 掛載就是寬，沒有標準的 max-w", async () => {
    localStorage.setItem("note.width.note-1", "wide");
    const doc = new Y.Doc();
    renderEditor("note-1", doc);
    await screen.findByTestId("note-editor");
    const column = screen.getByTestId("article-column");
    expect(column).toHaveClass(...articleColumn("wide").split(" "));
    expect(column).not.toHaveClass(STANDARD_MAX);
    doc.destroy();
  });

  it("L3 掛載後改成全寬 → 欄跟著變，BlockNoteEditor.create 不再被呼叫", async () => {
    const doc = new Y.Doc();
    renderEditor("note-1", doc);
    await screen.findByTestId("note-editor");
    const create = vi.spyOn(BlockNoteEditor, "create");
    try {
      act(() => setNoteWidth("note-1", "full"));
      const column = screen.getByTestId("article-column");
      expect(column).toHaveClass("max-w-none");
      expect(column).not.toHaveClass(STANDARD_MAX);
      expect(create).toHaveBeenCalledTimes(0);
    } finally {
      create.mockRestore();
    }
    doc.destroy();
  });

  it("L4 另一個分頁改了這篇（storage 事件）→ 開著的欄即時跟上", async () => {
    const doc = new Y.Doc();
    renderEditor("note-1", doc);
    await screen.findByTestId("note-editor");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "note.width.note-1", newValue: "wide" }));
    });
    expect(screen.getByTestId("article-column")).toHaveClass(...articleColumn("wide").split(" "));
    doc.destroy();
  });

  it("L5 換篇：note-2 是標準；note-1 設全寬後換回 note-1 → 全寬", async () => {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();
    const { rerender } = renderEditor("note-1", doc1);
    await screen.findByTestId("note-editor");
    rerender("note-2", doc2);
    expect(screen.getByTestId("article-column")).toHaveClass(...articleColumn("standard").split(" "));
    act(() => setNoteWidth("note-1", "full"));
    expect(screen.getByTestId("article-column")).toHaveClass(...articleColumn("standard").split(" "));
    rerender("note-1", doc1);
    expect(screen.getByTestId("article-column")).toHaveClass("max-w-none");
    doc1.destroy();
    doc2.destroy();
  });

  it("L6 頁首寬度鈕（headerSlot，與 NotePage 同組合）按一下 → 欄變寬；再按一下 → 全寬", async () => {
    const doc = new Y.Doc();
    renderEditor("note-1", doc, <NoteWidthToggle noteId="note-1" />);
    await screen.findByTestId("note-editor");
    const column = screen.getByTestId("article-column");
    fireEvent.click(screen.getByRole("button", { name: /^Width/ }));
    expect(column).toHaveClass(...articleColumn("wide").split(" "));
    expect(column).not.toHaveClass(STANDARD_MAX);
    fireEvent.click(screen.getByRole("button", { name: /^Width/ }));
    expect(screen.getByTestId("article-column")).toHaveClass("max-w-none");
    doc.destroy();
  });
});

describe("NoteEditor 手機編輯工具列", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderEditor(mobileToolbar: boolean | undefined, footerSlot?: ReactNode, fabClearance?: boolean) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <NoteEditor doc={new Y.Doc()} provider={{ awareness: null } as never} editable user={{ id: "u1", name: "Ann" }} noteId="note-1" mobileToolbar={mobileToolbar} footerSlot={footerSlot} fabClearance={fabClearance} />
        </ThemeProvider>
      </QueryClientProvider>,
    );
  }

  it("mobileToolbar：工具列在、文章欄尾端有 aria-hidden 的空白（讓文件尾端也能捲到工具列之上）", async () => {
    renderEditor(true);
    const column = (await screen.findByTestId("article-column")) as HTMLElement;
    expect(document.querySelector("[data-mobile-edit-toolbar]")).not.toBeNull();
    const spacer = column.querySelector("[data-mobile-toolbar-spacer]");
    expect(spacer).not.toBeNull();
    expect(column.lastElementChild).toBe(spacer);
  });

  it("mobileToolbar：內文卡手機下緣留 safe area（工具列頂端恰在捲動容器下緣上方 60px）；沒有工具列時不留", async () => {
    const on = renderEditor(true);
    const cardOn = (await screen.findByTestId("article-column")).closest(".overflow-hidden") as HTMLElement;
    expect(cardOn).toHaveClass("max-sm:pb-[env(safe-area-inset-bottom)]");
    on.unmount();
    renderEditor(false);
    const cardOff = (await screen.findByTestId("article-column")).closest(".overflow-hidden") as HTMLElement;
    expect(cardOff).not.toHaveClass("max-sm:pb-[env(safe-area-inset-bottom)]");
  });

  const FOOTER = <div data-testid="footer-probe">mentions</div>;
  const scrollRootOf = (column: HTMLElement) => column.closest(".overflow-y-auto") as HTMLElement;

  it("手機：欄、頁尾、工具列空白包在 min-h-full 的直欄裡（依序），欄撐滿剩下的高度；捲動容器在手機上是撐滿卡的直欄、流程包裝跟著撐", async () => {
    stubLayoutTier("phone");
    renderEditor(true, FOOTER);
    const column = (await screen.findByTestId("article-column")) as HTMLElement;
    const scrollRoot = scrollRootOf(column);
    const flow = column.parentElement as HTMLElement;
    const footer = screen.getByTestId("footer-probe");
    const spacer = document.querySelector("[data-mobile-toolbar-spacer]") as HTMLElement;
    expect(flow.parentElement).toBe(scrollRoot);
    expect(flow).toHaveClass("flex", "min-h-full", "flex-col");
    expect(flow).not.toHaveClass("contents");
    // 640 起仍是一般區塊；手機上卡至少一個視窗高，這層與流程包裝要把高度往下傳（短筆記點下方空白仍聚焦到最後）。
    expect(scrollRoot).not.toHaveClass("flex");
    expect(scrollRoot).toHaveClass("max-sm:flex", "max-sm:flex-col");
    expect(flow).toHaveClass("max-sm:grow");
    expect(column).toHaveClass("grow", "shrink-0", "relative");
    expect(column).not.toHaveClass("min-h-full");
    expect(Array.from(flow.children)).toEqual([column, footer, spacer]);
    expect(scrollRoot.children).toHaveLength(1);
    expect(column.contains(spacer)).toBe(false);
  });

  it("手機沒在編輯（沒有工具列）：頁尾仍在捲動容器的最後", async () => {
    stubLayoutTier("phone");
    renderEditor(false, FOOTER);
    const column = (await screen.findByTestId("article-column")) as HTMLElement;
    expect(column.parentElement!.lastElementChild).toBe(screen.getByTestId("footer-probe"));
  });

  it("手機：捲動容器委派表格的右緣提示（後來才出現的寬表格也標得到；非手機不標）", async () => {
    vi.stubGlobal("CSS", { supports: () => false });
    stubLayoutTier("phone");
    const view = renderEditor(false, FOOTER);
    const scrollRoot = scrollRootOf((await screen.findByTestId("article-column")) as HTMLElement);
    const table = document.createElement("div");
    table.className = "tableWrapper";
    for (const [key, value] of Object.entries({ scrollWidth: 900, clientWidth: 300, scrollLeft: 0 })) Object.defineProperty(table, key, { value, configurable: true });
    scrollRoot.appendChild(table);
    await waitFor(() => expect(table).toHaveAttribute("data-kb-more-right"));
    view.unmount();
    expect(table).not.toHaveAttribute("data-kb-more-right");
  });

  it.each(["overlay", "docked"] as const)("%s：表格不標右緣提示", async (tier) => {
    vi.stubGlobal("CSS", { supports: () => false });
    stubLayoutTier(tier);
    renderEditor(false, FOOTER);
    const scrollRoot = scrollRootOf((await screen.findByTestId("article-column")) as HTMLElement);
    const table = document.createElement("div");
    table.className = "tableWrapper";
    for (const [key, value] of Object.entries({ scrollWidth: 900, clientWidth: 300, scrollLeft: 0 })) Object.defineProperty(table, key, { value, configurable: true });
    scrollRoot.appendChild(table);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(table).not.toHaveAttribute("data-kb-more-right");
  });

  it.each(["overlay", "docked"] as const)("%s：頁尾照舊在卡底、不在捲動容器內", async (tier) => {
    stubLayoutTier(tier);
    renderEditor(false, FOOTER);
    const column = (await screen.findByTestId("article-column")) as HTMLElement;
    const footer = screen.getByTestId("footer-probe");
    expect(scrollRootOf(column).contains(footer)).toBe(false);
    expect(footer.previousElementSibling).toBe(scrollRootOf(column));
  });

  it("頁首槽位在手機給上緣 safe area（橫幅與頁首都在它之下）", async () => {
    renderEditor(false);
    await screen.findByTestId("article-column");
    expect(document.querySelector("[data-note-header-slot]")).toHaveClass("max-sm:pt-[env(safe-area-inset-top)]");
  });

  it("手機上捲的是文件：卡不裁切、至少一個視窗高（svh）；捲動容器縱向 visible；頁首槽位 sticky 釘在頂端、不透明底；640 起照舊", async () => {
    renderEditor(false, FOOTER, true);
    const column = (await screen.findByTestId("article-column")) as HTMLElement;
    const scrollRoot = scrollRootOf(column);
    const card = scrollRoot.parentElement as HTMLElement;
    const header = document.querySelector("[data-note-header-slot]") as HTMLElement;
    expect(card).toHaveClass("overflow-hidden", "max-sm:overflow-visible", "max-sm:min-h-svh");
    expect(card.className).not.toMatch(/(^|\s)max-sm:min-h-dvh(\s|$)/);
    expect(scrollRoot).toHaveClass("overflow-y-auto", "max-sm:overflow-y-visible", "overflow-x-clip");
    // 手機上高度從內容長出來（flex-basis auto），編輯器（className 也套到 BlockNote 的 portal 根節點）不靠 min-h-full。
    expect(scrollRoot).toHaveClass("max-sm:flex-auto");
    expect(screen.getByTestId("note-editor")).toHaveClass("min-h-full", "flex-1", "max-sm:min-h-0", "max-sm:flex-auto");
    expect(header).toHaveClass("max-sm:sticky", "max-sm:top-0", "max-sm:bg-card");
    expect(header.className).toMatch(/max-sm:z-\d+/);
    // 頁首的祖先（到卡為止）在手機上都不能是捲動容器，sticky 才黏得住文件。
    expect(header.parentElement).toBe(card);
  });

  it("版本預覽中：捲動容器只有 hidden，不帶手機的 flex（否則手機上預覽與活編輯器會同時出現）", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <NoteEditor doc={new Y.Doc()} provider={{ awareness: null } as never} editable user={{ id: "u1", name: "Ann" }} noteId="note-1" previewSlot={<div>preview</div>} />
        </ThemeProvider>
      </QueryClientProvider>,
    );
    const scrollRoot = scrollRootOf((await screen.findByTestId("article-column")) as HTMLElement);
    expect(scrollRoot).toHaveClass("hidden");
    expect(scrollRoot).not.toHaveClass("max-sm:flex");
  });

  it("手機：頁首槽位的高度寫進 <html> 的 --kb-sticky-top，卸載時移除；非手機不寫", async () => {
    const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return new DOMRect(0, 0, 390, this.hasAttribute("data-note-header-slot") ? 97.4 : 0);
    });
    onTestFinished(() => rect.mockRestore());
    stubLayoutTier("phone");
    const view = renderEditor(false, FOOTER);
    await screen.findByTestId("article-column");
    await waitFor(() => expect(document.documentElement.style.getPropertyValue("--kb-sticky-top")).toBe("97px"));
    view.unmount();
    expect(document.documentElement.style.getPropertyValue("--kb-sticky-top")).toBe("");
    stubLayoutTier("overlay");
    renderEditor(false, FOOTER);
    await screen.findByTestId("article-column");
    expect(document.documentElement.style.getPropertyValue("--kb-sticky-top")).toBe("");
  });

  it.each([false, true])("fabClearance：捲動內容最後有 aria-hidden 的空白（5rem＋safe area，浮動鈕之上）；欄撐滿高度（頁尾有無 %s 都一樣）", async (withFooter) => {
    stubLayoutTier("phone");
    renderEditor(false, withFooter ? FOOTER : undefined, true);
    const column = (await screen.findByTestId("article-column")) as HTMLElement;
    const flow = column.parentElement as HTMLElement;
    const clearance = document.querySelector("[data-fab-clearance]") as HTMLElement;
    expect(clearance).toHaveAttribute("aria-hidden", "true");
    expect(clearance).toHaveClass("h-[calc(5rem+env(safe-area-inset-bottom))]");
    expect(flow.lastElementChild).toBe(clearance);
    expect(flow).toHaveClass("flex", "min-h-full", "flex-col");
    expect(column).toHaveClass("grow", "shrink-0");
  });

  it("沒有 fabClearance：沒有這段空白", async () => {
    stubLayoutTier("phone");
    renderEditor(false, FOOTER);
    await screen.findByTestId("article-column");
    expect(document.querySelector("[data-fab-clearance]")).toBeNull();
  });

  it.each([false, undefined])("mobileToolbar=%s（桌機、或手機沒在編輯）：沒有工具列也沒有空白", async (flag) => {
    renderEditor(flag);
    await screen.findByTestId("article-column");
    expect(document.querySelector("[data-mobile-edit-toolbar]")).toBeNull();
    expect(document.querySelector("[data-mobile-toolbar-spacer]")).toBeNull();
  });
});

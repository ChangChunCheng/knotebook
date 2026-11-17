import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BlockNoteEditor, SuggestionMenu } from "@blocknote/core";
import { FilePanelExtension, SideMenuExtension } from "@blocknote/core/extensions";
import type { DefaultReactSuggestionItem } from "@blocknote/react";
import type { AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import { SelectionAiController } from "@/components/ai/SelectionAiController";
import { stubLayoutTier } from "@/test/layout-tier";
import { createTestEditor, renderAiHost, selectInBlock, stubAiFetch } from "@/test/ai-host";
import { installLiveStopInput } from "@/components/tour/live-stops";
import { NoteEditorView } from "./NoteEditor";

// 表情資料是 JSON 模組，node 端直接 import 會失敗；`:` 選單的測試只看外層定位，所以換掉預設的資料來源（定位選項照實傳進去）。
vi.mock("@blocknote/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@blocknote/react")>();
  const Original = actual.GridSuggestionMenuController as (props: Record<string, unknown>) => ReactNode;
  return {
    ...actual,
    GridSuggestionMenuController: (props: Record<string, unknown>) =>
      Original({ ...props, getItems: async () => [{ id: "x", onItemClick: () => {} }] }),
  };
});

/**
 * 曾以 mutation 實測（拿掉 `filePanel={false}`、
 * 或把 `useMemo` 換成每 render 新建）能讓 268 個既有測試全綠通過——`NoteEditorView`
 * 這段 JSX 接線在此之前完全零覆蓋。這個檔案直接掛真的 `<BlockNoteView>`
 * （`@blocknote/mantine`，自帶 `MantineProvider`）鎖住兩條核心契約：
 *
 * 1. `filePanel={false}` 真的關掉了 BlockNote 內建的 `FilePanelController`
 *    （否則使用者點開檔案類 block 會同時看到兩份面板疊在一起）。
 * 2. `useMemo(() => createFilePanel(noteId), [noteId])` 真的釘住了 `filePanel` 的
 *    元件身分——`noteId` 沒變時，`NoteEditorView` 因任何原因重新 render，
 *    `FilePanelController` 不會把它當成「換了一個元件」卸載重掛（否則使用者在
 *    Embed URL 輸入到一半就會被清空）。
 *
 * jsdom 缺 `ResizeObserver`／`window.matchMedia`（mantine 的 `MantineProvider`／
 * `@blocknote/react` 的 `usePrefersColorScheme` 會摸到）——兩個一行 stub 已經補進
 * `test/setup.ts`，這裡不用再另外處理。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any（同 NoteEditor.tsx/NoteEditor.test.ts）
function mountedEditor(): { editor: BlockNoteEditor<any, any, any>; container: HTMLElement } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  const editor = BlockNoteEditor.create({ schema: noteSchema }) as BlockNoteEditor<any, any, any>;
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor.mount(container);
  return { editor, container };
}

/** 插入一個 image block（有 Upload+Embed 兩個 tab，`FilePanel.tsx` 的分頁列在這個型別才會渲染），回傳它的 id。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
function insertImageBlock(editor: BlockNoteEditor<any, any, any>): string {
  const first = editor.document[0]!;
  return editor.insertBlocks([{ type: "image" } as never], first, "after")[0]!.id;
}

// SuggestionMenuController 用得到，但這個檔案不測 `[[` 觸發，回空陣列就好。
async function getItems(): Promise<DefaultReactSuggestionItem[]> {
  return [];
}

/** 自家 FilePanel 讀 `useAuthConfig()`，需要 QueryClientProvider；config 回不帶 `maxUploadBytes` 的設定（不前驗）。 */
function QueryWrapper({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("NoteEditorView（filePanel={false} + useMemo 接線）", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  let editor: BlockNoteEditor<any, any, any>;
  let container: HTMLElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    ({ editor, container } = mountedEditor());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) } as unknown as Response),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    editor.unmount();
    container.remove();
  });

  it("filePanel={false} 關掉內建面板：開啟 FilePanel 時畫面上只有 1 個 tablist（我們自家那個，不是內建又多一個）", () => {
    const blockId = insertImageBlock(editor);
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />, { wrapper: QueryWrapper });

    act(() => {
      editor.getExtension(FilePanelExtension)!.showMenu(blockId);
    });

    expect(screen.getAllByRole("tablist")).toHaveLength(1);
  });

  it("useMemo 護欄：noteId 不變、元件因故重 render，Embed 輸入到一半的值不會被清掉", () => {
    const blockId = insertImageBlock(editor);
    const { rerender } = render(
      <NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />,
      { wrapper: QueryWrapper },
    );

    act(() => {
      editor.getExtension(FilePanelExtension)!.showMenu(blockId);
    });

    fireEvent.click(screen.getByRole("tab", { name: "Embed link" }));
    const input = screen.getByPlaceholderText("Paste a link…");
    fireEvent.change(input, { target: { value: "https://example.com/half-typed" } });
    expect(input).toHaveValue("https://example.com/half-typed");

    // 同一個 noteId、只是父層重新 render（例如 editable/theme 這類跟 filePanel 無關的
    // prop 變動、或單純父元件重繪）——`filePanel` 的元件身分如果沒被 `useMemo` 釘住，
    // `FilePanelController` 會把它當一個新元件掛，底下的 Embed 輸入狀態會被砍掉重練。
    rerender(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);

    expect(screen.getByPlaceholderText("Paste a link…")).toHaveValue("https://example.com/half-typed");
  });
});

// ── issue #94：`slashMenu={false}` + 自家 `/` controller 接線 ────────────────────
//
// 比照本檔開頭記載的前例：實測把 `slashMenu={false}` 拿掉、或把整條
// `<SuggestionMenuController triggerCharacter="/">` 刪掉，693 條測試全綠——這段接線在
// 此之前零覆蓋。`NoteEditor.tsx` 的註解寫著「不明確設 false 會同時掛兩個 `/` 選單
// controller，按 `/` 會看到兩份選單疊在一起」，這裡就是釘住那句話的地方。

describe("NoteEditorView（issue #94：/ 選單接管）", () => {
  /** `[[` 選單的來源，用來確認它也套手機的 floating 選項。 */
  async function getWikilinkItems(): Promise<DefaultReactSuggestionItem[]> {
    return [{ title: "Linked note", onItemClick: () => {} }] as DefaultReactSuggestionItem[];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  let editor: BlockNoteEditor<any, any, any>;
  let container: HTMLElement;

  /** 只有一個項目的 `/` 選單來源，用來確認掛上去的是**我們的** controller。 */
  async function getSlashItems(): Promise<DefaultReactSuggestionItem[]> {
    return [{ title: "Diagram", onItemClick: () => {}, group: "Advanced" }] as DefaultReactSuggestionItem[];
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    ({ editor, container } = mountedEditor());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    editor.unmount();
    container.remove();
  });

  it("slashMenu={false}：按 / 時畫面上只有一份選單（沒有跟內建的疊在一起）", () => {
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getSlashItems} />);

    act(() => {
      editor.getExtension(SuggestionMenu)!.openSuggestionMenu("/");
    });

    expect(document.querySelectorAll(".bn-suggestion-menu")).toHaveLength(1);
  });

  it("那一份選單是我們自己的（getSlashItems 的項目真的渲染出來）", async () => {
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getSlashItems} />);

    act(() => {
      editor.getExtension(SuggestionMenu)!.openSuggestionMenu("/");
    });

    expect(await screen.findByText("Diagram")).toBeInTheDocument();
  });

  /** 選單外層（floating-ui 定位的那一層）的最大高度；等 size middleware 套用後才有值。 */
  async function floatingMaxHeight(itemText = "Diagram"): Promise<string> {
    await screen.findByText(itemText);
    const floating = document.querySelector(".bn-suggestion-menu")!.closest<HTMLElement>("[style*='z-index']")!;
    await waitFor(() => expect(floating.style.maxHeight).not.toBe(""));
    return floating.style.maxHeight;
  }

  it("手機：選單最大高度是 min(50vh, 可用高度)", async () => {
    stubLayoutTier("phone");
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getSlashItems} />);
    act(() => {
      editor.getExtension(SuggestionMenu)!.openSuggestionMenu("/");
    });
    expect(await floatingMaxHeight()).toMatch(/^min\(50vh, /);
  });

  it("手機：[[ 選單同樣套 min(50vh, 可用高度)", async () => {
    stubLayoutTier("phone");
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getWikilinkItems} getSlashItems={getSlashItems} />);
    act(() => {
      editor.getExtension(SuggestionMenu)!.openSuggestionMenu("[[");
    });
    expect(await floatingMaxHeight("Linked note")).toMatch(/^min\(50vh, /);
  });

  /** `:` 表情選單：要輸入兩個字才會出現（minQueryLength 2），格子內容是 emoji 不是文字，所以改看外層元素。 */
  async function emojiFloatingMaxHeight(): Promise<string> {
    editor.focus();
    editor.setTextCursorPosition(editor.document[0]!, "end");
    act(() => {
      editor.getExtension(SuggestionMenu)!.openSuggestionMenu(":");
    });
    act(() => {
      editor.insertInlineContent(["sm"]);
    });
    const grid = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".bn-grid-suggestion-menu");
      expect(el).not.toBeNull();
      return el!;
    });
    const floating = grid.closest<HTMLElement>("[style*='z-index']")!;
    await waitFor(() => expect(floating.style.maxHeight).not.toBe(""));
    return floating.style.maxHeight;
  }

  it("手機：: 表情選單同樣套 min(50vh, 可用高度)", async () => {
    stubLayoutTier("phone");
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getSlashItems} />);
    expect(await emojiFloatingMaxHeight()).toMatch(/^min\(50vh, /);
  });

  it("寬度 >= 640：: 表情選單最大高度維持預設（不套 50vh）", async () => {
    stubLayoutTier("docked");
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getSlashItems} />);
    expect(await emojiFloatingMaxHeight()).not.toContain("50vh");
  });

  it("寬度 >= 640：[[ 選單最大高度維持預設（不套 50vh）", async () => {
    stubLayoutTier("docked");
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getWikilinkItems} getSlashItems={getSlashItems} />);
    act(() => {
      editor.getExtension(SuggestionMenu)!.openSuggestionMenu("[[");
    });
    expect(await floatingMaxHeight("Linked note")).not.toContain("50vh");
  });

  it("寬度 >= 640：選單最大高度維持預設（不套 50vh）", async () => {
    stubLayoutTier("docked");
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getSlashItems} />);
    act(() => {
      editor.getExtension(SuggestionMenu)!.openSuggestionMenu("/");
    });
    expect(await floatingMaxHeight()).not.toContain("50vh");
  });
});

// ── 功能導覽要指到真的 `[[` 選單：外面那層 popover 帶導覽的目標屬性 ──────────────────────────────

describe("NoteEditorView（`[[` 選單帶導覽目標屬性）", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  let editor: BlockNoteEditor<any, any, any>;
  let container: HTMLElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    ({ editor, container } = mountedEditor());
  });

  afterEach(() => {
    editor.unmount();
    container.remove();
  });

  async function getWikilinkItems(): Promise<DefaultReactSuggestionItem[]> {
    return [{ title: "Some note", onItemClick: () => {} }] as DefaultReactSuggestionItem[];
  }

  it("`[[` 選單的 popover 帶 data-kb-tour-target=wikilinkMenu、`/` 選單的帶 slashMenu，預設的 z-index 還在；兩邊不互帶", async () => {
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getWikilinkItems} getSlashItems={getItems} />);

    act(() => {
      editor.getExtension(SuggestionMenu)!.openSuggestionMenu("[[");
    });
    expect(await screen.findByText("Some note")).toBeInTheDocument();
    const popover = document.querySelector<HTMLElement>('[data-kb-tour-target="wikilinkMenu"]')!;
    expect(popover).not.toBeNull();
    expect(document.querySelector('[data-kb-tour-target="slashMenu"]')).toBeNull();
    expect(popover).toContainElement(document.querySelector(".bn-suggestion-menu"));
    expect(popover.style.zIndex).toContain("80");

    act(() => {
      editor.getExtension(SuggestionMenu)!.closeMenu();
    });
    await waitFor(() => expect(document.querySelector(".bn-suggestion-menu")).toBeNull());
    act(() => {
      editor.getExtension(SuggestionMenu)!.openSuggestionMenu("/");
    });
    await waitFor(() => expect(document.querySelector(".bn-suggestion-menu")).not.toBeNull());
    const slashPopover = document.querySelector<HTMLElement>('[data-kb-tour-target="slashMenu"]')!;
    expect(slashPopover).not.toBeNull();
    expect(slashPopover).toContainElement(document.querySelector(".bn-suggestion-menu"));
    expect(slashPopover.style.zIndex).toContain("80");
    expect(document.querySelector('[data-kb-tour-target="wikilinkMenu"]')).toBeNull();
  });
});

describe("NoteEditorView（演示站的鍵盤攔截擋在真的 `[[` 選單前面）", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  let editor: BlockNoteEditor<any, any, any>;
  let container: HTMLElement;
  let uninstall: (() => void) | null = null;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    ({ editor, container } = mountedEditor());
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    editor.unmount();
    container.remove();
  });

  /** 開好 `[[` 選單，回傳「選了項目」的 spy 與一個往編輯器送按鍵的函式。 */
  async function openMenu(withInput: boolean) {
    const onItemClick = vi.fn();
    const items = async () => [{ title: "Some note", onItemClick }] as DefaultReactSuggestionItem[];
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={items} getSlashItems={getItems} />);
    act(() => {
      editor.getExtension(SuggestionMenu)!.openSuggestionMenu("[[", { deleteTriggerCharacter: false });
    });
    expect(await screen.findByText("Some note")).toBeInTheDocument();
    if (withInput) uninstall = installLiveStopInput({ next: () => {}, back: () => {} });
    const press = (init: KeyboardEventInit) => {
      act(() => {
        editor.domElement!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
      });
    };
    return { onItemClick, press };
  }

  it("沒有攔截時 Ctrl+Enter 會選中選單項目（確認這案量得到差別）", async () => {
    const { onItemClick, press } = await openMenu(false);
    press({ key: "Enter", ctrlKey: true });
    expect(onItemClick).toHaveBeenCalledTimes(1);
  });

  it("攔截開著：Enter、Ctrl／Alt／Meta＋Enter 都不選中項目，選單仍開著；Ctrl+A 不關選單", async () => {
    const { onItemClick, press } = await openMenu(true);
    for (const init of [{ key: "Enter" }, { key: "Enter", ctrlKey: true }, { key: "Enter", altKey: true }, { key: "Enter", metaKey: true }, { key: "a", ctrlKey: true }]) {
      press(init);
    }
    expect(onItemClick).not.toHaveBeenCalled();
    expect(editor.getExtension(SuggestionMenu)!.shown()).toBe(true);
  });
});

// ── #263：formatting toolbar 由 children 裡的 SelectionAiController 擁有──────────────
//
// NoteEditorView 自己只設 `formattingToolbar={false}`、不再掛 FormattingToolbarController；工具列壓制與 AI 項的行為測試在
// `components/ai/SelectionAiController.test.tsx`。這裡只釘接線：沒有 children 就沒有工具列；children 是 controller 時才有。
const AI_ACTION: AiActionDto = { id: "action-1", name: "Summarize", applyMode: "preview", kind: "quick" };
const ONE_PARAGRAPH = [{ id: "p1", type: "paragraph", content: "hello world" }];
const TWO_PARAGRAPHS = [...ONE_PARAGRAPH, { id: "p2", type: "paragraph", content: "second line" }];

describe("NoteEditorView（#263：children 透傳；工具列由 SelectionAiController 擁有）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("沒有 children：非空選取也不出現 formatting toolbar；children 換成 SelectionAiController 後出現（預設按鈕＋AI 鈕）", async () => {
    const editor = createTestEditor(ONE_PARAGRAPH);
    stubAiFetch({ actions: [AI_ACTION] });
    const host = renderAiHost({ editor });
    await waitFor(() => expect(host.queryClient.getQueryState(["ai-actions"])?.status).toBe("success"));
    selectInBlock(editor, "p1", 0, 5);
    await act(async () => {});
    expect(document.querySelector(".bn-formatting-toolbar")).toBeNull();

    host.rerenderHost({ children: <SelectionAiController /> });
    expect(await screen.findByRole("button", { name: "Bold" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "AI" })).toBeInTheDocument();
  });

  it("viewer（editable:false）→ AI 項不渲染", async () => {
    const editor = createTestEditor(ONE_PARAGRAPH);
    stubAiFetch({ actions: [AI_ACTION] });
    const host = renderAiHost({ editor, editable: false, children: <SelectionAiController /> });
    await waitFor(() => expect(host.queryClient.getQueryState(["ai-actions"])?.status).toBe("success"));
    selectInBlock(editor, "p1", 0, 5);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "AI" })).not.toBeInTheDocument();
  });

  it("actions 為空陣列（editable:true）→ 預設按鈕照常、AI 項不渲染", async () => {
    const editor = createTestEditor(ONE_PARAGRAPH);
    stubAiFetch({ actions: [] });
    const host = renderAiHost({ editor, children: <SelectionAiController /> });
    await waitFor(() => expect(host.queryClient.getQueryState(["ai-actions"])?.status).toBe("success"));
    selectInBlock(editor, "p1", 0, 5);
    expect(await screen.findByRole("button", { name: "Bold" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "AI" })).not.toBeInTheDocument();
  });
});

describe("NoteEditorView（區塊把手：手機不掛側選單）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(document, "elementsFromPoint");
  });

  async function hoverFirstParagraph() {
    const editor = createTestEditor(ONE_PARAGRAPH);
    stubAiFetch({ actions: [] });
    renderAiHost({ editor });
    const paragraph = await screen.findByText("hello world");
    Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [paragraph] });
    act(() => {
      fireEvent.mouseMove(paragraph, { clientX: 0, clientY: 0 });
    });
    await act(async () => {});
  }

  it("docked：滑過區塊出現拖曳把手", async () => {
    stubLayoutTier("docked");
    await hoverFirstParagraph();
    expect(await screen.findByLabelText("Open block menu")).toBeInTheDocument();
  });

  it("phone：滑過區塊也沒有拖曳把手", async () => {
    stubLayoutTier("phone");
    await hoverFirstParagraph();
    expect(screen.queryByLabelText("Open block menu")).not.toBeInTheDocument();
    expect(document.querySelector("[data-kb-side-menu-popover]")).toBeNull();
  });
});

describe("NoteEditorView（區塊選單開著時變窄到手機寬度）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(document, "elementsFromPoint");
  });

  it("側選單凍結中切到 phone：解凍、不丟例外；切回 docked 後滑到別的區塊，把手跟過去", async () => {
    const tier = stubLayoutTier("docked");
    const editor = createTestEditor(TWO_PARAGRAPHS);
    stubAiFetch({ actions: [] });
    renderAiHost({ editor });
    const first = await screen.findByText("hello world");
    const second = await screen.findByText("second line");
    let hovered: HTMLElement = first;
    Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [hovered] });
    act(() => {
      fireEvent.mouseMove(first, { clientX: 0, clientY: 0 });
    });
    fireEvent.click(await screen.findByLabelText("Open block menu"));
    const sideMenu = editor.getExtension(SideMenuExtension)!;
    await waitFor(() => expect(sideMenu.store.state?.show).toBe(true));
    act(() => tier.setLayoutTier("phone"));
    await waitFor(() => expect(sideMenu.store.state?.show).toBe(false));
    expect(screen.queryByLabelText("Open block menu")).not.toBeInTheDocument();
    act(() => tier.setLayoutTier("docked"));
    hovered = second;
    act(() => {
      fireEvent.mouseMove(second, { clientX: 0, clientY: 20 });
    });
    await waitFor(() => expect(sideMenu.store.state?.block.id).toBe("p2"));
    expect(sideMenu.store.state?.show).toBe(true);
  });
});

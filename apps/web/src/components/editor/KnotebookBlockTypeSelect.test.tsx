import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import i18n from "@/i18n";
import { createTestEditor, renderAiHost, selectInBlock, selectWholeBlocks, stubAiFetch, type AnyEditor } from "@/test/ai-host";
import { IMG, P } from "@/test/columns-fixtures";
import { SelectionAiController } from "@/components/ai/SelectionAiController";

// 桌機格式工具列的區塊類型選單：多區塊選取時只改本身是項目類型的區塊（#464）。掛法照 `ai/AiToolbar.test.tsx`。

const TABLE = { id: "t", type: "table", content: { type: "tableContent", rows: [{ cells: ["x", "y"] }, { cells: ["z", "w"] }] } } as never;

const toolbar = () => document.querySelector(".bn-formatting-toolbar");
// 區塊類型選單的觸發鈕：下拉按鈕裡唯一沒有 aria-label 的（顏色鈕等下拉都有）。
const SELECT_TRIGGER = ".bn-formatting-toolbar button[aria-haspopup]:not([aria-label])";
const selectTrigger = () => document.querySelector<HTMLElement>(SELECT_TRIGGER);

function mount(doc: unknown[]): AnyEditor {
  const editor = createTestEditor(doc);
  stubAiFetch({ actions: [] });
  renderAiHost({ editor, children: <SelectionAiController /> });
  return editor;
}

async function chooseItem(name: string) {
  await waitFor(() => expect(selectTrigger()).not.toBeNull());
  fireEvent.click(selectTrigger()!);
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}

describe("KnotebookBlockTypeSelect", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("多區塊選取（段落＋表格）：套用 Heading 1 → 段落變標題、表格內容不變", async () => {
    const editor = mount([P("alice", "a"), TABLE, P("bob", "b")]);
    const tableBefore = JSON.stringify(editor.getBlock("t")!.content);
    act(() => selectWholeBlocks(editor, "a", "b"));
    await chooseItem("Heading 1");
    await waitFor(() => expect(editor.getBlock("a")!.type).toBe("heading"));
    expect((editor.getBlock("a")!.props as { level: number }).level).toBe(1);
    expect(editor.getBlock("b")!.type).toBe("heading");
    expect(editor.getBlock("t")!.type).toBe("table");
    expect(JSON.stringify(editor.getBlock("t")!.content)).toBe(tableBefore);
  });

  // 選取跨過程式碼區塊時 BlockNote 整條格式工具列都不出現，所以這條路徑碰不到；同類「不能換類型」的區塊改用圖片守。
  it("多區塊選取（段落＋圖片）：圖片不變", async () => {
    const editor = mount([P("alice", "a"), IMG("img"), P("bob", "b")]);
    const imageBefore = JSON.stringify(editor.getBlock("img")!.props);
    act(() => selectWholeBlocks(editor, "a", "b"));
    await chooseItem("Heading 1");
    await waitFor(() => expect(editor.getBlock("a")!.type).toBe("heading"));
    expect(editor.getBlock("b")!.type).toBe("heading");
    expect(editor.getBlock("img")!.type).toBe("image");
    expect(JSON.stringify(editor.getBlock("img")!.props)).toBe(imageBefore);
  });

  it("選取開頭是表格：選單不出現，工具列其餘按鈕仍在", async () => {
    const editor = mount([TABLE, P("alice", "a")]);
    act(() => selectWholeBlocks(editor, "a", "a"));
    await waitFor(() => expect(toolbar()).not.toBeNull());
    const withParagraphButtons = toolbar()!.querySelectorAll("button").length;
    expect(selectTrigger()).not.toBeNull();
    act(() => editor.setSelection("t", "a"));
    expect(editor.getSelection()!.blocks[0]!.type).toBe("table");
    await waitFor(() => expect(selectTrigger()).toBeNull());
    expect(toolbar()!.querySelectorAll("button").length).toBeGreaterThan(0);
    expect(withParagraphButtons).toBeGreaterThan(0);
  });

  it("單一段落：選單出現，換成 Heading 2 生效、相鄰段落不變", async () => {
    const editor = mount([P("alice", "a"), P("bob", "b")]);
    act(() => selectInBlock(editor, "a", 0, 3));
    await chooseItem("Heading 2");
    await waitFor(() => expect(editor.getBlock("a")!.type).toBe("heading"));
    expect((editor.getBlock("a")!.props as { level: number }).level).toBe(2);
    expect(editor.getBlock("b")!.type).toBe("paragraph");
  });

  it("單一段落：選單的目前項目是 Paragraph", async () => {
    const editor = mount([P("alice", "a")]);
    act(() => selectInBlock(editor, "a", 0, 3));
    await waitFor(() => expect(selectTrigger()).not.toBeNull());
    expect(selectTrigger()!.textContent).toContain("Paragraph");
  });

  it("唯讀編輯器：選單不出現", async () => {
    const editor = mount([P("alice", "a")]);
    act(() => selectInBlock(editor, "a", 0, 3));
    await waitFor(() => expect(selectTrigger()).not.toBeNull());
    act(() => {
      editor.isEditable = false;
    });
    await waitFor(() => expect(selectTrigger()).toBeNull());
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { REWRITE_ACTION_ID, SUMMARIZE_ACTION_ID, type AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { contentStart, createTestEditor, renderAiHost, selectInBlock, stubAiFetch, type AnyEditor } from "@/test/ai-host";
import { createRequire } from "node:module";
import { useAiSession, type AiSessionValue } from "./AiSession";
import { SelectionAiController } from "./SelectionAiController";
import { stubLayoutTier } from "@/test/layout-tier";

const REWRITE: AiActionDto = { id: REWRITE_ACTION_ID, name: "Rewrite", applyMode: "direct", kind: "quick" };
const SUMMARIZE: AiActionDto = { id: SUMMARIZE_ACTION_ID, name: "Summarize", applyMode: "preview", kind: "quick" };

const DOC = [
  { id: "p1", type: "paragraph", content: "alpha beta gamma" },
  { id: "p2", type: "paragraph", content: "second paragraph" },
  { id: "p3", type: "paragraph", content: "third paragraph here" },
  { id: "img", type: "image", props: { url: "https://example.com/a.png" } },
];

// prosemirror-tables 不是 app 的直接依賴：從 @blocknote/core 的位置解析，拿到它實際用的那份 CellSelection。
const coreRequire = createRequire(createRequire(import.meta.url).resolve("@blocknote/core"));
const { CellSelection } = coreRequire("prosemirror-tables") as { CellSelection: { create(doc: unknown, anchor: number, head: number): never } };

let session!: AiSessionValue;
function Probe() {
  session = useAiSession();
  return null;
}

let editor: AnyEditor;
const toolbar = () => document.querySelector(".bn-formatting-toolbar");

async function mount(doc: unknown[] = DOC) {
  editor = createTestEditor(doc);
  const ai = stubAiFetch({ actions: [REWRITE, SUMMARIZE] });
  renderAiHost({
    editor,
    children: (
      <>
        <SelectionAiController />
        <Probe />
      </>
    ),
  });
  await waitFor(() => expect(session.actions).toHaveLength(2));
  return ai;
}

describe("SelectionAiController（#263：工具列壓制與 AI 鈕）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("按 AI 鈕開框；框開著且選取在 target 內 → 內建工具列收起；關框後恢復", async () => {
    await mount();
    selectInBlock(editor, "p1", 0, 5);
    fireEvent.click(await screen.findByRole("button", { name: "AI" }));
    expect(session.state.phase).toBe("input");
    await waitFor(() => expect(toolbar()).toBeNull());
    act(() => session.close());
    await waitFor(() => expect(toolbar()).not.toBeNull());
  });

  it("串流中在 target 外做非空選取 → 工具列出現、框不關、AI 鈕停用", async () => {
    const ai = await mount();
    selectInBlock(editor, "p1", 0, 5);
    fireEvent.click(await screen.findByRole("button", { name: "AI" }));
    act(() => {
      session.start(SUMMARIZE.id);
    });
    selectInBlock(editor, "p3", 0, 5);
    await waitFor(() => expect(toolbar()).not.toBeNull());
    expect(session.state.phase).toBe("streaming");
    expect(screen.getByRole("button", { name: "AI" })).toBeDisabled();
    expect(ai.calls).toHaveLength(1);
  });

  it("Ctrl+A 全選後開框 → 工具列收起（全選算在 target 內）", async () => {
    await mount();
    act(() => {
      editor._tiptapEditor.commands.selectAll();
    });
    fireEvent.click(await screen.findByRole("button", { name: "AI" }));
    expect(session.state.phase).toBe("input");
    await waitFor(() => expect(toolbar()).toBeNull());
  });

  it("NodeSelection（選到圖片）→ 工具列照上游出現，但沒有 AI 項", async () => {
    await mount();
    act(() => {
      editor._tiptapEditor.commands.setNodeSelection(contentStart(editor, "img") - 1);
    });
    await waitFor(() => expect(toolbar()).not.toBeNull());
    expect(screen.queryByRole("button", { name: "AI" })).not.toBeInTheDocument();
  });

  it("AI 項是一顆 icon 鈕：沒有下拉、沒有 aria-expanded", async () => {
    await mount();
    selectInBlock(editor, "p1", 0, 5);
    const button = await screen.findByRole("button", { name: "AI" });
    const toolbarRoot = button.closest<HTMLElement>(".bn-formatting-toolbar")!;
    expect(button).not.toHaveAttribute("aria-expanded");
    expect(button.querySelector('svg[data-icon="sparkles"]')).not.toBeNull();
    fireEvent.click(button);
    // 舊版的下拉清單畫在工具列根元素裡；新版按下只開框（框裡才有動作 chip）。
    expect(within(toolbarRoot).queryByRole("button", { name: REWRITE.name })).not.toBeInTheDocument();
  });
});

describe("SelectionAiController（手機：一律掛 controller，選文字時壓住工具列）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("phone：非空選取也沒有 formatting toolbar，AI session 仍可開", async () => {
    stubLayoutTier("phone");
    await mount();
    selectInBlock(editor, "p1", 0, 5);
    await act(async () => {});
    expect(toolbar()).toBeNull();
    expect(screen.queryByRole("button", { name: "Bold" })).not.toBeInTheDocument();
    act(() => session.open());
    await waitFor(() => expect(session.state.phase).toBe("input"));
    expect(await screen.findByTestId("selection-ai-box")).toBeInTheDocument();
  });

  it("phone：選到圖片區塊 → 工具列照舊出現（含刪除鈕）；改選文字 → 收起；再選圖片 → 又出現，只有一份", async () => {
    stubLayoutTier("phone");
    await mount();
    act(() => {
      editor._tiptapEditor.commands.setNodeSelection(contentStart(editor, "img") - 1);
    });
    await waitFor(() => expect(toolbar()).not.toBeNull());
    expect(toolbar()!.querySelector('[aria-label*="elete"]')).not.toBeNull();
    selectInBlock(editor, "p1", 0, 5);
    await waitFor(() => expect(toolbar()).toBeNull());
    act(() => {
      editor._tiptapEditor.commands.setNodeSelection(contentStart(editor, "img") - 1);
    });
    await waitFor(() => expect(toolbar()).not.toBeNull());
    expect(document.querySelectorAll(".bn-formatting-toolbar")).toHaveLength(1);
  });

  it("phone：選到跨儲存格（CellSelection）→ 工具列出現；游標在儲存格內選文字 → 沒有", async () => {
    stubLayoutTier("phone");
    await mount([
      { id: "t1", type: "table", content: { type: "tableContent", rows: [{ cells: ["cell a", "cell b"] }, { cells: ["cell c", "cell d"] }] } },
      { id: "p9", type: "paragraph", content: "after" },
    ]);
    const cellPositions: number[] = [];
    editor.transact((tr) => {
      tr.doc.descendants((node, pos) => {
        if (node.type.name === "tableCell" || node.type.name === "tableHeader") cellPositions.push(pos);
      });
    });
    expect(cellPositions.length).toBeGreaterThanOrEqual(2);
    act(() => {
      editor.transact((tr) => {
        tr.setSelection(CellSelection.create(tr.doc, cellPositions[0]!, cellPositions[1]!));
      });
    });
    await waitFor(() => expect(toolbar()).not.toBeNull());
    act(() => {
      editor._tiptapEditor.commands.setTextSelection({ from: cellPositions[0]! + 3, to: cellPositions[0]! + 6 });
    });
    await waitFor(() => expect(toolbar()).toBeNull());
  });

  it("docked → phone → docked：工具列消失再恢復，最後只有一份", async () => {
    const tier = stubLayoutTier("docked");
    await mount();
    selectInBlock(editor, "p1", 0, 5);
    expect(await screen.findByRole("button", { name: "Bold" })).toBeInTheDocument();
    act(() => tier.setLayoutTier("phone"));
    await waitFor(() => expect(toolbar()).toBeNull());
    act(() => tier.setLayoutTier("docked"));
    await waitFor(() => expect(document.querySelectorAll(".bn-formatting-toolbar")).toHaveLength(1));
    expect(screen.getAllByRole("button", { name: "Bold" })).toHaveLength(1);
  });

  it("docked：同樣的選取出現 formatting toolbar", async () => {
    stubLayoutTier("docked");
    await mount();
    selectInBlock(editor, "p1", 0, 5);
    expect(await screen.findByRole("button", { name: "Bold" })).toBeInTheDocument();
    expect(toolbar()).not.toBeNull();
  });
});

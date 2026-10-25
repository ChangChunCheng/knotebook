import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import { ShowSelectionExtension } from "@blocknote/core/extensions";
import { INSTRUCT_ACTION_ID, REWRITE_ACTION_ID, SUMMARIZE_ACTION_ID, type AiActionDto, type NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { OWNER_PERMS } from "@/test/fixtures";
import { dismissAllToasts } from "@/components/ui/toast";
import {
  contentStart,
  createTestEditor,
  placeCursor,
  renderAiHost,
  selectInBlock,
  selectText,
  selectWholeBlocks,
  stubAiFetch,
  type AiCall,
  type AnyEditor,
} from "@/test/ai-host";
import { IMG, P, row, shape, withChildren } from "@/test/columns-fixtures";
import { replaceBlocksKeepColumns } from "@/collab/columns/keep-columns";
import { activeAnchorOf, useAiSession, type AiSessionValue } from "./AiSession";
import { SelectionAiController } from "./SelectionAiController";

// 包一層照呼叫原實作的 spy（斷言自動套用寫入的陣列身分）；不用 automock——那會讓套用變成什麼都不做。
vi.mock("@/collab/columns/keep-columns", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/collab/columns/keep-columns")>();
  return { ...m, replaceBlocksKeepColumns: vi.fn(m.replaceBlocksKeepColumns) };
});
beforeEach(() => {
  vi.mocked(replaceBlocksKeepColumns).mockReset(); // 不可寫成箭頭直接回傳：beforeEach 回傳的函式會被當成 teardown 呼叫；mockReset 連 mockImplementationOnce 佇列一起清，並還原成包裝的原實作
});

const REWRITE: AiActionDto = { id: REWRITE_ACTION_ID, name: "Rewrite", applyMode: "direct", kind: "quick" };
const SUMMARIZE: AiActionDto = { id: SUMMARIZE_ACTION_ID, name: "Summarize", applyMode: "preview", kind: "quick" };
const INSTRUCT: AiActionDto = { id: INSTRUCT_ACTION_ID, name: "Instruct", applyMode: "preview", kind: "instruct" };
const ACTIONS = [REWRITE, SUMMARIZE, INSTRUCT];

const DOC = [
  { id: "p1", type: "paragraph", content: "alpha beta gamma" },
  { id: "p2", type: "paragraph", content: "second paragraph" },
  { id: "p3", type: "paragraph", content: "third paragraph here" },
];

let session!: AiSessionValue;
function Probe() {
  session = useAiSession();
  return null;
}

let editor: AnyEditor;
const highlighted = () => editor.getExtension(ShowSelectionExtension)!.store.state.enabledSet.has("selection-ai");
const docText = () => JSON.stringify(editor.document);
const phase = () => session.state.phase;

async function mount(opts: { actions?: AiActionDto[]; doc?: unknown[]; onAutoClose?: () => void } = {}) {
  editor = createTestEditor(opts.doc ?? DOC);
  const ai = stubAiFetch({ actions: opts.actions ?? ACTIONS });
  const host = renderAiHost({ editor, onAutoClose: opts.onAutoClose, children: <Probe /> });
  await waitFor(() => expect(session.actions).toHaveLength((opts.actions ?? ACTIONS).length));
  return { ai, host };
}

function openOn(blockId: string, start: number, end: number): void {
  selectInBlock(editor, blockId, start, end);
  act(() => session.open());
}

function startAction(actionId: string, instruction?: string): void {
  act(() => {
    session.start(actionId, instruction);
  });
}

async function finishStream(call: AiCall, text: string): Promise<void> {
  await act(async () => {
    call.delta(text);
    call.done();
  });
  await waitFor(() => expect(phase()).not.toBe("streaming"));
}

describe("AiSession 狀態機（#263 spec §5.2）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("open：取選取區塊當錨點、部分選取的子字串當 focus、進 input、開標亮", async () => {
    await mount();
    openOn("p1", 6, 10);
    const s = session.state;
    if (s.phase !== "input") throw new Error(`預期 input，實得 ${s.phase}`);
    expect(s.target.anchor.blockIds).toEqual(["p1"]);
    expect(s.target.focus).toBe("beta");
    await waitFor(() => expect(highlighted()).toBe(true));
  });

  it("open：整塊選取 → focus 為空字串；跨區塊部分選取 → 換行分隔", async () => {
    await mount();
    selectWholeBlocks(editor, "p1", "p2");
    act(() => session.open());
    expect(session.state.phase === "input" && session.state.target.focus).toBe("");
    act(() => session.close());
    selectText(editor, contentStart(editor, "p1") + 6, contentStart(editor, "p2") + 6);
    act(() => session.open());
    expect(session.state.phase === "input" && session.state.target.focus).toBe("beta gamma\nsecond");
  });

  it("open：空選取（只放游標）或 NodeSelection（圖片）→ 不開", async () => {
    await mount({ doc: [...DOC, { id: "img", type: "image", props: { url: "https://example.com/a.png" } }] });
    placeCursor(editor, "p1", 2);
    act(() => session.open());
    expect(phase()).toBe("idle");
    act(() => {
      editor._tiptapEditor.commands.setNodeSelection(contentStart(editor, "img") - 1);
    });
    act(() => session.open());
    expect(phase()).toBe("idle");
  });

  it("quick direct：串流完自動套用；activeAnchor 換成 insertedAnchor；before 是套用前凍結的原文；寫入的就是 prepared.blocks", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(REWRITE.id);
    expect(ai.calls[0]!.body).toEqual({ action_id: REWRITE.id, note_id: "note-1", text: "alpha beta gamma\n" });
    await finishStream(ai.calls[0]!, "ALPHA REWRITTEN");
    const s = session.state;
    if (s.phase !== "done" || !s.applied) throw new Error(`預期 done＋applied，實得 ${s.phase}`);
    expect(docText()).toContain("ALPHA REWRITTEN");
    expect(docText()).not.toContain("alpha beta gamma");
    expect(activeAnchorOf(s)).toBe(s.applied.insertedAnchor);
    expect(s.applied.insertedAnchor.blockIds).not.toContain("p1");
    expect(JSON.stringify(s.preview.before)).toContain("alpha beta gamma");
    expect(vi.mocked(replaceBlocksKeepColumns).mock.calls[0]?.[2]).toBe(s.prepared.blocks);
  });

  it("Instruct 一律預覽（就算清單把它標成 direct）；送 trim 後的 instruction 與 focus", async () => {
    const { ai } = await mount({ actions: [REWRITE, { ...INSTRUCT, applyMode: "direct" }] });
    openOn("p1", 0, 5);
    startAction(INSTRUCT.id, "  make it upper  ");
    expect(ai.calls[0]!.body).toEqual({
      action_id: INSTRUCT.id,
      note_id: "note-1",
      text: "alpha beta gamma\n",
      instruction: "make it upper",
      focus: "alpha",
    });
    await finishStream(ai.calls[0]!, "ALPHA beta gamma");
    expect(session.state.phase === "done" && session.state.applied).toBeNull();
    expect(docText()).toContain("alpha beta gamma");
  });

  it("Instruct 整塊選取 → wire 不帶 focus；空白指令不送", async () => {
    const { ai } = await mount();
    selectWholeBlocks(editor, "p1", "p1");
    act(() => session.open());
    startAction(INSTRUCT.id, " 　 ");
    expect(ai.calls).toHaveLength(0);
    startAction(INSTRUCT.id, "shorter");
    expect(ai.calls[0]!.body).not.toHaveProperty("focus");
    expect(ai.calls[0]!.body.instruction).toBe("shorter");
  });

  it("RF5 noChange：模型回的與原文只差 CRLF／尾端空白 → 不自動套用、preview.noChange、apply() 回 false、文件不動", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(REWRITE.id);
    await finishStream(ai.calls[0]!, "alpha beta gamma  \r\n");
    const s = session.state;
    if (s.phase !== "done") throw new Error(`預期 done，實得 ${s.phase}`);
    expect(s.preview.noChange).toBe(true);
    expect(s.applied).toBeNull();
    let applied = true;
    act(() => {
      applied = session.apply(true);
    });
    expect(applied).toBe(false);
    expect(vi.mocked(replaceBlocksKeepColumns)).not.toHaveBeenCalled();
  });

  it("外層 <text> 剝除：prepared 與預覽都不含標記", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    await finishStream(ai.calls[0]!, "<text>\nSUMMARY\n</text>");
    const s = session.state;
    if (s.phase !== "done") throw new Error(`預期 done，實得 ${s.phase}`);
    expect(JSON.stringify(s.prepared.blocks)).toContain("SUMMARY");
    expect(JSON.stringify(s.preview.after)).not.toContain("<text>");
  });

  it("空結果 → error 態 empty_result（不是 toast）", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    await finishStream(ai.calls[0]!, "   ");
    expect(session.state.phase === "error" && session.state.code).toBe("empty_result");
  });

  // 並排 PR-2（spec §11.6 第 1 點）：AI 結果走與 MCP 相同的檢查；不合格 → error 態、不建預覽、不套用。
  it.each([
    ["direct", REWRITE],
    ["preview", SUMMARIZE],
  ])("GS1（%s）：串流完成的內容含排版用的 flex div（S7）→ error 態 unsupported_columns、文件不變、沒有寫入", async (_mode, action) => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    const before = docText();
    startAction(action.id);
    await finishStream(ai.calls[0]!, `<div style="display:flex">\n\nA\n\n</div>`);
    const s = session.state;
    expect(s.phase).toBe("error");
    expect(s.phase === "error" && s.code).toBe("unsupported_columns");
    expect(docText()).toBe(before);
    expect(vi.mocked(replaceBlocksKeepColumns)).not.toHaveBeenCalled();
  });

  it("GS2：內容含裸 <img width> → error 態 unsupported_size", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(REWRITE.id);
    await finishStream(ai.calls[0]!, '<img src="/x" width="300">');
    expect(session.state.phase === "error" && session.state.code).toBe("unsupported_size");
    expect(vi.mocked(replaceBlocksKeepColumns)).not.toHaveBeenCalled();
  });

  it("MM3（#94）：選取涵蓋 mermaid 圖、AI 只改段落文字 → 自動套用後圖仍是 mermaid block、code 不變", async () => {
    const CODE = "graph TD; A-->B";
    const { ai } = await mount({ doc: [P("old words", "p1"), { id: "m", type: "mermaid", props: { code: CODE } }, P("tail", "p3")] });
    act(() => {
      editor.setSelection("p1", "p3"); // 圖在中間（mermaid 沒有 content，不能當選取端點）
    });
    act(() => session.open());
    expect(session.state.phase === "input" && session.state.target.anchor.blockIds).toEqual(["p1", "m", "p3"]);
    startAction(REWRITE.id);
    const sent = ai.calls[0]!.body.text;
    expect(sent).toContain("```mermaid\n" + CODE + "\n```"); // fixture 自檢：送出的是 fence
    await finishStream(ai.calls[0]!, sent.replace("old", "new"));
    expect(session.state.phase === "done" && session.state.applied !== null).toBe(true);
    const doc = editor.document as Array<{ type: string; props: Record<string, unknown>; content?: unknown }>;
    expect(doc.map((b) => b.type)).toEqual(["paragraph", "mermaid", "paragraph"]);
    expect(JSON.stringify(doc[0]!.content)).toContain("new words");
    expect(doc[1]!.props.code).toBe(CODE);
  });

  it("GS7（review r1 N2）：串流完成後 finish 意外丟例外 → error 態 internal（不卡在串流中）、沒有寫入、沒有未處理的 rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { ai } = await mount();
      openOn("p1", 0, 5);
      startAction(REWRITE.id);
      // finish 的第一步 anchorPlacement 讀 getParentBlock：在這裡造一個非預期的例外
      vi.spyOn(editor, "getParentBlock").mockImplementation(() => {
        throw new Error("boom");
      });
      await finishStream(ai.calls[0]!, "REWRITTEN");
      expect(session.state.phase === "error" && session.state.code).toBe("internal");
      expect(vi.mocked(replaceBlocksKeepColumns)).not.toHaveBeenCalled();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("GS8（review r1 I1）：預覽期間錨點被縮排、按套用 → 回 false、toast「原文已變更」、文件不變、沒有巢狀列", async () => {
    const { ai } = await mount({ doc: [P("prev", "p0"), P("x words", "x")] });
    openOn("x", 0, 1);
    startAction(SUMMARIZE.id);
    await finishStream(ai.calls[0]!, ROW2);
    expect(phase()).toBe("done");
    act(() => {
      editor.setTextCursorPosition("x", "end");
      editor.nestBlock();
    });
    expect(phase()).toBe("done"); // 游標在錨點內，D12 不關
    const before = docText();
    let applied = true;
    act(() => {
      applied = session.apply(true);
    });
    expect(applied).toBe(false);
    expect(await screen.findByText("The original text changed since this result was generated, so it wasn't applied.")).toBeInTheDocument();
    expect(docText()).toBe(before);
    expect(shape(editor)).toBe("paragraph:prev{paragraph:x words}");
  });

  it("GS6：AI 回了 core parse 會丟例外的內容 → error 態 unsupported_block（不卡在串流中）、框顯示錯誤文案、沒有寫入、沒有未處理的 rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      // 照 SelectionAiBox.test 的真實掛法：SelectionAiController（渲染框）與 Probe 一起當 host 的 children
      editor = createTestEditor(DOC);
      const ai = stubAiFetch({ actions: ACTIONS });
      renderAiHost({ editor, children: <><SelectionAiController /><Probe /></> });
      await waitFor(() => expect(session.actions).toHaveLength(ACTIONS.length));
      openOn("p1", 0, 5);
      const before = docText();
      startAction(REWRITE.id);
      await finishStream(ai.calls[0]!, '<div data-content-type="paragraph">x</div>');
      expect(session.state.phase === "error" && session.state.code).toBe("unsupported_block");
      const region = await screen.findByTestId("selection-ai-box");
      expect(await within(region).findByRole("alert")).toHaveTextContent("That content contains a block type this note can't store.");
      expect(docText()).toBe(before);
      expect(vi.mocked(replaceBlocksKeepColumns)).not.toHaveBeenCalled();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0)); // 讓 unhandledRejection 有機會先觸發
      });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  const ROW2 = `<div data-kb-columns style="display:flex;gap:16px">\n<div data-kb-column style="flex:1">\n\nA\n\n</div>\n<div data-kb-column style="flex:1.5">\n\nB\n\n</div>\n</div>`;
  it("GS5（Q6）：錨點在欄內、AI 回正規形並排 → error 態 unsupported_columns；錨點在頂層 → 自動套用成一列", async () => {
    const { ai } = await mount({ doc: [P("x", "x"), row([[P("a", "a1")], [P("b", "b1")]], "r")] });
    openOn("b1", 0, 1);
    startAction(REWRITE.id);
    await finishStream(ai.calls[0]!, ROW2);
    expect(session.state.phase === "error" && session.state.code).toBe("unsupported_columns");
    expect(vi.mocked(replaceBlocksKeepColumns)).not.toHaveBeenCalled();
    act(() => session.close());
    openOn("x", 0, 1);
    startAction(REWRITE.id);
    await finishStream(ai.calls[1]!, ROW2);
    expect(session.state.phase === "done" && session.state.applied !== null).toBe(true);
    expect(shape(editor)).toBe("ROW[COL(paragraph:A) | COL(paragraph:B)]  ROW[COL(paragraph:a) | COL(paragraph:b)]");
  });

  it("GS3（#305 站內 AI 半）：AI 只改一個字 → 套用後圖片寬度與兩張表的欄寬（含合併表頭的空段）都保留", async () => {
    const table = (id: string, columnWidths: (number | undefined)[], rows: unknown[]) => ({
      id,
      type: "table",
      content: { type: "tableContent", headerRows: 1, columnWidths, rows },
    });
    const t1 = table("t1", [120, undefined], [{ cells: ["a", "b"] }, { cells: ["c", "d"] }]);
    const t2 = table("t2", [120, undefined, 80], [{ cells: [{ type: "tableCell", props: { colspan: 2 }, content: "ab" }, "c"] }, { cells: ["d", "e", "f"] }]);
    const { ai } = await mount({ doc: [P("old words", "p1"), IMG("i1", 300), t1, t2] });
    act(() => {
      editor.setSelection("p1", "t2");
    });
    act(() => session.open());
    expect(session.state.phase === "input" && session.state.target.anchor.blockIds).toEqual(["p1", "i1", "t1", "t2"]);
    startAction(SUMMARIZE.id);
    const sent = ai.calls[0]!.body.text;
    await finishStream(ai.calls[0]!, sent.replace("old", "new"));
    expect(phase()).toBe("done");
    let applied = false;
    act(() => {
      applied = session.apply(true);
    });
    expect(applied).toBe(true);
    const doc = editor.document as Array<{ type: string; content?: unknown; props: Record<string, unknown> }>;
    expect(doc.map((b) => b.type)).toEqual(["paragraph", "image", "table", "table"]);
    expect(JSON.stringify(doc[0]!.content)).toContain("new words");
    expect(doc[1]!.props.previewWidth).toBe(300);
    expect((doc[2]!.content as { columnWidths: unknown[] }).columnWidths[0]).toBe(120);
    const ws = (doc[3]!.content as { columnWidths: unknown[] }).columnWidths;
    expect(ws).toHaveLength(3);
    expect(ws[0]).toBe(120);
    expect(Object.is(ws[1], undefined)).toBe(true);
    expect(ws[2]).toBe(80);
  });

  it("GS4：只選段落的文字、圖片是它的縮排子 block → direct 動作不自動套用（hasNonTextBlock 看子孫）", async () => {
    const { ai } = await mount({ doc: [withChildren(P("t", "p1"), [IMG("i1")])] });
    openOn("p1", 0, 1);
    expect(session.state.phase === "input" && session.state.target.anchor.blockIds).toEqual(["p1"]);
    startAction(REWRITE.id);
    await finishStream(ai.calls[0]!, "T");
    const s = session.state;
    expect(s.phase).toBe("done");
    expect(s.phase === "done" && s.applied).toBeNull();
    expect(vi.mocked(replaceBlocksKeepColumns)).not.toHaveBeenCalled();
  });

  it("串流錯誤 → error 態；retry 以同一組 request（含 instruction 與 focus）重送", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(INSTRUCT.id, "shorter");
    await act(async () => {
      ai.calls[0]!.fail("upstream_error");
    });
    await waitFor(() => expect(session.state.phase === "error" && session.state.code).toBe("upstream_error"));
    let retried = false;
    act(() => {
      retried = session.retry();
    });
    expect(retried).toBe(true);
    expect(ai.calls[1]!.body).toEqual(ai.calls[0]!.body);
  });

  it("retry 在已自動套用後不可用", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(REWRITE.id);
    await finishStream(ai.calls[0]!, "REWRITTEN");
    let retried = true;
    act(() => {
      retried = session.retry();
    });
    expect(retried).toBe(false);
    expect(ai.calls).toHaveLength(1);
  });

  it("手動套用成功 → 回 idle（S1）、文件換字、關標亮", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    await finishStream(ai.calls[0]!, "SUMMARY TEXT");
    await waitFor(() => expect(highlighted()).toBe(true));
    let applied = false;
    act(() => {
      applied = session.apply(true);
    });
    expect(applied).toBe(true);
    expect(phase()).toBe("idle");
    expect(docText()).toContain("SUMMARY TEXT");
    await waitFor(() => expect(highlighted()).toBe(false));
  });

  it("apply(false)（預覽尚未就緒）→ 回 false、停在 done、文件不動（spec §5.2：previewReady 是 apply 的前置條件）", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    await finishStream(ai.calls[0]!, "SUMMARY TEXT");
    let applied = true;
    act(() => {
      applied = session.apply(false);
    });
    expect(applied).toBe(false);
    expect(phase()).toBe("done");
    expect(docText()).not.toContain("SUMMARY TEXT");
  });

  it("手動套用撞守門（錨點被改）→ toast、停在 done、文件不動", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    await finishStream(ai.calls[0]!, "SUMMARY TEXT");
    act(() => {
      editor.updateBlock("p1", { content: "changed by a collaborator" });
    });
    let applied = true;
    act(() => {
      applied = session.apply(true);
    });
    expect(applied).toBe(false);
    expect(phase()).toBe("done");
    expect(await screen.findByText("The original text changed since this result was generated, so it wasn't applied.")).toBeInTheDocument();
    expect(docText()).not.toContain("SUMMARY TEXT");
  });

  it("cancel：abort 串流、回 idle、關標亮", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    act(() => session.cancel());
    expect(ai.calls[0]!.signal.aborted).toBe(true);
    expect(phase()).toBe("idle");
    await waitFor(() => expect(highlighted()).toBe(false));
  });

  it("close：done → idle、關標亮", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    await finishStream(ai.calls[0]!, "SUMMARY");
    act(() => session.close());
    expect(phase()).toBe("idle");
    await waitFor(() => expect(highlighted()).toBe(false));
  });

  it("D12：done 態在 target 外做非空選取 → 自動關閉、關標亮；onAutoClose 被呼叫一次", async () => {
    const onAutoClose = vi.fn();
    const { ai } = await mount({ onAutoClose });
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    await finishStream(ai.calls[0]!, "SUMMARY");
    selectInBlock(editor, "p3", 0, 5);
    expect(phase()).toBe("idle");
    expect(onAutoClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(highlighted()).toBe(false));
  });

  it("D12：串流中在 target 外選取不關；串流完成當下也不關；下一次選取變更才關", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    selectInBlock(editor, "p3", 0, 5);
    expect(phase()).toBe("streaming");
    await finishStream(ai.calls[0]!, "SUMMARY");
    expect(phase()).toBe("done");
    selectInBlock(editor, "p3", 6, 10);
    expect(phase()).toBe("idle");
  });

  it("D12：空選取（只放游標）不關；在 target 內選取不關", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    await finishStream(ai.calls[0]!, "SUMMARY");
    placeCursor(editor, "p3", 2);
    expect(phase()).toBe("done");
    selectInBlock(editor, "p1", 6, 10);
    expect(phase()).toBe("done");
  });

  it("D12（W14）：input 與 error 態一樣——在 target 外做非空選取 → 自動關閉、關標亮；onAutoClose 各呼叫一次", async () => {
    const onAutoClose = vi.fn();
    const { ai } = await mount({ onAutoClose });
    openOn("p1", 0, 5);
    await waitFor(() => expect(highlighted()).toBe(true));
    selectInBlock(editor, "p3", 0, 5);
    expect(phase()).toBe("idle");
    expect(onAutoClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(highlighted()).toBe(false));

    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    await act(async () => {
      ai.calls[0]!.fail("upstream_error");
    });
    await waitFor(() => expect(phase()).toBe("error"));
    await waitFor(() => expect(highlighted()).toBe(true));
    selectInBlock(editor, "p3", 6, 10);
    expect(phase()).toBe("idle");
    expect(onAutoClose).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(highlighted()).toBe(false));
  });

  it("editable 轉 false：串流中 abort、回 idle、關標亮", async () => {
    const { ai, host } = await mount();
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    host.rerenderHost({ editable: false });
    await waitFor(() => expect(phase()).toBe("idle"));
    expect(ai.calls[0]!.signal.aborted).toBe(true);
    await waitFor(() => expect(highlighted()).toBe(false));
  });

  it("noteId 換手：非 idle 態回 idle、關標亮", async () => {
    const { ai, host } = await mount();
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    await finishStream(ai.calls[0]!, "SUMMARY");
    host.rerenderHost({ noteId: "note-2" });
    await waitFor(() => expect(phase()).toBe("idle"));
    await waitFor(() => expect(highlighted()).toBe(false));
  });

  it("open() 從 done（已套用）出發：舊結果與還原入口丟棄、對當下選取開新框；串流中呼叫 open() 不動作", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(REWRITE.id);
    await finishStream(ai.calls[0]!, "REWRITTEN FIRST");
    const s = session.state;
    if (s.phase !== "done" || !s.applied) throw new Error("預期已自動套用");
    const insertedId = s.applied.insertedAnchor.blockIds[0]!;
    selectInBlock(editor, insertedId, 0, 3); // 在 activeAnchor 內：D12 不關
    act(() => session.open());
    const reopened = session.state;
    if (reopened.phase !== "input") throw new Error(`預期 input，實得 ${reopened.phase}`);
    expect(reopened.target.anchor.blockIds).toEqual([insertedId]);
    startAction(SUMMARIZE.id);
    act(() => session.open());
    expect(phase()).toBe("streaming");
    expect(ai.calls).toHaveLength(2);
  });

  it("open() 從 input 與 error 出發：同樣先關舊框（error 的 request 丟棄）再對當下選取開新框", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    selectInBlock(editor, "p1", 6, 10); // 仍在 target 內：D12 不關
    act(() => session.open());
    expect(session.state.phase === "input" && session.state.target.focus).toBe("beta");
    startAction(SUMMARIZE.id);
    await act(async () => {
      ai.calls[0]!.fail("upstream_error");
    });
    await waitFor(() => expect(phase()).toBe("error"));
    selectInBlock(editor, "p1", 11, 16);
    act(() => session.open());
    const s = session.state;
    expect(s.phase).toBe("input");
    expect(s.phase === "input" && s.target.focus).toBe("gamma");
  });

  it("selfWriteRef（自動套用＋還原那半）：串流中在 target 後方做非空選取 → direct 自動套用 → 還原，框仍在、回到未套用；D12 回呼 0 次", async () => {
    // 白箱斷言 onAutoClose：沒有旗標時 D12 會在還原的取代期間 close()，但 revert() 隨後的 setState 會蓋掉 idle（同一批次），
    // 框照樣留著——只看 state 抓不到（起草時 jsdom 突變實測：拿掉旗標只有 onAutoClose 斷言會紅）。
    const onAutoClose = vi.fn();
    const { ai } = await mount({ onAutoClose });
    openOn("p1", 0, 5);
    startAction(REWRITE.id);
    selectInBlock(editor, "p3", 0, 5); // target 後方；長度不同的替換會平移這個選取並發 selection change
    await finishStream(ai.calls[0]!, "A much longer rewritten first paragraph than before");
    expect(session.state.phase === "done" && session.state.applied !== null).toBe(true);
    act(() => session.revert());
    expect(onAutoClose).not.toHaveBeenCalled();
    const s = session.state;
    expect(s.phase).toBe("done");
    expect(s.phase === "done" && s.applied).toBeNull();
    expect(docText()).toContain("alpha beta gamma");
  });

  it("selfWriteRef（手動套用那半，白箱）：選取在 target 後方時按套用，D12 回呼 0 次", async () => {
    const onAutoClose = vi.fn();
    const { ai } = await mount({ onAutoClose });
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    selectInBlock(editor, "p3", 0, 5); // 串流中選，不觸發 D12；完成後選取仍在 p3
    await finishStream(ai.calls[0]!, "A much longer summary than the original first paragraph");
    act(() => {
      session.apply(true);
    });
    expect(onAutoClose).not.toHaveBeenCalled();
    expect(phase()).toBe("idle");
  });

  it("RF3：選取含圖片區塊時 direct 動作不自動套用（強制預覽）", async () => {
    const { ai } = await mount({ doc: [...DOC, { id: "img", type: "image", props: { url: "https://example.com/a.png" } }] });
    act(() => {
      editor._tiptapEditor.commands.selectAll();
    });
    act(() => session.open());
    startAction(REWRITE.id);
    await finishStream(ai.calls[0]!, "EVERYTHING REWRITTEN");
    expect(session.state.phase === "done" && session.state.applied).toBeNull();
    expect(docText()).toContain("alpha beta gamma");
  });

  it("還原撞 stale（插入的內容又被改）→ toast、applied 清空、文件不動", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(REWRITE.id);
    await finishStream(ai.calls[0]!, "REWRITTEN");
    const s = session.state;
    if (s.phase !== "done" || !s.applied) throw new Error("預期已自動套用");
    act(() => {
      editor.updateBlock(s.applied!.insertedAnchor.blockIds[0]!, { content: "edited after apply" });
    });
    act(() => session.revert());
    expect(await screen.findByText("This change can no longer be reverted — the text may have changed since.")).toBeInTheDocument();
    expect(session.state.phase === "done" && session.state.applied).toBeNull();
    expect(docText()).toContain("edited after apply");
  });

  it("#269 §9.4：送出的 markdown 把 wikilink 寫成 [現行標題 或 label](/notes/<id>)（匯出副本，不動文件）", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    editor = createTestEditor([
      { id: "w1", type: "paragraph", content: ["see ", { type: "wikilink", props: { targetNoteId: id, snapshotTitle: "Old", label: "", anchorBlockId: "h1" } }, " end"] },
    ]);
    const ai = stubAiFetch({ actions: ACTIONS, notes: [{ id, title: "Live Title", slug: "live", ownerId: "u1", role: "owner", createdAt: "x", updatedAt: "x", slugIsCustom: false, prevSlug: null, ownerHandle: "alice", lastEdited: null, group: null, groupId: null, permissions: OWNER_PERMS }] });
    const host = renderAiHost({ editor, children: <Probe /> });
    await waitFor(() => expect(session.actions).toHaveLength(ACTIONS.length));
    await waitFor(() => expect(host.queryClient.getQueryData(["notes"])).toBeDefined()); // AiSessionProvider 的 useNotes 把快取填好
    const before = JSON.stringify(editor.document);
    selectWholeBlocks(editor, "w1", "w1");
    act(() => session.open());
    startAction(REWRITE.id);
    expect(ai.calls[0]!.body.text).toContain(`[Live Title](/notes/${id}#b-h1)`);
    expect(JSON.stringify(editor.document)).toBe(before);
  });

  it("#269 §9.4：open() 的 focus（部分選取）也把 wikilink 寫成 [現行標題](/notes/<id>)", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    editor = createTestEditor([
      { id: "w1", type: "paragraph", content: ["see ", { type: "wikilink", props: { targetNoteId: id, snapshotTitle: "Old", label: "", anchorBlockId: "h1" } }, " end"] },
    ]);
    stubAiFetch({ actions: ACTIONS, notes: [{ id, title: "Live Title", slug: "live", ownerId: "u1", role: "owner", createdAt: "x", updatedAt: "x", slugIsCustom: false, prevSlug: null, ownerHandle: "alice", lastEdited: null, group: null, groupId: null, permissions: OWNER_PERMS }] });
    const host = renderAiHost({ editor, children: <Probe /> });
    await waitFor(() => expect(session.actions).toHaveLength(ACTIONS.length));
    await waitFor(() => expect(host.queryClient.getQueryData(["notes"])).toBeDefined());
    // wikilink 是 atom，佔 1 個位置："see "（4）＋wikilink（1）＝5，選到 " end" 之前（部分選取 ⇒ focus 非空）
    openOn("w1", 0, 5);
    expect(session.state.phase === "input" && session.state.target.focus).toBe(`see [Live Title](/notes/${id}#b-h1)`);
  });

  it("#269 終審 m1：文件存大寫 targetNoteId 時，送出的仍是現行標題（id 比對不分大小寫）", async () => {
    const id = "abcdef12-3456-4abc-8def-0123456789ab"; // 清單（server）回的小寫 id
    const upper = id.toUpperCase();
    expect(upper).not.toBe(id); // fixture 自檢：真的有 a–f 字母會被轉大寫
    editor = createTestEditor([
      { id: "w1", type: "paragraph", content: ["see ", { type: "wikilink", props: { targetNoteId: upper, snapshotTitle: "Old", label: "", anchorBlockId: "h1" } }, " end"] },
    ]);
    const ai = stubAiFetch({ actions: ACTIONS, notes: [{ id, title: "Live Title", slug: "live", ownerId: "u1", role: "owner", createdAt: "x", updatedAt: "x", slugIsCustom: false, prevSlug: null, ownerHandle: "alice", lastEdited: null, group: null, groupId: null, permissions: OWNER_PERMS }] });
    const host = renderAiHost({ editor, children: <Probe /> });
    await waitFor(() => expect(session.actions).toHaveLength(ACTIONS.length));
    await waitFor(() => expect(host.queryClient.getQueryData(["notes"])).toBeDefined());
    selectWholeBlocks(editor, "w1", "w1");
    act(() => session.open());
    startAction(REWRITE.id);
    expect(ai.calls[0]!.body.text).toContain(`[Live Title](/notes/${upper}#b-h1)`);
    expect(ai.calls[0]!.body.text).not.toContain("[Old]");
  });

  it("#269 RF1：送出的 /notes/ 連結文字經 markdown 跳脫；AI 原樣回寫後 label 逐字保留（文字＝現行標題者 label 仍空）", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const note: NoteDto = { id, title: "[Draft] Plan *v2*", slug: "draft", ownerId: "u1", role: "owner", createdAt: "x", updatedAt: "x", slugIsCustom: false, prevSlug: null, ownerHandle: "alice", lastEdited: null, group: null, groupId: null, permissions: OWNER_PERMS };
    const wl = (label: string) => ({ type: "wikilink", props: { targetNoteId: id, snapshotTitle: "Old", label, anchorBlockId: "" } });
    const external = { type: "link", href: "https://example.com/x", content: "k*z" };
    editor = createTestEditor([{ id: "w1", type: "paragraph", content: ["a ", wl(""), " b ", wl("a]b\\"), " end"] }, { id: "w2", type: "paragraph", content: [external] }]);
    const ai = stubAiFetch({ actions: ACTIONS, notes: [note] });
    const host = renderAiHost({ editor, children: <Probe /> });
    await waitFor(() => expect(session.actions).toHaveLength(ACTIONS.length));
    await waitFor(() => expect(host.queryClient.getQueryData(["notes"])).toBeDefined());
    selectWholeBlocks(editor, "w1", "w2");
    act(() => session.open());
    startAction(REWRITE.id);
    const sent = ai.calls[0]!.body.text;
    expect(sent).toContain(`a [\\[Draft\\] Plan \\*v2\\*](/notes/${id}) b [a\\]b\\\\](/notes/${id}) end`);
    // 只跳脫 `/notes/` 連結（shared `note-markdown-read.ts` 的 `escapeNoteLinkText`）：一般外部連結的文字照 `blocksToMarkdownLossy` 原樣送出。
    expect(sent).toContain("[k*z](https://example.com/x)");
    await finishStream(ai.calls[0]!, sent.replace(" end", " END"));
    const s = session.state;
    if (s.phase !== "done" || !s.applied) throw new Error("預期已自動套用");
    const links = (editor.document[0]!.content as Array<{ type: string; props?: Record<string, string> }>).filter((n) => n.type === "wikilink");
    expect(links.map((n) => [n.props!.targetNoteId, n.props!.label])).toEqual([
      [id, ""],
      [id, "a]b\\"],
    ]);
  });
});

// PR-1 過渡碼（PR-2 改成擴大成整列時移除）：跨欄或含整列的選取 `open()` 不開（final review I-1；AI 鈕也不出，見 AiToolbar.test AX*）。
describe("AiSession open() 與並排（PR-1 過渡）", () => {
  const TWO = () => [P("x", "x"), row([[P("a", "a1")], [P("b", "b1"), P("q", "q1")]], "r"), P("z", "z")];
  const THREE = () => [P("x", "x"), row([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")]], "r"), P("z", "z")];
  const NESTED = () => [P("x", "x"), row([[P("a", "a1")], [withChildren(P("p", "p1"), [P("c", "c1")])]], "r"), P("z", "z")];
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each<[string, () => unknown[], string, string]>([
    ["AO1 跨欄 a..b", TWO, "a1", "b1"],
    ["AO2 三欄 a..c", THREE, "a1", "c1"],
    ["AO3 從列外 x 選進列內", TWO, "x", "b1"],
    ["AO4 從欄內選到列外 z", TWO, "b1", "z"],
    ["AO6 從末欄的巢狀子 block 選到列外 z（欄是祖父節點）", NESTED, "c1", "z"],
  ])("%s → open() 後仍 idle、沒有標亮", async (_name, doc, from, to) => {
    await mount({ doc: doc() });
    act(() => {
      editor.setSelection(from, to);
    });
    act(() => session.open());
    expect(phase()).toBe("idle");
    expect(highlighted()).toBe(false);
  });

  it("AO5 完全在單一欄內（b..q）→ 照常開框、錨點是兩個欄內段落", async () => {
    await mount({ doc: TWO() });
    act(() => {
      editor.setSelection("b1", "q1");
    });
    act(() => session.open());
    const s = session.state;
    if (s.phase !== "input") throw new Error(`預期 input，實得 ${s.phase}`);
    expect(s.target.anchor.blockIds).toEqual(["b1", "q1"]);
  });
});

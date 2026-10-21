import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { REWRITE_ACTION_ID, type AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { contentStart, createTestEditor, renderAiHost, selectInBlock, stubAiFetch, type AnyEditor } from "@/test/ai-host";
import { IMG, P, row, shape } from "@/test/columns-fixtures";
import { useAiSession, type AiSessionValue } from "./AiSession";
import { SelectionAiController } from "./SelectionAiController";

// D25：工具列的檔案刪除鈕換成自家版（`KnotebookFileDeleteButton`），刪欄內的圖不收欄。掛法照 `SelectionAiController.test.tsx`。

const REWRITE: AiActionDto = { id: REWRITE_ACTION_ID, name: "Rewrite", applyMode: "direct", kind: "quick" };

let session!: AiSessionValue;
function Probe() {
  session = useAiSession();
  return null;
}

const deleteButtons = () => document.querySelectorAll("[data-kb-file-delete]");
const toolbar = () => document.querySelector(".bn-formatting-toolbar");

async function mount(doc: unknown[]): Promise<AnyEditor> {
  const editor = createTestEditor(doc);
  stubAiFetch({ actions: [REWRITE] });
  renderAiHost({
    editor,
    children: (
      <>
        <SelectionAiController />
        <Probe />
      </>
    ),
  });
  await waitFor(() => expect(session.actions).toHaveLength(1));
  return editor;
}

describe("AiToolbar 檔案刪除鈕（D25）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("AT1：選取欄內的圖 → 恰一顆自家刪除鈕；點它 → 圖刪掉、列與兩欄都在", async () => {
    const editor = await mount([P("x", "x"), row([[P("a", "a")], [IMG("img")]], "r"), P("z", "z")]);
    act(() => {
      editor._tiptapEditor.commands.setNodeSelection(contentStart(editor, "img") - 1);
    });
    await waitFor(() => expect(deleteButtons()).toHaveLength(1));
    // 原生的刪除鈕也不能還在（同一個 tooltip 字串）：保留原生、另加自家的話，按原生那顆照樣收欄。
    const label = deleteButtons()[0]!.getAttribute("aria-label")!;
    expect(toolbar()!.querySelectorAll(`[aria-label="${label}"]`)).toHaveLength(1);
    fireEvent.click(deleteButtons()[0]!);
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  paragraph:z");
  });

  it("AT2：選取的是段落文字 → 工具列在、沒有刪除鈕", async () => {
    const editor = await mount([P("x", "x"), row([[P("abc", "a")], [IMG("img")]], "r"), P("z", "z")]);
    selectInBlock(editor, "a", 0, 2);
    await waitFor(() => expect(toolbar()).not.toBeNull());
    expect(deleteButtons()).toHaveLength(0);
  });

  it("AT2b：選取從圖跨到下一段（兩個 block）→ 工具列在、沒有刪除鈕", async () => {
    const editor = await mount([P("x", "x"), IMG("img"), P("qq", "q")]);
    act(() => {
      editor._tiptapEditor.commands.setTextSelection({ from: contentStart(editor, "img") - 1, to: contentStart(editor, "q") + 2 });
    });
    expect(editor.getSelection()!.blocks.map((b) => b.id)).toEqual(["img", "q"]);
    await waitFor(() => expect(toolbar()).not.toBeNull());
    expect(deleteButtons()).toHaveLength(0);
  });
});

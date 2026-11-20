import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import { ShowSelectionExtension } from "@blocknote/core/extensions";
import { INSTRUCT_ACTION_ID, REWRITE_ACTION_ID, SUMMARIZE_ACTION_ID, type AiActionDto, type NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { OWNER_PERMS } from "@/test/fixtures";
import { dismissAllToasts, toast } from "@/components/ui/toast";
import {
  contentEnd,
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
import { IMG, P, integrity, row, shape, withChildren } from "@/test/columns-fixtures";
import { replaceBlocksKeepColumns } from "@/collab/columns/keep-columns";
import { activeAnchorOf, useAiSession, type AiSessionValue } from "./AiSession";
import * as Y from "yjs";
import { createNoteSizeGuard, estimateBlocksBytes } from "@/lib/note-size-guard";
import { SelectionAiController } from "./SelectionAiController";

// Wrapped in a spy that calls the original implementation (assertions pick up the identity of the written arrays); not automock, which would turn applying into a no-op.
vi.mock("@/collab/columns/keep-columns", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/collab/columns/keep-columns")>();
  return { ...m, replaceBlocksKeepColumns: vi.fn(m.replaceBlocksKeepColumns) };
});
// Wrap toast the same way (one case needs a toast that throws after applying).
vi.mock("@/components/ui/toast", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/components/ui/toast")>();
  return { ...m, toast: vi.fn(m.toast) };
});
beforeEach(() => {
  vi.mocked(toast).mockReset();
  vi.mocked(replaceBlocksKeepColumns).mockReset(); // Not an arrow returning it directly: a function returned from beforeEach is called as teardown. mockReset also clears the mockImplementationOnce queue and restores the wrapped original.
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

async function mount(opts: { actions?: AiActionDto[]; doc?: unknown[]; onAutoClose?: () => void; sizeGuard?: (incomingBytes: number) => boolean } = {}) {
  editor = createTestEditor(opts.doc ?? DOC);
  const ai = stubAiFetch({ actions: opts.actions ?? ACTIONS });
  const host = renderAiHost({ editor, onAutoClose: opts.onAutoClose, sizeGuard: opts.sizeGuard, children: <Probe /> });
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

describe("AiSession state machine (#263)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("open: uses the selected blocks as anchors, the partially selected substring as focus, enters input, turns highlight on", async () => {
    await mount();
    openOn("p1", 6, 10);
    const s = session.state;
    if (s.phase !== "input") throw new Error(`預期 input，實得 ${s.phase}`);
    expect(s.target.anchor.blockIds).toEqual(["p1"]);
    expect(s.target.focus).toBe("beta");
    await waitFor(() => expect(highlighted()).toBe(true));
  });

  it("open: whole-block selection gives an empty focus; partial selection across blocks is newline separated", async () => {
    await mount();
    selectWholeBlocks(editor, "p1", "p2");
    act(() => session.open());
    expect(session.state.phase === "input" && session.state.target.focus).toBe("");
    act(() => session.close());
    selectText(editor, contentStart(editor, "p1") + 6, contentStart(editor, "p2") + 6);
    act(() => session.open());
    expect(session.state.phase === "input" && session.state.target.focus).toBe("beta gamma\nsecond");
  });

  it("open: empty selection (caret only) or NodeSelection (image) does not open", async () => {
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

  it("quick direct: auto-applies after streaming; activeAnchor becomes insertedAnchor; before is the original text frozen before applying; what is written is prepared.blocks", async () => {
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

  it("Instruct always previews (even if the list marks it direct); sends the trimmed instruction and focus", async () => {
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

  it("Instruct on a whole-block selection: the wire request has no focus; a blank instruction is not sent", async () => {
    const { ai } = await mount();
    selectWholeBlocks(editor, "p1", "p1");
    act(() => session.open());
    startAction(INSTRUCT.id, " 　 ");
    expect(ai.calls).toHaveLength(0);
    startAction(INSTRUCT.id, "shorter");
    expect(ai.calls[0]!.body).not.toHaveProperty("focus");
    expect(ai.calls[0]!.body.instruction).toBe("shorter");
  });

  it("noChange: a reply differing from the original only by CRLF/trailing whitespace is not auto-applied, sets preview.noChange, apply() returns false, document untouched", async () => {
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

  it("outer <text> wrapper is stripped: neither prepared nor the preview contains the markers", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    await finishStream(ai.calls[0]!, "<text>\nSUMMARY\n</text>");
    const s = session.state;
    if (s.phase !== "done") throw new Error(`預期 done，實得 ${s.phase}`);
    expect(JSON.stringify(s.prepared.blocks)).toContain("SUMMARY");
    expect(JSON.stringify(s.preview.after)).not.toContain("<text>");
  });

  it("empty result gives error state empty_result (not a toast)", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    await finishStream(ai.calls[0]!, "   ");
    expect(session.state.phase === "error" && session.state.code).toBe("empty_result");
  });

  // Columns: AI results go through the same check as MCP; a failing result gives the error state, no preview, no apply.
  it.each([
    ["direct", REWRITE],
    ["preview", SUMMARIZE],
  ])("%s: streamed content containing a layout flex div gives error state unsupported_columns, document unchanged, nothing written", async (_mode, action) => {
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

  it("content with a bare <img width> gives error state unsupported_size", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(REWRITE.id);
    await finishStream(ai.calls[0]!, '<img src="/x" width="300">');
    expect(session.state.phase === "error" && session.state.code).toBe("unsupported_size");
    expect(vi.mocked(replaceBlocksKeepColumns)).not.toHaveBeenCalled();
  });

  it("#94: selection covers a mermaid diagram and the AI changes only paragraph text: after auto-apply the diagram is still a mermaid block with the same code", async () => {
    const CODE = "graph TD; A-->B";
    const { ai } = await mount({ doc: [P("old words", "p1"), { id: "m", type: "mermaid", props: { code: CODE } }, P("tail", "p3")] });
    act(() => {
      editor.setSelection("p1", "p3"); // diagram in the middle (mermaid has no content, so it cannot be a selection endpoint)
    });
    act(() => session.open());
    expect(session.state.phase === "input" && session.state.target.anchor.blockIds).toEqual(["p1", "m", "p3"]);
    startAction(REWRITE.id);
    const sent = ai.calls[0]!.body.text;
    expect(sent).toContain("```mermaid\n" + CODE + "\n```"); // fixture check: the diagram is sent as a fence
    await finishStream(ai.calls[0]!, sent.replace("old", "new"));
    expect(session.state.phase === "done" && session.state.applied !== null).toBe(true);
    const doc = editor.document as Array<{ type: string; props: Record<string, unknown>; content?: unknown }>;
    expect(doc.map((b) => b.type)).toEqual(["paragraph", "mermaid", "paragraph"]);
    expect(JSON.stringify(doc[0]!.content)).toContain("new words");
    expect(doc[1]!.props.code).toBe(CODE);
  });

  it("finish throwing unexpectedly after streaming completes gives error state internal (not stuck streaming), nothing written, no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { ai } = await mount();
      openOn("p1", 0, 5);
      startAction(REWRITE.id);
      // finish's first step anchorPlacement reads getParentBlock: provoke an unexpected throw there
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

  it("toast throwing after a successful direct auto-apply: still done + applied (revert entry present), revert works, no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { ai } = await mount();
      openOn("p1", 0, 5);
      startAction(REWRITE.id);
      vi.mocked(toast).mockImplementationOnce(() => {
        throw new Error("boom");
      });
      await finishStream(ai.calls[0]!, "see [[No Such Note]]"); // cannot rebind -> unboundCount 1 -> a rebindNotice toast is sent after applying
      expect(vi.mocked(toast)).toHaveBeenCalledTimes(1); // fixture check: the throwing toast really was called
      const s = session.state;
      expect(s.phase).toBe("done");
      expect(s.phase === "done" && s.applied !== null).toBe(true);
      expect(docText()).toContain("No Such Note");
      act(() => session.revert());
      expect(docText()).toContain("alpha beta gamma");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("anchor indented during preview, then apply: returns false, shows the original-text-changed toast, document unchanged, no nested row", async () => {
    const { ai } = await mount({ doc: [P("prev", "p0"), P("x words", "x")] });
    openOn("x", 0, 1);
    startAction(SUMMARIZE.id);
    await finishStream(ai.calls[0]!, ROW2);
    expect(phase()).toBe("done");
    act(() => {
      editor.setTextCursorPosition("x", "end");
      editor.nestBlock();
    });
    expect(phase()).toBe("done"); // caret is inside the anchor, so no close
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

  it("AI content that makes the core parse throw: error state unsupported_block (not stuck streaming), the box shows the error text, nothing written, no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      // Mounted like SelectionAiBox.test does: SelectionAiController (renders the box) and Probe are both children of the host
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
      // The message is generic: this code also covers parse exceptions and event-handler attributes, not just block types.
      const alert = await within(region).findByRole("alert");
      expect(alert).toHaveTextContent("That content contains something this note can't store.");
      expect(alert).not.toHaveTextContent("block type");
      expect(docText()).toBe(before);
      expect(vi.mocked(replaceBlocksKeepColumns)).not.toHaveBeenCalled();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0)); // give unhandledRejection a chance to fire first
      });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  const ROW2 = `<div data-kb-columns style="display:flex;gap:16px">\n<div data-kb-column style="flex:1">\n\nA\n\n</div>\n<div data-kb-column style="flex:1.5">\n\nB\n\n</div>\n</div>`;
  it("anchor inside a column and the AI returns canonical columns: error state unsupported_columns; anchor at top level: auto-applies as one row", async () => {
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

  it("#305 (in-site AI half): the AI changes a single word, and after applying the image width and the column widths of both tables (including the empty paragraph in a merged header) are preserved", async () => {
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

  it("selecting only a paragraph's text whose indented child block is an image: a direct action does not auto-apply (hasNonTextBlock looks at descendants)", async () => {
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

  it("stream error gives the error state; retry resends the same request (including instruction and focus)", async () => {
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

  it("retry is unavailable after an auto-apply", async () => {
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

  /** Real check function (`createNoteSizeGuard`): the note is currently about `size` bytes (represented by another Y.Doc) and the limit is the current size plus `headroom`. */
  function realGuard(headroom: number) {
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "x".repeat(20_000));
    const limit = Y.encodeStateAsUpdate(doc).byteLength + headroom;
    const notified: number[] = [];
    const calls: number[] = [];
    const guard = createNoteSizeGuard(() => doc, () => limit, l => notified.push(l));
    return { notified, calls, guard: (g: number) => (calls.push(g), guard(g)) };
  }

  it("note size limit (real check): the AI returns a big table that would exceed the limit, so direct does not auto-apply (stays done, document untouched, no extra original-text-changed toast); manual apply also returns false", async () => {
    const g = realGuard(2_000);
    const { ai } = await mount({ sizeGuard: g.guard });
    openOn("p1", 0, 5);
    startAction(REWRITE.id);
    const table = "| a | b | c | d | e |\n|---|---|---|---|---|\n" + Array.from({ length: 30 }, (_, r) => `| ${r} | b | c | d | e |`).join("\n");
    await finishStream(ai.calls[0]!, table);
    const s = session.state;
    if (s.phase !== "done") throw new Error(`預期 done，實得 ${s.phase}`);
    expect(g.calls[0]).toBe(estimateBlocksBytes(s.prepared.blocks) - estimateBlocksBytes([editor.getBlock("p1")]));
    expect(g.calls[0]!).toBeGreaterThan(2_000);
    expect(s.applied).toBeNull();
    expect(g.notified).toHaveLength(1);
    expect(docText()).toContain("alpha beta gamma");
    expect(vi.mocked(toast)).not.toHaveBeenCalledWith({ title: i18n.t("ai.box.applyGuardFailed") });
    let applied = true;
    act(() => {
      applied = session.apply(true);
    });
    expect(applied).toBe(false);
    expect(phase()).toBe("done");
    expect(docText()).toContain("alpha beta gamma");
    expect(g.notified).toHaveLength(2);
  });

  it("note size limit (real check): with the same little room left, the AI rewrites to shorter text (minus the replaced original the growth is < 0) and auto-applies as usual", async () => {
    const g = realGuard(10);
    const { ai } = await mount({ sizeGuard: g.guard });
    openOn("p1", 0, 5);
    startAction(REWRITE.id);
    await finishStream(ai.calls[0]!, "ALPHA");
    expect(g.calls[0]!).toBeLessThan(0);
    expect(g.notified).toEqual([]);
    expect(docText()).toContain("ALPHA");
    expect(docText()).not.toContain("alpha beta gamma");
  });

  it("manual apply succeeds: returns to idle, document text replaced, highlight off", async () => {
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

  it("apply(false) (preview not ready) returns false, stays done, document untouched (previewReady is a precondition of apply)", async () => {
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

  it("manual apply hits the guard (anchor changed): toast, stays done, document untouched", async () => {
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

  it("cancel: aborts the stream, returns to idle, highlight off", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    act(() => session.cancel());
    expect(ai.calls[0]!.signal.aborted).toBe(true);
    expect(phase()).toBe("idle");
    await waitFor(() => expect(highlighted()).toBe(false));
  });

  it("close: done goes to idle, highlight off", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    await finishStream(ai.calls[0]!, "SUMMARY");
    act(() => session.close());
    expect(phase()).toBe("idle");
    await waitFor(() => expect(highlighted()).toBe(false));
  });

  it("auto-close: a non-empty selection outside the target in the done state closes the box and turns highlight off; onAutoClose is called once", async () => {
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

  it("auto-close: selecting outside the target while streaming does not close, nor does the moment streaming completes; the next selection change closes", async () => {
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

  it("auto-close: an empty selection (caret only) does not close; selecting inside the target does not close", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    await finishStream(ai.calls[0]!, "SUMMARY");
    placeCursor(editor, "p3", 2);
    expect(phase()).toBe("done");
    selectInBlock(editor, "p1", 6, 10);
    expect(phase()).toBe("done");
  });

  it("auto-close: input and error states behave the same - a non-empty selection outside the target closes the box and turns highlight off; onAutoClose is called once each", async () => {
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

  it("editable turning false: aborts the stream, returns to idle, highlight off", async () => {
    const { ai, host } = await mount();
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    host.rerenderHost({ editable: false });
    await waitFor(() => expect(phase()).toBe("idle"));
    expect(ai.calls[0]!.signal.aborted).toBe(true);
    await waitFor(() => expect(highlighted()).toBe(false));
  });

  it("noteId change: non-idle states return to idle, highlight off", async () => {
    const { ai, host } = await mount();
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    await finishStream(ai.calls[0]!, "SUMMARY");
    host.rerenderHost({ noteId: "note-2" });
    await waitFor(() => expect(phase()).toBe("idle"));
    await waitFor(() => expect(highlighted()).toBe(false));
  });

  it("open() from done (applied): the old result and revert entry are dropped and a new box opens on the current selection; calling open() while streaming does nothing", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(REWRITE.id);
    await finishStream(ai.calls[0]!, "REWRITTEN FIRST");
    const s = session.state;
    if (s.phase !== "done" || !s.applied) throw new Error("預期已自動套用");
    const insertedId = s.applied.insertedAnchor.blockIds[0]!;
    selectInBlock(editor, insertedId, 0, 3); // inside activeAnchor: auto-close does not close
    act(() => session.open());
    const reopened = session.state;
    if (reopened.phase !== "input") throw new Error(`預期 input，實得 ${reopened.phase}`);
    expect(reopened.target.anchor.blockIds).toEqual([insertedId]);
    startAction(SUMMARIZE.id);
    act(() => session.open());
    expect(phase()).toBe("streaming");
    expect(ai.calls).toHaveLength(2);
  });

  it("open() from input and error: likewise closes the old box first (the error's request is dropped) and then opens a new one on the current selection", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    selectInBlock(editor, "p1", 6, 10); // still inside the target: auto-close does not close
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

  it("selfWriteRef (auto-apply + revert half): a non-empty selection after the target while streaming, then direct auto-apply, then revert: the box stays and returns to unapplied; the auto-close callback is called 0 times", async () => {
    // White-box assertion on onAutoClose: without the flag, close() runs during the revert replacement, but the setState in revert()
    // that follows overwrites idle (same batch) and the box stays anyway, so state alone cannot catch it (removing the flag only fails the onAutoClose assertion).
    const onAutoClose = vi.fn();
    const { ai } = await mount({ onAutoClose });
    openOn("p1", 0, 5);
    startAction(REWRITE.id);
    selectInBlock(editor, "p3", 0, 5); // after the target; a replacement of different length shifts this selection and fires a selection change
    await finishStream(ai.calls[0]!, "A much longer rewritten first paragraph than before");
    expect(session.state.phase === "done" && session.state.applied !== null).toBe(true);
    act(() => session.revert());
    expect(onAutoClose).not.toHaveBeenCalled();
    const s = session.state;
    expect(s.phase).toBe("done");
    expect(s.phase === "done" && s.applied).toBeNull();
    expect(docText()).toContain("alpha beta gamma");
  });

  it("selfWriteRef (manual apply half, white-box): applying with the selection after the target calls the auto-close callback 0 times", async () => {
    const onAutoClose = vi.fn();
    const { ai } = await mount({ onAutoClose });
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    selectInBlock(editor, "p3", 0, 5); // select while streaming, which does not trigger auto-close; the selection is still in p3 after completion
    await finishStream(ai.calls[0]!, "A much longer summary than the original first paragraph");
    act(() => {
      session.apply(true);
    });
    expect(onAutoClose).not.toHaveBeenCalled();
    expect(phase()).toBe("idle");
  });

  it("a direct action does not auto-apply when the selection contains an image block (forces preview)", async () => {
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

  it("revert hitting a stale anchor (the inserted content was edited again): toast, applied cleared, document untouched", async () => {
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

  it("#269: the sent markdown writes a wikilink as [current title or label](/notes/<id>) (an exported copy, the document is untouched)", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    editor = createTestEditor([
      { id: "w1", type: "paragraph", content: ["see ", { type: "wikilink", props: { targetNoteId: id, snapshotTitle: "Old", label: "", anchorBlockId: "h1" } }, " end"] },
    ]);
    const ai = stubAiFetch({ actions: ACTIONS, notes: [{ id, title: "Live Title", slug: "live", ownerId: "u1", role: "owner", createdAt: "x", updatedAt: "x", slugIsCustom: false, prevSlug: null, ownerHandle: "alice", lastEdited: null, group: null, groupId: null, folderId: null, permissions: OWNER_PERMS }] });
    const host = renderAiHost({ editor, children: <Probe /> });
    await waitFor(() => expect(session.actions).toHaveLength(ACTIONS.length));
    await waitFor(() => expect(host.queryClient.getQueryData(["notes"])).toBeDefined()); // AiSessionProvider's useNotes fills the cache
    const before = JSON.stringify(editor.document);
    selectWholeBlocks(editor, "w1", "w1");
    act(() => session.open());
    startAction(REWRITE.id);
    expect(ai.calls[0]!.body.text).toContain(`[Live Title](/notes/${id}#b-h1)`);
    expect(JSON.stringify(editor.document)).toBe(before);
  });

  it("#269: open()'s focus (partial selection) also writes the wikilink as [current title](/notes/<id>)", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    editor = createTestEditor([
      { id: "w1", type: "paragraph", content: ["see ", { type: "wikilink", props: { targetNoteId: id, snapshotTitle: "Old", label: "", anchorBlockId: "h1" } }, " end"] },
    ]);
    stubAiFetch({ actions: ACTIONS, notes: [{ id, title: "Live Title", slug: "live", ownerId: "u1", role: "owner", createdAt: "x", updatedAt: "x", slugIsCustom: false, prevSlug: null, ownerHandle: "alice", lastEdited: null, group: null, groupId: null, folderId: null, permissions: OWNER_PERMS }] });
    const host = renderAiHost({ editor, children: <Probe /> });
    await waitFor(() => expect(session.actions).toHaveLength(ACTIONS.length));
    await waitFor(() => expect(host.queryClient.getQueryData(["notes"])).toBeDefined());
    // A wikilink is an atom occupying 1 position: "see " (4) + wikilink (1) = 5, so the selection ends before " end" (a partial selection, so focus is non-empty)
    openOn("w1", 0, 5);
    expect(session.state.phase === "input" && session.state.target.focus).toBe(`see [Live Title](/notes/${id}#b-h1)`);
  });

  it("#269: when the document stores an uppercase targetNoteId the sent text still uses the current title (id matching is case-insensitive)", async () => {
    const id = "abcdef12-3456-4abc-8def-0123456789ab"; // lowercase id as returned by the list (server)
    const upper = id.toUpperCase();
    expect(upper).not.toBe(id); // fixture check: it really has a-f letters that get uppercased
    editor = createTestEditor([
      { id: "w1", type: "paragraph", content: ["see ", { type: "wikilink", props: { targetNoteId: upper, snapshotTitle: "Old", label: "", anchorBlockId: "h1" } }, " end"] },
    ]);
    const ai = stubAiFetch({ actions: ACTIONS, notes: [{ id, title: "Live Title", slug: "live", ownerId: "u1", role: "owner", createdAt: "x", updatedAt: "x", slugIsCustom: false, prevSlug: null, ownerHandle: "alice", lastEdited: null, group: null, groupId: null, folderId: null, permissions: OWNER_PERMS }] });
    const host = renderAiHost({ editor, children: <Probe /> });
    await waitFor(() => expect(session.actions).toHaveLength(ACTIONS.length));
    await waitFor(() => expect(host.queryClient.getQueryData(["notes"])).toBeDefined());
    selectWholeBlocks(editor, "w1", "w1");
    act(() => session.open());
    startAction(REWRITE.id);
    expect(ai.calls[0]!.body.text).toContain(`[Live Title](/notes/${upper}#b-h1)`);
    expect(ai.calls[0]!.body.text).not.toContain("[Old]");
  });

  it("#269: the sent /notes/ link text is markdown-escaped; after the AI echoes it back the label is kept verbatim (a label stays empty when the text equals the current title)", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const note: NoteDto = { id, title: "[Draft] Plan *v2*", slug: "draft", ownerId: "u1", role: "owner", createdAt: "x", updatedAt: "x", slugIsCustom: false, prevSlug: null, ownerHandle: "alice", lastEdited: null, group: null, groupId: null, folderId: null, permissions: OWNER_PERMS };
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
    // `/notes/` link text goes through `escapeNoteLinkText`; since #386 ordinary text (including external link text) also escapes markup characters (`escapeTextNodes`), each escaped once.
    expect(sent).toContain("[k\\*z](https://example.com/x)");
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

// Columns: when the selection touches columns, each anchor block becomes its top-level ancestor (deduplicated, order kept); a selection entirely inside one column or not touching columns is unchanged.
describe("AiSession open() and columns: expanding to the whole row", () => {
  const TWO = () => [P("x", "x"), row([[P("a", "a1")], [P("b", "b1"), P("q", "q1")]], "r"), P("z", "z")];
  const THREE = () => [P("x", "x"), row([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")]], "r"), P("z", "z")];
  const NESTED = () => [P("x", "x"), row([[P("a", "a1")], [withChildren(P("p", "p1"), [P("c", "c1")])]], "r"), P("z", "z")];
  const ROW2 = `<div data-kb-columns style="display:flex;gap:16px">\n<div data-kb-column style="flex:1">\n\nA\n\n</div>\n<div data-kb-column style="flex:1.5">\n\nB\n\n</div>\n</div>`;
  const anchorIds = () => (session.state.phase === "idle" ? null : session.state.target.anchor.blockIds);
  function openRange(from: string, to: string): void {
    act(() => {
      editor.setSelection(from, to);
    });
    act(() => session.open());
  }
  function openInside(blockId: string): void {
    selectInBlock(editor, blockId, 0, 1);
    act(() => session.open());
  }
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each<[string, () => unknown[], string, string, string[]]>([
    ["across columns a..b", TWO, "a1", "b1", ["r"]],
    ["three columns a..c", THREE, "a1", "c1", ["r"]],
    ["from outside the row (x) into the row", TWO, "x", "b1", ["x", "r"]],
    ["from inside a column to outside the row (z)", TWO, "b1", "z", ["r", "z"]],
    ["from a nested child block of the last column to outside the row (z) (the column is the grandparent node)", NESTED, "c1", "z", ["r", "z"]],
  ])("%s: goes to input, anchor expands to the whole top-level row, highlight on", async (_name, doc, from, to, expected) => {
    await mount({ doc: doc() });
    openRange(from, to);
    expect(phase()).toBe("input");
    expect(anchorIds()).toEqual(expected);
    await waitFor(() => expect(highlighted()).toBe(true));
  });

  it("entirely inside a single column (b..q): opens as usual, the anchors are the two paragraphs in the column", async () => {
    await mount({ doc: TWO() });
    openRange("b1", "q1");
    const s = session.state;
    if (s.phase !== "input") throw new Error(`預期 input，實得 ${s.phase}`);
    expect(s.target.anchor.blockIds).toEqual(["b1", "q1"]);
  });

  it("no expansion when columns are not touched: an indented child block by itself, or from an indented child block to a top-level paragraph: anchors follow the selection list", async () => {
    await mount({ doc: [withChildren(P("p", "p"), [P("k", "k1")]), P("z", "z"), row([[P("a", "a1")], [P("b", "b1")]], "r")] });
    openInside("k1");
    expect(anchorIds()).toEqual(["k1"]);
    act(() => session.close());
    openRange("k1", "z");
    expect(anchorIds()).toEqual(["k1", "z"]);
  });

  it("focus is computed from the expanded anchor: b1 start to z end: Instruct sends focus b\\nq\\nz (column 1 is not selected); a1 start to q1 end (the whole row text): no focus", async () => {
    const { ai } = await mount({ doc: TWO() });
    selectText(editor, contentStart(editor, "b1"), contentEnd(editor, "z"));
    act(() => session.open());
    expect(anchorIds()).toEqual(["r", "z"]);
    startAction(INSTRUCT.id, "shorter");
    expect(ai.calls[0]!.body.focus).toBe("b\nq\nz");
    act(() => session.close());
    selectText(editor, contentStart(editor, "a1"), contentEnd(editor, "q1"));
    act(() => session.open());
    expect(anchorIds()).toEqual(["r"]);
    startAction(INSTRUCT.id, "shorter");
    expect(ai.calls[1]!.body).not.toHaveProperty("focus");
  });

  it("from an indented child block into a row, with the AI returning columns: the anchors are the parent paragraph and the row; after applying there is no nested row and the top level is the new row plus z", async () => {
    const { ai } = await mount({ doc: [withChildren(P("p", "p"), [P("k", "k1")]), row([[P("a", "a1")], [P("b", "b1")]], "r"), P("z", "z")] });
    openRange("k1", "b1");
    expect(anchorIds()).toEqual(["p", "r"]);
    startAction(SUMMARIZE.id);
    await finishStream(ai.calls[0]!, ROW2);
    expect(phase()).toBe("done");
    let applied = false;
    act(() => {
      applied = session.apply(true);
    });
    expect(applied).toBe(true);
    expect(integrity(editor)).toEqual({ dupIds: 0, nullIds: 0, nestedRows: 0, valid: true });
    expect(shape(editor)).toBe("ROW[COL(paragraph:A) | COL(paragraph:B)]  paragraph:z");
  });

  it("anchor is the whole row and quick direct changes the text of one column: after auto-apply the row still has two columns and column 1 is A; revert restores the original, still two columns", async () => {
    const { ai } = await mount({ doc: TWO() });
    const original = shape(editor);
    openRange("a1", "b1");
    expect(anchorIds()).toEqual(["r"]);
    startAction(REWRITE.id);
    const sent = ai.calls[0]!.body.text;
    expect(sent).toContain("\n\na\n\n"); // fixture check: the whole row was sent (including a in column 1)
    await finishStream(ai.calls[0]!, sent.replace("\n\na\n\n", "\n\nA\n\n"));
    expect(session.state.phase === "done" && session.state.applied !== null).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph:A) | COL(paragraph:b,paragraph:q)]  paragraph:z");
    act(() => session.revert());
    expect(session.state.phase === "done" && session.state.applied).toBeNull();
    expect(shape(editor)).toBe(original);
    expect(integrity(editor)).toEqual({ dupIds: 0, nullIds: 0, nestedRows: 0, valid: true });
  });

  it("after the anchor expands to the whole row, selecting another segment inside the row (selectionInsideAnchor) does not auto-close the box", async () => {
    const onAutoClose = vi.fn();
    await mount({ doc: TWO(), onAutoClose });
    openRange("a1", "b1");
    expect(anchorIds()).toEqual(["r"]);
    selectInBlock(editor, "q1", 0, 1);
    expect(phase()).toBe("input");
    expect(onAutoClose).not.toHaveBeenCalled();
    selectInBlock(editor, "z", 0, 1); // contrast: outside the row closes
    expect(phase()).toBe("idle");
  });

  it("the row's second column has an image and the selection runs from a1 to z (expands to [r, z]): quick direct does not auto-apply", async () => {
    const { ai } = await mount({ doc: [P("x", "x"), row([[P("a", "a1")], [IMG("i1")]], "r"), P("z", "z")] });
    const before = docText();
    openRange("a1", "z");
    expect(anchorIds()).toEqual(["r", "z"]);
    startAction(REWRITE.id);
    await finishStream(ai.calls[0]!, "T");
    const s = session.state;
    expect(s.phase).toBe("done");
    expect(s.phase === "done" && s.applied).toBeNull();
    expect(docText()).toBe(before);
    expect(vi.mocked(replaceBlocksKeepColumns)).not.toHaveBeenCalled();
  });
});

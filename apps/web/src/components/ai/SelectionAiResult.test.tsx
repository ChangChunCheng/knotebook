import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useEditorState } from "@blocknote/react";
import { REWRITE_ACTION_ID, SUMMARIZE_ACTION_ID, type AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { verifyAnchor } from "@/ai/anchor";
import { createTestEditor, renderAiHost, selectInBlock, stubAiFetch, type AiCall, type AnyEditor } from "@/test/ai-host";
import { activeAnchorOf, useAiSession, type AiSessionValue } from "./AiSession";
import { SelectionAiResult } from "./SelectionAiResult";

const REWRITE: AiActionDto = { id: REWRITE_ACTION_ID, name: "Rewrite", applyMode: "direct", kind: "quick" };
const SUMMARIZE: AiActionDto = { id: SUMMARIZE_ACTION_ID, name: "Summarize", applyMode: "preview", kind: "quick" };

const DOC = [
  { id: "p0", type: "paragraph", content: "context before" },
  { id: "p1", type: "paragraph", content: "alpha beta gamma" },
  { id: "p2", type: "paragraph", content: "context after" },
];

let session!: AiSessionValue;
let editor: AnyEditor;

/**
 * Mounts `SelectionAiResult` under the same condition as `SelectionAiBox`: only when `phase === "done"`; `anchorOk` comes from the active
 * anchor's `verifyAnchor`, recomputed on every editor transaction (same useEditorState form as in the box). The real box also re-verifies it once.
 */
function ResultHost() {
  session = useAiSession();
  const anchor = activeAnchorOf(session.state);
  const status = useEditorState({ editor, selector: ({ editor: current }) => (current && anchor ? verifyAnchor(current, anchor) : null) });
  return session.state.phase === "done" ? <SelectionAiResult state={session.state} anchorOk={status === "ok"} run={(action) => action()} /> : null;
}

async function mount() {
  editor = createTestEditor(DOC);
  const ai = stubAiFetch({ actions: [REWRITE, SUMMARIZE] });
  renderAiHost({
    editor,
    children: <ResultHost />,
  });
  await waitFor(() => expect(session.actions).toHaveLength(2));
  return ai;
}

async function runToDone(ai: { calls: AiCall[] }, actionId: string, result: string) {
  selectInBlock(editor, "p1", 0, 5);
  act(() => session.open());
  act(() => {
    session.start(actionId);
  });
  await act(async () => {
    const call = ai.calls.at(-1)!;
    call.delta(result);
    call.done();
  });
  await waitFor(() => expect(session.state.phase).toBe("done"));
}

const docText = () => JSON.stringify(editor.document);

describe("SelectionAiResult (#263 preview state, real lazy module)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("apply is enabled once the preview is ready; applying goes to idle and the document text changes", async () => {
    const ai = await mount();
    await runToDone(ai, SUMMARIZE.id, "SUMMARY TEXT");
    const apply = screen.getByRole("button", { name: "Apply" });
    await waitFor(() => expect(apply).toBeEnabled());
    fireEvent.click(apply);
    expect(session.state.phase).toBe("idle");
    expect(docText()).toContain("SUMMARY TEXT");
  });

  it("the preview shows only the changed blocks (inside .kb-ai-preview): the surrounding p0/p2 are not in it and there are no surround markers", async () => {
    const ai = await mount();
    await runToDone(ai, SUMMARIZE.id, "SUMMARY TEXT");
    const preview = await screen.findByTestId("selection-ai-preview");
    expect(preview.closest(".kb-ai-preview")).not.toBeNull();
    await waitFor(() => expect(preview).toHaveTextContent("SUMMARY TEXT"));
    expect(preview).toHaveTextContent("alpha beta gamma"); // the original (deleted) text is still present
    expect(preview).not.toHaveTextContent("context before");
    expect(preview).not.toHaveTextContent("context after");
    expect(preview.querySelector('[data-diff="surround"]')).toBeNull();
  });

  it("noChange shows the no-changes message and apply stays disabled once the preview is ready", async () => {
    const ai = await mount();
    await runToDone(ai, SUMMARIZE.id, "alpha beta gamma\r\n");
    expect(screen.getByText("No changes — the result is the same as the original text.")).toBeInTheDocument();
    await screen.findByTestId("selection-ai-preview");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("anchor changed (not applied): no apply, no retry, only discard; discard goes to idle", async () => {
    const ai = await mount();
    await runToDone(ai, SUMMARIZE.id, "SUMMARY TEXT");
    act(() => {
      editor.updateBlock("p1", { content: "changed by a collaborator" });
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(session.state.phase).toBe("idle");
  });

  it("after a direct auto-apply: the button row is revert/close; a successful revert returns to apply/discard/retry", async () => {
    const ai = await mount();
    await runToDone(ai, REWRITE.id, "REWRITTEN TEXT");
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect(docText()).toContain("alpha beta gamma");
    for (const name of ["Apply", "Discard", "Retry"]) expect(await screen.findByRole("button", { name })).toBeInTheDocument();
  });

  it("applied and the inserted content edited again: revert is disabled (canRevert is false once the anchor is invalid), only close remains usable", async () => {
    const ai = await mount();
    await runToDone(ai, REWRITE.id, "REWRITTEN TEXT");
    const s = session.state;
    if (s.phase !== "done" || !s.applied) throw new Error("預期已自動套用");
    act(() => {
      editor.updateBlock(s.applied!.insertedAnchor.blockIds[0]!, { content: "edited after apply" });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Revert" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
  });

  it("knowledge values that were not applied are listed under the preview, and a direct action stops there", async () => {
    const ai = await mount();
    await runToDone(ai, REWRITE.id, "## Fresh\n<!-- knotebook:knowledge\nid: k_00000005\nevidence: bogus\nsuperseded_by: nope\nOwner: bob\n-->\n\nbody");
    const list = await screen.findByTestId("selection-ai-ignored");
    expect(list).toHaveTextContent("These knowledge info values weren't applied");
    expect([...list.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "Fresh · Owner: bob — no such field",
      "Fresh · Basis: bogus — not one of the options",
      "Fresh · Replaced by: nope — not a valid knowledge reference",
    ]);
    expect(docText()).not.toContain("Fresh");
    expect(screen.getByRole("button", { name: "Apply" })).toBeInTheDocument();
  });

  it("the list shows at most ten lines and counts the rest", async () => {
    const ai = await mount();
    const lines = Array.from({ length: 12 }, (_, i) => `extra${i + 1}: v${i + 1}`).join("\n");
    await runToDone(ai, SUMMARIZE.id, `## Fresh\n<!-- knotebook:knowledge\nid: k_00000005\n${lines}\n-->\n\nbody`);
    const list = await screen.findByTestId("selection-ai-ignored");
    expect(list.querySelectorAll("li")).toHaveLength(10);
    expect(list).toHaveTextContent("and 2 more");
  });

  it("the list is written in the interface language", async () => {
    await i18n.changeLanguage("zh-TW");
    const ai = await mount();
    await runToDone(ai, SUMMARIZE.id, "## Fresh\n<!-- knotebook:knowledge\nid: k_00000005\nevidence: bogus\n-->\n\nbody");
    const list = await screen.findByTestId("selection-ai-ignored");
    expect(list).toHaveTextContent("這些知識資訊沒有套用");
    expect(list.querySelector("li")).toHaveTextContent("Fresh · 依據：bogus — 不是可選的選項");
  });

  it("a result without ignored knowledge shows no list", async () => {
    const ai = await mount();
    await runToDone(ai, SUMMARIZE.id, "SUMMARY TEXT");
    await screen.findByTestId("selection-ai-preview");
    expect(screen.queryByTestId("selection-ai-ignored")).not.toBeInTheDocument();
  });

  it("retry resends the same request", async () => {
    const ai = await mount();
    await runToDone(ai, SUMMARIZE.id, "SUMMARY TEXT");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(ai.calls).toHaveLength(2);
    expect(ai.calls[1]!.body).toEqual(ai.calls[0]!.body);
  });
});

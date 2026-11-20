import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { INSTRUCT_ACTION_ID, REWRITE_ACTION_ID, SUMMARIZE_ACTION_ID, type AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { createTestEditor, renderAiHost, selectInBlock, stubAiFetch, type AiCall, type AnyEditor } from "@/test/ai-host";
import { P, row } from "@/test/columns-fixtures";
import { useAiSession, type AiSessionValue } from "./AiSession";
import { SelectionAiController } from "./SelectionAiController";

const REWRITE: AiActionDto = { id: REWRITE_ACTION_ID, name: "Rewrite", applyMode: "direct", kind: "quick" };
const SUMMARIZE: AiActionDto = { id: SUMMARIZE_ACTION_ID, name: "Summarize", applyMode: "preview", kind: "quick" };
const INSTRUCT: AiActionDto = { id: INSTRUCT_ACTION_ID, name: "Instruct", applyMode: "preview", kind: "instruct" };
const CUSTOM: AiActionDto = { id: "11111111-2222-4333-8444-555555555555", name: "Make it formal", applyMode: "preview", kind: "quick" };

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
const box = () => screen.queryByTestId("selection-ai-box");
const editorHasFocus = () => !!editor.domElement && editor.domElement.contains(document.activeElement);

/** Host mounted like NoteEditor really does: `SelectionAiController` (which renders the toolbar and the box) is a child of `NoteEditorView`. */
async function mount(opts: { actions?: AiActionDto[]; editable?: boolean; doc?: unknown[] } = {}) {
  editor = createTestEditor(opts.doc ?? DOC);
  const actions = opts.actions ?? [REWRITE, SUMMARIZE, INSTRUCT];
  const ai = stubAiFetch({ actions });
  const host = renderAiHost({
    editor,
    editable: opts.editable,
    children: (
      <>
        <SelectionAiController />
        <Probe />
      </>
    ),
  });
  await waitFor(() => expect(session.actions).toHaveLength(actions.length));
  return { ai, host };
}

async function openViaToolbar(blockId = "p1", start = 0, end = 5): Promise<HTMLElement> {
  selectInBlock(editor, blockId, start, end);
  fireEvent.click(await screen.findByRole("button", { name: "AI" }));
  return screen.findByTestId("selection-ai-box");
}

/** Waits one macrotask (lets the setTimeout(0) focus re-read scheduled by pointerdown run first). */
async function nextMacrotask(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function finish(call: AiCall, text: string): Promise<void> {
  await act(async () => {
    call.delta(text);
    call.done();
  });
  await waitFor(() => expect(session.state.phase).not.toBe("streaming"));
}

describe("SelectionAiBox (#263)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens: region (not dialog), aria-label, focus goes to the input; chips are icons with their names in aria-label/title", async () => {
    await mount({ actions: [REWRITE, CUSTOM, INSTRUCT] });
    const region = await openViaToolbar();
    expect(region).toHaveAttribute("role", "region");
    expect(region).toHaveAttribute("aria-label", "AI on selection");
    const input = within(region).getByRole("textbox", { name: "Instruction for the selected text" });
    expect(document.activeElement).toBe(input);
    const rewrite = within(region).getByRole("button", { name: "Rewrite" });
    expect(rewrite).toHaveAttribute("title", "Rewrite");
    expect(rewrite.querySelector('svg[data-icon="pen-line"]')).not.toBeNull();
    expect(within(region).getByRole("button", { name: "Make it formal" }).querySelector('svg[data-icon="sparkles"]')).not.toBeNull();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("without an Instruct action: input and send button are not rendered, focus lands on the first chip; Esc inside the box closes it and focus returns to the editor", async () => {
    await mount({ actions: [REWRITE, SUMMARIZE] });
    const region = await openViaToolbar();
    expect(within(region).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(region).queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(within(region).getByRole("button", { name: "Rewrite" }));
    // Returns false = the event was preventDefault-ed (NotePage's page-wide Esc gives up on defaultPrevented, so it does not also close the version preview)
    expect(fireEvent.keyDown(document.activeElement!, { key: "Escape" })).toBe(false);
    expect(session.state.phase).toBe("idle");
    expect(editorHasFocus()).toBe(true);
  });

  it("Enter sends (trimmed) and focus goes to the cancel button; while streaming, Esc inside the box cancels, returns to idle and focus returns to the editor", async () => {
    const { ai } = await mount();
    const region = await openViaToolbar();
    const input = within(region).getByRole("textbox");
    fireEvent.change(input, { target: { value: "  make it shorter  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(ai.calls[0]!.body.instruction).toBe("make it shorter");
    const cancel = await within(region).findByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: "Escape" });
    expect(ai.calls[0]!.signal.aborted).toBe(true);
    expect(session.state.phase).toBe("idle");
    expect(editorHasFocus()).toBe(true);
  });

  it("Enter while an IME is composing does not send, nor does Shift+Enter", async () => {
    const { ai } = await mount();
    const region = await openViaToolbar();
    const input = within(region).getByRole("textbox");
    fireEvent.change(input, { target: { value: "改短一點" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(ai.calls).toHaveLength(0);
  });

  it("input beyond 500 code points is rejected (an emoji counts as 1 and is never cut in half)", async () => {
    await mount();
    const region = await openViaToolbar();
    const input = within(region).getByRole<HTMLTextAreaElement>("textbox");
    fireEvent.change(input, { target: { value: "😀".repeat(501) } });
    expect(Array.from(input.value)).toHaveLength(500);
    expect(input.value).toBe("😀".repeat(500));
  });

  it("focus inside the box at completion: focus goes to the box container (not to any button)", async () => {
    const { ai } = await mount();
    const region = await openViaToolbar();
    fireEvent.click(within(region).getByRole("button", { name: "Summarize" }));
    expect(document.activeElement).toBe(within(region).getByRole("button", { name: "Cancel" }));
    await finish(ai.calls[0]!, "SUMMARY");
    expect(document.activeElement).toBe(screen.getByTestId("selection-ai-box"));
  });

  it("focus in the editor at completion: focus stays put (recorded as not-in-box before the cancel button unmounts)", async () => {
    const { ai } = await mount();
    const region = await openViaToolbar();
    fireEvent.click(within(region).getByRole("button", { name: "Summarize" }));
    act(() => editor.focus());
    expect(editorHasFocus()).toBe(true);
    await finish(ai.calls[0]!, "SUMMARY");
    expect(editorHasFocus()).toBe(true);
  });

  it("clicking a non-focusable spot outside the box before completion (focus falls to body, only focusout fires): focus is not pulled into the box at completion", async () => {
    const { ai } = await mount();
    const region = await openViaToolbar();
    fireEvent.click(within(region).getByRole("button", { name: "Summarize" }));
    const cancel = within(region).getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);
    // A real browser click on a non-focusable page background: pointerdown first, then focus drops to body (only blur/focusout, no focusin).
    fireEvent.pointerDown(document.body);
    act(() => cancel.blur());
    expect(document.activeElement).toBe(document.body);
    await nextMacrotask(); // the re-read scheduled by pointerdown runs after the focus move
    await finish(ai.calls[0]!, "SUMMARY");
    expect(document.activeElement).toBe(document.body);
  });

  it("pressing outside the box before completion without moving focus (touch scroll, dragging an outside scrollbar, an external component swallowing mousedown): focus still goes to the box container at completion", async () => {
    const { ai } = await mount();
    const region = await openViaToolbar();
    fireEvent.click(within(region).getByRole("button", { name: "Summarize" }));
    const cancel = within(region).getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.pointerDown(document.body);
    await nextMacrotask();
    expect(document.activeElement).toBe(cancel);
    await finish(ai.calls[0]!, "SUMMARY");
    expect(document.activeElement).toBe(screen.getByTestId("selection-ai-box"));
  });

  it("an instruction of only whitespace (including full-width space U+3000 and tab) is not sent on Enter", async () => {
    const { ai } = await mount();
    const region = await openViaToolbar();
    const input = within(region).getByRole("textbox");
    fireEvent.change(input, { target: { value: "\u3000 \t" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(ai.calls).toHaveLength(0);
    expect(session.state.phase).toBe("input");
  });

  it("Esc inside the editor does not close the box (only Esc inside the box counts)", async () => {
    await mount();
    await openViaToolbar();
    act(() => editor.focus());
    fireEvent.keyDown(editor.domElement!, { key: "Escape" });
    expect(session.state.phase).toBe("input");
    expect(box()).toBeInTheDocument();
  });

  it("close button (X) in the input state: closes the box, returns to idle, focus returns to the editor (focus was inside the box before the click)", async () => {
    await mount();
    const region = await openViaToolbar();
    expect(document.activeElement).toBe(within(region).getByRole("textbox"));
    fireEvent.click(within(region).getByRole("button", { name: "Close" }));
    expect(session.state.phase).toBe("idle");
    await waitFor(() => expect(box()).not.toBeInTheDocument());
    expect(editorHasFocus()).toBe(true);
  });

  it("reopening starts with an empty input (the old instruction is not reused)", async () => {
    await mount();
    let region = await openViaToolbar();
    fireEvent.change(within(region).getByRole("textbox"), { target: { value: "old instruction" } });
    fireEvent.keyDown(within(region).getByRole("textbox"), { key: "Escape" });
    await waitFor(() => expect(box()).not.toBeInTheDocument());
    region = await openViaToolbar("p2", 0, 6);
    expect(within(region).getByRole("textbox")).toHaveValue("");
  });

  it("anchor changed (input state): shows the original-text-changed notice, send and chips are hidden, only discard remains", async () => {
    await mount();
    const region = await openViaToolbar();
    act(() => {
      editor.updateBlock("p1", { content: "changed by a collaborator" });
    });
    expect(await within(region).findByText("The original text has changed since this was opened.")).toBeInTheDocument();
    expect(within(region).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(region).queryByRole("button", { name: "Rewrite" })).not.toBeInTheDocument();
    fireEvent.click(within(region).getByRole("button", { name: "Discard" }));
    expect(session.state.phase).toBe("idle");
  });

  it("anchor changed while streaming: shows the notice, the button row is discard + cancel; discard aborts and returns to idle", async () => {
    const { ai } = await mount();
    const region = await openViaToolbar();
    fireEvent.click(within(region).getByRole("button", { name: "Summarize" }));
    act(() => {
      editor.updateBlock("p1", { content: "changed by a collaborator" });
    });
    expect(await within(region).findByText("The original text has changed since this was opened.")).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    fireEvent.click(within(region).getByRole("button", { name: "Discard" }));
    expect(ai.calls[0]!.signal.aborted).toBe(true);
    expect(session.state.phase).toBe("idle");
  });

  it("anchor block deleted: the box stays (keeps the last position), shows the notice, only discard remains", async () => {
    await mount();
    const region = await openViaToolbar("p2", 0, 6);
    act(() => {
      editor.removeBlocks(["p2"]);
    });
    expect(await within(region).findByText("The original text has changed since this was opened.")).toBeInTheDocument();
    expect(screen.getByTestId("selection-ai-box")).toBe(region);
    expect(within(region).getByRole("button", { name: "Discard" })).toBeInTheDocument();
  });

  it("streaming state: Instruct shows \"Your instruction\", quick shows the action name; error state shows the errors.<code> text plus retry/close", async () => {
    const { ai } = await mount();
    let region = await openViaToolbar();
    fireEvent.change(within(region).getByRole("textbox"), { target: { value: "x" } });
    fireEvent.keyDown(within(region).getByRole("textbox"), { key: "Enter" });
    expect(within(region).getByText("Your instruction")).toBeInTheDocument();
    fireEvent.click(within(region).getByRole("button", { name: "Cancel" }));
    region = await openViaToolbar();
    fireEvent.click(within(region).getByRole("button", { name: "Summarize" }));
    expect(within(region).getByText("Summarize")).toBeInTheDocument();
    await act(async () => {
      ai.calls[1]!.fail("upstream_error");
    });
    expect(await within(region).findByRole("alert")).toHaveTextContent(i18n.t("errors.upstream_error"));
    expect(within(region).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("width = first block width of the active anchor plus left/right frame, capped at the visible width minus 16px", async () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return this.matches('.bn-block-outer[data-id="p1"]') ? new DOMRect(0, 0, 500, 24) : new DOMRect(0, 0, 0, 0);
    });
    await mount();
    const region = await openViaToolbar();
    // jsdom serializes the arguments of min() inaccurately, so only the number and the cap parts are pinned
    await waitFor(() => expect(region.style.width).toContain("502px"));
    expect(region.style.width).toContain("calc(100vw - 16px)");
    expect(region).toHaveClass("max-w-[calc(100vw-16px)]");
  });

  it("anchor expanded to a whole row: width measures the row node ([data-node-type=columnList][data-id]) plus left/right frame", async () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return this.matches('[data-node-type="columnList"][data-id="r"]') ? new DOMRect(0, 0, 600, 24) : new DOMRect(0, 0, 0, 0);
    });
    await mount({ doc: [P("x", "x"), row([[P("a", "a1")], [P("b", "b1")]], "r"), P("z", "z")] });
    act(() => {
      editor.setSelection("a1", "b1");
    });
    fireEvent.click(await screen.findByRole("button", { name: "AI" }));
    const region = await screen.findByTestId("selection-ai-box");
    expect(session.state.phase === "input" && session.state.target.anchor.blockIds).toEqual(["r"]);
    await waitFor(() => expect(region.style.width).toContain("602px"));
  });

  it("editable false (viewer): the box is not rendered", async () => {
    const { host } = await mount();
    await openViaToolbar();
    host.rerenderHost({ editable: false });
    await waitFor(() => expect(box()).not.toBeInTheDocument());
  });

  it("preview state through the real box: applying closes the box and focus returns to the editor (focus was inside the box before the action)", async () => {
    const { ai } = await mount();
    const region = await openViaToolbar();
    fireEvent.click(within(region).getByRole("button", { name: "Summarize" }));
    await finish(ai.calls[0]!, "SUMMARY TEXT");
    const apply = await within(screen.getByTestId("selection-ai-box")).findByRole("button", { name: "Apply" });
    await waitFor(() => expect(apply).toBeEnabled());
    fireEvent.click(apply);
    expect(session.state.phase).toBe("idle");
    await waitFor(() => expect(box()).not.toBeInTheDocument());
    expect(editorHasFocus()).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { DEFAULT_KNOWLEDGE_FIELD_VIEW, REWRITE_ACTION_ID, type AiActionDto, type KnowledgeFieldView } from "@knotebook/shared";
import i18n from "@/i18n";
import { knowledgeFieldsKey } from "@/api/knowledge-fields";
import { fieldView } from "@/components/knowledge/test-support";
import { createTestEditor, renderAiHost, selectWholeBlocks, stubAiFetch, type AiCall, type AiHostProps, type AnyEditor } from "@/test/ai-host";
import { useAiSession, type AiSessionValue } from "./AiSession";

const REWRITE: AiActionDto = { id: REWRITE_ACTION_ID, name: "Rewrite", applyMode: "direct", kind: "quick" };
const KNOWLEDGE = { knowledgeId: "k_00000001", knowledgeWhen: "when it matters", knowledgeConclusion: "keep it", knowledgeEvidence: "docs" };
const DOC = [
  { id: "h1", type: "heading", props: { level: 2, ...KNOWLEDGE }, content: "Title" },
  { id: "p1", type: "paragraph", content: "body text" },
  { id: "p2", type: "paragraph", content: "untouched" },
];

let session!: AiSessionValue;
function Probe() {
  session = useAiSession();
  return null;
}
let editor: AnyEditor;

async function run(opts: { knowledgeFields?: AiHostProps["knowledgeFields"]; served?: KnowledgeFieldView; range?: [string, string] } = {}): Promise<AiCall> {
  editor = createTestEditor(DOC);
  const ai = stubAiFetch({ actions: [REWRITE], ...(opts.served ? { knowledgeFields: opts.served } : {}) });
  const host = renderAiHost({ editor, knowledgeFields: opts.knowledgeFields, children: <Probe /> });
  await waitFor(() => expect(session.actions).toHaveLength(1));
  if (opts.knowledgeFields === "fetch") {
    await waitFor(() => expect(host.queryClient.getQueryState(knowledgeFieldsKey({ noteId: "note-1" }))?.status).toBe("success"));
  }
  selectWholeBlocks(editor, ...(opts.range ?? ["h1", "p1"]));
  act(() => session.open());
  act(() => {
    session.start(REWRITE_ACTION_ID);
  });
  await waitFor(() => expect(ai.calls).toHaveLength(1));
  return ai.calls[0]!;
}

async function reply(call: AiCall, text: string): Promise<void> {
  await act(async () => {
    call.delta(text);
    call.done();
  });
  await waitFor(() => expect(session.state.phase).not.toBe("streaming"));
}

const heading = () => (editor.getBlock("h1") ?? editor.document.find((b) => b.type === "heading"))!.props as Record<string, string>;
const doneState = () => {
  const state = session.state;
  if (state.phase !== "done") throw new Error(`expected done, got ${state.phase}`);
  return state;
};

describe("AI box with knowledge", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends the selected knowledge heading with its comment", async () => {
    const call = await run();
    expect(call.body.text).toContain("## Title\n<!-- knotebook:knowledge\nid: k_00000001\n");
    expect(call.body.text).toContain("when: when it matters");
  });

  it("a reply that drops the comment but keeps the heading is applied with the knowledge kept", async () => {
    const call = await run();
    await reply(call, "## Title\n\nrewritten body");
    expect(session.state.phase).toBe("done");
    expect(JSON.stringify(editor.document)).toContain("rewritten body");
    expect(heading()).toMatchObject(KNOWLEDGE);
  });

  it("a reply with a malformed knowledge comment ends in the error state and changes nothing", async () => {
    const call = await run();
    await reply(call, "## Title\n<!-- knotebook:knowledge\nid: k_00000001\nwhen: a\nwhen: b\n-->\n\nrewritten body");
    expect(session.state).toMatchObject({ phase: "error", code: "invalid_knowledge" });
    expect(JSON.stringify(editor.document)).not.toContain("rewritten body");
    expect(heading()).toMatchObject(KNOWLEDGE);
  });

  it("a quick action with ignored knowledge stops at the preview instead of applying", async () => {
    const call = await run();
    await reply(call, "## Title\n<!-- knotebook:knowledge\nid: k_00000001\nwhen: when it matters\nconclusion: keep it\nevidence: bogus\nOwner: bob\n-->\n\nrewritten body");
    expect(doneState().applied).toBeNull();
    expect(doneState().prepared.ignoredKnowledge).toEqual([
      { heading: "Title", key: "Owner", value: "bob", reason: "unknown_field" },
      { heading: "Title", key: "evidence", value: "bogus", reason: "not_an_option" },
    ]);
    expect(JSON.stringify(editor.document)).not.toContain("rewritten body");
    act(() => {
      session.apply(true);
    });
    expect(JSON.stringify(editor.document)).toContain("rewritten body");
    expect(heading()).toMatchObject({ ...KNOWLEDGE, knowledgeEvidence: "docs" });
  });

  it("with the fields provider outside the session provider, as in NoteEditor, the request leaves out a turned-off field", async () => {
    const call = await run({ knowledgeFields: "fetch", served: fieldView({ off: ["when"] }) });
    expect(call.body.text).toContain("<!-- knotebook:knowledge\nid: k_00000001\n");
    expect(call.body.text).toContain("conclusion: keep it");
    expect(call.body.text).not.toContain("when:");
    await reply(call, call.body.text.replace("conclusion: keep it", "conclusion: revised"));
    expect(doneState().prepared.ignoredKnowledge).toEqual([]);
    expect(heading()).toMatchObject({ ...KNOWLEDGE, knowledgeConclusion: "revised" });
  });

  it.each(["loading", "error"] as const)("with fields %s the request has no knowledge comments, the result stays in preview and a heading's knowledge is kept", async (status) => {
    const call = await run({ knowledgeFields: { view: DEFAULT_KNOWLEDGE_FIELD_VIEW, status } });
    expect(call.body.text).toContain("## Title");
    expect(call.body.text).not.toContain("knotebook:knowledge");
    await reply(call, "## Title\n\nrewritten body");
    expect(doneState().applied).toBeNull();
    expect(doneState().prepared.ignoredKnowledge).toEqual([]);
    expect(JSON.stringify(editor.document)).not.toContain("rewritten body");
    act(() => {
      session.apply(true);
    });
    expect(JSON.stringify(editor.document)).toContain("rewritten body");
    expect(heading()).toMatchObject(KNOWLEDGE);
  });

  it.each(["loading", "error"] as const)("with fields %s a direct action on plain text without knowledge is still applied", async (status) => {
    const call = await run({ knowledgeFields: { view: DEFAULT_KNOWLEDGE_FIELD_VIEW, status }, range: ["p2", "p2"] });
    await reply(call, "rewritten plain text");
    expect(doneState().applied).not.toBeNull();
    expect(JSON.stringify(editor.document)).toContain("rewritten plain text");
    expect(heading()).toMatchObject(KNOWLEDGE);
  });

  it.each(["loading", "error"] as const)("with fields %s a knowledge comment the AI adds to plain text is listed and stops at the preview", async (status) => {
    const call = await run({ knowledgeFields: { view: DEFAULT_KNOWLEDGE_FIELD_VIEW, status }, range: ["p2", "p2"] });
    await reply(call, "## Fresh\n<!-- knotebook:knowledge\nwhen: x\n-->\n\nrewritten plain text");
    expect(doneState().applied).toBeNull();
    expect(doneState().prepared.ignoredKnowledge).toEqual([{ heading: "Fresh", key: "when", value: "x", reason: "field_disabled" }]);
    expect(JSON.stringify(editor.document)).not.toContain("rewritten plain text");
  });

  it("with fields in error a knowledge comment the AI writes on its own is reported as field_disabled, not accepted", async () => {
    const call = await run({ knowledgeFields: { view: DEFAULT_KNOWLEDGE_FIELD_VIEW, status: "error" } });
    await reply(call, "## Title\n<!-- knotebook:knowledge\nwhen: x\n-->\n\nrewritten body");
    const prepared = doneState().prepared;
    expect((prepared.blocks[0]!.props as Record<string, string>).knowledgeWhen).toBe("when it matters");
    expect(prepared.ignoredKnowledge).toEqual([{ heading: "Title", key: "when", value: "x", reason: "field_disabled" }]);
  });

  it("a reply with a raw data-knowledge attribute does not set knowledge", async () => {
    const call = await run();
    await reply(call, '<h2 data-knowledge-id="k_000000ff" data-knowledge-when="x">Other</h2>\n\nrewritten body');
    expect(JSON.stringify(editor.document)).toContain("rewritten body");
    expect(JSON.stringify(editor.document)).not.toContain("k_000000ff");
  });
});

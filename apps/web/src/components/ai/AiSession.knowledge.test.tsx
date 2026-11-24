import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";
import {
  DEFAULT_KNOWLEDGE_FIELD_VIEW, REWRITE_ACTION_ID, type AiActionDto, type KnowledgeFieldView, type KnowledgeMembersDto, type KnowledgeMembersRequest,
} from "@knotebook/shared";
import i18n from "@/i18n";
import { knowledgeFieldsKey } from "@/api/knowledge-fields";
import { customFieldView, fieldView } from "@/components/knowledge/test-support";
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

let memberLookups: KnowledgeMembersRequest[] = [];
let memberSignals: AbortSignal[] = [];
let aiCalls: AiCall[] = [];

async function run(
  opts: {
    knowledgeFields?: AiHostProps["knowledgeFields"];
    served?: KnowledgeFieldView;
    range?: [string, string];
    doc?: unknown[];
    members?: (body: KnowledgeMembersRequest) => KnowledgeMembersDto | "hang";
    /** false: return as soon as the action starts, before the AI request goes out. */
    awaitCall?: boolean;
  } = {},
): Promise<AiCall> {
  editor = createTestEditor(opts.doc ?? DOC);
  const ai = stubAiFetch({ actions: [REWRITE], ...(opts.served ? { knowledgeFields: opts.served } : {}), ...(opts.members ? { members: opts.members } : {}) });
  memberLookups = ai.memberLookups;
  memberSignals = ai.memberSignals;
  aiCalls = ai.calls;
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
  if (opts.awaitCall === false) return undefined as never;
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

  describe("member fields", () => {
    const BOB = "aaaaaaaa-0000-4000-8000-000000000002";
    const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
    const MEMBER = customFieldView([{ key: "owner", type: "member", name: "Owner" }]);
    const MEMBER_DOC = [{ ...DOC[0]!, props: { ...DOC[0]!.props, knowledgeCustom: JSON.stringify({ owner: BOB }) } }, DOC[1]!, DOC[2]!];
    const directory = (body: KnowledgeMembersRequest): KnowledgeMembersDto => ({
      byId: (body.ids ?? []).filter((id) => id === BOB).map((id) => ({ id, handle: "bob", displayName: "Bob" })),
      byToken: (body.tokens ?? []).filter((t) => t === "alice").map((token) => ({ token, id: ALICE })),
    });

    it("the request writes a stored member by the handle looked up first", async () => {
      const call = await run({ doc: MEMBER_DOC, knowledgeFields: { view: MEMBER, status: "ready" }, members: directory });
      expect(memberLookups).toEqual([{ noteId: "note-1", ids: [BOB] }]);
      expect(call.body.text).toContain("x-owner: bob");
    });

    it("when the lookup fails the stored member is sent as user:<id>", async () => {
      const call = await run({ doc: MEMBER_DOC, knowledgeFields: { view: MEMBER, status: "ready" } });
      expect(call.body.text).toContain(`x-owner: user:${BOB}`);
    });

    it("a member the AI names by handle is looked up and stored as the user id", async () => {
      const call = await run({ doc: MEMBER_DOC, knowledgeFields: { view: MEMBER, status: "ready" }, members: directory });
      await reply(call, call.body.text.replace("x-owner: bob", "x-owner: ALICE"));
      expect(memberLookups.at(-1)).toEqual({ noteId: "note-1", tokens: ["alice"] });
      expect(doneState().prepared.ignoredKnowledge).toEqual([]);
      expect(heading().knowledgeCustom).toBe(JSON.stringify({ owner: ALICE }));
    });

    it("when resolving fails the named member is listed as unresolved and the stored one stays", async () => {
      let lookups = 0;
      const call = await run({
        doc: MEMBER_DOC,
        knowledgeFields: { view: MEMBER, status: "ready" },
        members: (body) => {
          lookups += 1;
          if (lookups > 1) throw new Error("down");
          return directory(body);
        },
      });
      await reply(call, call.body.text.replace("x-owner: bob", "x-owner: alice"));
      expect(doneState().applied).toBeNull();
      expect(doneState().prepared.ignoredKnowledge).toEqual([{ heading: "Title", key: "x-owner", value: "alice", reason: "unresolved_member" }]);
      expect((doneState().prepared.blocks[0]!.props as Record<string, string>).knowledgeCustom).toBe(JSON.stringify({ owner: BOB }));
    });

    it("the stored member written back keeps its heading, and the same member moved to another heading is looked up and stored", async () => {
      const withBob = (body: KnowledgeMembersRequest): KnowledgeMembersDto => ({
        ...directory(body),
        byToken: (body.tokens ?? []).flatMap((token) => (token === "bob" ? [{ token, id: BOB }] : token === "alice" ? [{ token, id: ALICE }] : [])),
      });
      const call = await run({ doc: MEMBER_DOC, knowledgeFields: { view: MEMBER, status: "ready" }, members: withBob });
      await reply(call, `${call.body.text.replace("body text", "rewritten body")}\n\n## Second\n<!-- knotebook:knowledge\nx-owner: bob\n-->\n\nmore`);
      expect(memberLookups.at(-1)).toEqual({ noteId: "note-1", tokens: ["bob"] });
      expect(doneState().prepared.ignoredKnowledge).toEqual([]);
      const customs = editor.document.filter((b) => b.type === "heading").map((b) => (b.props as Record<string, string>).knowledgeCustom);
      expect(customs).toEqual([JSON.stringify({ owner: BOB }), JSON.stringify({ owner: BOB })]);
    });

    it("cancelling while the handles are looked up aborts the lookup and sends nothing", async () => {
      await run({ doc: MEMBER_DOC, knowledgeFields: { view: MEMBER, status: "ready" }, members: () => "hang", awaitCall: false });
      await waitFor(() => expect(memberSignals).toHaveLength(1));
      expect(session.state.phase).toBe("streaming");
      act(() => session.cancel());
      expect(memberSignals[0]!.aborted).toBe(true);
      expect(session.state.phase).toBe("idle");
      await new Promise((r) => setTimeout(r, 50));
      expect(aiCalls).toHaveLength(0);
    });

    it("a handle lookup that never answers times out and the request writes user:<id>", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        await run({ doc: MEMBER_DOC, knowledgeFields: { view: MEMBER, status: "ready" }, members: () => "hang", awaitCall: false });
        await waitFor(() => expect(memberSignals).toHaveLength(1));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_000);
        });
        await waitFor(() => expect(aiCalls).toHaveLength(1));
        expect(memberSignals[0]!.aborted).toBe(true);
        expect(aiCalls[0]!.body.text).toContain(`x-owner: user:${BOB}`);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a token lookup that never answers times out and the named member is listed as unresolved", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const call = await run({ doc: MEMBER_DOC, knowledgeFields: { view: MEMBER, status: "ready" }, members: (body) => (body.tokens ? "hang" : directory(body)) });
        await act(async () => {
          call.delta(call.body.text.replace("x-owner: bob", "x-owner: alice"));
          call.done();
        });
        await waitFor(() => expect(memberSignals).toHaveLength(2));
        expect(session.state.phase).toBe("streaming");
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_000);
        });
        await waitFor(() => expect(session.state.phase).toBe("done"));
        expect(doneState().prepared.ignoredKnowledge).toEqual([{ heading: "Title", key: "x-owner", value: "alice", reason: "unresolved_member" }]);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

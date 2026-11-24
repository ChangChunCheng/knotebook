import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DEFAULT_KNOWLEDGE_FIELD_VIEW, resolveKnowledgeFieldView } from "@knotebook/shared";
import { DOC_TOO_COMPLEX, executeDocOp } from "../../src/notes/editing/doc-jobs.js";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { exportNoteForTransfer } from "../../src/transfer/export-note.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
async function docWith(blocks: unknown[]): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const s = await EditorSession.open(rt, doc);
  try {
    s.editor.replaceBlocks(s.editor.document, blocks as never);
  } finally {
    s.close();
  }
  return doc;
}

const knowledgeProps = (i: number) => ({ knowledgeId: `k_${String(i + 1).padStart(8, "0")}`, knowledgeWhen: `when ${i}`, knowledgeConclusion: `conclusion ${i}`, knowledgeEvidence: "tested" });
const note = (n: number, withKnowledge: boolean): unknown[] =>
  Array.from({ length: n }, (_, i) => [
    { type: "heading", props: { level: 2, ...(withKnowledge ? knowledgeProps(i) : {}) }, content: `Heading ${i}` },
    { type: "paragraph", content: `body ${i}` },
    ...(i % 7 === 0 ? [{ type: "bulletListItem", content: `item ${i}` }, { type: "bulletListItem", content: `item ${i}b` }] : []),
  ]).flat();

describe("a note with knowledge comments downloads like one without, plus the comment lines", () => {
  it("the segment table has no more fallback grouping calls or cap hits than the same note without knowledge, and every heading's segment holds its comment lines", async () => {
    const n = 120;
    const plain = await exportNoteForTransfer(rt, await docWith(note(n, false)), new Map());
    const rich = await exportNoteForTransfer(rt, await docWith(note(n, true)), new Map());
    expect(plain.segments).not.toBeNull();
    expect(rich.segments).not.toBeNull();
    expect(rich.stats.groupCalls).toBe(plain.stats.groupCalls);
    expect(rich.stats.capHits).toBe(plain.stats.capHits);
    expect(rich.stats.groupUsedWhilePerMatched).toBe(plain.stats.groupUsedWhilePerMatched);
    expect(rich.segments!.length).toBe(plain.segments!.length);
    const heading = (i: number) => rich.segments!.find(s => rich.lines[s.start] === `## Heading ${i}`)!;
    for (const i of [0, 1, 7, 60, n - 1]) {
      const seg = heading(i);
      expect(rich.lines.slice(seg.start + 1, seg.start + seg.count), `heading ${i}`).toEqual([
        "<!-- knotebook:knowledge",
        `id: k_${String(i + 1).padStart(8, "0")}`,
        `when: when ${i}`,
        `conclusion: conclusion ${i}`,
        "evidence: tested",
        "status: needs-verify",
        "-->",
      ]);
    }
  });

  it("a downloaded file has the same comment as read_note_section, both written with the fields the op carries", async () => {
    const fields = resolveKnowledgeFieldView({ defs: [], site: [{ fieldRef: "when", optionKey: "", enabled: false, name: null, position: null }] });
    const doc = await docWith(note(3, true));
    const state = Y.encodeStateAsUpdate(doc);
    const ask = async () => [];
    const read = await executeDocOp(rt, { kind: "read", state, wantShown: false, fields }, ask);
    const file = await executeDocOp(rt, { kind: "exportFile", state, key: new Uint8Array(32), salt: new Uint8Array(16), fields }, ask);
    if (read === DOC_TOO_COMPLEX || file === DOC_TOO_COMPLEX || typeof read.result === "string" || !("markdown" in read.result)) throw new Error("unexpected result");
    expect(file.body).toBe(read.result.markdown);
    expect(file.body).toContain("<!-- knotebook:knowledge\nid: k_00000001\nconclusion: conclusion 0\nevidence: tested\nstatus: needs-verify\n-->");
    expect(file.body).not.toContain("when:");
    const withDefaults = await executeDocOp(rt, { kind: "exportFile", state, key: new Uint8Array(32), salt: new Uint8Array(16), fields: DEFAULT_KNOWLEDGE_FIELD_VIEW }, ask);
    if (withDefaults === DOC_TOO_COMPLEX) throw new Error("unexpected result");
    expect(withDefaults.body).toContain("when: when 0\n");
  });

  it("a coloured toggle heading, an empty heading and a heading with only an id still line up", async () => {
    const blocks = [
      { type: "heading", props: { level: 2, textColor: "red", isToggleable: true, ...knowledgeProps(1) }, content: "Coloured", children: [{ type: "paragraph", content: "inside" }] },
      { type: "heading", props: { level: 2, ...knowledgeProps(2) }, content: "" },
      { type: "heading", props: { level: 3, knowledgeId: "k_00000009" }, content: "Only an id" },
      { type: "paragraph", content: "tail" },
    ];
    const ex = await exportNoteForTransfer(rt, await docWith(blocks), new Map());
    expect(ex.segments).not.toBeNull();
    expect(ex.segments!.map(s => s.ids.length).reduce((a, b) => a + b, 0)).toBe(ex.ids.length);
  });
});

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { COLUMNS_OPEN_TAG, columnOpenTag } from "@knotebook/shared";
import { noteAiEdits } from "../src/db/schema.js";
import { loadNoteDoc } from "../src/notes/editing/read.js";
import { EditorSession } from "../src/notes/editing/session.js";
import { buildCollabTestApp, testEditingRuntime, type CollabTestCtx, type TestClient } from "./helpers.js";
import { docText, getContent, seedTokenForUser, waitFor } from "./editing-helpers.js";
import { seedUpload } from "./copy-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";

const PASSWORD = "correct-horse-battery";

interface ToolResultBody {
  isError?: true;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown> & { code?: string; message?: string };
}
interface ToolCall {
  status: number;
  result: ToolResultBody;
}
// callTool/payloadOf/errorOf are copies of the same helpers in several other MCP test files, deliberately not moved into mcp-helpers.ts (a few lines each).
async function callTool(app: FastifyInstance, token: string, name: string, args: unknown = {}): Promise<ToolCall> {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), { token });
  return { status: res.statusCode, result: res.json().result };
}
function payloadOf<T>(call: ToolCall): T {
  expect(call.status).toBe(200);
  expect(call.result.isError, JSON.stringify(call.result)).toBeUndefined();
  return call.result.structuredContent as unknown as T;
}
function errorOf(call: ToolCall): Record<string, unknown> & { code?: string; message?: string } {
  expect(call.status).toBe(200);
  expect(call.result.isError).toBe(true);
  expect(call.result.content[0]!.text).toBe(JSON.stringify(call.result.structuredContent));
  return call.result.structuredContent!;
}

interface Scene {
  ctx: CollabTestCtx;
  ownerId: string;
  token: string;
  noteId: string;
  client: TestClient;
}
async function scene(): Promise<Scene> {
  const ctx = await buildCollabTestApp();
  const email = `o-${randomUUID()}@example.com`;
  const owner = await ctx.createUser({ email, password: PASSWORD });
  const note = await ctx.createNote(owner.id);
  const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write", "Claude Code");
  const session = await ctx.loginAs(email, PASSWORD);
  const client = await session.connect(note.id);
  return { ctx, ownerId: owner.id, token, noteId: note.id, client };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote's generic triple
type AnyBlocks = any[];
async function humanEdit(s: Scene, sentinel: string, blocks: AnyBlocks): Promise<void> {
  const es = await EditorSession.open(testEditingRuntime, s.client.doc);
  try {
    es.editor.replaceBlocks(es.editor.document, blocks);
  } finally {
    es.close(); // release the lease on the module-level singleton runtime, even when it throws
  }
  await waitFor(`server 收到人工編輯（${sentinel}）`, 5_000, () => docText(s.ctx.collab.hocuspocus.documents.get(s.noteId)!).includes(sentinel));
}
async function serverBlocks(s: Scene): Promise<AnyBlocks> {
  const { doc } = await loadNoteDoc({ db: s.ctx.db, collab: s.ctx.collab }, s.noteId);
  const es = await EditorSession.open(testEditingRuntime, doc);
  try {
    return es.editor.document;
  } finally {
    es.close();
  }
}
type SectionPayload = { section: { markdown: string; fingerprint?: string }; truncated: boolean };
const readTop = async (s: Scene) => {
  const r = payloadOf<SectionPayload>(await callTool(s.ctx.app, s.token, "read_note_section", { note_id: s.noteId, section_id: "_top" }));
  expect(r.truncated).toBe(false);
  return r.section;
};
const replaceTop = (s: Scene, markdown: string, ifMatch: string | undefined) =>
  callTool(s.ctx.app, s.token, "edit_note", { note_id: s.noteId, op: "replace_section", section_id: "_top", markdown, if_match: ifMatch });
const countEdits = async (s: Scene) => (await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.noteId))).length;

const P = (text: string) => ({ type: "paragraph", content: text });
const col = (width: number, ...children: AnyBlocks) => ({ type: "column", props: { width }, children });
const row = (...cols: AnyBlocks) => ({ type: "columnList", children: cols });

describe("columns read -> written back unchanged", () => {
  it("read_note_section _top carries the canonical columns row; replace_section with the original text succeeds, reading again is identical, the Y structure is still one row of two columns [1, 1.5]", async () => {
    const s = await scene();
    await humanEdit(s, "後段落", [P("前段落"), row(col(1, P("左欄L")), col(1.5, P("右欄R"))), P("後段落")]);
    const r1 = await readTop(s);
    const lines = r1.markdown.split("\n");
    expect(lines).toContain(COLUMNS_OPEN_TAG);
    expect(lines).toContain(columnOpenTag(1));
    expect(lines).toContain(columnOpenTag(1.5));

    payloadOf(await replaceTop(s, r1.markdown, r1.fingerprint));
    expect((await readTop(s)).markdown).toBe(r1.markdown);
    const blocks = await serverBlocks(s);
    expect(blocks.map(b => b.type)).toEqual(["paragraph", "columnList", "paragraph"]);
    expect(blocks[1].children.map((c: { type: string; props: { width: number } }) => [c.type, c.props.width])).toEqual([["column", 1], ["column", 1.5]]);
    s.client.disconnect();
  });
});

describe("#305: changing one word loses neither image width nor table column widths (server half)", () => {
  const sized = (uploadId: string): AnyBlocks => [
    P("old words"),
    { type: "image", props: { url: `/api/uploads/${uploadId}`, previewWidth: 300 } },
    { type: "table", content: { type: "tableContent", columnWidths: [120, undefined], rows: [{ cells: ["h1", "h2"] }, { cells: ["a", "b"] }] } },
    {
      type: "table",
      content: { type: "tableContent", headerRows: 1, columnWidths: [120, undefined, 80], rows: [{ cells: [{ type: "tableCell", props: { colspan: 2 }, content: "ab" }, "c"] }, { cells: ["d", "e", "f"] }] },
    },
    P("tail sentinel"),
  ];
  const seedSized = async (s: Scene) => {
    const uploadId = await seedUpload(s.ctx.db, s.ctx.uploadsDir, s.noteId, s.ownerId);
    await humanEdit(s, "tail sentinel", sized(uploadId));
  };

  it("read _top -> replace only old with new -> replace_section: paragraph text changed, previewWidth 300, both tables' columnWidths unchanged (merged cells without a width stay undefined), reading again is identical", async () => {
    const s = await scene();
    await seedSized(s);
    const r1 = await readTop(s);
    expect(r1.markdown.split("old").length - 1).toBe(1);
    const md = r1.markdown.replace("old", "new");
    payloadOf(await replaceTop(s, md, r1.fingerprint));

    const blocks = await serverBlocks(s);
    expect(blocks.map(b => b.type)).toEqual(["paragraph", "image", "table", "table", "paragraph"]);
    expect(blocks[0].content.map((t: { text: string }) => t.text).join("")).toBe("new words");
    expect(blocks[1].props.previewWidth).toBe(300);
    expect(blocks[2].content.columnWidths[0]).toBe(120);
    const ws = blocks[3].content.columnWidths as unknown[];
    expect(ws.map(v => (v === undefined ? "unset" : v))).toEqual([120, "unset", 80]);
    expect((await readTop(s)).markdown).toBe(md);
    s.client.disconnect();
  });

  it("REST GET /api/notes/:id/content also reads the <figure> width and the first row's colwidth", async () => {
    const s = await scene();
    await seedSized(s);
    const res = await getContent(s.ctx.app, s.noteId, s.token);
    expect(res.statusCode).toBe(200);
    const md = res.json().markdown as string;
    expect(md).toContain('width="300"></figure>');
    expect(md).toContain('colwidth="120"');
    s.client.disconnect();
  });
});

describe("invalid existing structure (exception)", () => {
  it("a 5-column row made by manual editing reads as 5 column lines; replace_section with the original text -> unsupported_columns, content unchanged", async () => {
    const s = await scene();
    await humanEdit(s, "第五欄", [row(col(1, P("第一欄")), col(1, P("第二欄")), col(1, P("第三欄")), col(1, P("第四欄")), col(1, P("第五欄")))]);
    const r1 = await readTop(s);
    expect(r1.markdown.split("\n").filter(l => l === columnOpenTag(1))).toHaveLength(5);
    const liveBefore = docText(s.ctx.collab.hocuspocus.documents.get(s.noteId)!);
    const editsBefore = await countEdits(s);

    const err = errorOf(await replaceTop(s, r1.markdown, r1.fingerprint));
    expect(err.code).toBe("unsupported_columns");
    expect(docText(s.ctx.collab.hocuspocus.documents.get(s.noteId)!)).toBe(liveBefore);
    expect(await countEdits(s)).toBe(editsBefore);
    expect((await readTop(s)).markdown).toBe(r1.markdown);
    s.client.disconnect();
  });
});

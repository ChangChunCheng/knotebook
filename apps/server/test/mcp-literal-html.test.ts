import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildCollabTestApp, type CollabTestCtx } from "./helpers.js";
import { bearer, getContent, seedTokenForUser } from "./editing-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import type { FastifyInstance } from "fastify";

const PASSWORD = "correct-horse-battery";

interface ToolCall {
  status: number;
  result: { isError?: true; content: { type: string; text: string }[]; structuredContent?: Record<string, unknown> };
}
// callTool/payloadOf are copies of the same helpers in several other MCP test files, deliberately not moved into mcp-helpers.ts (a few lines each).
async function callTool(app: FastifyInstance, token: string, name: string, args: unknown = {}): Promise<ToolCall> {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), { token });
  return { status: res.statusCode, result: res.json().result };
}
function payloadOf<T>(call: ToolCall): T {
  expect(call.status).toBe(200);
  expect(call.result.isError, JSON.stringify(call.result)).toBeUndefined();
  return call.result.structuredContent as unknown as T;
}

interface Scene {
  ctx: CollabTestCtx;
  token: string;
}
async function scene(): Promise<Scene> {
  const ctx = await buildCollabTestApp();
  const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
  const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write", "Claude Code");
  return { ctx, token };
}

const CONTENT =
  "# Lit\n\n" +
  "\\<b>bold\\</b> a \\<b> c EDITME\n\n" +
  "| h | x |\n| --- | --- |\n| \\<img src=x> | y |\n\n" +
  'plain <span style="color:red">red</span> \\<!-- c -->\n';

describe("#379 MCP/REST: literal HTML tags are read with a backslash and written back unchanged", () => {
  it("REST create -> MCP read -> replace_section write-back -> REST read and whole-note write-back are byte-identical; an unescaped <b> is still bold", async () => {
    const s = await scene();
    const { app } = s.ctx;
    const created = await app.inject({ method: "POST", url: "/api/notes", headers: bearer(s.token), payload: { title: "L", content: CONTENT } });
    expect(created.statusCode).toBe(201);
    const noteId = created.json().id as string;

    // The section id follows the heading block and changes after write-back, so re-fetch the outline on every read.
    const litId = async () =>
      payloadOf<{ sections: Array<{ sectionId: string; heading: string }> }>(await callTool(app, s.token, "read_note_outline", { note_id: noteId })).sections.find(
        x => x.heading === "Lit"
      )!.sectionId;
    const read = async () =>
      payloadOf<{ section: { markdown: string; fingerprint?: string }; truncated: boolean }>(
        await callTool(app, s.token, "read_note_section", { note_id: noteId, section_id: await litId() })
      );

    const r1 = await read();
    expect(r1.truncated).toBe(false);
    const md1 = r1.section.markdown;
    expect(md1).toContain("\\<b>bold\\</b> a \\<b> c EDITME");
    expect(md1).toContain("\\<img src=x>");
    expect(md1).toContain('<span style="color:red">red</span> \\<!-- c -->');

    const md2 = md1.replace("EDITME", "EDITED");
    payloadOf(await callTool(app, s.token, "edit_note", { note_id: noteId, op: "replace_section", section_id: await litId(), markdown: md2, if_match: r1.section.fingerprint }));
    expect((await read()).section.markdown).toBe(md2);

    const rest = await getContent(app, noteId, s.token);
    expect(rest.statusCode).toBe(200);
    const restBody = rest.json() as { markdown: string; fingerprint: string };
    expect(restBody.markdown).toContain("\\<b>bold\\</b> a \\<b> c EDITED");

    const sent = restBody.markdown.replace("EDITED", "AGAIN");
    const edit = await app.inject({
      method: "POST",
      url: `/api/notes/${noteId}/edits`,
      headers: bearer(s.token),
      payload: { op: "replace_all", markdown: sent, if_match: restBody.fingerprint },
    });
    expect(edit.statusCode, edit.body).toBe(201);
    const again = await getContent(app, noteId, s.token);
    expect(again.json().markdown).toBe(sent);

    payloadOf(await callTool(app, s.token, "edit_note", { note_id: noteId, op: "append", markdown: "<b>x</b>" }));
    expect((await getContent(app, noteId, s.token)).json().markdown).toContain("**x**");
  });
});

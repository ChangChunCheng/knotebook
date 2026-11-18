/**
 * #379：MCP／REST 讀寫筆記時，文字裡的字面 HTML 標籤讀出加反斜線（`\<`），照原文＋指紋寫回後還是字面文字；
 * 沒有跳脫的輸入（`<b>x</b>`）照舊寫成粗體。
 *
 * ⚠ `callTool`／`payloadOf` 與 `mcp-colors.test.ts` 等的同名 helper 是又一份（同樣的理由：各自只有幾行）。
 */
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

describe("#379 MCP／REST：字面 HTML 標籤讀出加反斜線、寫回後原樣", () => {
  it("REST 建立 → MCP 讀 → replace_section 寫回 → REST 讀與整篇寫回，位元組一致；沒跳脫的 <b> 仍是粗體", async () => {
    const s = await scene();
    const { app } = s.ctx;
    const created = await app.inject({ method: "POST", url: "/api/notes", headers: bearer(s.token), payload: { title: "L", content: CONTENT } });
    expect(created.statusCode).toBe(201);
    const noteId = created.json().id as string;

    // section id 跟著 heading block 走，寫回後會換——每次讀都重拿大綱。
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

    // 沒有跳脫的輸入行為不變：`<b>x</b>` 是粗體。
    payloadOf(await callTool(app, s.token, "edit_note", { note_id: noteId, op: "append", markdown: "<b>x</b>" }));
    expect((await getContent(app, noteId, s.token)).json().markdown).toContain("**x**");
  });
});

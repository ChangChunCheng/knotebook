import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { noteAiEdits, notes, noteStates } from "../src/db/schema.js";
import { PALETTE_COLORS } from "@knotebook/shared";
import { buildCollabTestApp, type CollabTestCtx } from "./helpers.js";
import { bearer, getContent, seedTokenForUser } from "./editing-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import type { FastifyInstance } from "fastify";

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
}
async function scene(): Promise<Scene> {
  const ctx = await buildCollabTestApp();
  const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
  const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write", "Claude Code");
  return { ctx, ownerId: owner.id, token };
}

const countNotes = async (s: Scene) => (await s.ctx.db.select().from(notes).where(eq(notes.ownerId, s.ownerId))).length;
const countEdits = async (s: Scene, noteId: string) => (await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, noteId))).length;
const stateBytes = async (s: Scene, noteId: string) => {
  const [r] = await s.ctx.db.select({ y: noteStates.ydoc }).from(noteStates).where(eq(noteStates.noteId, noteId));
  return r ? Buffer.from(r.y).toString("base64") : null;
};

const COLORED =
  "# Colors\n\n" +
  'plain <span style="color:red">red</span> and <span style="color:blue;background-color:yellow">both</span>\n\n' +
  '<p data-background-color="yellow" data-text-color="purple">whole paragraph</p>\n\n' +
  'hex <span style="color:#ff6600">o</span>\n\n' +
  '<table><tr><th>h1</th><th>h2</th></tr><tr><td data-background-color="blue">c</td><td data-background-color="#00ff00">d</td></tr></table>\n\n' +
  "# Other\n\nplain";
const BAD = 'x <span style="color:tomato">orange-ish</span>';

const REJECT_MESSAGE =
  "That markdown uses a color this editor cannot show, so nothing was written. Use one of: default, gray, brown, red, orange, yellow, green, blue, purple, pink, or a hex color written #rgb or #rrggbb, such as #ff6600.";
const expectListsPalette = (message: string | undefined) => {
  for (const c of PALETTE_COLORS) expect(message).toContain(c);
  expect(message).not.toContain("must be one of");
  expect(message).toContain("#rgb or #rrggbb");
  expect(message).toContain("#ff6600");
};

async function createColored(s: Scene): Promise<string> {
  const { note } = payloadOf<{ note: { id: string } }>(await callTool(s.ctx.app, s.token, "create_note", { title: "C", content: COLORED }));
  return note.id;
}

describe("#222 MCP write: built-in color names and color codes are accepted", () => {
  it("create_note with a short uppercase color code -> succeeds, read_note_section reads back lowercase #rrggbb", async () => {
    const s = await scene();
    const { note } = payloadOf<{ note: { id: string } }>(
      await callTool(s.ctx.app, s.token, "create_note", { title: "H", content: '<span style="color:#F60">x</span>' })
    );
    const outline = payloadOf<{ sections: Array<{ sectionId: string }> }>(await callTool(s.ctx.app, s.token, "read_note_outline", { note_id: note.id }));
    const sec = payloadOf<{ section: { markdown: string } }>(
      await callTool(s.ctx.app, s.token, "read_note_section", { note_id: note.id, section_id: outline.sections[0]!.sectionId })
    );
    expect(sec.section.markdown).toContain('<span style="color:#ff6600">x</span>');
  });

  it("create_note with an undisplayable color (a color name outside the palette) -> unsupported_color, message lists the 10 color names, no row created", async () => {
    const s = await scene();
    const err = errorOf(await callTool(s.ctx.app, s.token, "create_note", { title: "T", content: BAD }));
    expect(err.code).toBe("unsupported_color");
    expectListsPalette(err.message);
    expect(await countNotes(s)).toBe(0);
  });

  it("edit_note with an undisplayable color (a color name outside the palette) -> unsupported_color, content byte-identical, no new edit records", async () => {
    const s = await scene();
    const noteId = await createColored(s);
    const beforeState = await stateBytes(s, noteId);
    const beforeEdits = await countEdits(s, noteId);
    const err = errorOf(await callTool(s.ctx.app, s.token, "edit_note", { note_id: noteId, op: "append", markdown: BAD }));
    expect(err.code).toBe("unsupported_color");
    expectListsPalette(err.message);
    expect(await stateBytes(s, noteId)).toBe(beforeState);
    expect(await countEdits(s, noteId)).toBe(beforeEdits);
  });
});

describe("#222 REST write: same pipeline, 400 unsupported_color", () => {
  it("POST /api/notes/:id/edits and POST /api/notes {content} -> 400 unsupported_color, message lists the color names", async () => {
    const s = await scene();
    const noteId = await createColored(s);
    const beforeState = await stateBytes(s, noteId);
    const r1 = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${noteId}/edits`, headers: bearer(s.token), payload: { op: "append", markdown: BAD } });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().error.code).toBe("unsupported_color");
    expectListsPalette(r1.json().error.message);
    expect(await stateBytes(s, noteId)).toBe(beforeState);

    const before = await countNotes(s);
    const r2 = await s.ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(s.token), payload: { title: "X", content: BAD } });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().error.code).toBe("unsupported_color");
    expectListsPalette(r2.json().error.message);
    expect(await countNotes(s)).toBe(before);
  });

  it("POST /api/notes with #F60 -> 201; with tomato -> 400 and the exact message", async () => {
    const s = await scene();
    const ok = await s.ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(s.token), payload: { title: "H", content: '<span style="color:#F60">x</span>' } });
    expect(ok.statusCode).toBe(201);
    const read = await getContent(s.ctx.app, ok.json().id, s.token);
    expect(read.json().markdown).toContain('<span style="color:#ff6600">x</span>');
    const bad = await s.ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(s.token), payload: { title: "B", content: BAD } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toBe(REJECT_MESSAGE);
  });
});

describe("#222 reads carry colors; read -> replace_section write-back -> read again is identical", () => {
  it("read_note_section markdown carries three kinds of color; after writing back the original text + fingerprint, reading again is identical", async () => {
    const s = await scene();
    const noteId = await createColored(s);
    // The section id follows the heading block and changes after replace_section, so re-fetch the outline on every read.
    const colorsId = async () =>
      payloadOf<{ sections: Array<{ sectionId: string; heading: string }> }>(
        await callTool(s.ctx.app, s.token, "read_note_outline", { note_id: noteId })
      ).sections.find(x => x.heading === "Colors")!.sectionId;
    const read = async () =>
      payloadOf<{ section: { markdown: string; fingerprint?: string }; truncated: boolean }>(
        await callTool(s.ctx.app, s.token, "read_note_section", { note_id: noteId, section_id: await colorsId() })
      );
    const r1 = await read();
    expect(r1.truncated).toBe(false);
    const md1 = r1.section.markdown;
    // Paragraphs with only inline colors stay markdown with the span inside; whole-paragraph/cell colors become whole-paragraph HTML.
    expect(md1).toContain('\nplain <span style="color:red">red</span> and <span style="color:blue;background-color:yellow">both</span>\n');
    expect(md1).toContain('<p data-background-color="yellow" data-text-color="purple">whole paragraph</p>');
    expect(md1).toContain('<td data-background-color="blue">c</td>');
    expect(md1).toContain('hex <span style="color:#ff6600">o</span>');
    expect(md1).toContain('<td data-background-color="#00ff00">d</td>');
    expect(md1).not.toContain("| ---");

    payloadOf(await callTool(s.ctx.app, s.token, "edit_note", { note_id: noteId, op: "replace_section", section_id: await colorsId(), markdown: md1, if_match: r1.section.fingerprint }));
    const r2 = await read();
    expect(r2.section.markdown).toBe(md1);

    const rest = await getContent(s.ctx.app, noteId, s.token);
    expect(rest.json().markdown).toContain("# Other\n\nplain\n");
  });
});

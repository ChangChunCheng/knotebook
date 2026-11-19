// #108: bodyLimit boundaries of the two write endpoints. Why this family exists: a 413 request with a hard-coded 300 000 bytes (as in
// `note-edits.test.ts` and `mcp-endpoint.test.ts`) stays green when the limit is changed to 280 000. All four requests here are
// computed from `WRITE_BODY_LIMIT`, so the boundary moves with the constant; one set per endpoint catches the two sides diverging once they share one constant.
//
// Two easy-to-invert points: (1) exactly equal to the limit is not over - fastify's rule is ">" not ">=". (2) UTF-8 bytes are always >= UTF-16 code units, and the body also
// loses the JSON envelope, so in a body of exactly `WRITE_BODY_LIMIT` bytes the `markdown` is necessarily not over `MD`'s 262 144 code units - request 2 cannot get its 400 from
// `.max` (it returns 201 and the content really gets written); it relies on `.strict()` on every branch of `editBodySchema`. `.strict()` also does not persist, so it does not
// pollute later assertions in the file.
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { noteAiEdits } from "../src/db/schema.js";
import { WRITE_BODY_LIMIT } from "../src/http/body-limits.js";
import { buildCollabTestApp } from "./helpers.js";
import { bearer, docText, seedContent, seedTokenForUser } from "./editing-helpers.js";
import { rpc, mcpPost } from "./mcp-helpers.js";

const PASSWORD = "correct-horse-battery";
const SEED = "# A\n\n第一段的內容";

/**
 * Pads `filler` so the serialized body is exactly `target` bytes (payload all ASCII, 1 char = 1 byte). If the fixture is miscalculated (the body does not reach the
 * boundary) the case spins idle, so the size is pinned instead of trusting arithmetic.
 */
function padTo(build: (filler: string) => unknown, target: number): string {
  const empty = Buffer.byteLength(JSON.stringify(build("")));
  const payload = JSON.stringify(build("a".repeat(target - empty)));
  expect(Buffer.byteLength(payload)).toBe(target);
  return payload;
}

async function setup() {
  const ctx = await buildCollabTestApp();
  const u = await ctx.createUser({ email: "limit@example.com", password: PASSWORD });
  const note = await ctx.createNote(u.id);
  const session = await ctx.loginAs("limit@example.com", PASSWORD);
  await seedContent(ctx, session, note.id, SEED);
  const { token } = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write", "Claude Code (knotebook)");
  const postEdits = (payload: string) =>
    ctx.app.inject({
      method: "POST",
      url: `/api/notes/${note.id}/edits`,
      headers: { ...bearer(token), "content-type": "application/json" },
      payload,
    });
  const rows = () => ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, note.id));
  const live = () => docText(ctx.collab.hocuspocus.documents.get(note.id)!);
  return { ctx, note, token, postEdits, rows, live };
}

const mcpEnvelope = (pad: string) => rpc("tools/list", { pad });

describe("#108 bodyLimit boundaries of the write endpoints (WRITE_BODY_LIMIT)", () => {
  it("request 1, POST /:id/edits: limit + 1 bytes -> 413 content_too_large", async () => {
    const s = await setup();
    const res = await s.postEdits(padTo(md => ({ op: "append", markdown: md }), WRITE_BODY_LIMIT + 1));
    expect(res.statusCode).toBe(413);
    // #372: not fastify's native sentence but an English sentence in the same shape as other errors.
    expect(res.json()).toEqual({ error: { code: "content_too_large", message: "The request body is over this endpoint's size limit. Send a smaller request." } });
  });

  it("request 2, POST /:id/edits: exactly the limit + one undeclared key -> 400 invalid_body (not 413), and nothing persisted", async () => {
    const s = await setup();
    const before = s.live();
    // Exactly the limit = not over, so it gets into the handler; what blocks it is `.strict()`, not `.max` (see the header: a `markdown` of this size cannot exceed MD's code unit limit).
    const res = await s.postEdits(padTo(md => ({ op: "append", zzz: "x", markdown: md }), WRITE_BODY_LIMIT));
    expect(res.statusCode).not.toBe(413);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_body");
    // Rejection case: the live doc is unchanged and there are zero edit-log rows (the `.strict()` path does not persist).
    expect(s.live()).toBe(before);
    expect(await s.rows()).toHaveLength(0);
  });

  it("request 3, POST /api/mcp: limit + 1 bytes -> 413 content_too_large", async () => {
    const s = await setup();
    const res = await mcpPost(s.ctx.app, undefined, { token: s.token, raw: padTo(mcpEnvelope, WRITE_BODY_LIMIT + 1) });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: { code: "content_too_large", message: "The request body is over this endpoint's size limit. Send a smaller request." } });
  });

  it("request 4, POST /api/mcp: exactly the limit -> not 413 (a pile of padding still gets 200)", async () => {
    const s = await setup();
    const res = await mcpPost(s.ctx.app, undefined, { token: s.token, raw: padTo(mcpEnvelope, WRITE_BODY_LIMIT) });
    expect(res.statusCode).not.toBe(413);
    expect(res.statusCode).toBe(200);
    expect(res.json().error).toBeUndefined();
  });
});

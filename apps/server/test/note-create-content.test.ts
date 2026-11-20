import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { noteAiEdits, notes, users } from "../src/db/schema.js";
import { buildCollabTestApp, buildTestApp, signTestSession } from "./helpers.js";
import { seedGroup } from "./group-helpers.js";
import { bearer, getContent, seedTokenForUser } from "./editing-helpers.js";

const PASSWORD = "correct-horse-battery";

describe("POST /api/notes with content", () => {
  it("201 plain NoteDto with the content present, initial empty paragraph replaced, one undoable replace_all row left; [[...]] link -> target's backlinks include the new note", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const target = await ctx.createNote(u.id, "目標");
    const { token } = await seedTokenForUser(ctx.db, u.id);
    const res = await ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(token), payload: { title: "T", content: "# H\n\n看 [[目標]]" } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ title: "T", role: "owner" });
    expect(res.json().fingerprint).toBeUndefined();
    const id = res.json().id;
    const c = (await getContent(ctx.app, id, token)).json();
    expect(c.markdown).toContain(`看 [目標](/notes/${target.id})`);
    expect(c.outline).toHaveLength(2); // _top(0) + H: the initial empty paragraph is gone
    const rows = await ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.op).toBe("replace_all");
    // `/backlinks` is cookie-only (`app.authenticate`, not on #107's Bearer allowlist): Bearer would give 401 and an undefined
    // `body.backlinks`, so a session cookie is used.
    const cookie = `${SESSION_COOKIE}=${await signTestSession({ userId: u.id, tv: 0 })}`;
    const back = await ctx.app.inject({ method: "GET", url: `/api/notes/${target.id}/backlinks`, headers: { cookie } });
    expect(back.json().backlinks.map((b: { id: string }) => b.id)).toContain(id);
  });

  it("#145: create with content also derives the slug from the title (the row-insert point in `createWithContent`)", async () => {
    // This creation path lives in the service (`notes/editing/write-service.ts`, row created after parsing), not in `routes/notes.ts` or
    // `mcp/tools/create-note.ts`, so a derivation missing here wouldn't show in the other paths' results.
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, u.id);
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/notes",
      headers: bearer(token),
      payload: { title: "Content Path", content: "# H\n\n本文" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().slug).toBe("content-path");
    // Content really persisted: slug derivation didn't displace the pipeline's later half (insert still runs after parsing, before applying).
    expect((await getContent(ctx.app, res.json().id as string, token)).json().markdown).toContain("本文");
  });

  it("bad content (empty/too long/NUL) and a title with NUL -> 400 with no new row; app without collab given content -> 400, no row", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, u.id);
    const count = async () => (await ctx.db.select().from(notes).where(eq(notes.ownerId, u.id))).length;
    const NUL = String.fromCharCode(0);
    for (const [body, code] of [
      [{ title: "T", content: "   \n" }, "empty_content"],
      [{ title: "T", content: "a".repeat(262_145) }, "invalid_body"],
      [{ title: "T", content: "x" + NUL }, "invalid_body"],
      // An element that would be dropped inside the body also rejects the whole write
      [{ title: "T", content: '內文\n\n<iframe src="https://example.com"></iframe>' }, "unsupported_block"],
      // Title with NUL: without the schema's `.refine(noNul)` this is a 500, not 400
      // (pg rejects 0x00 in text columns and the error escapes to the global errorHandler).
      [{ title: "T" + NUL }, "invalid_body"],
      [{ title: "T" + NUL, content: "x" }, "invalid_body"],
    ] as const) {
      const r = await ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(token), payload: body });
      expect(r.statusCode, code).toBe(400);
      expect(r.json().error.code).toBe(code);
    }
    expect(await count()).toBe(0);
    // `buildTestApp()` and `buildCollabTestApp()` each call `freshDb()`: they are two different databases. The user must be created
    // on `plain.db` for its token to be inserted (a user in ctx with a token in plain hits the `api_tokens.user_id` FK).
    // `buildTestApp` has no `createUser`, so insert into `users` directly as `notes.test.ts` does (`handle` has a DB default).
    const plain = await buildTestApp();
    const [u2] = await plain.db.insert(users).values({ email: "b@example.com", displayName: "B" }).returning();
    const { token: t2 } = await seedTokenForUser(plain.db, u2!.id);
    const r2 = await plain.app.inject({ method: "POST", url: "/api/notes", headers: bearer(t2), payload: { title: "T", content: "x" } });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().error.code).toBe("invalid_body");
    expect((await plain.db.select().from(notes).where(eq(notes.ownerId, u2!.id))).length).toBe(0);
  });

  it("stricter schema: unknown field -> 400 invalid_body, no row (behaviour change for existing callers, documented in docs and CHANGELOG)", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, u.id);
    const r = await ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(token), payload: { title: "T", contents: "打錯的欄位名" } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("invalid_body");
    expect((await ctx.db.select().from(notes).where(eq(notes.ownerId, u.id))).length).toBe(0);
  });

  it("pipeline failure (beforeRecord throws) -> 500 and the row is deleted", async () => {
    const ctx = await buildCollabTestApp({ editingTestHooks: { beforeRecord: async () => { throw new Error("boom"); } } });
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, u.id);
    const r = await ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(token), payload: { title: "T", content: "x" } });
    expect(r.statusCode).toBe(500);
    expect((await ctx.db.select().from(notes).where(eq(notes.ownerId, u.id))).length).toBe(0);
  });

  it("#175: member with content + groupId -> 201 group note (role editor, ownerId null, groupId set), content really persisted", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const g = await seedGroup(ctx.db, "Team", [{ userId: u.id, role: "member" }]);
    const { token } = await seedTokenForUser(ctx.db, u.id);
    const res = await ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(token), payload: { groupId: g.id, content: "# Hi" } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ role: "editor", ownerId: null, ownerHandle: null, groupId: g.id, group: { id: g.id, name: "Team" } });
    // Re-reading the group note (LEFT JOIN users in `loadNoteWithOwner`) didn't come back empty: the response carries a signature instead of falling back to the insert row's null.
    expect(res.json().lastEdited).not.toBeNull();
    expect((await getContent(ctx.app, res.json().id as string, token)).json().markdown).toContain("Hi");
    const [row] = await ctx.db.select({ ownerId: notes.ownerId, groupId: notes.groupId }).from(notes).where(eq(notes.id, res.json().id as string));
    expect(row).toEqual({ ownerId: null, groupId: g.id });
  });
});

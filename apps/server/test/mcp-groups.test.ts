import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { noteAiEdits, notes, groups } from "../src/db/schema.js";
import { EDIT_LIMIT, FixedWindowLimiter } from "../src/http/rate-limit.js";
import { FORBIDDEN_MESSAGE } from "../src/mcp/tools/edit-note.js";
import { NOTE_NOT_FOUND_MESSAGE } from "../src/mcp/note-read.js";
import type { Db } from "../src/db/index.js";
import type { GroupTestHook } from "../src/groups/test-hook.js";
import { buildCollabTestApp, buildTestApp } from "./helpers.js";
import { bearer, getContent, seedContent, seedTokenForUser } from "./editing-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { cookieOf, seedGroup, seedNote, seedRole, seedShare, seedUser, setMemberRole } from "./group-helpers.js";

const PASSWORD = "correct-horse-battery";

async function callTool(app: FastifyInstance, token: string, name: string, args: unknown = {}) {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), { token });
  expect(res.statusCode).toBe(200);
  return res.json().result as { isError?: true; structuredContent?: Record<string, unknown> & { code?: string; message?: string } };
}

/** `notes` of the success path: first assert the tool didn't return an error (otherwise it goes red at "the tool returned internal", not at a later TypeError reading `notes`). */
async function notesOf(app: FastifyInstance, token: string, name: string, args: unknown = {}) {
  const result = await callTool(app, token, name, args);
  expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
  return result.structuredContent as { notes: Array<Record<string, unknown>>; nextCursor?: string | null };
}

describe("#175 list_notes / search_notes group notes", () => {
  it("three kinds mixed, paged with limit 2 back to the full set; group rows have owner={kind:group}, url /g/, role editor/viewer, never owner; no-read-flag members can't see them", async () => {
    const { app, db } = await buildTestApp();
    const [me, other, reader, blind] = await Promise.all(Array.from({ length: 4 }, () => seedUser(db)));
    const g = await seedGroup(db, "Team", [
      { userId: me!.id, role: "member" },
      { userId: reader!.id, role: "member" },
      { userId: blind!.id, role: "member" },
    ]);
    await setMemberRole(db, g.id, reader!.id, await seedRole(db, g.id, "Reader", { canRead: true }));
    await setMemberRole(db, g.id, blind!.id, await seedRole(db, g.id, "Nothing", { canManageGroup: true }));
    const mine = await seedNote(db, { ownerId: me!.id }, { title: "Mine" });
    const theirs = await seedNote(db, { ownerId: other!.id }, { title: "Theirs" });
    await seedShare(db, theirs.id, me!.id, "viewer");
    const gn1 = await seedNote(db, { groupId: g.id }, { title: "G1" });
    const gn2 = await seedNote(db, { groupId: g.id }, { title: "G2" });
    const { token } = await seedTokenForUser(db, me!.id, "notes:read");
    const seen: Array<Record<string, unknown>> = [];
    let cursor: string | null | undefined;
    do {
      const out = await notesOf(app, token, "list_notes", { limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...out.notes);
      cursor = out.nextCursor;
    } while (cursor);
    expect(seen.map(n => n.id).sort()).toEqual([mine.id, theirs.id, gn1.id, gn2.id].sort());
    const g1 = seen.find(n => n.id === gn1.id)!;
    expect(g1).toMatchObject({ owner: { kind: "group", id: g.id, name: "Team" }, role: "editor" });
    expect(g1.url).toBe(`/g/${g.id}/${gn1.slug}`);
    expect(seen.find(n => n.id === mine.id)).toMatchObject({ owner: { kind: "user", handle: me!.handle }, role: "owner" });
    expect(seen.filter(n => n.role === "owner").map(n => n.id)).toEqual([mine.id]);
    const readerToken = (await seedTokenForUser(db, reader!.id, "notes:read")).token;
    const readerRows = (await notesOf(app, readerToken, "list_notes")).notes;
    expect(readerRows.map(n => n.role)).toEqual(["viewer", "viewer"]);
    const blindToken = (await seedTokenForUser(db, blind!.id, "notes:read")).token;
    expect((await notesOf(app, blindToken, "list_notes")).notes).toEqual([]);
  });

  it("search_notes: rank (exact -> prefix -> substring) holds across the three kinds; a non-member's group notes don't appear", async () => {
    const { app, db } = await buildTestApp();
    const [me, outsider] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "Team", [{ userId: me.id, role: "member" }]);
    const foreign = await seedGroup(db, "Foreign", [{ userId: outsider.id, role: "admin" }]);
    const exact = await seedNote(db, { groupId: g.id }, { title: "plan" });
    const prefix = await seedNote(db, { ownerId: me.id }, { title: "plan b" });
    const infix = await seedNote(db, { groupId: g.id }, { title: "the plan" });
    await seedNote(db, { groupId: foreign.id }, { title: "plan" });
    const { token } = await seedTokenForUser(db, me.id, "notes:read");
    const hits = (await notesOf(app, token, "search_notes", { query: "plan" })).notes;
    expect(hits.map(h => h.id)).toEqual([exact.id, prefix.id, infix.id]);
    expect(hits[0]).toMatchObject({ owner: { kind: "group", id: g.id, name: "Team" }, url: `/g/${g.id}/${exact.slug}`, role: "editor" });
    expect(hits[2]).toMatchObject({ owner: { kind: "group", id: g.id, name: "Team" }, url: `/g/${g.id}/${infix.slug}`, role: "editor" });
    expect(hits[1]).toMatchObject({ owner: { kind: "user", handle: me.handle }, url: `/n/${me.handle}/${prefix.slug}`, role: "owner" });
  });
});

describe("#175 read_note_outline / edit_note group notes (needs collab)", () => {
  it("a member reads a group note's outline: note.owner is the group (with INNER JOIN it was not_found); a plain member's append succeeds and leaves a record; a read-only role gets forbidden and the message doesn't mention owner", async () => {
    const ctx = await buildCollabTestApp();
    const memberEmail = `m-${randomUUID()}@example.com`;
    const member = await ctx.createUser({ email: memberEmail, password: PASSWORD });
    const reader = await ctx.createUser({ email: `r-${randomUUID()}@example.com`, password: PASSWORD });
    const g = await seedGroup(ctx.db, "Team", [
      { userId: member.id, role: "member" },
      { userId: reader.id, role: "member" },
    ]);
    await setMemberRole(ctx.db, g.id, reader.id, await seedRole(ctx.db, g.id, "Reader", { canRead: true }));
    const note = await seedNote(ctx.db, { groupId: g.id }, { title: "Shared plan" });
    const session = await ctx.loginAs(memberEmail, PASSWORD);
    const client = await seedContent(ctx, session, note.id, "# A\n\n第一段");
    client.disconnect();
    const memberToken = (await seedTokenForUser(ctx.db, member.id, "notes:read notes:write", "Claude Code")).token;
    const outline = await callTool(ctx.app, memberToken, "read_note_outline", { note_id: note.id });
    expect(outline.isError).toBeUndefined();
    expect(outline.structuredContent!.note).toMatchObject({ id: note.id, owner: { kind: "group", id: g.id, name: "Team" }, role: "editor" });
    const appended = await callTool(ctx.app, memberToken, "edit_note", { note_id: note.id, op: "append", markdown: "追加" });
    expect(appended.isError).toBeUndefined();
    expect(await ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, note.id))).toHaveLength(1);
    const readerToken = (await seedTokenForUser(ctx.db, reader.id, "notes:read notes:write", "Claude Code")).token;
    const denied = await callTool(ctx.app, readerToken, "edit_note", { note_id: note.id, op: "append", markdown: "x" });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({
      code: "forbidden",
      message: "You can read this note but not change it. Ask whoever manages your access to it for editing rights.",
    });
    expect(String(denied.structuredContent!.message)).not.toMatch(/owner/i);
  });
});

/** The two dedicated messages, verbatim (the test deliberately does **not** import them from the implementation: a literal pins the wording). */
const E1_GROUP_NOT_FOUND = "No group with that id among the groups you belong to.";
const E2_CREATE_FORBIDDEN = "Your role in that group can't create notes. Leave out `group_id` to create a personal note.";
const RW = "notes:read notes:write" as const;

interface CreatedNote {
  id: string;
  slug: string;
  url: string;
  role: string;
  owner: { kind: string; id?: string; name?: string; handle?: string };
  lastEdited: { at: string; byHandle: string; agentLabel: string | null } | null;
}

/** `note` of the success path: first assert the tool didn't return an error (otherwise it goes red at "the tool returned internal", not at a later TypeError reading `note`). */
async function createdNote(app: FastifyInstance, token: string, args: unknown): Promise<CreatedNote> {
  const result = await callTool(app, token, "create_note", args);
  expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
  return result.structuredContent!.note as unknown as CreatedNote;
}

async function noteCount(db: Db): Promise<number> {
  return (await db.select({ id: notes.id }).from(notes)).length;
}

/** Remaining slots of the `edit` limiter the test holds: consume until rejected. */
function cellsLeft(limiter: FixedWindowLimiter, userId: string): number {
  let n = 0;
  while (limiter.consume(userId)) n += 1;
  return n;
}

describe("#175 create_note {group_id}", () => {
  it("plain member: group row, owner = group, url /g/, role editor; slug dedup scope = that group (asymmetric data: the personal call gets plan-3 instead)", async () => {
    const { app, db } = await buildTestApp();
    const me = await seedUser(db);
    const g = await seedGroup(db, "Team", [{ userId: me.id, role: "member" }]);
    await seedNote(db, { groupId: g.id }, { title: "Plan", slug: "plan" });
    await seedNote(db, { ownerId: me.id }, { title: "Plan", slug: "plan" });
    await seedNote(db, { ownerId: me.id }, { title: "Plan 2", slug: "plan-2" });
    const { token } = await seedTokenForUser(db, me.id, RW);

    const inGroup = await createdNote(app, token, { title: "Plan", group_id: g.id });
    const [row] = await db.select().from(notes).where(eq(notes.id, inGroup.id));
    expect(row!.groupId).toBe(g.id);
    expect(row!.ownerId).toBeNull();
    expect(inGroup.slug).toBe("plan-2");
    expect(inGroup.url).toBe(`/g/${g.id}/plan-2`);
    expect(inGroup.role).toBe("editor");
    expect(inGroup.owner).toEqual({ kind: "group", id: g.id, name: "Team" });

    const personal = await createdNote(app, token, { title: "Plan" });
    expect(personal.slug).toBe("plan-3");
    expect(personal.role).toBe("owner");
    expect(personal.owner).toEqual({ kind: "user", handle: me.handle });
  });

  it("reverse: personal has plan, the group has no notes -> the group call's slug is plan (personal notes don't occupy the group scope)", async () => {
    const { app, db } = await buildTestApp();
    const me = await seedUser(db);
    const g = await seedGroup(db, "Team", [{ userId: me.id, role: "member" }]);
    await seedNote(db, { ownerId: me.id }, { title: "Plan", slug: "plan" });
    const { token } = await seedTokenForUser(db, me.id, RW);
    const inGroup = await createdNote(app, token, { title: "Plan", group_id: g.id });
    expect(inGroup.slug).toBe("plan");
    expect(inGroup.url).toBe(`/g/${g.id}/plan`);
  });

  it("with content (collab app): content persisted, one note_ai_edits row, role editor, owner is the group, lastEdited non-null (rereadVisibleNote took the grouped branch)", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "Team", [{ userId: me.id, role: "member" }]);
    const { token } = await seedTokenForUser(ctx.db, me.id, RW, "Claude Code");
    const note = await createdNote(ctx.app, token, { title: "Doc", content: "# Hello\n\n群組內容", group_id: g.id });
    expect(note.role).toBe("editor");
    expect(note.owner).toEqual({ kind: "group", id: g.id, name: "Team" });
    expect(note.url.startsWith("/g/")).toBe(true);
    expect(note.lastEdited).not.toBeNull();
    expect(await ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, note.id))).toHaveLength(1);
    const content = await getContent(ctx.app, note.id, token);
    expect(content.statusCode).toBe(200);
    expect(JSON.stringify(content.json())).toContain("群組內容");
  });

  it("create-only role: creates with and without content, role viewer (not editor), later edit_note forbidden, the same token's REST revert is also 403 forbidden", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "Team", [{ userId: me.id, role: "member" }]);
    await setMemberRole(ctx.db, g.id, me.id, await seedRole(ctx.db, g.id, "Creator", { canRead: true, canCreate: true }));
    const { token } = await seedTokenForUser(ctx.db, me.id, RW, "Claude Code");

    const empty = await createdNote(ctx.app, token, { title: "Empty", group_id: g.id });
    const filled = await createdNote(ctx.app, token, { title: "Filled", content: "# Body\n\n文字", group_id: g.id });
    expect(empty.role).toBe("viewer");
    expect(filled.role).toBe("viewer");
    expect(empty.owner).toEqual({ kind: "group", id: g.id, name: "Team" });

    for (const n of [empty, filled]) {
      const denied = await callTool(ctx.app, token, "edit_note", { note_id: n.id, op: "append", markdown: "x" });
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent!.code).toBe("forbidden");
      expect(denied.structuredContent!.message).toBe(FORBIDDEN_MESSAGE);
      expect(String(denied.structuredContent!.message)).not.toContain("owner");
    }

    // Basis for the docs/mcp.md statement that undo is limited to people who can edit the note, which leaves out a create-only creator:
    // the note created with content has one note_ai_edits row (the response carries no editId, so read it from the DB); the create-only creator undoing it -> 403.
    const edits = await ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, filled.id));
    expect(edits).toHaveLength(1);
    const revert = await ctx.app.inject({ method: "POST", url: `/api/notes/${filled.id}/edits/${edits[0]!.id}/revert`, headers: bearer(token) });
    expect(revert.statusCode).toBe(403);
    expect(revert.json().error.code).toBe("forbidden");
  });

  it("non-member's group and a nonexistent uuid: zero new rows, edit limiter not charged, structuredContent byte-identical, group_not_found + E1_GROUP_NOT_FOUND, not NOTE_NOT_FOUND_MESSAGE", async () => {
    const edit = new FixedWindowLimiter(EDIT_LIMIT);
    const ctx = await buildCollabTestApp({ limiters: { edit } });
    const [me, other] = await Promise.all([seedUser(ctx.db), seedUser(ctx.db)]);
    await seedGroup(ctx.db, "Mine", [{ userId: me.id, role: "member" }]);
    const foreign = await seedGroup(ctx.db, "Foreign", [{ userId: other.id, role: "admin" }]);
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    const before = await noteCount(ctx.db);

    const nonMember = await callTool(ctx.app, token, "create_note", { title: "T", content: "# x", group_id: foreign.id });
    const missing = await callTool(ctx.app, token, "create_note", { title: "T", content: "# x", group_id: randomUUID() });

    expect(await noteCount(ctx.db)).toBe(before);
    expect(cellsLeft(edit, me.id), "group_not_found 不得啃 edit 桶").toBe(EDIT_LIMIT.limit);
    for (const r of [nonMember, missing]) {
      expect(r.isError).toBe(true);
      expect(r.structuredContent!.code).toBe("group_not_found");
      expect(r.structuredContent!.message).toBe(E1_GROUP_NOT_FOUND);
      expect(r.structuredContent!.message).not.toBe(NOTE_NOT_FOUND_MESSAGE);
    }
    expect(nonMember.structuredContent).toEqual(missing.structuredContent);
    expect(JSON.stringify(nonMember.structuredContent)).toBe(JSON.stringify(missing.structuredContent));
  });

  it("member whose role lacks the create flag: zero new rows, edit limiter not charged, forbidden", async () => {
    const edit = new FixedWindowLimiter(EDIT_LIMIT);
    const ctx = await buildCollabTestApp({ limiters: { edit } });
    const me = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "Team", [{ userId: me.id, role: "member" }]);
    await setMemberRole(ctx.db, g.id, me.id, await seedRole(ctx.db, g.id, "NoCreate", { canRead: true, canEdit: true }));
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    const before = await noteCount(ctx.db);

    const r = await callTool(ctx.app, token, "create_note", { title: "T", content: "# x", group_id: g.id });

    expect(await noteCount(ctx.db)).toBe(before);
    expect(cellsLeft(edit, me.id), "forbidden 不得啃 edit 桶").toBe(EDIT_LIMIT.limit);
    expect(r.isError).toBe(true);
    expect(r.structuredContent!.code).toBe("forbidden");
    expect(r.structuredContent!.message).toBe(E2_CREATE_FORBIDDEN);
  });

  it("non-member site admin: structuredContent byte-identical to an ordinary non-member / nonexistent uuid (no exemption)", async () => {
    const { app, db } = await buildTestApp();
    const [admin, plain, other] = await Promise.all([seedUser(db, { isAdmin: true }), seedUser(db), seedUser(db)]);
    const foreign = await seedGroup(db, "Foreign", [{ userId: other.id, role: "admin" }]);
    const adminToken = (await seedTokenForUser(db, admin.id, RW)).token;
    const plainToken = (await seedTokenForUser(db, plain.id, RW)).token;
    const before = await noteCount(db);

    const asAdmin = await callTool(app, adminToken, "create_note", { title: "T", group_id: foreign.id });
    const asPlain = await callTool(app, plainToken, "create_note", { title: "T", group_id: foreign.id });
    const adminMissing = await callTool(app, adminToken, "create_note", { title: "T", group_id: randomUUID() });

    expect(await noteCount(db)).toBe(before);
    expect(asAdmin.isError).toBe(true);
    expect(asAdmin.structuredContent!.code).toBe("group_not_found");
    expect(JSON.stringify(asAdmin.structuredContent)).toBe(JSON.stringify(asPlain.structuredContent));
    expect(JSON.stringify(asAdmin.structuredContent)).toBe(JSON.stringify(adminMissing.structuredContent));
  });

  it("group_id is not a uuid: zero new rows, isError and no structuredContent (SDK input validation shape, no code)", async () => {
    const { app, db } = await buildTestApp();
    const me = await seedUser(db);
    await seedGroup(db, "Team", [{ userId: me.id, role: "member" }]);
    const { token } = await seedTokenForUser(db, me.id, RW);
    const before = await noteCount(db);
    const r = await callTool(app, token, "create_note", { title: "T", group_id: "not-a-uuid" });
    expect(await noteCount(db)).toBe(before);
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
  });

  it("group deleted after the membership check (membership-checked seam): with and without content both return group_not_found + E1_GROUP_NOT_FOUND (not internal), zero new rows", async () => {
    // Only empty groups can be deleted, and this test's group has no notes. The hook can only get `db` after the app is built, hence the holder.
    const holder: { db?: Db } = {};
    const hook: GroupTestHook = async (point, hctx) => {
      if (point === "membership-checked") await holder.db!.delete(groups).where(eq(groups.id, hctx.groupId!));
    };

    const plain = await buildTestApp({ groupTestHook: hook });
    holder.db = plain.db;
    const me1 = await seedUser(plain.db);
    const g1 = await seedGroup(plain.db, "Doomed", [{ userId: me1.id, role: "member" }]);
    const t1 = (await seedTokenForUser(plain.db, me1.id, RW)).token;
    const r1 = await callTool(plain.app, t1, "create_note", { title: "T", group_id: g1.id });
    expect(await noteCount(plain.db)).toBe(0);
    expect(r1.isError).toBe(true);
    expect(r1.structuredContent!.code).toBe("group_not_found");
    expect(r1.structuredContent!.message).toBe(E1_GROUP_NOT_FOUND);

    const collab = await buildCollabTestApp({ groupTestHook: hook });
    holder.db = collab.db;
    const me2 = await seedUser(collab.db);
    const g2 = await seedGroup(collab.db, "Doomed", [{ userId: me2.id, role: "member" }]);
    const t2 = (await seedTokenForUser(collab.db, me2.id, RW)).token;
    const r2 = await callTool(collab.app, t2, "create_note", { title: "T", content: "# x", group_id: g2.id });
    expect(await noteCount(collab.db)).toBe(0);
    expect(await collab.db.select().from(noteAiEdits)).toHaveLength(0);
    expect(r2.isError).toBe(true);
    expect(r2.structuredContent!.code).toBe("group_not_found");
    expect(r2.structuredContent!.message).toBe(E1_GROUP_NOT_FOUND);
  });

  it("uppercase uuid group_id: succeeds, owner.id and url are lowercase", async () => {
    const { app, db } = await buildTestApp();
    const me = await seedUser(db);
    const g = await seedGroup(db, "Team", [{ userId: me.id, role: "member" }]);
    const { token } = await seedTokenForUser(db, me.id, RW);
    const note = await createdNote(app, token, { title: "Up", group_id: g.id.toUpperCase() });
    expect(note.owner.id).toBe(g.id);
    expect(note.url).toBe(`/g/${g.id}/${note.slug}`);
    expect(note.url).toBe(note.url.toLowerCase());
  });
});

describe("#180 create_note's group_id and strict registration", () => {
  it("old key groupId (valid group id) -> first assert zero new notes, then the SDK input validation error (isError, no code, message contains groupId)", async () => {
    const { app, db } = await buildTestApp();
    const me = await seedUser(db);
    const g = await seedGroup(db, "Team", [{ userId: me.id, role: "member" }]);
    const { token } = await seedTokenForUser(db, me.id, RW);
    const before = await noteCount(db);

    const res = await mcpPost(app, rpc("tools/call", { name: "create_note", arguments: { title: "Old key", groupId: g.id } }), { token });

    expect(await noteCount(db)).toBe(before);
    expect(res.statusCode).toBe(200);
    const result = res.json().result as { isError?: true; content: { text: string }[]; structuredContent?: { code?: string } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0]!.text).toContain("groupId");
  });

  it("REST POST /api/notes {groupId} is still 201 (the key rename only applies to MCP, createBodySchema is unchanged)", async () => {
    const { app, db } = await buildTestApp();
    const me = await seedUser(db);
    const g = await seedGroup(db, "Team", [{ userId: me.id, role: "member" }]);
    const res = await app.inject({ method: "POST", url: "/api/notes", cookies: await cookieOf(me.id), payload: { title: "REST", groupId: g.id } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ groupId: g.id, ownerId: null });
  });
});

describe("#239 notes:move doesn't govern create_note / edit_note", () => {
  it("read-write token without move: create_note {group_id} succeeds and the owner is the group; edit_note append on a group note succeeds", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "Team", [{ userId: me.id, role: "admin" }]);
    // The third argument says read-write (no notes:move) explicitly instead of relying on `seedTokenForUser`'s default: if the default changes, this test's intent must not change with it.
    const { token } = await seedTokenForUser(ctx.db, me.id, "notes:read notes:write");
    const created = await createdNote(ctx.app, token, { title: "W9", group_id: g.id });
    expect(created.owner.kind).toBe("group");
    const appended = await callTool(ctx.app, token, "edit_note", { note_id: created.id, op: "append", markdown: "W9" });
    expect(appended.isError).toBeUndefined();
  });
});

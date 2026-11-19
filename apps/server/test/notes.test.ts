import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { eq, or } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp, signTestSession } from "./helpers.js";
import { notes, noteLinks, noteShares, noteStateBackups, noteStates, uploads, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { resolveRole } from "../src/notes/service.js";
import type { CollabHooks } from "../src/collab/hooks.js";

async function insertUser(db: Db, overrides: Partial<{ email: string; displayName: string }> = {}) {
  const [u] = await db
    .insert(users)
    .values({
      email: overrides.email ?? `user-${Math.random().toString(36).slice(2)}@example.com`,
      displayName: overrides.displayName ?? "Test User",
    })
    .returning();
  return u;
}

// Sessions in these tests are always signed directly (not through /api/auth/login) and tokenVersion uses the DB default 0 (insertUser
// doesn't change it), matching the tv that UserGate.check compares.
async function cookieFor(userId: string): Promise<string> {
  return signTestSession({ userId, tv: 0 });
}

describe("resolveRole", () => {
  it("owner -> 'owner'", async () => {
    const { db } = await buildTestApp();
    const owner = await insertUser(db);
    const [note] = await db.insert(notes).values({ ownerId: owner.id }).returning();
    await expect(resolveRole(db, owner.id, note.id)).resolves.toBe("owner");
  });

  it("a note_shares 'editor' row -> 'editor'", async () => {
    const { db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-editor@example.com" });
    const editor = await insertUser(db, { email: "editor@example.com" });
    const [note] = await db.insert(notes).values({ ownerId: owner.id }).returning();
    await db.insert(noteShares).values({ noteId: note.id, userId: editor.id, role: "editor" });
    await expect(resolveRole(db, editor.id, note.id)).resolves.toBe("editor");
  });

  it("a note_shares 'viewer' row -> 'viewer'", async () => {
    const { db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-viewer@example.com" });
    const viewer = await insertUser(db, { email: "viewer@example.com" });
    const [note] = await db.insert(notes).values({ ownerId: owner.id }).returning();
    await db.insert(noteShares).values({ noteId: note.id, userId: viewer.id, role: "viewer" });
    await expect(resolveRole(db, viewer.id, note.id)).resolves.toBe("viewer");
  });

  it("note exists but is not shared -> 'none'", async () => {
    const { db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-none@example.com" });
    const stranger = await insertUser(db, { email: "stranger@example.com" });
    const [note] = await db.insert(notes).values({ ownerId: owner.id }).returning();
    await expect(resolveRole(db, stranger.id, note.id)).resolves.toBe("none");
  });

  it("note doesn't exist (valid UUID format) -> 'none'", async () => {
    const { db } = await buildTestApp();
    const user = await insertUser(db);
    await expect(resolveRole(db, user.id, "00000000-0000-0000-0000-000000000000")).resolves.toBe("none");
  });

  it("noteId not in UUID format -> 'none' (doesn't throw invalid input syntax)", async () => {
    const { db } = await buildTestApp();
    const user = await insertUser(db);
    await expect(resolveRole(db, user.id, "not-a-uuid")).resolves.toBe("none");
  });
});

describe("POST /api/notes", () => {
  it("no title -> 201, title defaults to Untitled, correct shape", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertUser(db);
    const cookie = await cookieFor(u.id);

    const res = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ title: "Untitled", ownerId: u.id, role: "owner" });
    expect(typeof body.id).toBe("string");
    expect(typeof body.createdAt).toBe("string");
    expect(typeof body.updatedAt).toBe("string");

    // Pin the exact field set of the DTO (not just a toMatchObject subset): the notes table also has the internal columns linksClock
    // and deletedAt, which NoteDto assembly must exclude explicitly so nobody later spreads `...note` into the response and leaks them.
    expect(Object.keys(body).sort()).toEqual([
      "createdAt", "folderId", "group", "groupId", "id", "lastEdited", "ownerHandle", "ownerId", "permissions", "prevSlug", "role", "slug", "slugIsCustom", "title", "updatedAt",
    ]);
    expect(body.group).toBeNull();
    expect(body.groupId).toBeNull();
    expect(body.permissions.moveToGroup).toBe(true);
  });

  it("with title -> 201 uses that title", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertUser(db);
    const cookie = await cookieFor(u.id);

    const res = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "My Note" } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ title: "My Note" });
  });

  // `createBodySchema.title`'s `.min(1)`: the empty-title case for PATCH goes through `updateBodySchema`, so create needs its own case.
  it("empty title -> 400 (guards createBodySchema's .min(1))", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertUser(db);
    const cookie = await cookieFor(u.id);

    const res = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_body");
  });

  // `createBodySchema.title`'s `.refine(noNul)`: without it a title containing U+0000 would be written to pg's
  // text column, pg answers 22021 and the exception escapes to the global errorHandler as a 500, so the "zero new rows" half is
  // asserted too (a status-code-only check can't see write paths other than 500).
  it("title containing NUL -> 400 and zero new rows in notes (guards .refine(noNul))", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertUser(db);
    const cookie = await cookieFor(u.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/notes",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { title: `a${String.fromCharCode(0)}b` },
    });
    expect(res.statusCode).toBe(400);
    const rows = await db.select({ id: notes.id }).from(notes).where(eq(notes.ownerId, u.id));
    expect(rows).toHaveLength(0);
  });

  it("not logged in -> 401", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/api/notes", payload: {} });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/notes", () => {
  it("includes owned and shared (correct role), sorted by updatedAt desc", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-list@example.com" });
    const viewer = await insertUser(db, { email: "viewer-list@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const viewerCookie = await cookieFor(viewer.id);

    const note1Res = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: { title: "First" } });
    const note1 = note1Res.json();
    const note2Res = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: { title: "Second" } });
    const note2 = note2Res.json();

    await db.insert(noteShares).values({ noteId: note1.id, userId: viewer.id, role: "viewer" });

    // Make note1's updatedAt later than note2's: PATCH note1 once (as the owner).
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note1.id}`,
      cookies: { [SESSION_COOKIE]: ownerCookie },
      payload: { title: "First Updated" },
    });
    expect(patchRes.statusCode).toBe(200);

    const ownerListRes = await app.inject({ method: "GET", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie } });
    expect(ownerListRes.statusCode).toBe(200);
    const ownerList = ownerListRes.json();
    expect(ownerList.map((n: { id: string }) => n.id)).toEqual([note1.id, note2.id]);
    expect(ownerList.find((n: { id: string }) => n.id === note1.id)).toMatchObject({ role: "owner", title: "First Updated" });

    const viewerListRes = await app.inject({ method: "GET", url: "/api/notes", cookies: { [SESSION_COOKIE]: viewerCookie } });
    expect(viewerListRes.statusCode).toBe(200);
    const viewerList = viewerListRes.json();
    expect(viewerList).toHaveLength(1);
    expect(viewerList[0]).toMatchObject({ id: note1.id, role: "viewer" });
  });

  it("not logged in -> 401", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/notes" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/notes/:id", () => {
  it("unshared user -> 404 not_found (not 403)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-get@example.com" });
    const stranger = await insertUser(db, { email: "stranger-get@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const strangerCookie = await cookieFor(stranger.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const res = await app.inject({ method: "GET", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: strangerCookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("viewer -> 200", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-get2@example.com" });
    const viewer = await insertUser(db, { email: "viewer-get2@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const viewerCookie = await cookieFor(viewer.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();
    await db.insert(noteShares).values({ noteId: note.id, userId: viewer.id, role: "viewer" });

    const res = await app.inject({ method: "GET", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: viewerCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: note.id, role: "viewer" });
  });

  it("nonexistent noteId -> 404", async () => {
    const { app, db } = await buildTestApp();
    const user = await insertUser(db);
    const cookie = await cookieFor(user.id);
    const res = await app.inject({
      method: "GET",
      url: "/api/notes/00000000-0000-0000-0000-000000000000",
      cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("non-UUID noteId -> 404 (the route-layer validation really wires up resolveRole's UUID guard, no 500)", async () => {
    const { app, db } = await buildTestApp();
    const user = await insertUser(db);
    const cookie = await cookieFor(user.id);
    const res = await app.inject({ method: "GET", url: "/api/notes/not-a-uuid", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("not logged in -> 401", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db);
    const ownerCookie = await cookieFor(owner.id);
    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const res = await app.inject({ method: "GET", url: `/api/notes/${note.id}` });
    expect(res.statusCode).toBe(401);
  });
});

describe("PATCH /api/notes/:id", () => {
  it("viewer -> 403 forbidden", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-patch@example.com" });
    const viewer = await insertUser(db, { email: "viewer-patch@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const viewerCookie = await cookieFor(viewer.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();
    await db.insert(noteShares).values({ noteId: note.id, userId: viewer.id, role: "viewer" });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: viewerCookie },
      payload: { title: "Hacked" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "forbidden" } });
  });

  it("editor -> 200, updatedAt increases", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-patch2@example.com" });
    const editor = await insertUser(db, { email: "editor-patch2@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const editorCookie = await cookieFor(editor.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();
    await db.insert(noteShares).values({ noteId: note.id, userId: editor.id, role: "editor" });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: editorCookie },
      payload: { title: "Edited by editor" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ title: "Edited by editor", role: "editor" });
    expect(Date.parse(body.updatedAt)).toBeGreaterThan(Date.parse(note.updatedAt));
  });

  it("empty title -> 400", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db);
    const ownerCookie = await cookieFor(owner.id);
    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: ownerCookie },
      payload: { title: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("user without permission -> 404", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-patch3@example.com" });
    const stranger = await insertUser(db, { email: "stranger-patch3@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const strangerCookie = await cookieFor(stranger.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: strangerCookie },
      payload: { title: "Nope" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /api/notes/:id", () => {
  it("editor -> 403 forbidden; beforeNoteDeleted not called (authorization must fail before collab teardown so it can't be used as a DoS surface)", async () => {
    const beforeNoteDeleted = vi.fn(async () => ({ release: () => {} }));
    const collabHooks: CollabHooks = {
      onShareChanged: vi.fn(),
      onUserRevoked: vi.fn(),
      onSessionRevoked: vi.fn(),
      onGroupAccessChanged: vi.fn(),
      beforeNoteDeleted,
      onNotesRestored: vi.fn(),
      linkSyncGate: () => ({ ok: false as const }),
    };
    const { app, db } = await buildTestApp({ collabHooks });
    const owner = await insertUser(db, { email: "owner-del@example.com" });
    const editor = await insertUser(db, { email: "editor-del@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const editorCookie = await cookieFor(editor.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();
    await db.insert(noteShares).values({ noteId: note.id, userId: editor.id, role: "editor" });

    const res = await app.inject({ method: "DELETE", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: editorCookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "forbidden" } });
    expect(beforeNoteDeleted).not.toHaveBeenCalled();
  });

  it("unrelated user -> 404; beforeNoteDeleted not called (same: someone without permission must not trigger any collab teardown side effect)", async () => {
    const beforeNoteDeleted = vi.fn(async () => ({ release: () => {} }));
    const collabHooks: CollabHooks = {
      onShareChanged: vi.fn(),
      onUserRevoked: vi.fn(),
      onSessionRevoked: vi.fn(),
      onGroupAccessChanged: vi.fn(),
      beforeNoteDeleted,
      onNotesRestored: vi.fn(),
      linkSyncGate: () => ({ ok: false as const }),
    };
    const { app, db } = await buildTestApp({ collabHooks });
    const owner = await insertUser(db, { email: "owner-del2@example.com" });
    const stranger = await insertUser(db, { email: "stranger-del2@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const strangerCookie = await cookieFor(stranger.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const res = await app.inject({ method: "DELETE", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: strangerCookie } });
    expect(res.statusCode).toBe(404);
    expect(beforeNoteDeleted).not.toHaveBeenCalled();
  });

  it("owner -> 204: moved to trash (#181): the notes row and related tables (note_states/note_state_backups/note_shares/note_links/uploads) all remain, deleted_at is non-NULL; GET afterwards 404 in_trash", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-del3@example.com" });
    const linkedUser = await insertUser(db, { email: "linked-del3@example.com" });
    const ownerCookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();
    const otherRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const otherNote = otherRes.json();

    // Seed at least one row in every related table: trashing doesn't touch child tables (everything returns to the pre-trash state on restore; only permanent deletion clears them, see trash-tx.test.ts).
    await db.insert(noteStates).values({ noteId: note.id, ydoc: Buffer.from("state") });
    await db.insert(noteStateBackups).values({ noteId: note.id, ydoc: Buffer.from("backup") });
    await db.insert(noteShares).values({ noteId: note.id, userId: linkedUser.id, role: "viewer" });
    await db.insert(noteLinks).values({ sourceNoteId: note.id, targetNoteId: otherNote.id });
    await db.insert(noteLinks).values({ sourceNoteId: otherNote.id, targetNoteId: note.id });
    await db.insert(uploads).values({ noteId: note.id, uploaderId: owner.id, mime: "image/png", size: 100 });

    const delRes = await app.inject({ method: "DELETE", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: ownerCookie } });
    expect(delRes.statusCode).toBe(204);

    expect(await db.select().from(noteStates).where(eq(noteStates.noteId, note.id))).toHaveLength(1);
    expect(await db.select().from(noteStateBackups).where(eq(noteStateBackups.noteId, note.id))).toHaveLength(1);
    expect(await db.select().from(noteShares).where(eq(noteShares.noteId, note.id))).toHaveLength(1);
    expect(
      await db.select().from(noteLinks).where(or(eq(noteLinks.sourceNoteId, note.id), eq(noteLinks.targetNoteId, note.id)))
    ).toHaveLength(2);
    expect(await db.select().from(uploads).where(eq(uploads.noteId, note.id))).toHaveLength(1);
    const [row] = await db.select({ deletedAt: notes.deletedAt, deletedBy: notes.deletedBy }).from(notes).where(eq(notes.id, note.id));
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.deletedBy).toBe(owner.id);

    const getRes = await app.inject({ method: "GET", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: ownerCookie } });
    expect(getRes.statusCode).toBe(404);
    expect(getRes.json().error.code).toBe("in_trash");
  });

  it("beforeNoteDeleted is awaited before the transaction: when the hook queries the DB the notes row still exists and isn't in trash yet", async () => {
    // dbRef is a mutable box: the beforeNoteDeleted vi.fn is defined before buildTestApp() returns the db it really needs (it is
    // passed to buildTestApp as an override), so the db can only be obtained lazily through this box; the box itself is a const
    // (assigned once), box.current is the mutable field.
    const dbRef: { current: Db | undefined } = { current: undefined };
    const beforeNoteDeleted = vi.fn(async (noteId: string) => {
      const rows = await dbRef.current!.select().from(notes).where(eq(notes.id, noteId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.deletedAt).toBeNull(); // since #181 the row still exists after trashing, only deleted_at tells "before the transaction" apart
      return { release: () => {} };
    });
    const collabHooks: CollabHooks = {
      onShareChanged: vi.fn(),
      onUserRevoked: vi.fn(),
      onSessionRevoked: vi.fn(),
      onGroupAccessChanged: vi.fn(),
      beforeNoteDeleted,
      onNotesRestored: vi.fn(),
      linkSyncGate: () => ({ ok: false as const }),
    };

    const built = await buildTestApp({ collabHooks });
    dbRef.current = built.db;
    const { app, db } = built;

    const owner = await insertUser(db, { email: "owner-del4@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const res = await app.inject({ method: "DELETE", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: ownerCookie } });
    expect(res.statusCode).toBe(204);
    expect(beforeNoteDeleted).toHaveBeenCalledTimes(1);
    expect(beforeNoteDeleted).toHaveBeenCalledWith(note.id);
  });

  it("beforeNoteDeleted throws -> the transaction doesn't run (notes still exists and isn't in trash)", async () => {
    const collabHooks: CollabHooks = {
      onShareChanged: vi.fn(),
      onUserRevoked: vi.fn(),
      onSessionRevoked: vi.fn(),
      onGroupAccessChanged: vi.fn(),
      beforeNoteDeleted: vi.fn(async (): Promise<never> => {
        throw new Error("collab teardown failed");
      }),
      onNotesRestored: vi.fn(),
      linkSyncGate: () => ({ ok: false as const }),
    };
    const { app, db } = await buildTestApp({ collabHooks });

    const owner = await insertUser(db, { email: "owner-del5@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const res = await app.inject({ method: "DELETE", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: ownerCookie } });
    expect(res.statusCode).toBe(500);

    const rows = await db.select().from(notes).where(eq(notes.id, note.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deletedAt).toBeNull();
  });

  it("not logged in -> 401", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db);
    const ownerCookie = await cookieFor(owner.id);
    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const res = await app.inject({ method: "DELETE", url: `/api/notes/${note.id}` });
    expect(res.statusCode).toBe(401);
  });

  it("owner -> 204: trashing doesn't delete attachments (#181): the uploads rows and files on disk remain (only permanent deletion deletes them, see the trash purge)", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-del6@example.com" });
    const ownerCookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const [upload] = await db
      .insert(uploads)
      .values({ noteId: note.id, uploaderId: owner.id, mime: "image/png", size: 4 })
      .returning();
    const filePath = path.join(uploadsDir, upload.id);
    writeFileSync(filePath, Buffer.from([1, 2, 3, 4]));
    expect(existsSync(filePath)).toBe(true);

    const delRes = await app.inject({ method: "DELETE", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: ownerCookie } });
    expect(delRes.statusCode).toBe(204);

    expect(await db.select().from(uploads).where(eq(uploads.id, upload.id))).toHaveLength(1);
    expect(existsSync(filePath)).toBe(true);
  });

  it("failure before the trashing transaction commits (simulated with a forced rollback) -> 500, note not in trash, attachment rows and disk files remain (#181: DELETE never deletes files; the old \"files deleted only after commit\" contract moved to permanent deletion)", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-del8@example.com" });
    const ownerCookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const [upload] = await db
      .insert(uploads)
      .values({ noteId: note.id, uploaderId: owner.id, mime: "image/png", size: 4 })
      .returning();
    const filePath = path.join(uploadsDir, upload.id);
    writeFileSync(filePath, Buffer.from([1, 2, 3, 4]));

    // Force the transaction to roll back after its callback (the DELETE transaction body) has run, simulating any failure before
    // commit (e.g. the DB connection dropping at the commit moment): this doesn't reach any known branch in our code; the test double
    // merely produces the state "callback finished but the transaction never committed", checking that trashing doesn't take effect
    // and attachments aren't touched, rather than checking a specific error-handling branch.
    //
    // db.transaction is a drizzle generic overload (callback type bound to the concrete schema/query types); this is only a wrapper
    // that throws after the callback, and matching the full generic signature has no real benefit here (same as existing test doubles
    // in the repo that use any, e.g. apps/web/src/components/wikilink/spec.tsx).
    /* eslint-disable @typescript-eslint/no-explicit-any -- see the comment above */
    const orig = db.transaction.bind(db);
    const transactionSpy = vi.spyOn(db, "transaction").mockImplementation((cb: any, cfg?: any) =>
      orig(async (tx: any) => {
        await cb(tx);
        throw new Error("forced rollback（測試替身，非真實錯誤）");
      }, cfg)
    );
    /* eslint-enable @typescript-eslint/no-explicit-any */

    try {
      const delRes = await app.inject({ method: "DELETE", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: ownerCookie } });
      expect(delRes.statusCode).toBe(500);

      const [row] = await db.select({ deletedAt: notes.deletedAt }).from(notes).where(eq(notes.id, note.id));
      expect(row?.deletedAt).toBeNull();
      expect(await db.select().from(uploads).where(eq(uploads.id, upload.id))).toHaveLength(1);
      expect(existsSync(filePath)).toBe(true);
    } finally {
      transactionSpy.mockRestore();
    }
  });
});

import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { MAX_BACKLINKS, MAX_LINK_TARGETS, SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp, signTestSession } from "./helpers.js";
import { notes, noteLinks, noteShares, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { noopCollabHooks, type CollabHooks } from "../src/collab/hooks.js";
import type { WriteNoteLinksHooks } from "../src/notes/links.js";

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

async function cookieFor(userId: string): Promise<string> {
  return signTestSession({ userId, tv: 0 });
}

/**
 * `linkSyncGate` always returns `{ ok: true, clock }`. `buildTestApp` replaces `collabHooks` wholesale (not a partial patch), so spread
 * `noopCollabHooks` to keep the other members such as `onShareChanged` as no-ops. `clock` is a getter, not a fixed value, so one app
 * instance can simulate a client submitting different clocks over several submissions within one test (LWW/no-op/concurrent cases need this).
 */
function collabHooksAllowing(getClock: () => number): CollabHooks {
  return { ...noopCollabHooks, linkSyncGate: () => ({ ok: true as const, clock: getClock() }) };
}

async function createNote(db: Db, ownerId: string, title?: string): Promise<{ id: string }> {
  const values = title === undefined ? { ownerId } : { ownerId, title };
  const [row] = await db.insert(notes).values(values).returning({ id: notes.id });
  return row;
}

async function linkedTargets(db: Db, sourceId: string): Promise<string[]> {
  const rows = await db.select({ targetNoteId: noteLinks.targetNoteId }).from(noteLinks).where(eq(noteLinks.sourceNoteId, sourceId));
  return rows.map(r => r.targetNoteId).sort();
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitUntil 逾時（${timeoutMs}ms）`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe("POST /api/notes/:id/links", () => {
  it("204; full replacement (a second, smaller set deletes the extra old links, not just accumulates)", async () => {
    let clock = 1;
    const { app, db } = await buildTestApp({ collabHooks: collabHooksAllowing(() => clock) });
    const owner = await insertUser(db, { email: "owner-links1@example.com" });
    const cookie = await cookieFor(owner.id);
    const source = await createNote(db, owner.id);
    const a = await createNote(db, owner.id, "A");
    const b = await createNote(db, owner.id, "B");

    const res1 = await app.inject({
      method: "POST",
      url: `/api/notes/${source.id}/links`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { link_target_ids: [a.id, b.id] },
    });
    expect(res1.statusCode).toBe(204);
    expect(await linkedTargets(db, source.id)).toEqual([a.id, b.id].sort());

    clock = 2;
    const res2 = await app.inject({
      method: "POST",
      url: `/api/notes/${source.id}/links`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { link_target_ids: [b.id] },
    });
    expect(res2.statusCode).toBe(204);
    expect(await linkedTargets(db, source.id)).toEqual([b.id]);

    const [row] = await db.select({ linksClock: notes.linksClock }).from(notes).where(eq(notes.id, source.id));
    expect(row?.linksClock).toBe(2);
  });

  it("same clock is still accepted (LWW): resending a different set at the same clock overwrites the previous content", async () => {
    const clock = 5;
    const { app, db } = await buildTestApp({ collabHooks: collabHooksAllowing(() => clock) });
    const owner = await insertUser(db, { email: "owner-links2@example.com" });
    const cookie = await cookieFor(owner.id);
    const source = await createNote(db, owner.id);
    const a = await createNote(db, owner.id, "A");
    const b = await createNote(db, owner.id, "B");

    const res1 = await app.inject({
      method: "POST",
      url: `/api/notes/${source.id}/links`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { link_target_ids: [a.id] },
    });
    expect(res1.statusCode).toBe(204);

    // The clock is unchanged (still 5) but the target set becomes b: the `<=` gate keeps a same-clock resend effective.
    const res2 = await app.inject({
      method: "POST",
      url: `/api/notes/${source.id}/links`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { link_target_ids: [b.id] },
    });
    expect(res2.statusCode).toBe(204);
    expect(await linkedTargets(db, source.id)).toEqual([b.id]);
  });

  it("clock going backwards -> 204 but no-op (DB: note_links and links_clock both unchanged)", async () => {
    let clock = 5;
    const { app, db } = await buildTestApp({ collabHooks: collabHooksAllowing(() => clock) });
    const owner = await insertUser(db, { email: "owner-links3@example.com" });
    const cookie = await cookieFor(owner.id);
    const source = await createNote(db, owner.id);
    const a = await createNote(db, owner.id, "A");
    const b = await createNote(db, owner.id, "B");

    const res1 = await app.inject({
      method: "POST",
      url: `/api/notes/${source.id}/links`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { link_target_ids: [a.id] },
    });
    expect(res1.statusCode).toBe(204);

    clock = 3; // older than the committed 5
    const res2 = await app.inject({
      method: "POST",
      url: `/api/notes/${source.id}/links`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { link_target_ids: [b.id] },
    });
    expect(res2.statusCode).toBe(204);

    expect(await linkedTargets(db, source.id)).toEqual([a.id]);
    const [row] = await db.select({ linksClock: notes.linksClock }).from(notes).where(eq(notes.id, source.id));
    expect(row?.linksClock).toBe(5);
  });

  it("two concurrent submissions of different sets -> B is blocked by A's row lock (can't reach the write point before A commits); the final set is exactly one complete set", async () => {
    // Directly proves the invariant "the clock UPDATE is the transaction's first write statement" (rather than faking concurrency with
    // Promise.all of two app.inject calls: with pg Pool opening the second request's connection lazily the two injects may not overlap
    // at all, equivalent to two sequential requests, proving no serialization).
    //
    // Probe: `beforeLinkWrite` (after the batch authorization query, before writing note_links). A's first call pauses there, having
    // already run its `UPDATE notes SET links_clock=...` and holding the source row lock until A commits. If the code is right (UPDATE
    // first), B's transaction is blocked on its own UPDATE by A's row lock, so B's batch authorization query and hook never run and
    // `bReachedHook` stays false while A is paused. If the UPDATE were moved to the end of the transaction, B would not be blocked: the hook
    // would be called before A releases (`bReachedHook` turns true early) and the test fails.
    let callCount = 0;
    let aReachedHook = false;
    let bReachedHook = false;
    let resolveADeferred: () => void = () => {};
    const aDeferred = new Promise<void>(resolve => {
      resolveADeferred = resolve;
    });

    const hooks: WriteNoteLinksHooks = {
      beforeLinkWrite: async () => {
        callCount += 1;
        if (callCount === 1) {
          aReachedHook = true;
          await aDeferred;
        } else {
          bReachedHook = true;
        }
      },
    };

    const { app, db } = await buildTestApp({ collabHooks: collabHooksAllowing(() => 1), linkSyncTestHooks: hooks });
    const owner = await insertUser(db, { email: "owner-links4@example.com" });
    const cookie = await cookieFor(owner.id);
    const source = await createNote(db, owner.id);
    const a = await createNote(db, owner.id, "A");
    const b = await createNote(db, owner.id, "B");
    const c = await createNote(db, owner.id, "C");

    const resAPromise = app.inject({
      method: "POST",
      url: `/api/notes/${source.id}/links`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { link_target_ids: [a.id, b.id] },
    });

    await waitUntil(() => aReachedHook); // A has run the UPDATE and holds the row lock, paused inside its own hook

    const resBPromise = app.inject({
      method: "POST",
      url: `/api/notes/${source.id}/links`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { link_target_ids: [c.id] },
    });

    // try/finally from here: any assertion failure must still release A and let both requests finish; otherwise A stays stuck on
    // `await aDeferred` (transaction neither committed nor rolled back), holding a pool connection and hanging the next test's
    // `freshDb()` (`CREATE DATABASE` can't get a connection).
    try {
      // Give B ample time to try to advance: if B is really blocked on its own UPDATE by A's row lock it never reaches the hook however
      // long we wait (blocked by pg, not merely not scheduled yet); if it does, the UPDATE is not (or no longer) the transaction's
      // first write statement and the row lock doesn't cover the batch authorization/write.
      await new Promise(resolve => setTimeout(resolve, 400));
      expect(bReachedHook, "B 不應該在 A 釋放列鎖之前就抵達 beforeLinkWrite——代表 UPDATE 沒有序列化後續寫入").toBe(false);

      resolveADeferred();
      const resA = await resAPromise;
      expect(resA.statusCode).toBe(204);

      const resB = await resBPromise;
      expect(resB.statusCode).toBe(204);
      expect(bReachedHook).toBe(true); // only after A releases can B advance to its own write point

      const finalTargets = await linkedTargets(db, source.id);
      const setA = [a.id, b.id].sort();
      const setB = [c.id].sort();
      const isCompleteSetA = JSON.stringify(finalTargets) === JSON.stringify(setA);
      const isCompleteSetB = JSON.stringify(finalTargets) === JSON.stringify(setB);
      expect(
        isCompleteSetA || isCompleteSetB,
        `note_links 最終集合必須恰為兩次提交之一的完整集合，不得是混合結果（實際：${JSON.stringify(finalTargets)}）`
      ).toBe(true);
    } finally {
      resolveADeferred(); // resolving an already-resolved promise again is a safe no-op
      await Promise.allSettled([resAPromise, resBPromise]);
    }
  });

  it("target deleted concurrently after the batch authorization and before the write (FK race) -> drop that target and retry once, no 500", async () => {
    const hooks: WriteNoteLinksHooks = {
      // `db` only exists after the buildTestApp call below: bind late through a closure
      beforeLinkWrite: async () => {},
    };
    const { app, db } = await buildTestApp({ collabHooks: collabHooksAllowing(() => 1), linkSyncTestHooks: hooks });
    const owner = await insertUser(db, { email: "owner-links5@example.com" });
    const cookie = await cookieFor(owner.id);
    const source = await createNote(db, owner.id);
    const survivor = await createNote(db, owner.id, "Survivor");
    const doomed = await createNote(db, owner.id, "Doomed");

    // After the batch authorization query judged `doomed` linkable (it still exists) and before the insert, delete it on another
    // connection (the same `db`, not the transaction's `tx`) and commit, so the following insert hits foreign_key_violation.
    hooks.beforeLinkWrite = async () => {
      await db.delete(notes).where(eq(notes.id, doomed.id));
    };

    const res = await app.inject({
      method: "POST",
      url: `/api/notes/${source.id}/links`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { link_target_ids: [survivor.id, doomed.id] },
    });
    expect(res.statusCode).toBe(204);
    expect(await linkedTargets(db, source.id)).toEqual([survivor.id]);
  });

  it("target without access (a stranger's unshared note) -> silently filtered, no error", async () => {
    const { app, db } = await buildTestApp({ collabHooks: collabHooksAllowing(() => 1) });
    const owner = await insertUser(db, { email: "owner-links6@example.com" });
    const stranger = await insertUser(db, { email: "stranger-links6@example.com" });
    const cookie = await cookieFor(owner.id);
    const source = await createNote(db, owner.id);
    const allowed = await createNote(db, owner.id, "Allowed");
    const forbidden = await createNote(db, stranger.id, "Forbidden");

    const res = await app.inject({
      method: "POST",
      url: `/api/notes/${source.id}/links`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { link_target_ids: [allowed.id, forbidden.id] },
    });
    expect(res.statusCode).toBe(204);
    expect(await linkedTargets(db, source.id)).toEqual([allowed.id]);
  });

  it("an editor (shared user) is also accepted for targets they can access (not owner-only)", async () => {
    const { app, db } = await buildTestApp({ collabHooks: collabHooksAllowing(() => 1) });
    const owner = await insertUser(db, { email: "owner-links7@example.com" });
    const editor = await insertUser(db, { email: "editor-links7@example.com" });
    const editorCookie = await cookieFor(editor.id);
    const source = await createNote(db, owner.id);
    await db.insert(noteShares).values({ noteId: source.id, userId: editor.id, role: "editor" });
    // The target is another note shared to the editor (not owned by them): exercises the batch authorization query's shared branch.
    const sharedTarget = await createNote(db, owner.id, "Shared Target");
    await db.insert(noteShares).values({ noteId: sharedTarget.id, userId: editor.id, role: "viewer" });

    const res = await app.inject({
      method: "POST",
      url: `/api/notes/${source.id}/links`,
      cookies: { [SESSION_COOKIE]: editorCookie },
      payload: { link_target_ids: [sharedTarget.id] },
    });
    expect(res.statusCode).toBe(204);
    expect(await linkedTargets(db, source.id)).toEqual([sharedTarget.id]);
  });

  it("self-link (target is the note itself) -> filtered out, not persisted as a self-link", async () => {
    const { app, db } = await buildTestApp({ collabHooks: collabHooksAllowing(() => 1) });
    const owner = await insertUser(db, { email: "owner-links8@example.com" });
    const cookie = await cookieFor(owner.id);
    const source = await createNote(db, owner.id);
    const other = await createNote(db, owner.id, "Other");

    const res = await app.inject({
      method: "POST",
      url: `/api/notes/${source.id}/links`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { link_target_ids: [source.id, other.id] },
    });
    expect(res.statusCode).toBe(204);
    expect(await linkedTargets(db, source.id)).toEqual([other.id]);
  });

  it("non-uuid :id -> 404 (no 500, no leaking of format error details)", async () => {
    const { app, db } = await buildTestApp({ collabHooks: collabHooksAllowing(() => 1) });
    const owner = await insertUser(db, { email: "owner-links9@example.com" });
    const cookie = await cookieFor(owner.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/notes/not-a-uuid/links",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { link_target_ids: [] },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("target count over MAX_LINK_TARGETS after normalization -> 400 invalid_body", async () => {
    const { app, db } = await buildTestApp({ collabHooks: collabHooksAllowing(() => 1) });
    const owner = await insertUser(db, { email: "owner-links10@example.com" });
    const cookie = await cookieFor(owner.id);
    const source = await createNote(db, owner.id);

    const tooMany = Array.from({ length: MAX_LINK_TARGETS + 1 }, () => randomUUID());
    const res = await app.inject({
      method: "POST",
      url: `/api/notes/${source.id}/links`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { link_target_ids: tooMany },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "invalid_body" } });
    expect(await linkedTargets(db, source.id)).toEqual([]);
  });

  it("not logged in -> 401", async () => {
    const { app, db } = await buildTestApp({ collabHooks: collabHooksAllowing(() => 1) });
    const owner = await insertUser(db, { email: "owner-links11@example.com" });
    const source = await createNote(db, owner.id);

    const res = await app.inject({ method: "POST", url: `/api/notes/${source.id}/links`, payload: { link_target_ids: [] } });
    expect(res.statusCode).toBe(401);
  });

  it("nonexistent note -> 404", async () => {
    const { app, db } = await buildTestApp({ collabHooks: collabHooksAllowing(() => 1) });
    const owner = await insertUser(db, { email: "owner-links12@example.com" });
    const cookie = await cookieFor(owner.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/notes/00000000-0000-0000-0000-000000000000/links",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { link_target_ids: [] },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("viewer (read-only share) -> 403", async () => {
    const { app, db } = await buildTestApp({ collabHooks: collabHooksAllowing(() => 1) });
    const owner = await insertUser(db, { email: "owner-links13@example.com" });
    const viewer = await insertUser(db, { email: "viewer-links13@example.com" });
    const viewerCookie = await cookieFor(viewer.id);
    const source = await createNote(db, owner.id);
    await db.insert(noteShares).values({ noteId: source.id, userId: viewer.id, role: "viewer" });

    const res = await app.inject({
      method: "POST",
      url: `/api/notes/${source.id}/links`,
      cookies: { [SESSION_COOKIE]: viewerCookie },
      payload: { link_target_ids: [] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "forbidden" } });
  });

  it("linkSyncGate ok:false (noopCollabHooks default) -> 409 not_loaded, nothing written", async () => {
    const { app, db } = await buildTestApp(); // default noopCollabHooks: linkSyncGate always returns { ok: false }
    const owner = await insertUser(db, { email: "owner-links14@example.com" });
    const cookie = await cookieFor(owner.id);
    const source = await createNote(db, owner.id);
    const target = await createNote(db, owner.id, "Target");

    const res = await app.inject({
      method: "POST",
      url: `/api/notes/${source.id}/links`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { link_target_ids: [target.id] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "not_loaded" } });
    expect(await linkedTargets(db, source.id)).toEqual([]);
  });
});

describe("GET /api/notes/:id/backlinks", () => {
  it("reader filter: returns only source notes the reader can see (owned/shared hit, a stranger's unshared source is filtered out)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-backlinks1@example.com" });
    const stranger = await insertUser(db, { email: "stranger-backlinks1@example.com" });
    const editor = await insertUser(db, { email: "editor-backlinks1@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const editorCookie = await cookieFor(editor.id);

    const target = await createNote(db, owner.id, "Target");
    // The owner's own source note: visible to the owner via the owned branch.
    const ownedSource = await createNote(db, owner.id, "Owned Source");
    await db.insert(noteLinks).values({ sourceNoteId: ownedSource.id, targetNoteId: target.id });
    // A stranger's source note shared to the owner (viewer): visible to the owner via the shared branch.
    const sharedSource = await createNote(db, stranger.id, "Shared Source");
    await db.insert(noteShares).values({ noteId: sharedSource.id, userId: owner.id, role: "viewer" });
    await db.insert(noteLinks).values({ sourceNoteId: sharedSource.id, targetNoteId: target.id });
    // A stranger's source note shared with nobody: must be filtered out for the owner (even though it does link to target).
    const forbiddenSource = await createNote(db, stranger.id, "Forbidden Source");
    await db.insert(noteLinks).values({ sourceNoteId: forbiddenSource.id, targetNoteId: target.id });

    // The editor has share rights on target (editor role) but none on ownedSource/sharedSource; the editor also owns a note linking to
    // target, verifying that the filter is by the querier, not by target's owner: of the three the owner sees, the editor should see only the one they own.
    await db.insert(noteShares).values({ noteId: target.id, userId: editor.id, role: "editor" });
    const editorOwnSource = await createNote(db, editor.id, "Editor Own Source");
    await db.insert(noteLinks).values({ sourceNoteId: editorOwnSource.id, targetNoteId: target.id });

    const ownerRes = await app.inject({ method: "GET", url: `/api/notes/${target.id}/backlinks`, cookies: { [SESSION_COOKIE]: ownerCookie } });
    expect(ownerRes.statusCode).toBe(200);
    const ownerRows = ownerRes.json().backlinks as Array<{ id: string; ownerHandle: string }>;
    expect(ownerRows.map(b => b.id).sort()).toEqual([ownedSource.id, sharedSource.id].sort());
    // ownerHandle must be the source note owner's, not the requester's (if either union's JOIN were bound to the requester, the
    // sharedSource row would return owner.handle; stranger != requester makes that visible)
    expect(ownerRows.find(b => b.id === ownedSource.id)?.ownerHandle).toBe(owner.handle);
    expect(ownerRows.find(b => b.id === sharedSource.id)?.ownerHandle).toBe(stranger.handle);

    const editorRes = await app.inject({ method: "GET", url: `/api/notes/${target.id}/backlinks`, cookies: { [SESSION_COOKIE]: editorCookie } });
    expect(editorRes.statusCode).toBe(200);
    // slug is NOT NULL (#122): rows inserted directly by createNote take the DB default (`untitled-<uuid8>`); ownerHandle is the
    // source note owner's (the editor's own) username.
    expect(editorRes.json().backlinks).toEqual([
      {
        id: editorOwnSource.id,
        title: "Editor Own Source",
        slug: expect.stringMatching(/^untitled-[0-9a-f]{8}$/),
        ownerHandle: editor.handle,
        // Each row carries the source note's groupId (the web app builds `/g/` links from it); null for personal notes.
        groupId: null,
      },
    ]);
  });

  it("combination: the filter runs before LIMIT - when a stranger's source notes flood the LIMIT window, the querier still gets the ones they can see (issue #25)", async () => {
    // The reader filter and truncation each have their own tests, but no combination case pins the order: if the implementation took
    // MAX_BACKLINKS rows first and filtered afterwards, the LIMIT window would fill with newer unshared sources and the filtered result
    // would be empty or a truncated remnant, leaving the original concern (leaking others' titles, or seeing an incomplete result) unguarded.
    //
    // The layout makes the wrong order fail necessarily: visible sources (2 owned + 3 shared to the querier, covering both union
    // branches) get an older updatedAt, MAX_BACKLINKS unshared ones a newer one; both set explicitly from the same Node clock, not
    // relying on DB transaction timestamps. A limit-first implementation gets 200 unshared rows and returns empty after filtering;
    // the correct one returns exactly those 5.
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-backlinks-combo@example.com" });
    const stranger = await insertUser(db, { email: "stranger-backlinks-combo@example.com" });
    const cookie = await cookieFor(owner.id);
    const target = await createNote(db, owner.id, "Target");

    const older = new Date(Date.now() - 60_000);
    const newer = new Date();
    const visibleIds = await db.transaction(async tx => {
      // owned branch: the owner's own source notes.
      const ownedRows = await tx
        .insert(notes)
        .values(Array.from({ length: 2 }, (_, i) => ({ ownerId: owner.id, title: `Owned ${i}`, updatedAt: older })))
        .returning({ id: notes.id });
      // shared branch: a stranger's source notes shared to the owner (viewer).
      const sharedRows = await tx
        .insert(notes)
        .values(Array.from({ length: 3 }, (_, i) => ({ ownerId: stranger.id, title: `Shared ${i}`, updatedAt: older })))
        .returning({ id: notes.id });
      const all = [...ownedRows, ...sharedRows];
      await tx.insert(noteLinks).values(all.map(r => ({ sourceNoteId: r.id, targetNoteId: target.id })));
      await tx.insert(noteShares).values(sharedRows.map(r => ({ noteId: r.id, userId: owner.id, role: "viewer" })));
      return all.map(r => r.id);
    });

    await db.transaction(async tx => {
      const rows = await tx
        .insert(notes)
        .values(Array.from({ length: MAX_BACKLINKS }, (_, i) => ({ ownerId: stranger.id, title: `Hidden ${i}`, updatedAt: newer })))
        .returning({ id: notes.id });
      await tx.insert(noteLinks).values(rows.map(r => ({ sourceNoteId: r.id, targetNoteId: target.id })));
    });

    const res = await app.inject({ method: "GET", url: `/api/notes/${target.id}/backlinks`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const backlinks = res.json().backlinks as Array<{ id: string; title: string }>;
    // Exactly the 5 notes the querier can see (2 owned + 3 shared): not empty (the limit-first shape), and no unshared title leaks in.
    expect(backlinks.map(b => b.id).sort()).toEqual([...visibleIds].sort());
    for (const b of backlinks) expect(b.title).toMatch(/^(Owned|Shared) /);
  });

  it("ordering: updatedAt desc; source notes batch-created in one transaction (same defaultNow timestamp) are tie-broken by id desc", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-backlinks2@example.com" });
    const cookie = await cookieFor(owner.id);
    const target = await createNote(db, owner.id, "Target");

    // Batch insert in one transaction: the three source notes share the same updatedAt (defaultNow), so ordering by updatedAt desc alone
    // leaves their relative order undefined; the secondary key id desc is what makes the assertion stable.
    const tied = await db.transaction(async tx => {
      const rows = await tx
        .insert(notes)
        .values([
          { ownerId: owner.id, title: "Tied A" },
          { ownerId: owner.id, title: "Tied B" },
          { ownerId: owner.id, title: "Tied C" },
        ])
        .returning({ id: notes.id });
      await tx.insert(noteLinks).values(rows.map(r => ({ sourceNoteId: r.id, targetNoteId: target.id })));
      return rows;
    });

    // Created in a later transaction: its defaultNow is necessarily later than the batch above, so it sorts first.
    const later = await createNote(db, owner.id, "Later");
    await db.insert(noteLinks).values({ sourceNoteId: later.id, targetNoteId: target.id });

    const res = await app.inject({ method: "GET", url: `/api/notes/${target.id}/backlinks`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const ids = res.json().backlinks.map((b: { id: string }) => b.id);

    const tiedIdsDesc = tied.map(r => r.id).sort().reverse();
    expect(ids).toEqual([later.id, ...tiedIdsDesc]);
  });

  it(`limit: more than MAX_BACKLINKS (${MAX_BACKLINKS}) source notes -> truncated to ${MAX_BACKLINKS}, keeping the newest by updatedAt/id`, async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-backlinks3@example.com" });
    const cookie = await cookieFor(owner.id);
    const target = await createNote(db, owner.id, "Target");

    const total = MAX_BACKLINKS + 1;
    const sourceIds = await db.transaction(async tx => {
      const rows = await tx
        .insert(notes)
        .values(Array.from({ length: total }, (_, i) => ({ ownerId: owner.id, title: `Source ${i}` })))
        .returning({ id: notes.id });
      await tx.insert(noteLinks).values(rows.map(r => ({ sourceNoteId: r.id, targetNoteId: target.id })));
      return rows.map(r => r.id);
    });

    const res = await app.inject({ method: "GET", url: `/api/notes/${target.id}/backlinks`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.backlinks).toHaveLength(MAX_BACKLINKS);

    // All source notes are created in one transaction (identical updatedAt), so only id desc decides which batch survives truncation.
    const expectedTop = [...sourceIds].sort().reverse().slice(0, MAX_BACKLINKS);
    expect(body.backlinks.map((b: { id: string }) => b.id)).toEqual(expectedTop);
  });

  it("not logged in -> 401", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-backlinks4@example.com" });
    const target = await createNote(db, owner.id);

    const res = await app.inject({ method: "GET", url: `/api/notes/${target.id}/backlinks` });
    expect(res.statusCode).toBe(401);
  });

  it("reader without read access to :id (a stranger) -> 404", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-backlinks5@example.com" });
    const stranger = await insertUser(db, { email: "stranger-backlinks5@example.com" });
    const strangerCookie = await cookieFor(stranger.id);
    const target = await createNote(db, owner.id);

    const res = await app.inject({ method: "GET", url: `/api/notes/${target.id}/backlinks`, cookies: { [SESSION_COOKIE]: strangerCookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("nonexistent note -> 404", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-backlinks6@example.com" });
    const cookie = await cookieFor(owner.id);

    const res = await app.inject({
      method: "GET",
      url: "/api/notes/00000000-0000-0000-0000-000000000000/backlinks",
      cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("non-uuid :id -> 404 (no 500)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-backlinks7@example.com" });
    const cookie = await cookieFor(owner.id);

    const res = await app.inject({ method: "GET", url: "/api/notes/not-a-uuid/backlinks", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });
});

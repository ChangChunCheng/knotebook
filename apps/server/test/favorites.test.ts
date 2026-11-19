/** The GET cases write records straight into `note_favorites`; losing read access and moving to the trash only filter at read time and leave the records untouched. */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { FavoriteDto } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { groupMembers, noteFavorites, notes, noteShares } from "../src/db/schema.js";
import { addFavorite } from "../src/favorites/queries.js";
import type { GroupRacePoint } from "../src/groups/test-hook.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import { cookieOf, seedGroup, seedNote, seedRole, seedShare, seedUser, setMemberRole } from "./group-helpers.js";
import { buildTestApp } from "./helpers.js";
import { captureLogs } from "./helpers/admin-auth.js";
import { inject, markRestored, markTrashed } from "./trash-helpers.js";

const list = async (app: FastifyInstance, userId: string): Promise<FavoriteDto[]> => {
  const res = await inject(app, "GET", "/api/favorites", userId);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as FavoriteDto[];
};
const listIds = async (app: FastifyInstance, userId: string) => (await list(app, userId)).map(f => f.noteId);

async function favorite(db: Db, userId: string, noteId: string, at?: Date): Promise<void> {
  await db.insert(noteFavorites).values({ userId, noteId, ...(at === undefined ? {} : { createdAt: at }) });
}
async function favoriteRows(db: Db, userId: string): Promise<string[]> {
  const rows = await db.select({ noteId: noteFavorites.noteId }).from(noteFavorites).where(eq(noteFavorites.userId, userId));
  return rows.map(r => r.noteId).sort();
}

describe("GET /api/favorites: order and response shape", () => {
  it("no favorites -> 200 []", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    expect(await list(app, alice.id)).toEqual([]);
  });

  it("newest first; favoritedAt is an ISO string with millisecond precision, equal to the stored time", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    // Both ids and insertion order deliberately differ from time order: only sorting by time yields a, c, b.
    const a = await seedNote(db, { ownerId: alice.id }, { id: "00000000-0000-4000-8000-000000000001" });
    const b = await seedNote(db, { ownerId: alice.id }, { id: "00000000-0000-4000-8000-000000000002" });
    const c = await seedNote(db, { ownerId: alice.id }, { id: "00000000-0000-4000-8000-000000000003" });
    const t0 = Date.parse("2026-01-01T00:00:00.123Z");
    await favorite(db, alice.id, a.id, new Date(t0 + 2000));
    await favorite(db, alice.id, b.id, new Date(t0));
    await favorite(db, alice.id, c.id, new Date(t0 + 1000));

    const got = await list(app, alice.id);
    expect(got).toEqual([
      { noteId: a.id, favoritedAt: new Date(t0 + 2000).toISOString() },
      { noteId: c.id, favoritedAt: new Date(t0 + 1000).toISOString() },
      { noteId: b.id, favoritedAt: new Date(t0).toISOString() },
    ]);
    for (const f of got) {
      expect(typeof f.favoritedAt).toBe("string");
      expect(new Date(f.favoritedAt).toISOString()).toBe(f.favoritedAt);
    }
  });

  it("notes added at the same time are ordered by note id descending (across personal, shared and group sources)", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }]);
    // Ids increase with insertion order: without the sort, the natural order of the table and every branch is ascending.
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const owned = [1, 4, 7].map(n => id(n));
    const shared = [2, 5].map(n => id(n));
    const grouped = [3, 6].map(n => id(n));
    for (const nid of owned) await seedNote(db, { ownerId: alice.id }, { id: nid });
    for (const nid of shared) {
      await seedNote(db, { ownerId: bob.id }, { id: nid });
      await seedShare(db, nid, alice.id, "viewer");
    }
    for (const nid of grouped) await seedNote(db, { groupId: g.id }, { id: nid });
    const same = new Date("2026-02-02T02:02:02.222Z");
    for (const n of [1, 2, 3, 4, 5, 6, 7]) await favorite(db, alice.id, id(n), same);

    const got = await list(app, alice.id);
    expect(got.map(f => f.noteId)).toEqual([7, 6, 5, 4, 3, 2, 1].map(n => id(n)));
    expect(new Set(got.map(f => f.favoritedAt))).toEqual(new Set([same.toISOString()]));
  });

  it("favorites on personal, shared and group notes together -> all three returned; same-source notes not favorited aren't", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }]);
    const mine = await seedNote(db, { ownerId: alice.id });
    const fromBob = await seedNote(db, { ownerId: bob.id });
    await seedShare(db, fromBob.id, alice.id, "viewer");
    const inGroup = await seedNote(db, { groupId: g.id });
    await favorite(db, alice.id, mine.id, new Date("2026-03-01T00:00:00.000Z"));
    await favorite(db, alice.id, fromBob.id, new Date("2026-03-02T00:00:00.000Z"));
    await favorite(db, alice.id, inGroup.id, new Date("2026-03-03T00:00:00.000Z"));
    // One visible but not favorited note per source: must not appear in the list.
    await seedNote(db, { ownerId: alice.id });
    const sharedOther = await seedNote(db, { ownerId: bob.id });
    await seedShare(db, sharedOther.id, alice.id, "editor");
    await seedNote(db, { groupId: g.id });

    expect(await listIds(app, alice.id)).toEqual([inGroup.id, fromBob.id, mine.id]);
  });
});

describe("GET /api/favorites: only your own, and only currently visible", () => {
  it("alice and bob in the same group: alice's favorite appears only in alice's list", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }, { userId: bob.id, role: "member" }]);
    const n = await seedNote(db, { groupId: g.id });
    await favorite(db, alice.id, n.id);

    expect(await listIds(app, alice.id)).toEqual([n.id]);
    expect(await list(app, bob.id)).toEqual([]);
  });

  it("alice and bob each favorite the same note -> each list carries its own favorite time", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }, { userId: bob.id, role: "member" }]);
    const n = await seedNote(db, { groupId: g.id });
    const aliceAt = new Date("2026-06-06T06:06:06.111Z");
    const bobAt = new Date("2026-06-07T07:07:07.222Z");
    await favorite(db, alice.id, n.id, aliceAt);
    await favorite(db, bob.id, n.id, bobAt);

    expect(await list(app, alice.id)).toEqual([{ noteId: n.id, favoritedAt: aliceAt.toISOString() }]);
    expect(await list(app, bob.id)).toEqual([{ noteId: n.id, favoritedAt: bobAt.toISOString() }]);
  });

  it("share revoked -> not returned, record remains; shared again -> returns with the original time", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const n = await seedNote(db, { ownerId: bob.id });
    await seedShare(db, n.id, alice.id, "viewer");
    const at = new Date("2026-04-04T04:04:04.444Z");
    await favorite(db, alice.id, n.id, at);
    expect(await list(app, alice.id)).toEqual([{ noteId: n.id, favoritedAt: at.toISOString() }]);

    await db.delete(noteShares).where(and(eq(noteShares.noteId, n.id), eq(noteShares.userId, alice.id)));
    expect(await list(app, alice.id)).toEqual([]);
    expect(await favoriteRows(db, alice.id)).toEqual([n.id]);

    await seedShare(db, n.id, alice.id, "viewer");
    expect(await list(app, alice.id)).toEqual([{ noteId: n.id, favoritedAt: at.toISOString() }]);
  });

  it("group role changed to unable-to-read, or removed from the group -> the group's notes aren't returned; in both cases the record remains", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const g = await seedGroup(db, "Garden", [{ userId: bob.id, role: "admin" }, { userId: alice.id, role: "member" }]);
    const n = await seedNote(db, { groupId: g.id });
    await favorite(db, alice.id, n.id);
    expect(await listIds(app, alice.id)).toEqual([n.id]);

    const noRead = await seedRole(db, g.id, "no-read", { canRead: false });
    await setMemberRole(db, g.id, alice.id, noRead);
    expect(await list(app, alice.id)).toEqual([]);
    expect(await favoriteRows(db, alice.id)).toEqual([n.id]);

    await setMemberRole(db, g.id, alice.id, g.memberRoleId);
    expect(await listIds(app, alice.id)).toEqual([n.id]);

    await db.delete(groupMembers).where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.userId, alice.id)));
    expect(await list(app, alice.id)).toEqual([]);
    expect(await favoriteRows(db, alice.id)).toEqual([n.id]);
  });

  it("moved to the trash -> not returned, record remains; restored -> returns, time unchanged", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });
    const at = new Date("2026-05-05T05:05:05.555Z");
    await favorite(db, alice.id, n.id, at);

    await markTrashed(db.$client, n.id, alice.id);
    expect(await list(app, alice.id)).toEqual([]);
    expect(await favoriteRows(db, alice.id)).toEqual([n.id]);

    await markRestored(db.$client, n.id);
    expect(await list(app, alice.id)).toEqual([{ noteId: n.id, favoritedAt: at.toISOString() }]);
  });
});

describe("GET /api/favorites: cookie only", () => {
  it("not signed in -> 401", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/favorites" });
    expect(res.statusCode, res.body).toBe(401);
  });

  it("Bearer token only, no cookie -> 401", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });
    await favorite(db, alice.id, n.id);
    const { token } = await seedTokenForUser(db, alice.id);
    const res = await app.inject({ method: "GET", url: "/api/favorites", headers: bearer(token) });
    expect(res.statusCode, res.body).toBe(401);
  });
});

const NOT_FOUND_BODY = '{"error":{"code":"not_found","message":"No note with that id."}}';
const INVALID_BODY = { error: { code: "invalid_body", message: "Invalid request body." } };
const TOO_MANY = { error: { code: "too_many_requests", message: "Too many requests. Wait a moment and try again." } };

const put = (app: FastifyInstance, userId: string | null, id: string, payload?: unknown): Promise<LightMyRequestResponse> =>
  inject(app, "PUT", `/api/favorites/${id}`, userId, payload);
const del = (app: FastifyInstance, userId: string | null, id: string): Promise<LightMyRequestResponse> =>
  inject(app, "DELETE", `/api/favorites/${id}`, userId);

/** Rows of the table (all users); `at` is UTC microsecond-precision text, which shows whether milliseconds were truncated. */
async function storedRows(db: Db): Promise<Array<{ user_id: string; note_id: string; at: string }>> {
  const { rows } = await db.$client.query<{ user_id: string; note_id: string; at: string }>(
    `select user_id::text, note_id::text, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as at
       from note_favorites order by user_id, note_id`,
  );
  return rows;
}
/** Microsecond-precision UTC text -> millisecond ISO (equals `toISOString()` only when the microsecond tail is 000). */
const usToIso = (at: string): string => `${at.slice(0, 23)}Z`;

describe("PUT /api/favorites/:id: add", () => {
  it("adding your own note -> 200 { noteId, favoritedAt }, stored with millisecond precision; adding again (also with `{}`) -> the same string, still one row in the table", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });

    const first = await put(app, alice.id, n.id);
    expect(first.statusCode, first.body).toBe(200);
    const dto = first.json() as FavoriteDto;
    expect(Object.keys(dto).sort()).toEqual(["favoritedAt", "noteId"]);
    expect(dto.noteId).toBe(n.id);
    expect(new Date(dto.favoritedAt).toISOString()).toBe(dto.favoritedAt);
    const rows = await storedRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.at.endsWith("000"), rows[0]!.at).toBe(true);
    expect(usToIso(rows[0]!.at)).toBe(dto.favoritedAt);

    const again = await put(app, alice.id, n.id);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toEqual(dto);
    const withEmptyBody = await put(app, alice.id, n.id, {});
    expect(withEmptyBody.statusCode, withEmptyBody.body).toBe(200);
    expect(withEmptyBody.json()).toEqual(dto);
    expect(await storedRows(db)).toEqual(rows);
    expect(await list(app, alice.id)).toEqual([dto]);
  });

  it("a per-person-shared viewer and a read-only group member can both add", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const shared = await seedNote(db, { ownerId: bob.id });
    await seedShare(db, shared.id, alice.id, "viewer");
    const g = await seedGroup(db, "Garden", [{ userId: bob.id, role: "admin" }, { userId: alice.id, role: "member" }]);
    const readOnly = await seedRole(db, g.id, "reader", { canRead: true });
    await setMemberRole(db, g.id, alice.id, readOnly);
    const inGroup = await seedNote(db, { groupId: g.id });

    for (const id of [shared.id, inGroup.id]) {
      const res = await put(app, alice.id, id);
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as FavoriteDto).noteId).toBe(id);
    }
    expect(await favoriteRows(db, alice.id)).toEqual([shared.id, inGroup.id].sort());
  });

  it("nonexistent, not shared by others, in your own trash, unreadable in the group, non-UUID :id -> 404, the five bodies byte-for-byte identical, no new row in the table", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const bobs = await seedNote(db, { ownerId: bob.id });
    const trashed = await seedNote(db, { ownerId: alice.id });
    await markTrashed(db.$client, trashed.id, alice.id);
    const g = await seedGroup(db, "Garden", [{ userId: bob.id, role: "admin" }, { userId: alice.id, role: "member" }]);
    const noRead = await seedRole(db, g.id, "no-read", { canRead: false });
    await setMemberRole(db, g.id, alice.id, noRead);
    const unreadableGroupNote = await seedNote(db, { groupId: g.id });

    for (const id of [randomUUID(), bobs.id, trashed.id, unreadableGroupNote.id, "not-a-uuid"]) {
      const res = await put(app, alice.id, id);
      expect(res.statusCode, `${id} ${res.body}`).toBe(404);
      expect(res.body, id).toBe(NOT_FOUND_BODY);
    }
    // A non-UUID is checked before the body: a bad body still gets the same 404.
    const badIdBadBody = await put(app, alice.id, "not-a-uuid", { extra: 1 });
    expect(badIdBadBody.statusCode).toBe(404);
    expect(badIdBadBody.body).toBe(NOT_FOUND_BODY);
    expect(await storedRows(db)).toEqual([]);
  });

  it("uppercase UUID :id -> 200, both the stored and the returned noteId are lowercase", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });

    const res = await put(app, alice.id, n.id.toUpperCase());
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as FavoriteDto).noteId).toBe(n.id);
    expect((await storedRows(db)).map(r => r.note_id)).toEqual([n.id]);
  });

  it("PUT with no body (and no Content-Type) -> favorited time is now, stored as whole milliseconds", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    // Five notes: pg's now() lands exactly on a whole millisecond with probability ~1/1000, and all five doing so is negligible - if the value weren't truncated to milliseconds it would certainly show.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await seedNote(db, { ownerId: alice.id })).id);

    const before = Date.now();
    const got = new Map<string, string>();
    for (const id of ids) {
      const res = await app.inject({ method: "PUT", url: `/api/favorites/${id}`, cookies: await cookieOf(alice.id) });
      expect(res.statusCode, res.body).toBe(200);
      got.set(id, (res.json() as FavoriteDto).favoritedAt);
    }
    const after = Date.now();

    const rows = await storedRows(db);
    expect(rows.map(r => r.note_id).sort()).toEqual([...ids].sort());
    for (const r of rows) {
      expect(r.at.endsWith("000"), r.at).toBe(true);
      expect(usToIso(r.at)).toBe(got.get(r.note_id));
      // The database and the test process share one clock; allow 1 second of slack.
      const t = Date.parse(got.get(r.note_id)!);
      expect(t).toBeGreaterThanOrEqual(before - 1000);
      expect(t).toBeLessThanOrEqual(after + 1000);
    }
    // Milliseconds are kept: if truncated only to seconds, all five would be `.000000` (all five landing on a whole second is negligible).
    expect(rows.some(r => !r.at.endsWith(".000000")), rows.map(r => r.at).join(" ")).toBe(true);
  });

  it("a body that isn't an empty object (any field, array, JSON null) -> 400 invalid_body, nothing written; `{}` -> 200", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });

    const bad: unknown[] = [{ extra: 1 }, { favoritedAt: "2026-01-01T00:00:00.000Z" }, { favoritedAt: null }, []];
    for (const payload of bad) {
      const res = await put(app, alice.id, n.id, payload);
      expect(res.statusCode, `${JSON.stringify(payload)} ${res.body}`).toBe(400);
      expect(res.json()).toEqual(INVALID_BODY);
    }
    const nullBody = await app.inject({
      method: "PUT",
      url: `/api/favorites/${n.id}`,
      cookies: await cookieOf(alice.id),
      headers: { "content-type": "application/json" },
      payload: "null",
    });
    expect(nullBody.statusCode, nullBody.body).toBe(400);
    expect(nullBody.json()).toEqual(INVALID_BODY);
    expect(await storedRows(db)).toEqual([]);

    const empty = await put(app, alice.id, n.id, {});
    expect(empty.statusCode, empty.body).toBe(200);
    expect(await favoriteRows(db, alice.id)).toEqual([n.id]);
  });

  it("the note is permanently deleted between authorization and write -> 404 (same body), nothing written, no error log; not deleting in the test hook -> 200", async () => {
    for (const purgeInSeam of [true, false]) {
      const points: GroupRacePoint[] = [];
      const seam: { db?: Db; target?: string } = {};
      const logs = captureLogs();
      const { app, db } = await buildTestApp(
        {
          groupTestHook: async (point, ctx) => {
            points.push(point);
            if (point === "favorite-authorized" && purgeInSeam) {
              expect(ctx.noteId).toBe(seam.target);
              await seam.db!.delete(notes).where(eq(notes.id, seam.target!));
            }
          },
        },
        logs.options,
      );
      seam.db = db;
      const alice = await seedUser(db, { displayName: "Alice" });
      const n = await seedNote(db, { ownerId: alice.id });
      seam.target = n.id;

      const res = await put(app, alice.id, n.id);
      expect(points, String(purgeInSeam)).toEqual(["favorite-authorized"]);
      if (purgeInSeam) {
        expect(res.statusCode, res.body).toBe(404);
        expect(res.body).toBe(NOT_FOUND_BODY);
        expect(await storedRows(db)).toEqual([]);
      } else {
        expect(res.statusCode, res.body).toBe(200);
        expect(await favoriteRows(db, alice.id)).toEqual([n.id]);
      }
      expect(logs.lines.filter(l => l.level === "error" || l.level === "fatal")).toEqual([]);
      await app.close();
    }
  });

  it("addFavorite on a nonexistent note -> 'gone' (no exception)", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    expect(await addFavorite(db, { userId: alice.id, noteId: randomUUID() })).toBe("gone");
    expect(await storedRows(db)).toEqual([]);
  });
});

describe("DELETE /api/favorites/:id: remove", () => {
  it("own -> 204 and the row is gone; not favorited -> 204; bob's row for the same note untouched; unreadable note (after share revoked) -> 204 and the row is gone; non-UUID -> 404", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }, { userId: bob.id, role: "member" }]);
    const both = await seedNote(db, { groupId: g.id });
    const mine = await seedNote(db, { ownerId: alice.id });
    const fromBob = await seedNote(db, { ownerId: bob.id });
    await seedShare(db, fromBob.id, alice.id, "viewer");
    for (const id of [both.id, mine.id, fromBob.id]) expect((await put(app, alice.id, id)).statusCode).toBe(200);
    expect((await put(app, bob.id, both.id)).statusCode).toBe(200);

    const r1 = await del(app, alice.id, both.id);
    expect(r1.statusCode, r1.body).toBe(204);
    expect(r1.body).toBe("");
    expect(await favoriteRows(db, alice.id)).toEqual([mine.id, fromBob.id].sort());
    expect(await favoriteRows(db, bob.id)).toEqual([both.id]);

    const r2 = await del(app, alice.id, both.id);
    expect(r2.statusCode, r2.body).toBe(204);
    const never = await del(app, alice.id, randomUUID());
    expect(never.statusCode, never.body).toBe(204);

    await db.delete(noteShares).where(and(eq(noteShares.noteId, fromBob.id), eq(noteShares.userId, alice.id)));
    const unreadable = await del(app, alice.id, fromBob.id);
    expect(unreadable.statusCode, unreadable.body).toBe(204);
    expect(await favoriteRows(db, alice.id)).toEqual([mine.id]);
    expect(await favoriteRows(db, bob.id)).toEqual([both.id]);

    const bad = await del(app, alice.id, "not-a-uuid");
    expect(bad.statusCode).toBe(404);
    expect(bad.body).toBe(NOT_FOUND_BODY);
    expect(await favoriteRows(db, alice.id)).toEqual([mine.id]);
  });

  it("uppercase UUID :id can be deleted too", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });
    expect((await put(app, alice.id, n.id)).statusCode).toBe(200);
    expect((await del(app, alice.id, n.id.toUpperCase())).statusCode).toBe(204);
    expect(await favoriteRows(db, alice.id)).toEqual([]);
  });
});

describe("PUT/DELETE: favorite throttle bucket", () => {
  it("PUT and DELETE share one bucket, counted per person; GET, 400 before authorization and 404 aren't charged; over the limit -> 429 and nothing written or deleted", async () => {
    const { app, db } = await buildTestApp({ limiters: { favorite: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) } });
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const a1 = await seedNote(db, { ownerId: alice.id });
    const a2 = await seedNote(db, { ownerId: alice.id });
    const bobs = await seedNote(db, { ownerId: bob.id });

    for (let i = 0; i < 10; i++) await list(app, alice.id);
    for (const id of [randomUUID(), bobs.id, "not-a-uuid"]) expect((await put(app, alice.id, id)).statusCode).toBe(404);
    expect((await put(app, alice.id, a1.id, { extra: 1 })).statusCode).toBe(400);
    expect((await del(app, alice.id, "not-a-uuid")).statusCode).toBe(404);

    expect((await put(app, alice.id, a1.id)).statusCode).toBe(200);
    expect((await del(app, alice.id, a2.id)).statusCode).toBe(204);

    const overPut = await put(app, alice.id, a2.id);
    expect(overPut.statusCode, overPut.body).toBe(429);
    expect(overPut.json()).toEqual(TOO_MANY);
    const overDel = await del(app, alice.id, a1.id);
    expect(overDel.statusCode, overDel.body).toBe(429);
    expect(overDel.json()).toEqual(TOO_MANY);
    expect(await favoriteRows(db, alice.id)).toEqual([a1.id]);

    const bobPut = await put(app, bob.id, bobs.id);
    expect(bobPut.statusCode, bobPut.body).toBe(200);
  });
});

describe("PUT/DELETE: cookie only", () => {
  it("not signed in -> 401; Bearer token only, no cookie -> 401; nothing written or deleted", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });
    const kept = await seedNote(db, { ownerId: alice.id });
    expect((await put(app, alice.id, kept.id)).statusCode).toBe(200);
    const { token } = await seedTokenForUser(db, alice.id);

    for (const method of ["PUT", "DELETE"] as const) {
      for (const id of [n.id, kept.id]) {
        const anon = await app.inject({ method, url: `/api/favorites/${id}` });
        expect(anon.statusCode, `${method} anon ${anon.body}`).toBe(401);
        const withToken = await app.inject({ method, url: `/api/favorites/${id}`, headers: bearer(token) });
        expect(withToken.statusCode, `${method} bearer ${withToken.body}`).toBe(401);
      }
    }
    expect(await favoriteRows(db, alice.id)).toEqual([kept.id]);
  });
});

describe("permanently deleting a note takes its favorite records with it", () => {
  it("permanent delete from the trash -> that note's record is gone; another note's record remains", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const gone = await seedNote(db, { ownerId: alice.id });
    const stays = await seedNote(db, { ownerId: alice.id });
    for (const id of [gone.id, stays.id]) expect((await put(app, alice.id, id)).statusCode).toBe(200);
    await markTrashed(db.$client, gone.id, alice.id);
    expect(await favoriteRows(db, alice.id)).toEqual([gone.id, stays.id].sort());

    const res = await inject(app, "POST", "/api/trash/purge", alice.id, { ids: [gone.id] });
    expect(res.statusCode, res.body).toBe(200);
    expect(await favoriteRows(db, alice.id)).toEqual([stays.id]);
  });

  it("delete group - delete all -> every person's records on the group's notes are gone; records on personal notes remain", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "admin" }, { userId: bob.id, role: "member" }]);
    const inGroup = await seedNote(db, { groupId: g.id });
    const personal = await seedNote(db, { ownerId: alice.id });
    for (const [who, id] of [[alice.id, inGroup.id], [bob.id, inGroup.id], [alice.id, personal.id]] as const) {
      expect((await put(app, who, id)).statusCode).toBe(200);
    }

    const res = await inject(app, "DELETE", `/api/groups/${g.id}`, alice.id, { mode: "delete" });
    expect(res.statusCode, res.body).toBe(204);
    expect(await favoriteRows(db, alice.id)).toEqual([personal.id]);
    expect(await favoriteRows(db, bob.id)).toEqual([]);
  });
});

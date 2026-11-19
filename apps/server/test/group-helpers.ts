/** Seeds: bulk seeds always spell out `slug`/`handle` explicitly - relying on the `untitled-<uuid8>`/`user-<uuid8>` DEFAULTs has a birthday problem (#150). Direct `db.insert(notes)` is fine in test/ because the notes-slug.test.ts source guard only scans src/. */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { and, eq, sql } from "drizzle-orm";
import { expect, vi } from "vitest";
import { SESSION_COOKIE, type NoteWidth } from "@knotebook/shared";
import type { CollabHooks } from "../src/collab/hooks.js";
import type { Db } from "../src/db/index.js";
import { groupMembers, groupRoles, groups, noteRedirects, noteShares, notes, users } from "../src/db/schema.js";
import { signTestSession } from "./helpers.js";

export interface SeededUser {
  id: string;
  email: string;
  handle: string;
}

export async function seedUser(
  db: Db,
  over: { isAdmin?: boolean; displayName?: string; disabled?: boolean } = {},
): Promise<SeededUser> {
  const tag = randomUUID().slice(0, 12);
  const [u] = await db
    .insert(users)
    .values({
      email: `grp-${tag}@example.com`,
      handle: `grp-${tag}`,
      displayName: over.displayName ?? `User ${tag}`,
      isAdmin: over.isAdmin ?? false,
      ...(over.disabled ? { disabledAt: new Date() } : {}),
    })
    .returning();
  return { id: u!.id, email: u!.email, handle: u!.handle };
}

/** Session cookie for `app.inject({ cookies })` (signed directly, tv=0 - matching insert's default token_version). */
export async function cookieOf(userId: string): Promise<Record<string, string>> {
  return { [SESSION_COOKIE]: await signTestSession({ userId, tv: 0 }) };
}

/** Built-in role flags must match migration 0012 (step 2) and createGroupInTx. */
export async function seedGroup(
  db: Db,
  name: string,
  members: ReadonlyArray<{ userId: string; role: "admin" | "member" }>,
  opts?: { id?: string },
): Promise<{ id: string; adminRoleId: string; memberRoleId: string }> {
  const [g] = await db.insert(groups).values({ id: opts?.id, name, createdBy: members[0]?.userId ?? null }).returning({ id: groups.id });
  const [admin] = await db
    .insert(groupRoles)
    .values({ groupId: g!.id, builtin: "admin", canRead: true, canCreate: true, canEdit: true, canDelete: true, canManagePublicLink: true, canManageMembers: true, canManageGroup: true })
    .returning({ id: groupRoles.id });
  const [member] = await db
    .insert(groupRoles)
    .values({ groupId: g!.id, builtin: "member", canRead: true, canCreate: true, canEdit: true })
    .returning({ id: groupRoles.id });
  if (members.length > 0) {
    await db.insert(groupMembers).values(
      members.map(m => ({ groupId: g!.id, userId: m.userId, roleId: m.role === "admin" ? admin!.id : member!.id })),
    );
  }
  return { id: g!.id, adminRoleId: admin!.id, memberRoleId: member!.id };
}

type RoleFlag = "canRead" | "canCreate" | "canEdit" | "canDelete" | "canManagePublicLink" | "canManageMembers" | "canManageGroup";

/**
 * Custom role (direct insert, bypassing `POST .../roles`; **defaults to `canRead: false`** - an unreadable role the DB still allows but production can't write; spell out `canRead: true`
 * for new tests that need a readable role). The flag combination is still constrained by two CHECKs: the four note flags (create/edit/delete/manage public link) imply read
 * (`group_roles_read_implied_chk`), and the built-in admin has all seven flags true (`group_roles_admin_all_chk`); a wrong combination gives 23514.
 * Create no longer implies edit (since migration 0013).
 */
export async function seedRole(db: Db, groupId: string, name: string, flags: Partial<Record<RoleFlag, boolean>>): Promise<string> {
  const [r] = await db.insert(groupRoles).values({ groupId, name, canRead: false, ...flags }).returning({ id: groupRoles.id });
  return r!.id;
}

export async function setMemberRole(db: Db, groupId: string, userId: string, roleId: string): Promise<void> {
  await db.update(groupMembers).set({ roleId }).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)));
}

/** A personal note takes `{ ownerId }`, a group note `{ groupId }` (XOR). slug defaults to random (#150 birthday problem). */
export async function seedNote(
  db: Db,
  owner: { ownerId: string } | { groupId: string },
  opts: { id?: string; title?: string; slug?: string; slugIsCustom?: boolean; prevSlug?: string; legacySlug?: string; publicToken?: string; publicSlug?: string; publicWidth?: NoteWidth } = {},
): Promise<{ id: string; slug: string }> {
  const slug = opts.slug ?? `n-${randomUUID().slice(0, 12)}`;
  const [n] = await db
    .insert(notes)
    .values({
      ...(opts.id !== undefined ? { id: opts.id } : {}),
      ...("groupId" in owner ? { groupId: owner.groupId } : { ownerId: owner.ownerId }),
      title: opts.title ?? "Untitled",
      slug,
      ...(opts.slugIsCustom !== undefined ? { slugIsCustom: opts.slugIsCustom } : {}),
      ...(opts.prevSlug !== undefined ? { prevSlug: opts.prevSlug } : {}),
      ...(opts.legacySlug !== undefined ? { legacySlug: opts.legacySlug } : {}),
      ...(opts.publicToken !== undefined ? { publicToken: opts.publicToken } : {}),
      ...(opts.publicSlug !== undefined ? { publicSlug: opts.publicSlug } : {}),
      ...(opts.publicWidth !== undefined ? { publicWidth: opts.publicWidth } : {}),
    })
    .returning({ id: notes.id });
  return { id: n!.id, slug };
}

/** Inserts a redirect row directly (production writes redirects only when a note leaves its path: moving a note into a group, or deleting a group in transfer mode). `expired` gives an already-expired row. */
export async function seedRedirect(db: Db, oldPath: string, noteId: string, opts: { expired?: boolean } = {}): Promise<void> {
  await db.insert(noteRedirects).values({
    oldPath,
    noteId,
    expiresAt: opts.expired ? sql`now() - interval '1 minute'` : sql`now() + interval '1 month'`,
  });
}

export async function seedShare(db: Db, noteId: string, userId: string, role: "viewer" | "editor"): Promise<void> {
  await db.insert(noteShares).values({ noteId, userId, role });
}

/** Output of `explain (costs off)` for a drizzle `.toSQL()` (parameters bound as-is). */
export async function planOf(pool: Pool, q: { sql: string; params: unknown[] }): Promise<string> {
  const { rows } = await pool.query(`explain (costs off) ${q.sql}`, q.params);
  return rows.map((r: Record<string, string>) => r["QUERY PLAN"]).join("\n");
}

/** The first group user 1 belongs to in `seedPlannerData` (user 1 belongs to groups 8, 9, 10). */
export const PLANNER_GROUP_OF_USER1 = "00000000-0000-4000-9000-000000000008";

/**
 * Scale data for EXPLAIN (as in migrate.test.ts: analyze after seeding so the planner really chooses):
 * 2000 users, 500 groups, 3 groups per person (about 6000 member rows), 5000 notes (4/5 in groups, about 8 per group),
 * one per-person share row per note. Returns user 1 and a note in group 8.
 * Note: the kept "one share row per note" also lands on group notes (the shape of residual share rows on group notes) - only for EXPLAIN scale, **don't** use this seed for visibility assertions.
 * Note: it also creates only the `member` built-in role, with no admin role and no admin (the "at least one admin per group" invariant doesn't hold) - **don't** use it to test admin invariants.
 */
export async function seedPlannerData(pool: Pool): Promise<{ userId: string; noteId: string }> {
  const U = (n: string): string => `('00000000-0000-4000-8000-' || lpad(to_hex(${n}), 12, '0'))::uuid`;
  const G = (n: string): string => `('00000000-0000-4000-9000-' || lpad(to_hex(${n}), 12, '0'))::uuid`;
  await pool.query(
    `insert into users (id, email, display_name, handle)
     select ${U("g")}, 'planner' || g || '@example.com', 'P' || g, 'planner-' || g from generate_series(1, 2000) g`,
  );
  await pool.query(`insert into groups (id, name) select ${G("g")}, 'G' || g from generate_series(1, 500) g`);
  await pool.query(`insert into group_roles (group_id, builtin, can_read, can_create, can_edit) select id, 'member', true, true, true from groups`);
  await pool.query(
    `insert into group_members (group_id, user_id, role_id)
     select x.gid, x.uid, r.id
     from (select ${G("((u * 7 + k) % 500) + 1")} as gid, ${U("u")} as uid from generate_series(1, 2000) u, generate_series(0, 2) k) x
     join group_roles r on r.group_id = x.gid and r.builtin = 'member'
     on conflict do nothing`,
  );
  await pool.query(
    `insert into notes (owner_id, title, slug, group_id)
     select case when g % 5 = 0 then ${U("(g % 2000) + 1")} else null end, 'T' || g, 'planner-' || g,
            case when g % 5 = 0 then null else ${G("(g % 500) + 1")} end
     from generate_series(1, 5000) g`,
  );
  await pool.query(
    `insert into note_shares (note_id, user_id, role)
     select n.id, ${U("((hashtext(n.id::text) & 2147483647) % 2000) + 1")}, 'viewer' from notes n
     on conflict do nothing`,
  );
  for (const t of ["users", "groups", "group_roles", "group_members", "notes", "note_shares"]) await pool.query(`analyze ${t}`);
  const { rows } = await pool.query(`select id from notes where group_id = $1 limit 1`, [PLANNER_GROUP_OF_USER1]);
  return { userId: "00000000-0000-4000-8000-000000000001", noteId: rows[0].id as string };
}

/** The seven members are a spy `CollabHooks` (`linkSyncGate` always rejects, like the existing test stubs). */
export function spyCollabHooks() {
  return {
    onShareChanged: vi.fn<(noteId: string, userId: string) => void>(),
    onUserRevoked: vi.fn<(userId: string) => void>(),
    onSessionRevoked: vi.fn<(userId: string, sessionId: string) => void>(),
    onGroupAccessChanged: vi.fn<(noteIds: readonly string[], userIds: readonly string[]) => void>(),
    beforeNoteDeleted: vi.fn(async () => ({ release: () => {} })),
    onNotesRestored: vi.fn<(noteIds: readonly string[]) => void>(),
    linkSyncGate: () => ({ ok: false as const }),
  } satisfies CollabHooks;
}

export type MatrixActor = "anon" | "nonMember" | "member" | "admin" | "siteAdmin" | "badId" | "missing";
export const MATRIX_ACTORS: readonly MatrixActor[] = ["anon", "nonMember", "member", "admin", "siteAdmin", "badId", "missing"];

export interface MatrixScene {
  groupId: string;
  admin: SeededUser;
  member: SeededUser;
  other: SeededUser;
  outsider: SeededUser;
  siteAdmin: SeededUser;
  newcomer: SeededUser;
  /** Custom role nobody holds (all six flags off, only the always-true read). */
  customRoleId: string;
}

export interface MatrixEndpoint {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** `groupId` already resolved per actor (`badId` = non-UUID, `missing` = nonexistent UUID). */
  url: (groupId: string, scene: MatrixScene) => string;
  payload?: (scene: MatrixScene) => Record<string, unknown>;
  expected: Record<MatrixActor, number>;
}

async function seedMatrixScene(db: Db): Promise<MatrixScene> {
  const admin = await seedUser(db);
  const member = await seedUser(db);
  const other = await seedUser(db);
  const outsider = await seedUser(db);
  const siteAdmin = await seedUser(db, { isAdmin: true });
  const newcomer = await seedUser(db);
  const g = await seedGroup(db, "Matrix", [
    { userId: admin.id, role: "admin" },
    { userId: member.id, role: "member" },
    { userId: other.id, role: "member" },
  ]);
  const customRoleId = await seedRole(db, g.id, "Matrix custom", { canRead: true });
  return { groupId: g.id, admin, member, other, outsider, siteAdmin, newcomer, customRoleId };
}

/**
 * Group route authorization matrix: a fresh scenario per actor (destructive endpoints don't interfere).
 * The 404 responses of non-member/non-UUID/nonexistent must be **byte-for-byte identical**.
 */
export async function runGroupAuthMatrix(app: FastifyInstance, db: Db, endpoint: MatrixEndpoint): Promise<void> {
  const notFoundBodies: string[] = [];
  for (const actor of MATRIX_ACTORS) {
    const scene = await seedMatrixScene(db);
    const groupId = actor === "badId" ? "not-a-uuid" : actor === "missing" ? randomUUID() : scene.groupId;
    const who =
      actor === "anon" ? null
        : actor === "nonMember" ? scene.outsider
          : actor === "member" ? scene.member
            : actor === "siteAdmin" ? scene.siteAdmin
              : scene.admin;
    const res = await app.inject({
      method: endpoint.method,
      url: endpoint.url(groupId, scene),
      ...(who ? { cookies: await cookieOf(who.id) } : {}),
      ...(endpoint.payload ? { payload: endpoint.payload(scene) } : {}),
    });
    expect(res.statusCode, `${endpoint.method} ${endpoint.url("<id>", scene)} as ${actor}：${res.body}`).toBe(endpoint.expected[actor]);
    if (actor === "nonMember" || actor === "badId" || actor === "missing") notFoundBodies.push(res.body);
  }
  expect(new Set(notFoundBodies).size, "非成員／非 UUID／不存在的 404 必須逐位元組相同").toBe(1);
  expect(JSON.parse(notFoundBodies[0]!)).toEqual({ error: { code: "not_found", message: "No group with that id." } });
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Waits until "a connection on this test DB is waiting on a lock" or "another request has finished". Called inside concurrency test hooks:
 * `"blocked"` = the interleaving really happened (another request got stuck on a lock we hold); `"settled"` = the other request wasn't blocked and ran to completion.
 * Tests finally assert it is `"blocked"`, proving that the case exercised an interleaving rather than a sequence.
 */
export async function waitForBlockedOrSettled(pool: Pool, other: Promise<unknown>, timeoutMs = 5_000): Promise<"blocked" | "settled"> {
  let settled = false;
  void other.then(() => { settled = true; }, () => { settled = true; });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (settled) return "settled";
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (rows[0]!.n >= 1) return "blocked";
    await sleep(20);
  }
  throw new Error(`waitForBlockedOrSettled 逾時（${timeoutMs}ms）`);
}

/**
 * Polls until "at least n connections on this test DB are waiting on locks" (same query as above). For queuing several requests in order on the same lock:
 * send the first -> wait for 1 -> send the second -> wait for 2, so the queue order is the send order.
 */
export async function waitForLockWaiters(pool: Pool, n: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (rows[0]!.n >= n) return;
    await sleep(20);
  }
  throw new Error(`waitForLockWaiters(${n}) 逾時（${timeoutMs}ms）`);
}

/** Ownership and public-link state of a note; `updated_at` as text (microsecond precision, more accurate than a JS Date). */
export async function noteState(pool: Pool, noteId: string): Promise<{
  owner_id: string | null; group_id: string | null; slug: string; prev_slug: string | null; slug_is_custom: boolean;
  public_token: string | null; public_slug: string | null; updated_at: string;
}> {
  const { rows } = await pool.query(
    `select owner_id, group_id, slug, prev_slug, slug_is_custom, public_token, public_slug, updated_at::text as updated_at from notes where id = $1`,
    [noteId],
  );
  return rows[0];
}

export async function sharesOf(db: Db, noteId: string): Promise<Array<{ userId: string; role: string }>> {
  const rows = await db.select({ userId: noteShares.userId, role: noteShares.role }).from(noteShares).where(eq(noteShares.noteId, noteId));
  return rows.sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
}

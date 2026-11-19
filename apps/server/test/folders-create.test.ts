/** Control and combining characters are always built with `String.fromCharCode` (no escape sequences in the source). */
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { FOLDER_DEPTH_MAX, FOLDERS_PER_SPACE_MAX, type FolderDto, type FolderListDto } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { groupMembers } from "../src/db/schema.js";
import type { GroupRacePoint } from "../src/groups/test-hook.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import { folderRow, seedFolder } from "./folder-helpers.js";
import { noteState, seedNote, seedRole, seedUser } from "./group-helpers.js";
import { buildTestApp, freshLimiters } from "./helpers.js";
import { inject, sixRoleScene } from "./trash-helpers.js";
import { INJECTED_LOCK_TIMEOUT_BOUND_MS } from "./lock-timeout-bound.js";

// The default space-lock limit is set to 60 s in this file (product value 5000) so the wall-clock bound for "the injected short limit took effect" is far from both - see ./lock-timeout-bound.ts.
vi.mock("../src/storage/tx/quota.js", async () => ({
  ...(await vi.importActual<typeof import("../src/storage/tx/quota.js")>("../src/storage/tx/quota.js")),
  DEFAULT_STORAGE_LOCK_TIMEOUT_MS: (await import("./lock-timeout-bound.js")).SLOW_DEFAULT_LOCK_TIMEOUT_MS,
}));

const NUL = String.fromCharCode(0);
const LONE_SURROGATE = String.fromCharCode(0xd800);
const COMBINING_ACUTE = String.fromCharCode(0x301);
const E_ACUTE = String.fromCharCode(0xe9);
const RANDOM_UUID = "7d0c6a4e-1f2b-4c3d-9e8f-0a1b2c3d4e5f";
const FOLDER_KEYS = ["createdAt", "id", "name", "parentId", "permissions", "space"];
const ALL = { manage: true, deleteNotes: true, createNote: true };

const post = (app: FastifyInstance, userId: string | null, payload: unknown) => inject(app, "POST", "/api/folders", userId, payload);

function created(res: LightMyRequestResponse): FolderDto {
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as FolderDto;
}

/** Asserts status and error code; returns the raw body (for byte-for-byte comparison). */
function failed(res: LightMyRequestResponse, status: number, code: string): string {
  expect(res.statusCode, res.body).toBe(status);
  expect((res.json() as { error: { code: string } }).error.code).toBe(code);
  return res.body;
}
const messageOf = (res: LightMyRequestResponse): string => (res.json() as { error: { message: string } }).error.message;

async function listOf(app: FastifyInstance, userId: string): Promise<FolderDto[]> {
  const res = await inject(app, "GET", "/api/folders", userId);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as FolderListDto).folders;
}

async function folderCount(db: Db): Promise<number> {
  const { rows } = await db.$client.query<{ n: number }>("select count(*)::int as n from folders");
  return rows[0]!.n;
}

/** sixRoleScene + create-only (read + create, no edit) + noRead (member, role without read) + site admin (non-member). */
async function roleScene(db: Db) {
  const s = await sixRoleScene(db);
  const createOnly = await seedUser(db);
  const noRead = await seedUser(db);
  const siteAdmin = await seedUser(db, { isAdmin: true });
  const createOnlyRole = await seedRole(db, s.groupId, "create-only", { canRead: true, canCreate: true });
  const noReadRole = await seedRole(db, s.groupId, "no-read", {});
  await db.insert(groupMembers).values([
    { groupId: s.groupId, userId: createOnly.id, roleId: createOnlyRole },
    { groupId: s.groupId, userId: noRead.id, roleId: noReadRole },
  ]);
  return { ...s, createOnly, noRead, siteAdmin };
}

/** Test hook: after `arm(point, fn)`, the first time point is passed fn runs (once only). */
function armedHook() {
  let armed: { point: GroupRacePoint; fn: () => Promise<void> } | null = null;
  return {
    hook: async (point: GroupRacePoint) => {
      if (armed && armed.point === point) {
        const { fn } = armed;
        armed = null;
        await fn();
      }
    },
    arm(point: GroupRacePoint, fn: () => Promise<void>) {
      armed = { point, fn };
    },
  };
}

describe("POST /api/folders", () => {
  it("personal root: 201, key set, permissions all true, created_by = caller, listed by GET", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const f = created(await post(app, u.id, { name: "Docs", space: { kind: "personal" } }));
    expect(Object.keys(f).sort()).toEqual(FOLDER_KEYS);
    expect(f).toMatchObject({ name: "Docs", parentId: null, space: { kind: "personal" }, permissions: ALL });
    expect(Object.keys(f.space)).toEqual(["kind"]);
    expect(await folderRow(db.$client, f.id)).toMatchObject({ kind: "personal", owner_id: u.id, group_id: null, parent_id: null, name: "Docs", created_by: u.id });
    expect(await listOf(app, u.id)).toEqual([f]);
  });

  it("private shared root: createNote is false", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const f = created(await post(app, u.id, { name: "Shared", space: { kind: "shared" } }));
    expect(f).toMatchObject({ space: { kind: "shared" }, permissions: { manage: true, deleteNotes: true, createNote: false } });
    expect(await folderRow(db.$client, f.id)).toMatchObject({ kind: "shared", owner_id: u.id, group_id: null, created_by: u.id });
  });

  it("group root: a role with can_edit 201; no edit 403; non-member/no read/site admin/nonexistent/non-UUID 404 group_not_found byte-for-byte identical", async () => {
    const { app, db } = await buildTestApp();
    const s = await roleScene(db);
    const space = { kind: "group", groupId: s.groupId };
    for (const u of [s.admin, s.member, s.editDelete, s.editOnly]) {
      const f = created(await post(app, u.id, { name: `by-${u.id}`, space }));
      expect(f.space).toEqual({ kind: "group", groupId: s.groupId });
      expect(await folderRow(db.$client, f.id)).toMatchObject({ kind: "group", owner_id: null, group_id: s.groupId, created_by: u.id });
    }
    for (const u of [s.deleteOnly, s.readOnly, s.createOnly]) {
      const res = await post(app, u.id, { name: `x-${u.id}`, space });
      failed(res, 403, "forbidden");
      expect(messageOf(res)).toBe("Your role in this group can't create folders.");
    }
    const bodies = [
      failed(await post(app, s.outsider.id, { name: "A", space }), 404, "group_not_found"),
      failed(await post(app, s.noRead.id, { name: "A", space }), 404, "group_not_found"),
      failed(await post(app, s.siteAdmin.id, { name: "A", space }), 404, "group_not_found"),
      failed(await post(app, s.member.id, { name: "A", space: { kind: "group", groupId: RANDOM_UUID } }), 404, "group_not_found"),
      failed(await post(app, s.member.id, { name: "A", space: { kind: "group", groupId: "x" } }), 404, "group_not_found"),
    ];
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain("No group with that id.");
    const { rows } = await db.$client.query<{ n: number }>("select count(*)::int as n from folders where group_id = $1", [s.groupId]);
    expect(rows[0]!.n).toBe(4);
  });

  it("parent folder: own 201; someone else's, a non-member group's, a site admin viewing another's, a random uuid and 'x' give byte-for-byte identical 404; group folder readOnly 403", async () => {
    const { app, db } = await buildTestApp();
    const s = await roleScene(db);
    const other = await seedUser(db);
    const mine = await seedFolder(db, { personal: s.outsider.id });
    const mineShared = await seedFolder(db, { shared: s.outsider.id });
    const othersPersonal = await seedFolder(db, { personal: other.id });
    const groupFolder = await seedFolder(db, { group: s.groupId });

    const child = created(await post(app, s.outsider.id, { name: "child", parentId: mine.id }));
    expect(child).toMatchObject({ parentId: mine.id, space: { kind: "personal" }, permissions: ALL });
    expect((await folderRow(db.$client, child.id))?.parent_id).toBe(mine.id);
    const sharedChild = created(await post(app, s.outsider.id, { name: "child", parentId: mineShared.id }));
    expect(sharedChild).toMatchObject({ parentId: mineShared.id, space: { kind: "shared" }, permissions: { createNote: false } });
    const groupChild = created(await post(app, s.member.id, { name: "child", parentId: groupFolder.id }));
    expect(groupChild).toMatchObject({ parentId: groupFolder.id, space: { kind: "group", groupId: s.groupId }, permissions: { manage: true, deleteNotes: false, createNote: true } });

    const bodies = [
      failed(await post(app, s.outsider.id, { name: "A", parentId: othersPersonal.id }), 404, "folder_not_found"),
      failed(await post(app, s.outsider.id, { name: "A", parentId: groupFolder.id }), 404, "folder_not_found"),
      failed(await post(app, s.siteAdmin.id, { name: "A", parentId: othersPersonal.id }), 404, "folder_not_found"),
      failed(await post(app, s.siteAdmin.id, { name: "A", parentId: groupFolder.id }), 404, "folder_not_found"),
      failed(await post(app, s.noRead.id, { name: "A", parentId: groupFolder.id }), 404, "folder_not_found"),
      failed(await post(app, s.outsider.id, { name: "A", parentId: RANDOM_UUID }), 404, "folder_not_found"),
      failed(await post(app, s.outsider.id, { name: "A", parentId: "x" }), 404, "folder_not_found"),
    ];
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain("No folder with that id.");
    for (const u of [s.readOnly, s.deleteOnly, s.createOnly]) {
      const res = await post(app, u.id, { name: "A", parentId: groupFolder.id });
      failed(res, 403, "forbidden");
      expect(messageOf(res)).toBe("You don't have permission to manage this folder.");
    }
    expect(await folderCount(db)).toBe(7);
  });

  it("name: NUL/lone surrogate/newline/81 characters 400; trailing newline trimmed; 80 x emoji; NFC; same-level case-insensitive and NFC collisions 409; same name under a different parent or in a different space 201", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const other = await seedUser(db);
    const personal = { kind: "personal" };
    const bad: Array<[string, string]> = [
      [`A${NUL}B`, "The folder name contains characters that can't be stored."],
      [`A${LONE_SURROGATE}`, "The folder name contains characters that can't be stored."],
      ["A\nB", "The folder name can't contain line breaks or control characters."],
      ["a".repeat(81), "Folder names must be 1 to 80 characters."],
      ["   ", "Folder names must be 1 to 80 characters."],
    ];
    for (const [name, message] of bad) {
      const res = await post(app, u.id, { name, space: personal });
      failed(res, 400, "invalid_body");
      expect(messageOf(res)).toBe(message);
    }
    expect(await folderCount(db)).toBe(0);

    expect(created(await post(app, u.id, { name: "A\n", space: personal })).name).toBe("A");
    const emoji = created(await post(app, u.id, { name: "😀".repeat(80), space: personal }));
    expect(Array.from(emoji.name)).toHaveLength(80);
    const nfc = created(await post(app, u.id, { name: `e${COMBINING_ACUTE}`, space: personal }));
    expect(nfc.name).toBe(E_ACUTE);
    expect((await folderRow(db.$client, nfc.id))?.name).toBe(E_ACUTE);

    const docs = created(await post(app, u.id, { name: "Docs", space: personal }));
    const taken = await post(app, u.id, { name: "docs", space: personal });
    failed(taken, 409, "folder_name_taken");
    expect(messageOf(taken)).toBe("A folder with that name already exists here.");
    failed(await post(app, u.id, { name: E_ACUTE, space: personal }), 409, "folder_name_taken");
    failed(await post(app, u.id, { name: `E${COMBINING_ACUTE}`, space: personal }), 409, "folder_name_taken");

    created(await post(app, u.id, { name: "Docs", parentId: docs.id }));
    created(await post(app, u.id, { name: "Docs", space: { kind: "shared" } }));
    created(await post(app, other.id, { name: "Docs", space: personal }));
  });

  it(`depth: creating ${FOLDER_DEPTH_MAX} levels in a row 201, level ${FOLDER_DEPTH_MAX + 1} 409 folder_too_deep`, async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    let parent = created(await post(app, u.id, { name: "L1", space: { kind: "personal" } }));
    for (let level = 2; level <= FOLDER_DEPTH_MAX; level++) {
      parent = created(await post(app, u.id, { name: `L${level}`, parentId: parent.id }));
    }
    const res = await post(app, u.id, { name: "too deep", parentId: parent.id });
    failed(res, 409, "folder_too_deep");
    expect(messageOf(res)).toBe("Folders can be nested at most 5 levels deep.");
    expect(await folderCount(db)).toBe(FOLDER_DEPTH_MAX);
  });

  it(`count: the ${FOLDERS_PER_SPACE_MAX}th in a space 201, one more 409 folder_limit (including child levels); the same person's other space and another user are unaffected`, async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const other = await seedUser(db);
    const p = await seedFolder(db, { personal: u.id }, { name: "P" });
    await db.$client.query(
      `insert into folders (kind, owner_id, parent_id, name, created_by)
       select 'personal', $1::uuid, $2::uuid, 'bulk-' || g, $1::uuid from generate_series(1, $3::int) g`,
      [u.id, p.id, FOLDERS_PER_SPACE_MAX - 2],
    );
    created(await post(app, u.id, { name: "last", space: { kind: "personal" } }));
    const full = await post(app, u.id, { name: "one more", parentId: p.id });
    failed(full, 409, "folder_limit");
    expect(messageOf(full)).toBe("This space has reached its folder limit.");
    failed(await post(app, u.id, { name: "root more", space: { kind: "personal" } }), 409, "folder_limit");
    created(await post(app, u.id, { name: "fine", space: { kind: "shared" } }));
    created(await post(app, other.id, { name: "fine", space: { kind: "personal" } }));
  });

  it("body: parentId together with space, neither, unknown key, malformed space, name missing or not a string 400; name is judged before position; uppercase parentId/groupId 201", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const s = await roleScene(db);
    const mine = await seedFolder(db, { personal: u.id });
    const before = await folderCount(db);
    const bad: unknown[] = [
      { name: "A", parentId: mine.id, space: { kind: "personal" } },
      { name: "A" },
      { name: "A", space: { kind: "personal" }, extra: 1 },
      { name: "A", space: { kind: "x" } },
      { name: "A", space: { kind: "personal", groupId: s.groupId } },
      { name: "A", space: { kind: "group" } },
      { name: "A", space: { kind: "group", groupId: s.groupId, x: 1 } },
      { name: "A", space: { kind: "shared", x: 1 } },
      { space: { kind: "personal" } },
      { name: 1, space: { kind: "personal" } },
      { name: "A", parentId: 1 },
    ];
    for (const payload of bad) failed(await post(app, u.id, payload), 400, "invalid_body");
    failed(await post(app, u.id, { name: `A${NUL}`, parentId: RANDOM_UUID }), 400, "invalid_body");
    expect(await folderCount(db)).toBe(before);

    const upper = created(await post(app, u.id, { name: "upper", parentId: mine.id.toUpperCase() }));
    expect(upper.parentId).toBe(mine.id);
    const upperGroup = created(await post(app, s.member.id, { name: "upper", space: { kind: "group", groupId: s.groupId.toUpperCase() } }));
    expect(upperGroup.space).toEqual({ kind: "group", groupId: s.groupId });
    expect((await folderRow(db.$client, upperGroup.id))?.group_id).toBe(s.groupId);
  });

  it("auth: Bearer (notes:read notes:write) POST 401; Bearer notes:read GET 200; not signed in GET/POST 401", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const f = await seedFolder(db, { personal: u.id }, { name: "Mine" });
    const rw = await seedTokenForUser(db, u.id, "notes:read notes:write");
    const ro = await seedTokenForUser(db, u.id, "notes:read");
    const viaBearer = await app.inject({ method: "POST", url: "/api/folders", headers: bearer(rw.token), payload: { name: "B", space: { kind: "personal" } } });
    expect(viaBearer.statusCode, viaBearer.body).toBe(401);
    expect(await folderCount(db)).toBe(1);
    const got = await app.inject({ method: "GET", url: "/api/folders", headers: bearer(ro.token) });
    expect(got.statusCode, got.body).toBe(200);
    expect((got.json() as FolderListDto).folders.map(x => x.id)).toEqual([f.id]);
    expect((await inject(app, "GET", "/api/folders", null)).statusCode).toBe(401);
    expect((await post(app, null, { name: "C", space: { kind: "personal" } })).statusCode).toBe(401);
  });

  it("throttle: folder bucket limit 1 - requests failing authorization aren't charged; 429 before the second success; another user unaffected", async () => {
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ folder: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }) });
    const u = await seedUser(db);
    const other = await seedUser(db);
    failed(await post(app, u.id, { name: "A", parentId: RANDOM_UUID }), 404, "folder_not_found");
    failed(await post(app, u.id, { name: "", space: { kind: "personal" } }), 400, "invalid_body");
    created(await post(app, u.id, { name: "first", space: { kind: "personal" } }));
    const res = await post(app, u.id, { name: "second", space: { kind: "personal" } });
    failed(res, 429, "too_many_requests");
    expect(messageOf(res)).toBe("Too many writes. Wait a moment and try again.");
    created(await post(app, other.id, { name: "first", space: { kind: "personal" } }));
    expect(await folderCount(db)).toBe(2);
  });

  it("group deleted (transferred) after authorization, before the transaction: group root 404 group_not_found, parent-folder form 404 folder_not_found, byte-for-byte identical to nonexistent", async () => {
    const seam = armedHook();
    const { app, db } = await buildTestApp({ groupTestHook: seam.hook });
    const deleteGroupOf = (adminId: string, groupId: string) => async () => {
      const del = await inject(app, "DELETE", `/api/groups/${groupId}`, adminId, { mode: "transfer", transferTo: adminId });
      expect(del.statusCode, del.body).toBe(204);
    };
    const a = await sixRoleScene(db);
    seam.arm("folder-authorized", deleteGroupOf(a.admin.id, a.groupId));
    const rootBody = failed(await post(app, a.member.id, { name: "A", space: { kind: "group", groupId: a.groupId } }), 404, "group_not_found");
    expect(rootBody).toBe(failed(await post(app, a.member.id, { name: "A", space: { kind: "group", groupId: RANDOM_UUID } }), 404, "group_not_found"));

    const b = await sixRoleScene(db);
    const gf = await seedFolder(db, { group: b.groupId });
    seam.arm("folder-authorized", deleteGroupOf(b.admin.id, b.groupId));
    const parentBody = failed(await post(app, b.member.id, { name: "A", parentId: gf.id }), 404, "folder_not_found");
    expect(parentBody).toBe(failed(await post(app, b.member.id, { name: "A", parentId: RANDOM_UUID }), 404, "folder_not_found"));
    // Only checks that these POSTs created no row (where the group folder itself ends up is decided by deleting the group, not asserted here).
    const { rows } = await db.$client.query<{ n: number }>("select count(*)::int as n from folders where name = 'A'");
    expect(rows[0]!.n).toBe(0);
  });

  it("role downgrade inside the transaction (after the structure lock): removing can_edit -> 403; removing read or removing from the group -> 404 (root: group_not_found, parent folder: folder_not_found)", async () => {
    const seam = armedHook();
    const { app, db } = await buildTestApp({ groupTestHook: seam.hook });
    const pool = db.$client;
    const s = await sixRoleScene(db);
    const gf = await seedFolder(db, { group: s.groupId });
    const space = { kind: "group", groupId: s.groupId };
    const roleOf = async (userId: string) =>
      (await pool.query<{ role_id: string }>("select role_id from group_members where group_id = $1 and user_id = $2", [s.groupId, userId])).rows[0]!.role_id;
    const setFlags = (userId: string, sqlSet: string) => async () => {
      await pool.query(`update group_roles set ${sqlSet} where id = $1`, [await roleOf(userId)]);
    };
    const restore = (userId: string) => setFlags(userId, "can_read = true, can_edit = true")();

    const forbidden: Array<[unknown, string]> = [
      [{ name: "A", space }, "Your role in this group can't create folders."],
      [{ name: "A", parentId: gf.id }, "You don't have permission to manage this folder."],
    ];
    for (const [payload, message] of forbidden) {
      seam.arm("folder-structure-locked", setFlags(s.editOnly.id, "can_edit = false"));
      const res = await post(app, s.editOnly.id, payload);
      failed(res, 403, "forbidden");
      expect(messageOf(res)).toBe(message);
      await restore(s.editOnly.id);
    }
    seam.arm("folder-structure-locked", setFlags(s.editOnly.id, "can_edit = false, can_read = false"));
    failed(await post(app, s.editOnly.id, { name: "A", space }), 404, "group_not_found");
    await restore(s.editOnly.id);
    seam.arm("folder-structure-locked", setFlags(s.editOnly.id, "can_edit = false, can_read = false"));
    failed(await post(app, s.editOnly.id, { name: "A", parentId: gf.id }), 404, "folder_not_found");
    await restore(s.editOnly.id);

    const kick = async () => {
      await pool.query("delete from group_members where group_id = $1 and user_id = $2", [s.groupId, s.editDelete.id]);
    };
    seam.arm("folder-structure-locked", kick);
    failed(await post(app, s.editDelete.id, { name: "A", space }), 404, "group_not_found");
    await pool.query("insert into group_members (group_id, user_id, role_id) select $1, $2, id from group_roles where group_id = $1 and builtin = 'member'", [s.groupId, s.editDelete.id]);
    seam.arm("folder-structure-locked", kick);
    failed(await post(app, s.editDelete.id, { name: "A", parentId: gf.id }), 404, "folder_not_found");
    expect(await folderCount(db)).toBe(1);
  });

  it("structure lock waits too long (another connection holds the same space's lock, lock_timeout 300 ms): 409 server_busy (< 20 s: the injected value took effect, not this file's default 60 s), no row created; 201 as usual after the lock is released", async () => {
    const { app, db } = await buildTestApp({ storageLockTimeoutMs: 300 });
    const u = await seedUser(db);
    const holder = await db.$client.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [`knotebook.folders:personal:${u.id}`]);
      const t0 = Date.now();
      const res = await post(app, u.id, { name: "busy", space: { kind: "personal" } });
      const ms = Date.now() - t0;
      failed(res, 409, "server_busy");
      expect(messageOf(res)).toBe("The server is busy. Try again in a moment.");
      expect(ms).toBeLessThan(INJECTED_LOCK_TIMEOUT_BOUND_MS);
    } finally {
      try {
        await holder.query("rollback");
      } finally {
        holder.release();
      }
    }
    expect(await folderCount(db)).toBe(0);
    created(await post(app, u.id, { name: "busy", space: { kind: "personal" } }));
  });

  it("parent folder changed space after the pre-read (simulates a transfer to the caller's personal folder) or deleted: 404 folder_not_found, not 500", async () => {
    const seam = armedHook();
    const { app, db } = await buildTestApp({ groupTestHook: seam.hook });
    const s = await sixRoleScene(db);
    const gf = await seedFolder(db, { group: s.groupId });
    seam.arm("folder-authorized", async () => {
      await db.$client.query("update folders set kind = 'personal', owner_id = $2, group_id = null where id = $1", [gf.id, s.member.id]);
    });
    const body = failed(await post(app, s.member.id, { name: "A", parentId: gf.id }), 404, "folder_not_found");
    expect(body).toBe(failed(await post(app, s.member.id, { name: "A", parentId: RANDOM_UUID }), 404, "folder_not_found"));

    // The parent folder was deleted after the pre-read: the KEY SHARE read inside the transaction finds nothing -> 404 (not the 500 of FK 23503).
    const gone = await seedFolder(db, { personal: s.member.id });
    seam.arm("folder-authorized", async () => {
      await db.$client.query("delete from folders where id = $1", [gone.id]);
    });
    expect(failed(await post(app, s.member.id, { name: "A", parentId: gone.id }), 404, "folder_not_found")).toBe(body);
    expect(await folderCount(db)).toBe(1);
  });

  it("creating a folder leaves the state of all the caller's notes (including updated_at) and the note_states row count unchanged", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const s = await sixRoleScene(db);
    const n1 = await seedNote(db, { ownerId: s.member.id });
    const n2 = await seedNote(db, { ownerId: s.member.id });
    const gn = await seedNote(db, { groupId: s.groupId });
    await pool.query("insert into note_states (note_id, ydoc) values ($1, decode('00', 'hex')), ($2, decode('00', 'hex'))", [n1.id, gn.id]);
    const ids = [n1.id, n2.id, gn.id];
    const snapshot = async () => ({
      states: await Promise.all(ids.map(id => noteState(pool, id))),
      noteStates: (await pool.query<{ n: number; v: string }>(
        "select count(*)::int as n, string_agg(note_id::text || ':' || version || ':' || updated_at::text, ',' order by note_id) as v from note_states",
      )).rows[0],
    });
    const before = await snapshot();
    const root = created(await post(app, s.member.id, { name: "P", space: { kind: "personal" } }));
    created(await post(app, s.member.id, { name: "C", parentId: root.id }));
    created(await post(app, s.member.id, { name: "G", space: { kind: "group", groupId: s.groupId } }));
    expect(await snapshot()).toEqual(before);
  });
});

describe("GET /api/folders", () => {
  it("permissions of group folders per role; non-members, no-read members and site admins can't see them", async () => {
    const { app, db } = await buildTestApp();
    const s = await roleScene(db);
    const gf = await seedFolder(db, { group: s.groupId }, { name: "G" });
    await seedFolder(db, { personal: s.admin.id }, { name: "admin's own" });
    const expected: Array<[string, { manage: boolean; deleteNotes: boolean; createNote: boolean }]> = [
      [s.admin.id, ALL],
      [s.member.id, { manage: true, deleteNotes: false, createNote: true }],
      [s.editDelete.id, { manage: true, deleteNotes: true, createNote: false }],
      [s.deleteOnly.id, { manage: false, deleteNotes: true, createNote: false }],
      [s.editOnly.id, { manage: true, deleteNotes: false, createNote: false }],
      [s.readOnly.id, { manage: false, deleteNotes: false, createNote: false }],
      [s.createOnly.id, { manage: false, deleteNotes: false, createNote: false }],
    ];
    for (const [userId, permissions] of expected) {
      const groupRows = (await listOf(app, userId)).filter(f => f.space.kind === "group");
      expect(groupRows).toEqual([expect.objectContaining({ id: gf.id, permissions })]);
    }
    for (const u of [s.outsider, s.noRead, s.siteAdmin]) expect(await listOf(app, u.id)).toEqual([]);
  });
});

/** Control and combining characters are always built with `String.fromCharCode` (no escape sequences in the source). */
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Pool } from "pg";
import { FOLDER_DEPTH_MAX, type FolderDto } from "@knotebook/shared";
import type { GroupRacePoint } from "../src/groups/test-hook.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import { folderRow, noteFolderCols, placementOf, seedFolder, seedFolderChain, seedPlacement, setNoteFolder, xminOf } from "./folder-helpers.js";
import { noteState, seedNote, seedShare, seedUser } from "./group-helpers.js";
import { buildTestApp, freshLimiters } from "./helpers.js";
import { inject, markTrashed, sixRoleScene, trashCols } from "./trash-helpers.js";
import { INJECTED_LOCK_TIMEOUT_BOUND_MS } from "./lock-timeout-bound.js";

// The default space-lock limit is set to 60 s in this file (product value 5000) so the wall-clock bound for "the injected short limit took effect" is far from both - see ./lock-timeout-bound.ts.
vi.mock("../src/storage/tx/quota.js", async () => ({
  ...(await vi.importActual<typeof import("../src/storage/tx/quota.js")>("../src/storage/tx/quota.js")),
  DEFAULT_STORAGE_LOCK_TIMEOUT_MS: (await import("./lock-timeout-bound.js")).SLOW_DEFAULT_LOCK_TIMEOUT_MS,
}));

const NUL = String.fromCharCode(0);
const COMBINING_ACUTE = String.fromCharCode(0x301);
const E_ACUTE = String.fromCharCode(0xe9);
const CAP_E_ACUTE = String.fromCharCode(0xc9);
const RANDOM_UUID = "7d0c6a4e-1f2b-4c3d-9e8f-0a1b2c3d4e5f";
const FOLDER_KEYS = ["createdAt", "id", "name", "parentId", "permissions", "space"];
const NOT_MANAGER = "You don't have permission to manage this folder.";

const patch = (app: FastifyInstance, userId: string | null, id: string, payload?: unknown) =>
  inject(app, "PATCH", `/api/folders/${id}`, userId, payload);

function ok(res: LightMyRequestResponse): FolderDto {
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as FolderDto;
}

/** Asserts status and error code; returns the raw body (for byte-for-byte comparison). */
function failed(res: LightMyRequestResponse, status: number, code: string): string {
  expect(res.statusCode, res.body).toBe(status);
  expect((res.json() as { error: { code: string } }).error.code).toBe(code);
  return res.body;
}
const messageOf = (res: LightMyRequestResponse): string => (res.json() as { error: { message: string } }).error.message;

const parentOf = async (pool: Pool, id: string) => (await folderRow(pool, id))?.parent_id;
const nameOf = async (pool: Pool, id: string) => (await folderRow(pool, id))?.name;

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

describe("PATCH /api/folders/:id", () => {
  it("rename: 200; a case-only difference is written; NFC-equivalent isn't written; same-level collision 409; name rules same as create", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const u = await seedUser(db);
    const f = await seedFolder(db, { personal: u.id }, { name: "Docs" });
    await seedFolder(db, { personal: u.id }, { name: "Other" });

    const renamed = ok(await patch(app, u.id, f.id, { name: "Renamed" }));
    expect(Object.keys(renamed).sort()).toEqual(FOLDER_KEYS);
    expect(renamed).toMatchObject({ id: f.id, name: "Renamed", parentId: null, space: { kind: "personal" }, permissions: { manage: true, deleteNotes: true, createNote: true } });
    expect(await nameOf(pool, f.id)).toBe("Renamed");
    expect(ok(await patch(app, u.id, f.id, { name: "renamed" })).name).toBe("renamed");
    expect(await nameOf(pool, f.id)).toBe("renamed");

    const e = await seedFolder(db, { personal: u.id }, { name: E_ACUTE });
    const x0 = await xminOf(pool, "folders", e.id);
    expect(ok(await patch(app, u.id, e.id, { name: `e${COMBINING_ACUTE}` })).name).toBe(E_ACUTE);
    expect(await xminOf(pool, "folders", e.id)).toBe(x0);
    expect(ok(await patch(app, u.id, e.id, { name: `E${COMBINING_ACUTE}` })).name).toBe(CAP_E_ACUTE);
    expect(await nameOf(pool, e.id)).toBe(CAP_E_ACUTE);

    const taken = await patch(app, u.id, f.id, { name: "other" });
    failed(taken, 409, "folder_name_taken");
    expect(messageOf(taken)).toBe("A folder with that name already exists here.");
    const bad: Array<[string, string]> = [
      [`A${NUL}B`, "The folder name contains characters that can't be stored."],
      ["A\nB", "The folder name can't contain line breaks or control characters."],
      ["a".repeat(81), "Folder names must be 1 to 80 characters."],
      ["   ", "Folder names must be 1 to 80 characters."],
    ];
    for (const [name, message] of bad) {
      const res = await patch(app, u.id, f.id, { name });
      failed(res, 400, "invalid_body");
      expect(messageOf(res)).toBe(message);
    }
    // The name is judged before the position: a NUL name with a random id is also 400.
    failed(await patch(app, u.id, RANDOM_UUID, { name: `A${NUL}` }), 400, "invalid_body");
    expect(ok(await patch(app, u.id, f.id, { name: "  Trimmed\n" })).name).toBe("Trimmed");
  });

  it("move: under a sibling 200; parentId null back to root; moving to the original parent doesn't write (xmin unchanged); target level already has the same name 409; name and position changed together", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const u = await seedUser(db);
    const a = await seedFolder(db, { personal: u.id }, { name: "A" });
    const b = await seedFolder(db, { personal: u.id }, { name: "B" });
    const a1 = await seedFolder(db, { personal: u.id }, { name: "A1", parentId: a.id });

    expect(ok(await patch(app, u.id, a1.id, { parentId: b.id })).parentId).toBe(b.id);
    expect(await parentOf(pool, a1.id)).toBe(b.id);
    expect(ok(await patch(app, u.id, a1.id, { parentId: null })).parentId).toBeNull();
    expect(await parentOf(pool, a1.id)).toBeNull();

    let x = await xminOf(pool, "folders", a1.id);
    expect(ok(await patch(app, u.id, a1.id, { parentId: null })).parentId).toBeNull();
    expect(await xminOf(pool, "folders", a1.id)).toBe(x);
    ok(await patch(app, u.id, a1.id, { parentId: a.id }));
    x = await xminOf(pool, "folders", a1.id);
    expect(ok(await patch(app, u.id, a1.id, { parentId: a.id, name: "A1" })).parentId).toBe(a.id);
    expect(await xminOf(pool, "folders", a1.id)).toBe(x);

    await seedFolder(db, { personal: u.id }, { name: "dup", parentId: b.id });
    const dup = await seedFolder(db, { personal: u.id }, { name: "Dup" });
    const taken = await patch(app, u.id, dup.id, { parentId: b.id });
    failed(taken, 409, "folder_name_taken");
    expect(messageOf(taken)).toBe("A folder with that name already exists here.");
    expect(await parentOf(pool, dup.id)).toBeNull();

    const both = ok(await patch(app, u.id, dup.id, { parentId: b.id, name: "Dup2" }));
    expect(both).toMatchObject({ parentId: b.id, name: "Dup2" });
    expect(await folderRow(pool, dup.id)).toMatchObject({ parent_id: b.id, name: "Dup2" });
  });

  it("cycle: moving into itself, its child, its grandchild 409 folder_cycle, nothing written", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const u = await seedUser(db);
    const [x, y, z] = await seedFolderChain(db, { personal: u.id }, ["X", "Y", "Z"]);
    const before = await xminOf(pool, "folders", x!);
    for (const target of [x!, y!, z!]) {
      const res = await patch(app, u.id, x!, { parentId: target });
      failed(res, 409, "folder_cycle");
      expect(messageOf(res)).toBe("A folder can't be moved into itself or one of its subfolders.");
    }
    failed(await patch(app, u.id, y!, { parentId: z! }), 409, "folder_cycle");
    expect(await parentOf(pool, x!)).toBeNull();
    expect(await parentOf(pool, y!)).toBe(x);
    expect(await xminOf(pool, "folders", x!)).toBe(before);
  });

  it(`depth: a height-2 subtree moved under a parent of depth 4 409, depth 3 200; moving back to root is judged by height; an over-deep tree can still be renamed and moved to its original parent`, async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const u = await seedUser(db);
    const space = { personal: u.id };
    const d = await seedFolderChain(db, space, ["D1", "D2", "D3", "D4"]);
    const [s1, s2] = await seedFolderChain(db, space, ["S1", "S2"]);
    const res = await patch(app, u.id, s1!, { parentId: d[3]! });
    failed(res, 409, "folder_too_deep");
    expect(messageOf(res)).toBe(`Folders can be nested at most ${FOLDER_DEPTH_MAX} levels deep.`);
    expect(await parentOf(pool, s1!)).toBeNull();
    expect(ok(await patch(app, u.id, s1!, { parentId: d[2]! })).parentId).toBe(d[2]);
    expect(await parentOf(pool, s2!)).toBe(s1);

    // An over-deep tree made by a transfer (7 levels seeded directly): under H1 the height is 6, moving to root 409; renaming and "moving to the original parent" don't check depth.
    const [r, h1, ...rest] = await seedFolderChain(db, space, ["R", "H1", "H2", "H3", "H4", "H5", "H6"]);
    failed(await patch(app, u.id, h1!, { parentId: null }), 409, "folder_too_deep");
    expect(await parentOf(pool, h1!)).toBe(r);
    expect(ok(await patch(app, u.id, h1!, { parentId: r!, name: "H1x" })).name).toBe("H1x");
    expect(ok(await patch(app, u.id, rest[4]!, { name: "deepest" })).name).toBe("deepest");
    expect(ok(await patch(app, u.id, rest[0]!, { parentId: null })).parentId).toBeNull();
  });

  it("cross-space: personal -> own shared, personal -> a visible group, group -> personal 400; an invisible group folder 404 byte-for-byte identical to a random uuid, 'x' and ''", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const s = await sixRoleScene(db);
    const other = await sixRoleScene(db);
    const u = s.member;
    const p1 = await seedFolder(db, { personal: u.id });
    const sh = await seedFolder(db, { shared: u.id });
    const g = await seedFolder(db, { group: s.groupId });
    const hidden = await seedFolder(db, { group: other.groupId });

    for (const [self, target] of [[p1.id, sh.id], [p1.id, g.id], [g.id, p1.id], [sh.id, p1.id]] as const) {
      const res = await patch(app, u.id, self, { parentId: target });
      failed(res, 400, "folder_cross_space");
      expect(messageOf(res)).toBe("A folder can't be moved to another space.");
    }
    const bodies = [
      failed(await patch(app, u.id, p1.id, { parentId: hidden.id }), 404, "folder_not_found"),
      failed(await patch(app, u.id, g.id, { parentId: hidden.id }), 404, "folder_not_found"),
      failed(await patch(app, u.id, p1.id, { parentId: RANDOM_UUID }), 404, "folder_not_found"),
      failed(await patch(app, u.id, p1.id, { parentId: "x" }), 404, "folder_not_found"),
      failed(await patch(app, u.id, p1.id, { parentId: "" }), 404, "folder_not_found"),
      failed(await patch(app, u.id, hidden.id, { name: "A" }), 404, "folder_not_found"),
    ];
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain("No folder with that id.");
    for (const id of [p1.id, sh.id, g.id, hidden.id]) expect(await parentOf(pool, id)).toBeNull();
  });

  it("permissions (group folder): admin/member/editDelete/editOnly rename and move 200; deleteOnly, readOnly 403; non-members and site admins 404 same shape as nonexistent", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const s = await sixRoleScene(db);
    const siteAdmin = await seedUser(db, { isAdmin: true });
    const g = await seedFolder(db, { group: s.groupId }, { name: "G" });
    const c = await seedFolder(db, { group: s.groupId }, { name: "C", parentId: g.id });

    for (const [i, u] of [s.admin, s.member, s.editDelete, s.editOnly].entries()) {
      const renamed = ok(await patch(app, u.id, g.id, { name: `G${i}` }));
      expect(renamed.space).toEqual({ kind: "group", groupId: s.groupId });
      expect(ok(await patch(app, u.id, c.id, { parentId: null })).parentId).toBeNull();
      expect(ok(await patch(app, u.id, c.id, { parentId: g.id })).parentId).toBe(g.id);
    }
    expect(ok(await patch(app, s.member.id, g.id, { name: "G" })).permissions).toEqual({ manage: true, deleteNotes: false, createNote: true });
    const before = await xminOf(pool, "folders", g.id);
    for (const u of [s.deleteOnly, s.readOnly]) {
      for (const [id, payload] of [[g.id, { name: "nope" }], [c.id, { parentId: null }], [c.id, { name: "nope", parentId: null }]] as const) {
        const res = await patch(app, u.id, id, payload);
        failed(res, 403, "forbidden");
        expect(messageOf(res)).toBe(NOT_MANAGER);
      }
      // Order: visibility -> space -> manage rights - someone without manage rights gets 400 moving to a cross-space target and 404 to an invisible target.
      const own = await seedFolder(db, { personal: u.id });
      const cross = await patch(app, u.id, c.id, { parentId: own.id });
      failed(cross, 400, "folder_cross_space");
      expect(messageOf(cross)).toBe("A folder can't be moved to another space.");
      failed(await patch(app, u.id, c.id, { parentId: RANDOM_UUID }), 404, "folder_not_found");
    }
    const bodies = [
      failed(await patch(app, s.outsider.id, g.id, { name: "nope" }), 404, "folder_not_found"),
      failed(await patch(app, s.outsider.id, c.id, { parentId: null }), 404, "folder_not_found"),
      failed(await patch(app, siteAdmin.id, g.id, { name: "nope" }), 404, "folder_not_found"),
      failed(await patch(app, s.member.id, RANDOM_UUID, { name: "nope" }), 404, "folder_not_found"),
    ];
    expect(new Set(bodies).size).toBe(1);
    expect(await xminOf(pool, "folders", g.id)).toBe(before);
    expect(await folderRow(pool, c.id)).toMatchObject({ parent_id: g.id, name: "C" });
  });

  it("before and after move and rename, notes in the subtree (live, trashed, shared, with versions and note_states) don't have a single bit written", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const u = await seedUser(db);
    const viewer = await seedUser(db);
    const [p, q] = await seedFolderChain(db, { personal: u.id }, ["P", "Q"]);
    const r = await seedFolder(db, { personal: u.id }, { name: "R" });
    const live = await seedNote(db, { ownerId: u.id }, { prevSlug: "old-slug", publicToken: "tok-fu7", publicSlug: "pub-fu7" });
    const trashed = await seedNote(db, { ownerId: u.id });
    const shared = await seedNote(db, { ownerId: u.id });
    const versioned = await seedNote(db, { ownerId: u.id });
    const ids = [live.id, trashed.id, shared.id, versioned.id];
    await setNoteFolder(pool, live.id, q!);
    await setNoteFolder(pool, trashed.id, q!);
    await setNoteFolder(pool, shared.id, p!);
    await setNoteFolder(pool, versioned.id, q!);
    await markTrashed(pool, trashed.id, u.id);
    await seedShare(db, shared.id, viewer.id, "editor");
    const viewerShelf = await seedFolder(db, { shared: viewer.id });
    await seedPlacement(pool, viewer.id, shared.id, viewerShelf.id);
    await pool.query("insert into note_states (note_id, ydoc) values ($1, decode('00', 'hex'))", [versioned.id]);
    await pool.query("insert into note_versions (note_id, seq, ydoc, kind) values ($1, 1, decode('00', 'hex'), 'auto'), ($1, 2, decode('00', 'hex'), 'manual')", [versioned.id]);
    await pool.query("insert into note_redirects (old_path, note_id, expires_at) values ($1, $2, now() + interval '1 day')", [`/n/fu7-${live.id}`, live.id]);

    const snapshot = async () => ({
      notes: await Promise.all(ids.map(async id => ({
        state: await noteState(pool, id),
        folder: await noteFolderCols(pool, id),
        trash: await trashCols(pool, id),
        xmin: await xminOf(pool, "notes", id),
      }))),
      placement: await placementOf(pool, viewer.id, shared.id),
      counts: (await pool.query(
        `select (select count(*)::int from note_versions where note_id = any($1)) as versions,
                (select count(*)::int from note_redirects where note_id = any($1)) as redirects,
                (select string_agg(note_id::text || ':' || version || ':' || updated_at::text, ',' order by note_id) from note_states where note_id = any($1)) as states`,
        [ids],
      )).rows[0],
    });
    const before = await snapshot();
    expect(before.counts).toMatchObject({ versions: 2, redirects: 1 });
    ok(await patch(app, u.id, q!, { parentId: r.id }));
    ok(await patch(app, u.id, p!, { name: "P renamed" }));
    ok(await patch(app, u.id, q!, { parentId: null, name: "Q renamed" }));
    ok(await patch(app, u.id, p!, { parentId: q! }));
    expect(await snapshot()).toEqual(before);
  });

  it("bystanders: rename and move touch only that row (xmin and name of siblings, same-named folders in one's own shared and others' same-named folders unchanged)", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const u = await seedUser(db);
    const other = await seedUser(db);
    const target = await seedFolder(db, { personal: u.id }, { name: "Same" });
    const bystanders = [
      await seedFolder(db, { personal: u.id }, { name: "Sibling" }),
      await seedFolder(db, { shared: u.id }, { name: "Same" }),
      await seedFolder(db, { personal: other.id }, { name: "Same" }),
      await seedFolder(db, { personal: other.id }, { name: "Sibling" }),
    ];
    const dest = await seedFolder(db, { personal: u.id }, { name: "Dest" });
    const snap = async () => Promise.all(bystanders.map(async f => ({ x: await xminOf(pool, "folders", f.id), row: await folderRow(pool, f.id) })));
    const before = await snap();
    ok(await patch(app, u.id, target.id, { name: "Renamed" }));
    expect(await snap()).toEqual(before);
    ok(await patch(app, u.id, target.id, { parentId: dest.id }));
    expect(await snap()).toEqual(before);
    expect(await folderRow(pool, target.id)).toMatchObject({ name: "Renamed", parent_id: dest.id });
  });

  it("body and auth: {}, unknown key, wrong type 400; parentId 'x' 404; uppercase :id and uppercase parentId 200; Bearer, not signed in 401", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const u = await seedUser(db);
    const f = await seedFolder(db, { personal: u.id }, { name: "F" });
    const dest = await seedFolder(db, { personal: u.id }, { name: "Dest" });
    const empty = await patch(app, u.id, f.id, {});
    failed(empty, 400, "invalid_body");
    expect(messageOf(empty)).toBe("Invalid request body: send at least one field.");
    failed(await patch(app, u.id, f.id), 400, "invalid_body");
    for (const payload of [{ name: "A", x: 1 }, { name: 1 }, { parentId: 1 }, { name: null }, { parentId: dest.id, extra: true }]) {
      failed(await patch(app, u.id, f.id, payload), 400, "invalid_body");
    }
    failed(await patch(app, u.id, f.id, { parentId: "x" }), 404, "folder_not_found");
    expect(await folderRow(pool, f.id)).toMatchObject({ name: "F", parent_id: null });

    expect(ok(await patch(app, u.id, f.id.toUpperCase(), { name: "Upper" })).id).toBe(f.id);
    const moved = ok(await patch(app, u.id, f.id.toUpperCase(), { parentId: dest.id.toUpperCase() }));
    expect(moved.parentId).toBe(dest.id);
    expect(await folderRow(pool, f.id)).toMatchObject({ name: "Upper", parent_id: dest.id });
    // An uppercase "original parent" is also not a move: nothing is written.
    const x = await xminOf(pool, "folders", f.id);
    expect(ok(await patch(app, u.id, f.id, { parentId: dest.id.toUpperCase() })).parentId).toBe(dest.id);
    expect(await xminOf(pool, "folders", f.id)).toBe(x);
    failed(await patch(app, u.id, "x", { name: "A" }), 404, "folder_not_found");

    const rw = await seedTokenForUser(db, u.id, "notes:read notes:write");
    const viaBearer = await app.inject({ method: "PATCH", url: `/api/folders/${f.id}`, headers: bearer(rw.token), payload: { name: "B" } });
    expect(viaBearer.statusCode, viaBearer.body).toBe(401);
    expect((await patch(app, null, f.id, { name: "C" })).statusCode).toBe(401);
    expect(await nameOf(pool, f.id)).toBe("Upper");
  });

  it("throttle: folder bucket limit 1 - requests with an invalid name, invisible, without manage rights or cross-space aren't charged; 429 before the second success; another user unaffected", async () => {
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ folder: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }) });
    const s = await sixRoleScene(db);
    const u = s.readOnly;
    const other = await seedUser(db);
    const f = await seedFolder(db, { personal: u.id });
    const sh = await seedFolder(db, { shared: u.id });
    const g = await seedFolder(db, { personal: other.id });
    const gf = await seedFolder(db, { group: s.groupId });
    failed(await patch(app, u.id, gf.id, { name: "nope" }), 403, "forbidden");
    failed(await patch(app, u.id, f.id, { name: "" }), 400, "invalid_body");
    failed(await patch(app, u.id, RANDOM_UUID, { name: "A" }), 404, "folder_not_found");
    failed(await patch(app, u.id, f.id, { parentId: RANDOM_UUID }), 404, "folder_not_found");
    failed(await patch(app, u.id, f.id, { parentId: sh.id }), 400, "folder_cross_space");
    ok(await patch(app, u.id, f.id, { name: "first" }));
    const res = await patch(app, u.id, f.id, { name: "second" });
    failed(res, 429, "too_many_requests");
    expect(messageOf(res)).toBe("Too many writes. Wait a moment and try again.");
    ok(await patch(app, other.id, g.id, { name: "first" }));
    expect(await nameOf(db.$client, f.id)).toBe("first");
  });

  it("state changes after the pre-read (test hooks): parent becomes someone else's -> 404 (not 400); parent becomes own shared -> 400; the folder itself deleted or changed space -> 404; group deleted -> 404; downgrade -> 403/404", async () => {
    const seam = armedHook();
    const { app, db } = await buildTestApp({ groupTestHook: seam.hook });
    const pool = db.$client;
    const u = await seedUser(db);
    const stranger = await seedUser(db);
    const notFoundBody = failed(await patch(app, u.id, RANDOM_UUID, { name: "A" }), 404, "folder_not_found");

    // The parent becomes someone else's personal folder after authorization: invisible (and cross-space too) -> visibility is judged first -> 404.
    const self = await seedFolder(db, { personal: u.id }, { name: "Self" });
    const p2 = await seedFolder(db, { personal: u.id }, { name: "P2" });
    seam.arm("folder-authorized", async () => {
      await pool.query("update folders set owner_id = $2 where id = $1", [p2.id, stranger.id]);
    });
    expect(failed(await patch(app, u.id, self.id, { parentId: p2.id }), 404, "folder_not_found")).toBe(notFoundBody);
    // The parent becomes the user's own shared folder after authorization: visible, cross-space -> 400.
    const p3 = await seedFolder(db, { personal: u.id }, { name: "P3" });
    seam.arm("folder-authorized", async () => {
      await pool.query("update folders set kind = 'shared' where id = $1", [p3.id]);
    });
    failed(await patch(app, u.id, self.id, { parentId: p3.id }), 400, "folder_cross_space");
    expect(await parentOf(pool, self.id)).toBeNull();

    // The folder itself is deleted after authorization (rename uses FOR UPDATE and move a plain read; both give 404) or changes space.
    for (const payload of [{ name: "gone" }, { parentId: null }]) {
      const doomed = await seedFolder(db, { personal: u.id }, { parentId: self.id });
      seam.arm("folder-authorized", async () => {
        await pool.query("delete from folders where id = $1", [doomed.id]);
      });
      expect(failed(await patch(app, u.id, doomed.id, payload), 404, "folder_not_found")).toBe(notFoundBody);
    }
    const moved = await seedFolder(db, { personal: u.id }, { name: "Moved" });
    seam.arm("folder-authorized", async () => {
      await pool.query("update folders set kind = 'shared' where id = $1", [moved.id]);
    });
    expect(failed(await patch(app, u.id, moved.id, { name: "x" }), 404, "folder_not_found")).toBe(notFoundBody);
    expect(await nameOf(pool, moved.id)).toBe("Moved");

    // The group is deleted after authorization (transfer) -> 404.
    const a = await sixRoleScene(db);
    const ga = await seedFolder(db, { group: a.groupId }, { name: "GA" });
    seam.arm("folder-authorized", async () => {
      const del = await inject(app, "DELETE", `/api/groups/${a.groupId}`, a.admin.id, { mode: "transfer", transferTo: a.admin.id });
      expect(del.statusCode, del.body).toBe(204);
    });
    expect(failed(await patch(app, a.member.id, ga.id, { name: "x" }), 404, "folder_not_found")).toBe(notFoundBody);

    // Downgrade after the structure lock: removing can_edit -> 403; removing read or removing from the group -> 404.
    const s = await sixRoleScene(db);
    const gs = await seedFolder(db, { group: s.groupId }, { name: "GS" });
    const roleOf = async (userId: string) =>
      (await pool.query<{ role_id: string }>("select role_id from group_members where group_id = $1 and user_id = $2", [s.groupId, userId])).rows[0]!.role_id;
    const setFlags = (sqlSet: string) => async () => {
      await pool.query(`update group_roles set ${sqlSet} where id = $1`, [await roleOf(s.editOnly.id)]);
    };
    for (const payload of [{ name: "x" }, { parentId: null }]) {
      seam.arm("folder-structure-locked", setFlags("can_edit = false"));
      const res = await patch(app, s.editOnly.id, gs.id, payload);
      failed(res, 403, "forbidden");
      expect(messageOf(res)).toBe(NOT_MANAGER);
      await setFlags("can_edit = true")();
    }
    // Same order inside the transaction: after authorization can_edit is removed and the new parent becomes the user's own personal folder (visible, cross-space) -> 400, not 403.
    const gp = await seedFolder(db, { group: s.groupId }, { name: "GP" });
    seam.arm("folder-authorized", async () => {
      await setFlags("can_edit = false")();
      await pool.query("update folders set kind = 'personal', owner_id = $2, group_id = null where id = $1", [gp.id, s.editOnly.id]);
    });
    failed(await patch(app, s.editOnly.id, gs.id, { parentId: gp.id }), 400, "folder_cross_space");
    await setFlags("can_edit = true")();
    expect(await parentOf(pool, gs.id)).toBeNull();
    seam.arm("folder-structure-locked", setFlags("can_edit = false, can_read = false"));
    expect(failed(await patch(app, s.editOnly.id, gs.id, { name: "x" }), 404, "folder_not_found")).toBe(notFoundBody);
    await setFlags("can_read = true, can_edit = true")();
    seam.arm("folder-structure-locked", async () => {
      await pool.query("delete from group_members where group_id = $1 and user_id = $2", [s.groupId, s.editDelete.id]);
    });
    expect(failed(await patch(app, s.editDelete.id, gs.id, { name: "x" }), 404, "folder_not_found")).toBe(notFoundBody);
    expect(await nameOf(pool, gs.id)).toBe("GS");
  });

  it("structure lock waits too long (another connection holds the same space's lock, lock_timeout 300 ms): 409 server_busy (< 20 s: the injected value took effect, not this file's default 60 s), nothing written; 200 as usual after the lock is released", async () => {
    const { app, db } = await buildTestApp({ storageLockTimeoutMs: 300 });
    const pool = db.$client;
    const u = await seedUser(db);
    const f = await seedFolder(db, { personal: u.id }, { name: "Busy" });
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [`knotebook.folders:personal:${u.id}`]);
      const t0 = Date.now();
      const res = await patch(app, u.id, f.id, { name: "busy2" });
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
    expect(await nameOf(pool, f.id)).toBe("Busy");
    expect(ok(await patch(app, u.id, f.id, { name: "busy2" })).name).toBe("busy2");
  });
});

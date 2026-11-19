// Move-to-trash x {move, upload, copy, share, change slug, change title, open public link, MCP `edit_note`} races. Each operation has three shapes:
//   (a) operation first - it stops at its in-transaction hook (holding locks), DELETE is sent and confirmed waiting on the lock -> release -> operation succeeds, then the move;
//   (b) move first - the operation stops at its post-authorization hook, the whole DELETE runs inside the hook -> release -> the operation returns the not_found it had at that point, state untouched;
//   (c) move in flight - DELETE stops at `note-trash-locked` (holding FOR UPDATE), the operation is sent and confirmed waiting on the lock -> release -> operation not_found
//       (the path where PG re-evaluates `deleted_at IS NULL` against the new version after the lock wait).
// Title change and opening a public link have no transaction (single UPDATE / three statements without a transaction), and MCP `edit_note`'s direct write holds no DB lock either: (a) is
// replaced by a sequential case (DELETE after the operation completes); MCP's concurrency evidence is in `trash-direct-write.test.ts`, and MCP does not wait on locks so it has no (c).
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Pool } from "pg";
import { createCollabHooks } from "../src/collab/hooks-impl.js";
import type { NoteDeleteGate } from "../src/collab/hooks.js";
import type { Db } from "../src/db/index.js";
import { noteAiEdits, noteVersions, notes, uploads } from "../src/db/schema.js";
import type { GroupTestHook } from "../src/groups/test-hook.js";
import { loadDoc, seedDoc, xmlOf } from "./copy-helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { noteState, seedGroup, seedNote, seedShare, seedUser, sharesOf, spyCollabHooks, waitForLockWaiters, type SeededUser } from "./group-helpers.js";
import { buildCollabTestApp, buildTestApp } from "./helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { filesIn, upload } from "./storage-helpers.js";
import { inject, trashCols } from "./trash-helpers.js";
import { paraDoc } from "./version-helpers.js";

type Res = LightMyRequestResponse;
const NOT_FOUND = { error: { code: "not_found", message: "No note with that id." } };
const FORBIDDEN = { error: { code: "forbidden", message: "You don't have permission to delete this note." } };
const del = (app: FastifyInstance, id: string, by: string) => inject(app, "DELETE", `/api/notes/${id}`, by);

/** One-shot test hook: the handler registered by `on` is removed and run on first trigger, later triggers pass through. */
class Seams {
  private readonly handlers = new Map<string, () => Promise<void>>();
  on(name: string, fn: () => Promise<void>): void {
    this.handlers.set(name, fn);
  }
  async fire(name: string): Promise<void> {
    const fn = this.handlers.get(name);
    if (!fn) return;
    this.handlers.delete(name);
    await fn();
  }
  hold(name: string): { entered: Promise<void>; open: () => void } {
    let open!: () => void;
    let enter!: () => void;
    const gate = new Promise<void>(r => { open = r; });
    const entered = new Promise<void>(r => { enter = r; });
    this.on(name, async () => {
      enter();
      await gate;
    });
    return { entered, open };
  }
  readonly group: GroupTestHook = point => this.fire(point);
}

async function entered(seam: Promise<void>, req: Promise<Res>): Promise<void> {
  await Promise.race([seam, req.then(r => { throw new Error(`請求沒走到縫就回了 ${r.statusCode} ${r.body}`); })]);
}

/** Waits for n connections stuck on locks; on timeout it releases first so in-flight requests finish, then throws the timeout (no dangling requests). */
async function blockedOrBail(pool: Pool, n: number, bail: () => void, inflight: Array<Promise<unknown>>): Promise<void> {
  try {
    await waitForLockWaiters(pool, n);
  } catch (err) {
    bail();
    await Promise.allSettled(inflight);
    throw err;
  }
}

interface Scene {
  app: FastifyInstance;
  db: Db;
  pool: Pool;
  uploadsDir: string;
  seams: Seams;
  release: ReturnType<typeof vi.fn>;
  owner: SeededUser;
  friend: SeededUser;
  groupId: string;
  noteId: string;
}

/**
 * The owner's personal note (custom slug, one viewer share); the owner is `ownerRole` in the target group of the move.
 * The gate injects a release spy the existing way (`beforeNoteDeleted` returns `{ release }`).
 */
async function scene(ownerRole: "admin" | "member" = "admin"): Promise<Scene> {
  const seams = new Seams();
  const release = vi.fn();
  const beforeNoteDeleted = vi.fn<(noteId: string) => Promise<NoteDeleteGate>>(async () => ({ release }));
  const built = await buildTestApp({
    collabHooks: { ...spyCollabHooks(), beforeNoteDeleted },
    groupTestHook: seams.group,
    slugPatchTestHook: point => seams.fire(`slug-${point}`),
    slugUpdateTestHook: () => seams.fire("rename"),
  });
  const { db } = built;
  const [owner, friend, viewer] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
  const g = await seedGroup(db, "Target", [{ userId: owner.id, role: ownerRole }]);
  const n = await seedNote(db, { ownerId: owner.id }, { title: "原標題", slug: "old-custom", slugIsCustom: true });
  await seedShare(db, n.id, viewer.id, "viewer");
  return { ...built, pool: db.$client, seams, release, owner, friend, groupId: g.id, noteId: n.id };
}

const titleOf = async (db: Db, id: string) => (await db.select({ title: notes.title }).from(notes).where(eq(notes.id, id)))[0]!.title;
const uploadRows = async (db: Db, id: string) => (await db.select({ id: uploads.id }).from(uploads).where(eq(uploads.noteId, id))).map(r => r.id);

async function snap(e: Scene) {
  const [width] = await e.db.select({ w: notes.publicWidth }).from(notes).where(eq(notes.id, e.noteId));
  return {
    state: await noteState(e.pool, e.noteId),
    title: await titleOf(e.db, e.noteId),
    width: width!.w,
    shares: await sharesOf(e.db, e.noteId),
    versions: (await e.db.select({ n: sql<number>`count(*)::int` }).from(noteVersions).where(eq(noteVersions.noteId, e.noteId)))[0]!.n,
    uploads: await uploadRows(e.db, e.noteId),
    notes: (await e.db.select({ n: sql<number>`count(*)::int` }).from(notes))[0]!.n,
    files: await filesIn(e.uploadsDir),
  };
}

interface Op {
  name: string;
  /** In-transaction hook of (a) (holding locks); null = no transaction, (a) becomes sequential. */
  locked: string | null;
  auth: string;
  ok: number;
  send(e: Scene): Promise<Res>;
  applied(e: Scene, res: Res): Promise<void>;
}

const OPS: Op[] = [
  {
    name: "move to group", locked: "note-move-locked", auth: "note-move-authorized", ok: 200,
    send: e => inject(e.app, "POST", `/api/notes/${e.noteId}/move`, e.owner.id, { groupId: e.groupId }),
    applied: async e => expect(await noteState(e.pool, e.noteId)).toMatchObject({ owner_id: null, group_id: e.groupId }),
  },
  {
    name: "upload", locked: "storage-space-locked", auth: "upload-authorized", ok: 201,
    send: e => upload(e.app, e.noteId, e.owner.id, 8),
    applied: async e => {
      const ids = await uploadRows(e.db, e.noteId);
      expect(ids).toHaveLength(1);
      expect(await filesIn(e.uploadsDir)).toEqual(ids);
    },
  },
  {
    name: "copy", locked: "note-copy-locked", auth: "note-copy-authorized", ok: 201,
    send: e => inject(e.app, "POST", `/api/notes/${e.noteId}/copy`, e.owner.id, {}),
    applied: async (e, res) => expect(await trashCols(e.pool, (res.json() as { id: string }).id)).toEqual({ deleted_at: null, deleted_by: null }),
  },
  {
    name: "share", locked: "share-group-checked", auth: "share-authorized", ok: 200,
    send: e => inject(e.app, "PUT", `/api/notes/${e.noteId}/shares`, e.owner.id, { email: e.friend.email, role: "editor" }),
    applied: async e => expect(await sharesOf(e.db, e.noteId)).toContainEqual({ userId: e.friend.id, role: "editor" }),
  },
  {
    name: "change URL", locked: "slug-slug-written", auth: "slug-authorized", ok: 200,
    send: e => inject(e.app, "PATCH", `/api/notes/${e.noteId}`, e.owner.id, { slug: "x-new" }),
    applied: async e => expect(await noteState(e.pool, e.noteId)).toMatchObject({ slug: "x-new", prev_slug: "old-custom" }),
  },
  {
    name: "change title", locked: null, auth: "rename", ok: 200,
    send: e => inject(e.app, "PATCH", `/api/notes/${e.noteId}`, e.owner.id, { title: "新標題" }),
    applied: async e => expect(await titleOf(e.db, e.noteId)).toBe("新標題"),
  },
  {
    name: "open public link", locked: null, auth: "public-link-authorized", ok: 200,
    send: e => inject(e.app, "PUT", `/api/notes/${e.noteId}/public-link`, e.owner.id),
    applied: async (e, res) => expect((await noteState(e.pool, e.noteId)).public_token).toBe((res.json() as { token: string }).token),
  },
];

/**
 * (a) interleaving: the operation stops at `seam` (holding locks) -> DELETE is sent and confirmed waiting -> operation released. Once the move gets the lock it waits at
 * `note-trash-locked` until the operation's response has been sent - it does not race the operation's post-commit re-read/authorization (which would occasionally turn "operation succeeded" into 404).
 */
async function opFirst(e: Scene, seam: string, send: () => Promise<Res>): Promise<{ op: Res; del: Res }> {
  const op = e.seams.hold(seam);
  let replied!: () => void;
  const opReplied = new Promise<void>(r => { replied = r; });
  e.seams.on("note-trash-locked", () => opReplied);
  const opRes = send();
  await entered(op.entered, opRes);
  const delRes = del(e.app, e.noteId, e.owner.id);
  await blockedOrBail(e.pool, 1, () => { op.open(); replied(); }, [opRes, delRes]);
  op.open();
  const opOut = await opRes;
  replied();
  return { op: opOut, del: await delRes };
}

describe("move to trash x ordinary operations", () => {
  for (const op of OPS) {
    if (op.locked !== null) {
      const seam = op.locked;
      it(`${op.name} operation first: operation stops at ${seam} (holding the lock), trash waits on the lock -> operation ${op.ok}, trash 204, the operation's effect stays`, async () => {
        const e = await scene();
        const r = await opFirst(e, seam, () => op.send(e));
        expect(r.op.statusCode, r.op.body).toBe(op.ok);
        expect(r.del.statusCode, r.del.body).toBe(204);
        await op.applied(e, r.op);
        expect((await trashCols(e.pool, e.noteId))?.deleted_by).toBe(e.owner.id);
        expect(e.release).not.toHaveBeenCalled();
      });
    } else {
      it(`${op.name} operation first (sequential): operation ${op.ok}, then trash 204, the operation's effect stays`, async () => {
        const e = await scene();
        const res = await op.send(e);
        expect(res.statusCode, res.body).toBe(op.ok);
        expect((await del(e.app, e.noteId, e.owner.id)).statusCode).toBe(204);
        await op.applied(e, res);
        expect((await trashCols(e.pool, e.noteId))?.deleted_by).toBe(e.owner.id);
      });
    }

    it(`${op.name} trash first: while the operation stops at ${op.auth} (after authorization) the whole DELETE completes -> operation 404 not_found, state untouched`, async () => {
      const e = await scene();
      const before = await snap(e);
      let d: Res | undefined;
      e.seams.on(op.auth, async () => { d = await del(e.app, e.noteId, e.owner.id); });

      const res = await op.send(e);

      expect(d?.statusCode, "縫裡的 DELETE").toBe(204);
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json()).toEqual(NOT_FOUND);
      expect(await snap(e)).toEqual(before);
      expect((await trashCols(e.pool, e.noteId))?.deleted_by).toBe(e.owner.id);
    });

    it(`${op.name} trash in flight: trash stops at note-trash-locked, operation waits on the lock -> trash 204, operation 404 not_found, state untouched`, async () => {
      const e = await scene();
      const before = await snap(e);
      const tr = e.seams.hold("note-trash-locked");
      const d = del(e.app, e.noteId, e.owner.id);
      await entered(tr.entered, d);
      const r = op.send(e);
      await blockedOrBail(e.pool, 1, tr.open, [d, r]);
      tr.open();

      expect((await d).statusCode).toBe(204);
      const res = await r;
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json()).toEqual(NOT_FOUND);
      expect(await snap(e)).toEqual(before);
    });
  }

  it("move to group: operation first, owner is only an ordinary member of the target group -> move 200, the move to trash is re-judged inside the transaction as 403, gate release is called, the note does not go to trash", async () => {
    const e = await scene("member");
    const r = await opFirst(e, "note-move-locked", () => OPS[0]!.send(e));
    expect(r.op.statusCode, r.op.body).toBe(200);
    expect(r.del.statusCode, r.del.body).toBe(403);
    expect(r.del.json()).toEqual(FORBIDDEN);
    expect(e.release).toHaveBeenCalledTimes(1);
    expect(await noteState(e.pool, e.noteId)).toMatchObject({ owner_id: null, group_id: e.groupId });
    expect(await trashCols(e.pool, e.noteId)).toEqual({ deleted_at: null, deleted_by: null });
  });
});

/** MCP: real hooks (gate, unload wait) + `beforeMerge` hook; the note has one paragraph and its document is not loaded. */
async function mcpScene() {
  const seams = new Seams();
  const ctx = await buildCollabTestApp({
    collabHooks: (server, log) => createCollabHooks(server, log),
    groupTestHook: seams.group,
    editingTestHooks: { beforeMerge: () => seams.fire("beforeMerge") },
  });
  const owner = await seedUser(ctx.db);
  const n = await seedNote(ctx.db, { ownerId: owner.id });
  await seedDoc(ctx.db, n.id, paraDoc(["內容"]));
  const { token } = await seedTokenForUser(ctx.db, owner.id);
  return { ctx, seams, owner, noteId: n.id, token, pool: ctx.db.$client as Pool };
}
const editNote = (app: FastifyInstance, token: string, noteId: string) =>
  mcpPost(app, rpc("tools/call", { name: "edit_note", arguments: { note_id: noteId, op: "append", markdown: "MCP 寫的" } }), { token });
type ToolResult = { isError?: boolean; content: Array<{ text: string }>; structuredContent?: { code?: string } };
const stateHex = async (pool: Pool, id: string) =>
  (await pool.query<{ y: string }>(`select encode(ydoc, 'hex') as y from note_states where note_id = $1`, [id])).rows[0]?.y;
const aiEdits = async (db: Db, id: string) => (await db.select({ id: noteAiEdits.id }).from(noteAiEdits).where(eq(noteAiEdits.noteId, id))).length;

describe("move to trash x MCP edit_note", () => {
  it("operation first (sequential): move 204 after the edit_note write, the written content stays in the trashed note", async () => {
    const s = await mcpScene();
    const res = await editNote(s.ctx.app, s.token, s.noteId);
    expect((res.json().result as ToolResult).isError, res.body).toBeFalsy();

    expect((await del(s.ctx.app, s.noteId, s.owner.id)).statusCode).toBe(204);

    expect(xmlOf((await loadDoc(s.ctx.db, s.noteId))!)).toContain("MCP 寫的");
    expect(await aiEdits(s.ctx.db, s.noteId)).toBe(1);
    expect((await trashCols(s.pool, s.noteId))?.deleted_by).toBe(s.owner.id);
  });

  it("move first: DELETE 204 inside the beforeMerge hook, then simulate the gate TTL expiring (only the DB check left) -> edit_note not_found, content and AI records unchanged", async () => {
    const s = await mcpScene();
    const before = { state: await stateHex(s.pool, s.noteId), edits: await aiEdits(s.ctx.db, s.noteId) };
    let d: Res | undefined;
    s.seams.on("beforeMerge", async () => {
      d = await del(s.ctx.app, s.noteId, s.owner.id);
      s.ctx.collab.unmarkDeleting(s.noteId);
    });

    const res = await editNote(s.ctx.app, s.token, s.noteId);

    expect(d?.statusCode, "縫裡的 DELETE").toBe(204);
    expect(s.ctx.collab.isDeleting(s.noteId)).toBe(false);
    const result = res.json().result as ToolResult;
    expect(result.isError, res.body).toBe(true);
    expect(result.structuredContent?.code).toBe("not_found");
    const missing = (await editNote(s.ctx.app, s.token, randomUUID())).json().result as ToolResult;
    expect(result.content[0]!.text).toBe(missing.content[0]!.text);
    expect({ state: await stateHex(s.pool, s.noteId), edits: await aiEdits(s.ctx.db, s.noteId) }).toEqual(before);
  });
});

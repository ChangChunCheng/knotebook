import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import type { VersionDto } from "@knotebook/shared";
import { noteStates, noteVersions, notes } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { versionFingerprint } from "../src/notes/version-fingerprint.js";
import { seedDoc } from "./copy-helpers.js";
import { bearer, seedTokenForUser, waitFor } from "./editing-helpers.js";
import { cookieOf, seedGroup, seedNote, seedShare, seedUser } from "./group-helpers.js";
import { buildCollabTestApp, buildTestApp, freshLimiters } from "./helpers.js";
import { noteBase, paraDoc, versionsOf } from "./version-helpers.js";

type Who = string | null;
async function call(app: FastifyInstance, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, who: Who, payload?: unknown) {
  return app.inject({ method, url, ...(who ? { cookies: await cookieOf(who) } : {}), ...(payload !== undefined ? { payload: payload as object } : {}) });
}

async function restSetup(over: Parameters<typeof buildTestApp>[0] = {}) {
  const built = await buildTestApp(over);
  const { app, db } = built;
  const owner = await seedUser(db);
  const note = await seedNote(db, { ownerId: owner.id });
  await seedDoc(db, note.id, paraDoc(["版本一的內容"]));
  /** Replaces note_states to simulate content changing while the document isn't loaded; returns the new version fingerprint. */
  const setContent = async (text: string) => {
    const d = paraDoc([text]);
    await db.update(noteStates).set({ ydoc: Buffer.from(Y.encodeStateAsUpdate(d)) }).where(eq(noteStates.noteId, note.id));
    return versionFingerprint(d.getXmlFragment(YDOC_FRAGMENT));
  };
  const base = `/api/notes/${note.id}/versions`;
  return { app, db, owner, note, setContent, base };
}

describe("permission matrix", () => {
  it("owner/editor/group editor can read and write; viewer 403; invisible 404; logged out 401; PAT 401", async () => {
    const s = await restSetup();
    expect((await call(s.app, "POST", s.base, s.owner.id, {})).statusCode).toBe(201); // make v1 first
    const editor = await seedUser(s.db);
    const viewer = await seedUser(s.db);
    const stranger = await seedUser(s.db);
    await seedShare(s.db, s.note.id, editor.id, "editor");
    await seedShare(s.db, s.note.id, viewer.id, "viewer");
    for (const who of [s.owner.id, editor.id]) {
      expect((await call(s.app, "GET", s.base, who)).statusCode, who).toBe(200);
      expect((await call(s.app, "GET", `${s.base}/1`, who)).statusCode).toBe(200);
      expect((await call(s.app, "PATCH", `${s.base}/1`, who, { name: "n" })).statusCode).toBe(200);
    }
    for (const [method, url, body] of [["GET", s.base, undefined], ["GET", `${s.base}/1`, undefined], ["POST", s.base, {}], ["PATCH", `${s.base}/1`, { name: "x" }], ["DELETE", `${s.base}/1`, undefined]] as const) {
      const v = await call(s.app, method, url, viewer.id, body);
      expect(v.statusCode, `${method} ${url} viewer`).toBe(403);
      expect(v.json().error).toEqual({ code: "forbidden", message: "You don't have edit access to this note." });
      expect((await call(s.app, method, url, stranger.id, body)).statusCode, `${method} ${url} none`).toBe(404);
      expect((await call(s.app, method, url, null, body)).statusCode, `${method} ${url} anon`).toBe(401);
    }
    const { token } = await seedTokenForUser(s.db, s.owner.id);
    expect((await s.app.inject({ method: "GET", url: s.base, headers: bearer(token) })).statusCode).toBe(401);
    expect((await s.app.inject({ method: "POST", url: s.base, headers: bearer(token), payload: {} })).statusCode).toBe(401);

    const g = await seedGroup(s.db, "G", [{ userId: s.owner.id, role: "admin" }, { userId: editor.id, role: "member" }]);
    const gnote = await seedNote(s.db, { groupId: g.id });
    expect((await call(s.app, "POST", `/api/notes/${gnote.id}/versions`, editor.id, {})).statusCode).toBe(201);
  });

  it("deployment without collab: the apply route isn't registered (404), the other five work as usual", async () => {
    const s = await restSetup();
    expect((await call(s.app, "POST", s.base, s.owner.id, {})).statusCode).toBe(201);
    const v1 = (await versionsOf(s.db, s.note.id))[0]!;
    expect((await call(s.app, "POST", `${s.base}/1/apply`, s.owner.id, { versionId: v1.id, discardUnsaved: false })).statusCode).toBe(404);
  });

  it("role check runs before the limiter is charged: a viewer hitting each write 3 times (limit 2) always gets 403, never 429, and the owner's limiter isn't consumed", async () => {
    const s = await restSetup({ limiters: freshLimiters({ edit: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) }) });
    for (const [method, url, body] of [["POST", s.base, {}], ["PATCH", `${s.base}/1`, { name: "x" }], ["DELETE", `${s.base}/1`, undefined]] as const) {
      const viewer = await seedUser(s.db); // limiter keyed by userId: one viewer per route, so swapping a single route is caught too
      await seedShare(s.db, s.note.id, viewer.id, "viewer");
      for (let i = 0; i < 3; i += 1) {
        const r = await call(s.app, method, url, viewer.id, body);
        expect(r.statusCode, `${method} #${i + 1}`).toBe(403);
        expect(r.json().error.code).toBe("forbidden");
      }
    }
    expect((await call(s.app, "POST", s.base, s.owner.id, {})).statusCode).toBe(201);
  });
});

describe("parameter validation: malformed or out-of-range params get 404/400, never 500", () => {
  it(":id not a uuid -> 404; invalid :seq -> 404 (not 500); invalid before/limit -> 400", async () => {
    const s = await restSetup();
    expect((await call(s.app, "GET", "/api/notes/not-a-uuid/versions", s.owner.id)).json().error.code).toBe("not_found");
    for (const seq of ["0", "01", "-1", "1.5", "1e3", "2147483648", "abc", "%00", "１"]) {
      const r = await call(s.app, "GET", `${s.base}/${seq}`, s.owner.id);
      expect(r.statusCode, seq).toBe(404);
      expect((await call(s.app, "DELETE", `${s.base}/${seq}`, s.owner.id)).statusCode, `DELETE ${seq}`).toBe(404);
    }
    for (const q of ["before=0", "before=2147483648", "before=x", "limit=0", "limit=101", "limit=1.5", "limit=01", "limit=-1", "foo=1", "limit=1&limit=2", "kind=", "kind=foo", "kind=MANUAL", "kind=manual&kind=auto"]) {
      const r = await call(s.app, "GET", `${s.base}?${q}`, s.owner.id);
      expect(r.statusCode, q).toBe(400);
      expect(r.json().error.code).toBe("invalid_body");
      expect(r.json().error.message).toBe("Invalid request body.");
    }
    expect((await call(s.app, "GET", `${s.base}?limit=100&before=2147483647`, s.owner.id)).statusCode).toBe(200);
  });
});

describe("GET list and snapshot", () => {
  it("newest first, cursor paging, nextBefore exactly null on the last page; editors carry handle (deleted users give an empty string); current", async () => {
    const s = await restSetup();
    const fp = versionFingerprint(paraDoc(["版本一的內容"]).getXmlFragment(YDOC_FRAGMENT));
    const ghost = "00000000-0000-4000-8000-0000000000ff";
    const ids: string[] = [];
    for (let seq = 1; seq <= 5; seq += 1) {
      const [row] = await s.db.insert(noteVersions).values({
        noteId: s.note.id, seq, ydoc: Buffer.from([0]), kind: seq === 3 ? "manual" : "auto", name: seq === 3 ? "里程碑" : null,
        editors: [{ user_id: s.owner.id, agent_label: null }, { user_id: ghost, agent_label: "Claude" }], baseSeq: seq === 4 ? 2 : null,
        baseVersionId: seq === 4 ? ids[1]! : null,
      }).returning({ id: noteVersions.id });
      ids.push(row!.id);
    }
    await s.db.update(notes).set({ versionCounter: 5, versionBaseSeq: 5, versionBaseFingerprint: fp, versionBaseVersionId: ids[4]! }).where(eq(notes.id, s.note.id));
    const p1 = (await call(s.app, "GET", `${s.base}?limit=2`, s.owner.id)).json();
    expect(p1.versions.map((v: { seq: number }) => v.seq)).toEqual([5, 4]);
    expect(p1.nextBefore).toBe(4);
    expect(p1.current).toEqual({ baseSeq: 5, base: { id: ids[4], name: null, deleted: false }, dirty: false, nextSeq: 6, autoEnabled: true });
    expect(p1.versions[1]).toMatchObject({ kind: "auto", name: null, baseSeq: 2, base: { id: ids[1], name: null, deleted: false }, editors: [{ handle: s.owner.handle, agentLabel: null }, { handle: "", agentLabel: "Claude" }] });
    expect(Object.keys(p1.versions[0]).sort()).toEqual(["base", "baseSeq", "createdAt", "editors", "id", "kind", "name", "seq"]);
    const p2 = (await call(s.app, "GET", `${s.base}?limit=2&before=4`, s.owner.id)).json();
    expect(p2.versions.map((v: { seq: number }) => v.seq)).toEqual([3, 2]);
    expect(p2.versions[0]).toMatchObject({ kind: "manual", name: "里程碑" });
    const p3 = (await call(s.app, "GET", `${s.base}?limit=2&before=2`, s.owner.id)).json();
    expect(p3.versions.map((v: { seq: number }) => v.seq)).toEqual([1]);
    expect(p3.nextBefore).toBeNull();
    const exact = (await call(s.app, "GET", `${s.base}?limit=5`, s.owner.id)).json();
    expect(exact.nextBefore).toBeNull(); // exactly a full page: no empty-page cursor
    await s.setContent("內容變了");
    expect((await call(s.app, "GET", s.base, s.owner.id)).json().current.dirty).toBe(true);
  });

  it("kind filter (#258): manual/auto/omitted; combined with before, limit, nextBefore; current is unaffected by the filter", async () => {
    const s = await restSetup();
    // seq 1..9: manual = 2, 5, 6, 9; the rest are auto.
    const manual = new Set([2, 5, 6, 9]);
    for (let seq = 1; seq <= 9; seq += 1) {
      await s.db.insert(noteVersions).values({
        noteId: s.note.id, seq, ydoc: Buffer.from([0]), kind: manual.has(seq) ? "manual" : "auto", name: null, editors: [], baseSeq: null,
      });
    }
    await s.db.update(notes).set({ versionCounter: 9 }).where(eq(notes.id, s.note.id));
    const seqs = (b: { versions: Array<{ seq: number }> }) => b.versions.map(v => v.seq);
    const get = async (q: string) => (await call(s.app, "GET", `${s.base}${q}`, s.owner.id)).json();

    const all = await get("");
    expect(seqs(all)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1]);
    const onlyManual = await get("?kind=manual");
    expect(seqs(onlyManual)).toEqual([9, 6, 5, 2]);
    expect(onlyManual.versions.every((v: { kind: string }) => v.kind === "manual")).toBe(true);
    expect(onlyManual.nextBefore).toBeNull();
    const onlyAuto = await get("?kind=auto");
    expect(seqs(onlyAuto)).toEqual([8, 7, 4, 3, 1]);
    expect(onlyAuto.versions.every((v: { kind: string }) => v.kind === "auto")).toBe(true);
    expect(onlyManual.current).toEqual(all.current);
    expect(onlyAuto.current).toEqual(all.current);

    // Combined with limit/before: nextBefore is the seq of the last entry of the filtered page; passing it as before gets the next page with no gaps or repeats.
    const m1 = await get("?kind=manual&limit=2");
    expect(seqs(m1)).toEqual([9, 6]);
    expect(m1.nextBefore).toBe(6);
    const m2 = await get(`?kind=manual&limit=2&before=${m1.nextBefore}`);
    expect(seqs(m2)).toEqual([5, 2]);
    expect(m2.nextBefore).toBeNull(); // exactly a full page, nothing matching after
    const a1 = await get("?kind=auto&limit=3");
    expect(seqs(a1)).toEqual([8, 7, 4]);
    expect(a1.nextBefore).toBe(4);
    const a2 = await get(`?kind=auto&limit=3&before=${a1.nextBefore}`);
    expect(seqs(a2)).toEqual([3, 1]);
    expect(a2.nextBefore).toBeNull();
    const none = await get("?kind=manual&before=2");
    expect(none.versions).toEqual([]);
    expect(none.nextBefore).toBeNull();
    expect(none.current).toEqual(all.current);
  });

  it("kind filter: after an auto version is renamed to manual it shows up in kind=manual at once and disappears from kind=auto", async () => {
    const s = await restSetup();
    await s.db.insert(noteVersions).values({ noteId: s.note.id, seq: 1, ydoc: Buffer.from([0]), kind: "auto", name: null, editors: [], baseSeq: null });
    await s.db.update(notes).set({ versionCounter: 1 }).where(eq(notes.id, s.note.id));
    expect((await call(s.app, "GET", `${s.base}?kind=manual`, s.owner.id)).json().versions).toEqual([]);
    expect((await call(s.app, "PATCH", `${s.base}/1`, s.owner.id, { name: "命名" })).statusCode).toBe(200);
    expect((await call(s.app, "GET", `${s.base}?kind=manual`, s.owner.id)).json().versions.map((v: { seq: number }) => v.seq)).toEqual([1]);
    expect((await call(s.app, "GET", `${s.base}?kind=auto`, s.owner.id)).json().versions).toEqual([]);
  });

  it("#272: base: a base outside this page or filtered out by kind still carries its name; after the base row is deleted { id, name: null, deleted: true }; legacy data deleted before the upgrade { id: null, deleted: true }; current.base; POST/PATCH responses carry base", async () => {
    const s = await restSetup();
    const ins = async (seq: number, kind: "auto" | "manual", name: string | null, baseSeq: number | null, baseVersionId: string | null) =>
      (await s.db.insert(noteVersions).values({ noteId: s.note.id, seq, ydoc: Buffer.from([0]), kind, name, editors: [], baseSeq, baseVersionId }).returning())[0]!;
    const v1 = await ins(1, "manual", "起點", null, null);
    await ins(2, "auto", null, 9, null); // legacy data: derived from 9, no base uuid
    const v3 = await ins(3, "manual", "第三", 1, v1.id);
    const v4 = await ins(4, "auto", null, 3, v3.id);
    const fp = versionFingerprint(paraDoc(["版本一的內容"]).getXmlFragment(YDOC_FRAGMENT));
    await s.db.update(notes).set({ versionCounter: 4, versionBaseSeq: 4, versionBaseFingerprint: fp, versionBaseVersionId: v4.id }).where(eq(notes.id, s.note.id));
    const get = async (q: string) => (await call(s.app, "GET", `${s.base}${q}`, s.owner.id)).json();
    expect((await get("?limit=1&before=4")).versions[0]).toMatchObject({ seq: 3, baseSeq: 1, base: { id: v1.id, name: "起點", deleted: false } }); // base not on this page
    const autos = await get("?kind=auto");
    expect(autos.versions.map((v: VersionDto) => [v.seq, v.base])).toEqual([
      [4, { id: v3.id, name: "第三", deleted: false }], // base filtered out by kind=auto
      [2, { id: null, name: null, deleted: true }], // legacy data
    ]);
    expect(autos.current.base).toEqual({ id: v4.id, name: null, deleted: false });
    await s.db.delete(noteVersions).where(eq(noteVersions.id, v1.id));
    expect((await get("?limit=1&before=4")).versions[0].base).toEqual({ id: v1.id, name: null, deleted: true });
    await s.setContent("第五版的內容");
    const saved = await call(s.app, "POST", s.base, s.owner.id, {});
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject({ seq: 5, baseSeq: null, base: null });
    const renamed = await call(s.app, "PATCH", `${s.base}/3`, s.owner.id, { name: "改名" });
    expect(renamed.json()).toMatchObject({ seq: 3, base: { id: v1.id, name: null, deleted: true } });
  });

  it("snapshot: { id, seq, ydoc (base64) }, Cache-Control private, no-store; nonexistent -> 404", async () => {
    const s = await restSetup();
    expect((await call(s.app, "POST", s.base, s.owner.id, {})).statusCode).toBe(201);
    const [v1] = await versionsOf(s.db, s.note.id);
    const r = await call(s.app, "GET", `${s.base}/1`, s.owner.id);
    expect(r.headers["cache-control"]).toBe("private, no-store");
    expect(r.json()).toEqual({ id: v1!.id, seq: 1, ydoc: Buffer.from(v1!.ydoc).toString("base64") });
    const r404 = await call(s.app, "GET", `${s.base}/9`, s.owner.id);
    expect(r404.statusCode).toBe(404);
    expect(r404.json().error.code).toBe("not_found");
  });
});

describe("POST manual save", () => {
  it("no base and clean -> 201 new version; clean with a base -> 201 upgraded (count unchanged); dirty -> new version", async () => {
    const s = await restSetup();
    const a = await call(s.app, "POST", s.base, s.owner.id, { name: "首版" });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ seq: 1, kind: "manual", name: "首版", upgraded: false, baseSeq: null, editors: [{ handle: s.owner.handle, agentLabel: null }] });
    const b = await call(s.app, "POST", s.base, s.owner.id, { name: "改名" });
    expect(b.json()).toMatchObject({ seq: 1, name: "改名", upgraded: true });
    expect(await versionsOf(s.db, s.note.id)).toHaveLength(1);
    await s.setContent("第二版");
    expect((await call(s.app, "POST", s.base, s.owner.id, {})).json()).toMatchObject({ seq: 2, upgraded: false, name: null });
  });

  it("no base and truly empty note -> creates a version (author filled in)", async () => {
    const s = await restSetup();
    const empty = await seedNote(s.db, { ownerId: s.owner.id });
    const r = await call(s.app, "POST", `/api/notes/${empty.id}/versions`, s.owner.id, {});
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ seq: 1, upgraded: false });
  });

  it("name rules: whitespace only -> null; 120 code points accepted, 121 rejected; NUL/lone surrogate 400 (not 500); wrong body shape 400", async () => {
    const s = await restSetup();
    const smile = String.fromCodePoint(0x1f600);
    expect((await call(s.app, "POST", s.base, s.owner.id, { name: " 　 " })).json().name).toBeNull();
    expect((await call(s.app, "PATCH", `${s.base}/1`, s.owner.id, { name: smile.repeat(120) })).json().name).toBe(smile.repeat(120));
    for (const bad of [smile.repeat(121), `a${String.fromCodePoint(0)}b`, "a\uD800b"]) {
      for (const [method, url] of [["POST", s.base], ["PATCH", `${s.base}/1`]] as const) {
        const r = await call(s.app, method, url, s.owner.id, { name: bad });
        expect(r.statusCode, `${method} ${JSON.stringify(bad).slice(0, 20)}`).toBe(400);
        expect(r.json().error.code).toBe("invalid_body");
        expect(r.json().error.message).toBe("Version names can be at most 120 characters and can't contain characters that can't be stored.");
      }
    }
    for (const body of [{ name: 5 }, { foo: 1 }, []]) expect((await call(s.app, "POST", s.base, s.owner.id, body)).statusCode).toBe(400);
    expect((await call(s.app, "PATCH", `${s.base}/1`, s.owner.id, {})).statusCode).toBe(400);
  });

  it("deleted note -> 404 (canEdit's none branch, never reaches saveVersion)", async () => {
    const s = await restSetup();
    await s.db.delete(notes).where(eq(notes.id, s.note.id));
    expect((await call(s.app, "POST", s.base, s.owner.id, {})).statusCode).toBe(404);
  });

  it("write endpoints consume the edit limiter (GET doesn't): limit 2 -> third write 429", async () => {
    const s = await restSetup({ limiters: freshLimiters({ edit: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) }) });
    for (let i = 0; i < 5; i += 1) expect((await call(s.app, "GET", s.base, s.owner.id)).statusCode).toBe(200);
    expect((await call(s.app, "POST", s.base, s.owner.id, {})).statusCode).toBe(201);
    expect((await call(s.app, "PATCH", `${s.base}/1`, s.owner.id, { name: "a" })).statusCode).toBe(200);
    const r = await call(s.app, "DELETE", `${s.base}/1`, s.owner.id);
    expect(r.statusCode).toBe(429);
    expect(r.json().error.code).toBe("too_many_requests");
  });
});

describe("PATCH/DELETE", () => {
  it("PATCH on an auto version -> becomes manual; {name:null} clears the name and stays manual; nonexistent -> 404", async () => {
    const s = await restSetup();
    await s.db.insert(noteVersions).values({ noteId: s.note.id, seq: 1, ydoc: Buffer.from([0]), kind: "auto" });
    const r = await call(s.app, "PATCH", `${s.base}/1`, s.owner.id, { name: "命名" });
    expect(r.json()).toMatchObject({ seq: 1, kind: "manual", name: "命名" });
    expect((await call(s.app, "PATCH", `${s.base}/1`, s.owner.id, { name: null })).json()).toMatchObject({ kind: "manual", name: null });
    expect((await call(s.app, "PATCH", `${s.base}/7`, s.owner.id, { name: "x" })).statusCode).toBe(404);
  });

  it("DELETE: base -> 409 version_is_base (English message); nonexistent -> 404; non-base -> 204", async () => {
    const s = await restSetup();
    expect((await call(s.app, "POST", s.base, s.owner.id, {})).statusCode).toBe(201);
    await s.setContent("第二版");
    expect((await call(s.app, "POST", s.base, s.owner.id, {})).statusCode).toBe(201);
    const base = await call(s.app, "DELETE", `${s.base}/2`, s.owner.id);
    expect(base.statusCode).toBe(409);
    expect(base.json().error).toEqual({ code: "version_is_base", message: "This version is the base of the current content, so it can't be deleted." });
    expect((await call(s.app, "DELETE", `${s.base}/9`, s.owner.id)).statusCode).toBe(404);
    expect((await call(s.app, "DELETE", `${s.base}/1`, s.owner.id)).statusCode).toBe(204);
    expect((await versionsOf(s.db, s.note.id)).map(v => v.seq)).toEqual([2]);
  });
});

describe("POST apply with real collab", () => {
  async function collabSetup(opts: Parameters<typeof buildCollabTestApp>[0] = {}) {
    const ctx = await buildCollabTestApp(opts);
    const u = await ctx.createUser({ email: "a@example.com", password: "correct-horse-battery" });
    const note = await ctx.createNote(u.id);
    const session = await ctx.loginAs("a@example.com", "correct-horse-battery");
    const base = `/api/notes/${note.id}/versions`;
    const unloaded = () => waitFor("卸載", 10_000, () => ctx.collab.hocuspocus.documents.size === 0);
    const setContent = (text: string) => ctx.db.update(noteStates).set({ ydoc: Buffer.from(Y.encodeStateAsUpdate(paraDoc([text]))) }).where(eq(noteStates.noteId, note.id));
    await seedDoc(ctx.db, note.id, paraDoc(["版本一"]));
    const post = (url: string, body: unknown) => session.fetch(url, { method: "POST", body: JSON.stringify(body) });
    expect((await post(base, {})).status).toBe(201);
    await setContent("版本二");
    expect((await post(base, {})).status).toBe(201);
    const [v1, v2] = await versionsOf(ctx.db, note.id);
    return { ctx, u, note, session, base, unloaded, setContent, post, v1: v1!, v2: v2! };
  }

  it("200 { current }; uppercase versionId counts as the same version; mismatched versionId 409; nonexistent seq 404; bad body 400", async () => {
    const s = await collabSetup();
    const ok = await s.post(`${s.base}/1/apply`, { versionId: s.v1.id.toUpperCase(), discardUnsaved: false });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ current: { baseSeq: 1, base: { id: s.v1.id, name: null, deleted: false }, dirty: false, nextSeq: 3, autoEnabled: true } });
    const mm = await s.post(`${s.base}/2/apply`, { versionId: s.v1.id, discardUnsaved: false });
    expect(mm.status).toBe(409);
    expect((await mm.json()).error).toEqual({ code: "version_mismatch", message: "That version no longer exists or has been replaced. Reload and try again." });
    expect((await s.post(`${s.base}/9/apply`, { versionId: s.v1.id, discardUnsaved: false })).status).toBe(404);
    for (const body of [{ versionId: s.v1.id }, { versionId: "x", discardUnsaved: true }, { versionId: s.v1.id, discardUnsaved: "no" }, { versionId: s.v1.id, discardUnsaved: true, x: 1 }]) {
      expect((await s.post(`${s.base}/1/apply`, body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("dirty with discardUnsaved=false -> 409 version_unsaved_changes (English message); true -> 200", async () => {
    const s = await collabSetup();
    await s.setContent("沒存的第三版");
    const r = await s.post(`${s.base}/1/apply`, { versionId: s.v1.id, discardUnsaved: false });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toEqual({ code: "version_unsaved_changes", message: "The note has changes that aren't in any saved version." });
    expect((await s.post(`${s.base}/1/apply`, { versionId: s.v1.id, discardUnsaved: true })).status).toBe(200);
  });

  it("version deleted while queued, with a WS connection (document not unloaded) -> response baseSeq null, dirty true; after everyone leaves -> no cut (#272), baseSeq null, nextSeq 3", async () => {
    let deleteV1: (() => Promise<void>) | null = null;
    const s = await collabSetup({ editingTestHooks: { beforeMerge: async () => { if (deleteV1) await deleteV1(); } } });
    const client = await s.session.connect(s.note.id);
    deleteV1 = async () => { await s.ctx.db.delete(noteVersions).where(sql`note_versions.note_id = ${s.note.id} and note_versions.seq = 1`); };
    const r = await s.post(`${s.base}/1/apply`, { versionId: s.v1.id, discardUnsaved: false });
    expect((await r.json()).current).toMatchObject({ baseSeq: null, dirty: true }); // actual current after the apply completes
    deleteV1 = null;
    client.disconnect();
    await s.unloaded();
    await s.ctx.collab.versions.scanDue(new Date(Date.now() + 3_600_000));
    expect((await versionsOf(s.ctx.db, s.note.id)).map(v => v.seq)).toEqual([2]);
    expect((await (await s.session.fetch(s.base)).json()).current).toMatchObject({ baseSeq: null, nextSeq: 3 });
  });

  it("version deleted while queued, no WS connection -> unloading no longer cuts a version (#272), response baseSeq null, dirty false, nextSeq 3; a manual save afterwards -> 201 new v3, total 2, GET dirty=false, base 3", async () => {
    let deleteV1: (() => Promise<void>) | null = null;
    const s = await collabSetup({ editingTestHooks: { beforeMerge: async () => { if (deleteV1) await deleteV1(); } } });
    deleteV1 = async () => { await s.ctx.db.delete(noteVersions).where(sql`note_versions.note_id = ${s.note.id} and note_versions.seq = 1`); };
    const r = await s.post(`${s.base}/1/apply`, { versionId: s.v1.id, discardUnsaved: false });
    expect((await r.json()).current).toMatchObject({ baseSeq: null, dirty: false, nextSeq: 3 });
    deleteV1 = null;
    await s.unloaded();
    expect((await versionsOf(s.ctx.db, s.note.id)).map(v => v.seq)).toEqual([2]);
    const saved = await s.post(s.base, {});
    expect(saved.status).toBe(201);
    expect((await saved.json()).upgraded).toBe(false);
    expect((await versionsOf(s.ctx.db, s.note.id)).map(v => v.seq)).toEqual([2, 3]);
    expect((await (await s.session.fetch(s.base)).json()).current.dirty).toBe(false);
    expect((await noteBase(s.ctx.db, s.note.id)).baseSeq).toBe(3);
  });

  it("viewer apply -> 403 and content and version_base_seq unchanged; stranger -> 404", async () => {
    const s = await collabSetup();
    const viewer = await s.ctx.createUser({ email: "v@example.com", password: "correct-horse-battery" });
    await s.ctx.createUser({ email: "x@example.com", password: "correct-horse-battery" });
    await s.ctx.share(s.note.id, viewer.id, "viewer");
    const before = await noteBase(s.ctx.db, s.note.id);
    const stateBefore = (await s.ctx.db.select({ ydoc: noteStates.ydoc }).from(noteStates).where(eq(noteStates.noteId, s.note.id)))[0]!.ydoc;
    const body = { versionId: s.v1.id, discardUnsaved: true };
    const vs = await s.ctx.loginAs("v@example.com", "correct-horse-battery");
    const v = await vs.fetch(`${s.base}/1/apply`, { method: "POST", body: JSON.stringify(body) });
    expect(v.status).toBe(403);
    expect((await v.json()).error).toEqual({ code: "forbidden", message: "You don't have edit access to this note." });
    const xs = await s.ctx.loginAs("x@example.com", "correct-horse-battery");
    expect((await xs.fetch(`${s.base}/1/apply`, { method: "POST", body: JSON.stringify(body) })).status).toBe(404);
    expect(await noteBase(s.ctx.db, s.note.id)).toEqual(before);
    const stateAfter = (await s.ctx.db.select({ ydoc: noteStates.ydoc }).from(noteStates).where(eq(noteStates.noteId, s.note.id)))[0]!.ydoc;
    expect(Buffer.from(stateAfter).equals(Buffer.from(stateBefore))).toBe(true);
  });

  it("viewer applying 3 times (limit 2) -> 403 every time, not 429", async () => {
    const s = await collabSetup({ limiters: { edit: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) } });
    const viewer = await s.ctx.createUser({ email: "v@example.com", password: "correct-horse-battery" });
    await s.ctx.share(s.note.id, viewer.id, "viewer");
    const vs = await s.ctx.loginAs("v@example.com", "correct-horse-battery");
    for (let i = 0; i < 3; i += 1) {
      const r = await vs.fetch(`${s.base}/1/apply`, { method: "POST", body: JSON.stringify({ versionId: s.v1.id, discardUnsaved: true }) });
      expect(r.status, `apply #${i + 1}`).toBe(403);
    }
  });

  it("queue held by an apply and wait times out -> manual save 503 server_busy (English message); apply 200 after release", async () => {
    let entered: (() => void) | null = null;
    let release: (() => void) | null = null;
    const gate = new Promise<void>(r => { release = r; });
    const inHook = new Promise<void>(r => { entered = r; });
    let armed = false;
    const s = await collabSetup({ editingQueueWaitMs: 300, editingTestHooks: { beforeMerge: async () => { if (armed) { entered!(); await gate; } } } });
    armed = true;
    const applying = s.post(`${s.base}/1/apply`, { versionId: s.v1.id, discardUnsaved: true });
    await inHook;
    const busy = await s.post(s.base, { name: "排隊中" });
    expect(busy.status).toBe(503);
    const err = (await busy.json()).error;
    expect(err.code).toBe("server_busy");
    expect(err.message).toBe("The note is being written right now. Try again in a moment.");
    armed = false;
    release!();
    expect((await applying).status).toBe(200);
  });

  it("manual save and apply concurrently are serialized through the same queue: both succeed", async () => {
    const s = await collabSetup();
    const [a, b] = await Promise.all([
      s.post(`${s.base}/1/apply`, { versionId: s.v1.id, discardUnsaved: true }),
      s.post(s.base, { name: "併發" }),
    ]);
    expect([a.status, b.status]).toEqual([200, 201]);
    const rows = await versionsOf(s.ctx.db, s.note.id);
    expect(rows.find(v => v.name === "併發")).toBeDefined();
  });
});

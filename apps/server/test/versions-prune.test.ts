import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { createVersionService } from "../src/collab/versions.js";
import { selectVersionsToDelete } from "../src/collab/version-policy.js";
import { noteVersions, notes } from "../src/db/schema.js";
import { EditorSession } from "../src/notes/editing/session.js";
import { versionFingerprint } from "../src/notes/version-fingerprint.js";
import { seedDoc } from "./copy-helpers.js";
import { cookieOf, seedGroup, seedNote, seedUser } from "./group-helpers.js";
import { buildTestApp, testEditingRuntime } from "./helpers.js";
import { deepDoc, paraDoc, versionsOf } from "./version-helpers.js";

const NOW = new Date("2026-10-09T12:00:00Z");
/** Inserts N automatic version rows on a note: createdAt follows the `days` array (days before NOW, may be fractional); seq 1..N; the base points at the last row. */
async function seedAutos(db: Awaited<ReturnType<typeof buildTestApp>>["db"], noteId: string, days: number[]): Promise<void> {
  for (let i = 0; i < days.length; i += 1) {
    await db.insert(noteVersions).values({ noteId, seq: i + 1, ydoc: Buffer.from([0]), kind: "auto", createdAt: new Date(NOW.getTime() - days[i]! * 86_400_000) });
  }
  await db.update(notes).set({ versionCounter: days.length, versionBaseSeq: days.length, versionBaseFingerprint: "fp" }).where(eq(notes.id, noteId));
}

describe("concurrency guard of pruneNote (re-judged at DELETE time)", () => {
  it("between reading and deleting: one row renamed to manual and the base switched by an apply to some row -> both rows are kept", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    // Fewer days = newer: seq 1 is oldest (70.4 days ago), seq 4 newest (70.1 days ago), all four in the same UTC day (2026-07-31, Friday) -> the same week: keep seq 4, delete 1-3.
    await seedAutos(db, n.id, [70.4, 70.3, 70.2, 70.1, 0.5]);
    const svc = createVersionService({
      db, log: { warn: () => {} },
      testHooks: {
        afterPruneRead: async (_id, doomed) => {
          expect(doomed).toEqual([1, 2, 3]);
          await db.update(noteVersions).set({ kind: "manual" }).where(sql`note_versions.note_id = ${n.id} and note_versions.seq = 1`);
          await db.update(notes).set({ versionBaseSeq: 2 }).where(eq(notes.id, n.id));
        },
      },
    });
    expect(await svc.pruneNote(n.id, NOW)).toBe(1);
    expect((await versionsOf(db, n.id)).map(v => v.seq)).toEqual([1, 2, 4, 5]);
  });
});

describe("prune after a cut", () => {
  it("after a manual version, old automatic versions are pruned by policy: result = the policy's output for the same set of rows", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedDoc(db, n.id, paraDoc(["新內容"]));
    // Build rows relative to the DB's now (pruneNote inside the cut uses the real clock): stay at least 0.4 days away from an interval boundary.
    for (const [i, d] of [10.5, 10.52, 70.1, 70.12, 3.5].entries()) {
      await db.execute(sql`insert into note_versions (note_id, seq, ydoc, kind, created_at) values (${n.id}, ${i + 1}, '\\x00'::bytea, 'auto', now() - make_interval(secs => ${d * 86400}))`);
    }
    await db.update(notes).set({ versionCounter: 5, versionBaseSeq: 5, versionBaseFingerprint: "stale" }).where(eq(notes.id, n.id));
    const before = await versionsOf(db, n.id);
    const r = await app.inject({ method: "POST", url: `/api/notes/${n.id}/versions`, cookies: await cookieOf(u.id), payload: {} });
    expect(r.statusCode).toBe(201);
    const expectDoomed = selectVersionsToDelete([...before, { seq: 6, kind: "manual", createdAt: new Date() }], { now: new Date(), keepAllDays: 7, dailyUntilDays: 30, baseSeq: 6 });
    expect((await versionsOf(db, n.id)).map(v => v.seq)).toEqual([1, 2, 3, 4, 5, 6].filter(s => !expectDoomed.includes(s)));
    expect(expectDoomed.length).toBeGreaterThan(0); // precondition: this data really has something to delete
  });
});

describe("sweep scale (three rounds in a row cover each of the >= 250 notes)", () => {
  it("250 notes each with one row to delete: after three rounds (100/100/50) every note is clean; the fourth round returns 0", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db);
    await db.execute(sql`insert into notes (owner_id, slug) select ${u.id}, 'sw-' || g from generate_series(1, 250) g`);
    await db.execute(sql`
      insert into note_versions (note_id, seq, ydoc, kind, created_at)
      select n.id, s.seq, '\\x00'::bytea, 'auto', ${NOW}::timestamptz - make_interval(days => s.days, hours => s.seq)
      from notes n cross join (values (1, 70), (2, 70), (3, 0)) as s(seq, days)
      where n.slug like 'sw-%'`);
    await db.execute(sql`update notes set version_counter = 3, version_base_seq = 3, version_base_fingerprint = 'fp' where slug like 'sw-%'`);
    const svc = createVersionService({ db, log: { warn: () => {} } });
    expect([await svc.sweep(NOW), await svc.sweep(NOW), await svc.sweep(NOW)]).toEqual([100, 100, 50]);
    const left = await db.execute(sql`select count(*)::int as n from note_versions`);
    expect(left.rows[0]).toEqual({ n: 500 }); // 2 left per note (the newer row of the same week + the newest)
    expect(await svc.sweep(NOW)).toBe(0);
  });
});

describe("pathological documents (deep nesting: 5000 levels must not make the version routes and move return 500)", () => {
  it("5000 levels: GET /versions is not 500, manual save 201, GET snapshot 200, move to a group succeeds", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "admin" }]);
    const n = await seedNote(db, { ownerId: u.id });
    await seedDoc(db, n.id, deepDoc(5000));
    const cookies = await cookieOf(u.id);
    expect((await app.inject({ method: "GET", url: `/api/notes/${n.id}/versions`, cookies })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/notes/${n.id}/versions`, cookies, payload: {} })).statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: `/api/notes/${n.id}/versions/1`, cookies })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/notes/${n.id}/move`, cookies, payload: { groupId: g.id } })).statusCode).toBe(200);
  });
});

describe("measurements (reported only, no limit asserted)", () => {
  it("deleting a group with transfer, 50 notes (3 versions each): elapsed time", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "admin" }]);
    for (let i = 0; i < 50; i += 1) {
      const n = await seedNote(db, { groupId: g.id });
      for (let s = 1; s <= 3; s += 1) await db.insert(noteVersions).values({ noteId: n.id, seq: s, ydoc: Buffer.from([0]), kind: "auto" });
    }
    const t0 = performance.now();
    const r = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}`, cookies: await cookieOf(u.id), payload: { mode: "transfer", transferTo: u.id } });
    console.log(`MEASURE transfer 50 notes: ${Math.round(performance.now() - t0)} ms`);
    expect(r.statusCode).toBe(204);
  });

  it("server proxy: after an old heading missing isToggleable is mounted, are attributes written back and does the version fingerprint change", async () => {
    const doc = new Y.Doc();
    const g = new Y.XmlElement("blockGroup");
    doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [g]);
    const c = new Y.XmlElement("blockContainer");
    c.setAttribute("id", "h1");
    const h = new Y.XmlElement("heading");
    for (const [k, v] of Object.entries({ level: 1, backgroundColor: "default", textColor: "default", textAlignment: "left" })) h.setAttribute(k, v as string);
    const t = new Y.XmlText();
    h.insert(0, [t]);
    c.insert(0, [h]);
    g.insert(0, [c]);
    t.insert(0, "舊標題");
    const fpBefore = versionFingerprint(doc.getXmlFragment(YDOC_FRAGMENT));
    const sv = Y.encodeStateVector(doc);
    const s = await EditorSession.open(testEditingRuntime, doc);
    s.close();
    const wrote = Y.encodeStateAsUpdate(doc, sv).length > 2;
    const fpChanged = versionFingerprint(doc.getXmlFragment(YDOC_FRAGMENT)) !== fpBefore;
    console.log(`MEASURE mount writeback: wrote=${wrote} fpChanged=${fpChanged} attrs=${JSON.stringify(h.getAttributes())}`);
    expect(fpBefore).toMatch(/^[0-9a-f]{16}$/);
    expect(wrote || !fpChanged).toBe(true); // if nothing was written back the fingerprint must not change (the fingerprint reads only the Yjs structure)
  });

  it("server side: elapsed time of a manual save and a GET snapshot for a 2000-block note", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedDoc(db, n.id, paraDoc(Array.from({ length: 2000 }, (_, i) => `第 ${i} 段的一些文字內容`)));
    const cookies = await cookieOf(u.id);
    let t0 = performance.now();
    expect((await app.inject({ method: "POST", url: `/api/notes/${n.id}/versions`, cookies, payload: {} })).statusCode).toBe(201);
    const saveMs = Math.round(performance.now() - t0);
    t0 = performance.now();
    const snap = await app.inject({ method: "GET", url: `/api/notes/${n.id}/versions/1`, cookies });
    console.log(`MEASURE server 2000 blocks: save=${saveMs} ms snapshot=${Math.round(performance.now() - t0)} ms bytes=${snap.body.length}`);
    expect(snap.statusCode).toBe(200);
  });
});

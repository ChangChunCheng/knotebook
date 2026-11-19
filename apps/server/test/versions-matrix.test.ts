import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT, topLevelContainers } from "@knotebook/shared";
import { createVersionService } from "../src/collab/versions.js";
import { groups, siteSettings, users } from "../src/db/schema.js";
import { bearer, docText, seedContent, seedTokenForUser, waitFor } from "./editing-helpers.js";
import { seedGroup, seedNote } from "./group-helpers.js";
import { buildCollabTestApp, type CollabTestCtx, type TestClient } from "./helpers.js";
import { noteBase, paraDoc, pendingOf, versionsOf, waitForPending } from "./version-helpers.js";

const PASSWORD = "correct-horse-battery";

async function setup() {
  const ctx = await buildCollabTestApp({ versionAutoWaitMs: 0 });
  const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
  const session = await ctx.loginAs("a@example.com", PASSWORD);
  const { token } = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write", "Claude Code (knotebook)");
  const unloaded = () => waitFor("卸載", 10_000, () => ctx.collab.hocuspocus.documents.size === 0);
  return { ctx, u, session, token, unloaded, scan: () => ctx.collab.versions.scanDue() };
}
type S = Awaited<ReturnType<typeof setup>>;

async function typeFirst(ctx: CollabTestCtx, noteId: string, client: TestClient, fn: (t: Y.XmlText) => void, until: (s: string) => boolean): Promise<void> {
  const p = topLevelContainers(client.doc.getXmlFragment(YDOC_FRAGMENT))[0]!.get(0) as Y.XmlElement;
  client.doc.transact(() => fn(p.get(0) as Y.XmlText));
  await waitFor("server 收到", 5_000, () => until(docText(ctx.collab.hocuspocus.documents.get(noteId)!)));
}

async function cutPoints(s: S, noteId: string): Promise<[number, number]> {
  const client = await seedContent(s.ctx, s.session, noteId, "矩陣測試的人工內容");
  const ai = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${noteId}/edits`, headers: bearer(s.token), payload: { op: "append", markdown: "AI 加的" } });
  expect(ai.statusCode).toBe(201);
  client.disconnect();
  await s.unloaded();
  await s.scan();
  const afterCuts = (await versionsOf(s.ctx.db, noteId)).length;
  const save = await s.session.fetch(`/api/notes/${noteId}/versions`, { method: "POST", body: JSON.stringify({}) });
  expect(save.status).toBe(201);
  return [afterCuts, (await versionsOf(s.ctx.db, noteId)).length];
}

describe("switch matrix", () => {
  it("site master switch off -> scan cuts nothing, manual still creates", async () => {
    const s = await setup();
    await s.ctx.db.update(siteSettings).set({ autoVersionsEnabled: false });
    const n = await s.ctx.createNote(s.u.id);
    expect(await cutPoints(s, n.id)).toEqual([0, 1]);
  });

  it("personal switch off -> personal notes are not cut; group notes still are (site on + personal off)", async () => {
    const s = await setup();
    await s.ctx.db.update(users).set({ autoVersions: false }).where(eq(users.id, s.u.id));
    const personal = await s.ctx.createNote(s.u.id);
    expect(await cutPoints(s, personal.id)).toEqual([0, 1]);
    const g = await seedGroup(s.ctx.db, "G", [{ userId: s.u.id, role: "admin" }]);
    const gnote = await seedNote(s.ctx.db, { groupId: g.id });
    const [cuts] = await cutPoints(s, gnote.id);
    expect(cuts).toBe(1); // #272: human and AI in the same quiet period -> the same version
  });

  it("group switch off -> group notes are not cut, manual still creates", async () => {
    const s = await setup();
    const g = await seedGroup(s.ctx.db, "G", [{ userId: s.u.id, role: "admin" }]);
    await s.ctx.db.update(groups).set({ autoVersions: false }).where(eq(groups.id, g.id));
    const gnote = await seedNote(s.ctx.db, { groupId: g.id });
    expect(await cutPoints(s, gnote.id)).toEqual([0, 1]);
  });

  it("a changed switch takes effect only after reload: while loaded, pending and cuts follow the value at load time; after reload with it off nothing is pending", async () => {
    const s = await setup();
    const n = await s.ctx.createNote(s.u.id);
    const client = await seedContent(s.ctx, s.session, n.id, "載入時開著");
    await waitForPending(s.ctx.db, n.id);
    const r = await s.session.fetch("/api/auth/profile", { method: "PATCH", body: JSON.stringify({ autoVersions: false }) });
    expect(r.status).toBe(200);
    await s.scan(); // the document is still loaded: this load cycle is still on (note: for an unloaded note the scan reads the current DB value)
    expect(await versionsOf(s.ctx.db, n.id)).toHaveLength(1);
    client.disconnect();
    await s.unloaded();
    const again = await s.session.connect(n.id);
    await typeFirst(s.ctx, n.id, again, t => t.insert(0, "再載入後改"), x => x.includes("再載入後改"));
    again.disconnect();
    await s.unloaded();
    expect((await pendingOf(s.ctx.db, n.id)).at).toBeNull();
    await s.scan();
    expect(await versionsOf(s.ctx.db, n.id)).toHaveLength(1);
  });
});

describe("fingerprint scenarios", () => {
  it("after apply, typing one character and deleting it -> not dirty; applying the base version itself (same content) -> dirty=false and the scan does not cut extra", async () => {
    const s = await setup();
    const n = await s.ctx.createNote(s.u.id);
    const client = await seedContent(s.ctx, s.session, n.id, "第一版的文字");
    await s.session.fetch(`/api/notes/${n.id}/versions`, { method: "POST", body: JSON.stringify({}) });
    const [v1] = await versionsOf(s.ctx.db, n.id);
    const apply = await s.session.fetch(`/api/notes/${n.id}/versions/1/apply`, { method: "POST", body: JSON.stringify({ versionId: v1!.id, discardUnsaved: false }) });
    expect((await apply.json()).current.dirty).toBe(false);
    await typeFirst(s.ctx, n.id, client, t => t.insert(0, "Ж"), x => x.includes("Ж"));
    await typeFirst(s.ctx, n.id, client, t => t.delete(0, 1), x => !x.includes("Ж"));
    expect((await (await s.session.fetch(`/api/notes/${n.id}/versions`)).json()).current.dirty).toBe(false);
    client.disconnect();
    await s.unloaded();
    await s.scan();
    expect(await versionsOf(s.ctx.db, n.id)).toHaveLength(1);
  });
});

describe("version number concurrency", () => {
  it("10 manual cuts of one note at once (each with different content, document not loaded) -> exactly one version succeeds, the rest are null because the base changed; then 9 sequential ones -> seq 1..10 contiguous = the counter", async () => {
    const s = await setup();
    const n = await s.ctx.createNote(s.u.id);
    // Barrier (`testHooks.afterMetaRead`): all 10 calls finish reading meta before they are released together, all entering the transaction with the same old base (null) -
    // otherwise on a cold pool the call with a warm connection commits before the others read meta, and latecomers with the new base succeed once more (2 succeed).
    let arrived = 0;
    let barrierOn = true;
    let release!: () => void;
    const all = new Promise<void>(r => { release = r; });
    const svc = createVersionService({
      db: s.ctx.db,
      log: s.ctx.app.log,
      testHooks: {
        afterMetaRead: async () => {
          if (!barrierOn) return;
          arrived += 1;
          if (arrived === 10) release();
          await all;
        },
      },
    });
    const docs = Array.from({ length: 10 }, (_, i) => paraDoc([`內容 ${i}`]));
    const results = await Promise.all(docs.map(d => svc.cutIfDirty(n.id, d, { kind: "manual", transient: d })));
    expect(arrived).toBe(10);
    expect(results.filter(r => r !== null && !("skipped" in r))).toHaveLength(1);
    expect(results.filter(r => r === null)).toHaveLength(9);
    barrierOn = false;
    for (let i = 0; i < 9; i += 1) {
      const d = paraDoc([`循序 ${i}`]);
      await svc.cutIfDirty(n.id, d, { kind: "manual", transient: d });
    }
    expect((await versionsOf(s.ctx.db, n.id)).map(v => v.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect((await noteBase(s.ctx.db, n.id)).counter).toBe(10);
  });

  it("loaded, 10 automatic cuts of the same content at once -> exactly one version; a manual and a scan colliding on the same content -> total exactly +1 (#272)", async () => {
    const s = await setup();
    const n = await s.ctx.createNote(s.u.id);
    const client = await seedContent(s.ctx, s.session, n.id, "同一份內容");
    const live = s.ctx.collab.hocuspocus.documents.get(n.id)!;
    await Promise.all(Array.from({ length: 10 }, () => s.ctx.collab.versions.cutIfDirty(n.id, live, { kind: "auto" })));
    expect(await versionsOf(s.ctx.db, n.id)).toHaveLength(1);
    await typeFirst(s.ctx, n.id, client, t => t.insert(0, "再改"), x => x.includes("再改"));
    await waitForPending(s.ctx.db, n.id);
    await Promise.all([s.scan(), s.ctx.collab.versions.cutIfDirty(n.id, live, { kind: "manual", name: "手動" })]);
    expect(await versionsOf(s.ctx.db, n.id)).toHaveLength(2);
    client.disconnect();
  });
});

describe("revert does not cut at once (#272)", () => {
  it("human unsaved changes before the revert -> no new version at revert time; scan after leaving +1 (human, AI and revert in the same version)", async () => {
    const s = await setup();
    const n = await s.ctx.createNote(s.u.id);
    const client = await seedContent(s.ctx, s.session, n.id, "撤回測試原文");
    const ai = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${n.id}/edits`, headers: bearer(s.token), payload: { op: "append", markdown: "AI 這段會被撤回" } });
    const editId = ai.json().editId as string;
    await typeFirst(s.ctx, n.id, client, t => t.insert(0, "人又改"), x => x.includes("人又改"));
    const before = (await versionsOf(s.ctx.db, n.id)).length;
    const rv = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${n.id}/edits/${editId}/revert`, headers: bearer(s.token) });
    expect(rv.statusCode).toBe(201);
    expect((await versionsOf(s.ctx.db, n.id)).length - before).toBe(0);
    client.disconnect();
    await s.unloaded();
    await s.scan();
    expect((await versionsOf(s.ctx.db, n.id)).length - before).toBe(1);
  });
});

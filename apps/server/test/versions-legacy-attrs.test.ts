// Version history x old-schema notes, and manual save when the base row is gone. For an old note whose note_states lacks the newer schema's default
// attributes, y-prosemirror writes back the default attributes of the touched paragraph when a browser types a character and deletes it.
// Here a WS client simulates that write-back by calling setAttribute directly.
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import * as Y from "yjs";
import { YDOC_FRAGMENT, topLevelBlocks } from "@knotebook/shared";
import { noteStates } from "../src/db/schema.js";
import { versionFingerprint } from "../src/notes/version-fingerprint.js";
import { seedDoc } from "./copy-helpers.js";
import { waitFor } from "./editing-helpers.js";
import { cookieOf, seedNote, seedUser } from "./group-helpers.js";
import { buildCollabTestApp, buildTestApp } from "./helpers.js";
import { noteBase, paraDoc, versionsOf } from "./version-helpers.js";

const PASSWORD = "correct-horse-battery";
const PARA_DEFAULTS = { backgroundColor: "default", textAlignment: "left", textColor: "default" } as const;

/** Shape of the seed script: heading has only level (number), paragraph has no attributes. */
function legacyDoc(): Y.Doc {
  const doc = new Y.Doc();
  const g = new Y.XmlElement("blockGroup");
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [g]);
  const h = new Y.XmlElement("heading");
  h.setAttribute("level", 2 as unknown as string);
  const ht = new Y.XmlText();
  h.insert(0, [ht]);
  const hc = new Y.XmlElement("blockContainer");
  hc.setAttribute("id", "legacy-h");
  hc.insert(0, [h]);
  const p = new Y.XmlElement("paragraph");
  const pt = new Y.XmlText();
  p.insert(0, [pt]);
  const pc = new Y.XmlElement("blockContainer");
  pc.setAttribute("id", "legacy-p");
  pc.insert(0, [p]);
  g.insert(0, [hc, pc]);
  ht.insert(0, "Legacy heading");
  pt.insert(0, "Legacy paragraph");
  return doc;
}

async function legacySetup() {
  const ctx = await buildCollabTestApp({ versionAutoWaitMs: 0 });
  const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
  const note = await ctx.createNote(u.id);
  await seedDoc(ctx.db, note.id, legacyDoc());
  const session = await ctx.loginAs("a@example.com", PASSWORD);
  const unloaded = () => waitFor("落盤並卸載", 10_000, () => ctx.collab.hocuspocus.documents.size === 0);
  return { ctx, note, session, unloaded };
}

async function rewriteParagraphAttrs(s: Awaited<ReturnType<typeof legacySetup>>, attrs: Record<string, string>) {
  const c = await s.session.connect(s.note.id);
  await waitFor("版本狀態初始化", 5_000, () => s.ctx.collab.versions.debugState(s.note.id)?.initialized === true);
  const p = topLevelBlocks(c.doc.getXmlFragment(YDOC_FRAGMENT))[1]!.get(0) as Y.XmlElement;
  expect(p.nodeName).toBe("paragraph");
  expect(p.getAttributes()).toEqual({});
  c.doc.transact(() => {
    for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
  });
  const serverDoc = s.ctx.collab.hocuspocus.documents.get(s.note.id)!;
  const serverPara = () => topLevelBlocks(serverDoc.getXmlFragment(YDOC_FRAGMENT))[1]!.get(0) as Y.XmlElement;
  await waitFor("server 收到屬性回寫", 5_000, () => serverPara().getAttribute("textColor") === attrs.textColor);
  expect(serverPara().getAttributes()).toEqual(attrs);
  expect(serverPara().toString()).toContain("Legacy paragraph");
  const dirty = await s.ctx.collab.versions.isDirty(s.note.id, serverDoc);
  return { c, dirty };
}

// The new wikilink props default to "": version fingerprint rule (a value equal to the schema default counts as absent; the default table is derived dynamically from
// the schema) ignores them, so a new tab writing `label=""`/`anchorBlockId=""` does not cut another version; non-default values still enter the fingerprint.
function wikilinkDoc(attrs: Record<string, string>): Y.Doc {
  const doc = new Y.Doc();
  const g = new Y.XmlElement("blockGroup");
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [g]);
  const c = new Y.XmlElement("blockContainer");
  c.setAttribute("id", "w1");
  const p = new Y.XmlElement("paragraph");
  const w = new Y.XmlElement("wikilink");
  w.setAttribute("targetNoteId", "33333333-3333-4333-8333-333333333333");
  w.setAttribute("snapshotTitle", "T");
  for (const [k, v] of Object.entries(attrs)) w.setAttribute(k, v);
  p.insert(0, [w]);
  c.insert(0, [p]);
  g.insert(0, [c]);
  return doc;
}

describe("#269: new wikilink props and the version fingerprint", () => {
  it("fingerprints are equal before and after backfilling label='' and anchorBlockId=''", () => {
    const fp = (attrs: Record<string, string>) => versionFingerprint(wikilinkDoc(attrs).getXmlFragment(YDOC_FRAGMENT));
    expect(fp({ label: "", anchorBlockId: "" })).toBe(fp({}));
  });
  it("label='x' differs from having no attributes", () => {
    const fp = (attrs: Record<string, string>) => versionFingerprint(wikilinkDoc(attrs).getXmlFragment(YDOC_FRAGMENT));
    expect(fp({ label: "x" })).not.toBe(fp({}));
  });
});

describe("old-schema note gets default attributes written back", () => {
  it("paragraph gains three default values, text unchanged -> isDirty false; disconnect and scan -> total 0", async () => {
    const s = await legacySetup();
    const { c, dirty } = await rewriteParagraphAttrs(s, { ...PARA_DEFAULTS });
    expect(dirty).toBe(false);
    c.disconnect();
    await s.unloaded();
    await s.ctx.collab.versions.scanDue();
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
  });

  it("control: same flow but textAlignment is center (non-default) -> isDirty true; disconnect and scan -> total 1, content is the written-back one", async () => {
    const s = await legacySetup();
    const { c, dirty } = await rewriteParagraphAttrs(s, { ...PARA_DEFAULTS, textAlignment: "center" });
    expect(dirty).toBe(true);
    const after = versionFingerprint(s.ctx.collab.hocuspocus.documents.get(s.note.id)!.getXmlFragment(YDOC_FRAGMENT));
    c.disconnect();
    await s.unloaded();
    await s.ctx.collab.versions.scanDue();
    const rows = await versionsOf(s.ctx.db, s.note.id);
    expect(rows.map(r => [r.seq, r.kind])).toEqual([[1, "auto"]]);
    const v1 = new Y.Doc();
    Y.applyUpdate(v1, rows[0]!.ydoc);
    expect(versionFingerprint(v1.getXmlFragment(YDOC_FRAGMENT))).toBe(after);
  });
});

async function call(app: FastifyInstance, url: string, who: string, payload: unknown) {
  return app.inject({ method: "POST", url, cookies: await cookieOf(who), payload: payload as object });
}

describe("manual save: the base points at a deleted version", () => {
  it("create v1 -> delete v1 directly with SQL (bypassing version_is_base) -> content unchanged -> POST manual save -> 201 new version seq 2, upgraded false, base now points at 2", async () => {
    const built = await buildTestApp();
    const owner = await seedUser(built.db);
    const note = await seedNote(built.db, { ownerId: owner.id });
    await seedDoc(built.db, note.id, paraDoc(["基底會被刪掉的內容"]));
    const url = `/api/notes/${note.id}/versions`;
    const first = await call(built.app, url, owner.id, {});
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ seq: 1, upgraded: false });
    const before = await noteBase(built.db, note.id);
    expect(before).toMatchObject({ counter: 1, baseSeq: 1 });
    await built.db.execute(sql`delete from note_versions where note_versions.note_id = ${note.id} and note_versions.seq = 1`);
    expect(await versionsOf(built.db, note.id)).toEqual([]);

    const r = await call(built.app, url, owner.id, { name: "補存" });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ seq: 2, kind: "manual", name: "補存", upgraded: false, baseSeq: null });
    const rows = await versionsOf(built.db, note.id);
    expect(rows.map(x => [x.seq, x.kind, x.name, x.baseSeq])).toEqual([[2, "manual", "補存", null]]);
    expect(await noteBase(built.db, note.id)).toEqual({ counter: 2, baseSeq: 2, baseFingerprint: before.baseFingerprint });
  });

  it("create v1 -> delete v1 with SQL -> content changed -> POST manual save -> 201 seq 2, baseSeq null (does not point at the deleted v1)", async () => {
    const built = await buildTestApp();
    const owner = await seedUser(built.db);
    const note = await seedNote(built.db, { ownerId: owner.id });
    await seedDoc(built.db, note.id, paraDoc(["改前的內容"]));
    const url = `/api/notes/${note.id}/versions`;
    expect((await call(built.app, url, owner.id, {})).json()).toMatchObject({ seq: 1, upgraded: false });
    expect(await noteBase(built.db, note.id)).toMatchObject({ counter: 1, baseSeq: 1 });
    await built.db.execute(sql`delete from note_versions where note_versions.note_id = ${note.id} and note_versions.seq = 1`);
    const changed = paraDoc(["改後的內容"]);
    await built.db
      .update(noteStates)
      .set({ ydoc: Buffer.from(Y.encodeStateAsUpdate(changed)) })
      .where(eq(noteStates.noteId, note.id));
    const changedFp = versionFingerprint(changed.getXmlFragment(YDOC_FRAGMENT));

    const r = await call(built.app, url, owner.id, {});
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ seq: 2, kind: "manual", upgraded: false, baseSeq: null });
    const rows = await versionsOf(built.db, note.id);
    expect(rows.map(x => [x.seq, x.kind, x.baseSeq])).toEqual([[2, "manual", null]]);
    expect(await noteBase(built.db, note.id)).toEqual({ counter: 2, baseSeq: 2, baseFingerprint: changedFp });
  });
});

import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import * as Y from "yjs";
import { YDOC_FRAGMENT, topLevelContainers } from "@knotebook/shared";
import { noteAiEdits, noteLinkConversion, noteLinks, notes, users } from "../src/db/schema.js";
import { LINK_CONVERSION_VERSION_NAME, runLinkConversion, type LinkConversionDeps } from "../src/notes/link-conversion.js";
import { buildCollabTestApp, testConfig, type CollabTestCtx } from "./helpers.js";
import { loadDoc, seedDoc, wikilinkDoc } from "./copy-helpers.js";
import { seedGroup, seedNote, seedShare } from "./group-helpers.js";
import { seedOldNote, versionsOf } from "./version-helpers.js";

const PASSWORD = "correct-horse-battery";
const ORIGIN = testConfig.publicUrl.origin;

type Ctx = CollabTestCtx;
function depsOf(ctx: Ctx): LinkConversionDeps {
  return ctx.app.linkConversion.deps!;
}
async function run(ctx: Ctx, deps: LinkConversionDeps = depsOf(ctx), signal = new AbortController().signal) {
  return runLinkConversion(deps, { signal, batchSize: 50 });
}
async function pending(ctx: Ctx, noteId: string): Promise<void> {
  await ctx.db.insert(noteLinkConversion).values({ noteId, status: "pending" });
}
async function statusOf(ctx: Ctx, noteId: string) {
  const [r] = await ctx.db.select().from(noteLinkConversion).where(eq(noteLinkConversion.noteId, noteId));
  return r ? { status: r.status, attempts: r.attempts, converted: r.converted, unresolved: r.unresolved } : null;
}
function wikilinks(doc: Y.Doc): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const n of doc.getXmlFragment(YDOC_FRAGMENT).createTreeWalker(x => x instanceof Y.XmlElement && x.nodeName === "wikilink")) out.push((n as Y.XmlElement).getAttributes());
  return out;
}
function linkHrefs(doc: Y.Doc): string[] {
  const out: string[] = [];
  for (const n of doc.getXmlFragment(YDOC_FRAGMENT).createTreeWalker(x => x instanceof Y.XmlText)) {
    for (const op of (n as Y.XmlText).toDelta() as Array<{ attributes?: { link?: { href: string } } }>) if (op.attributes?.link) out.push(op.attributes.link.href);
  }
  return out;
}
/** Same Yjs item id (client:clock) means the block wasn't rewritten. */
function itemIdOf(doc: Y.Doc, index: number): string {
  const c = topLevelContainers(doc.getXmlFragment(YDOC_FRAGMENT))[index] as unknown as { _item: { id: { client: number; clock: number } } };
  return `${c._item.id.client}:${c._item.id.clock}`;
}
async function linksOf(ctx: Ctx, noteId: string): Promise<string[]> {
  return (await ctx.db.select({ t: noteLinks.targetNoteId }).from(noteLinks).where(eq(noteLinks.sourceNoteId, noteId))).map(r => r.t).sort();
}
function versionDoc(row: { ydoc: Uint8Array }): Y.Doc {
  const d = new Y.Doc();
  Y.applyUpdate(d, new Uint8Array(row.ydoc));
  return d;
}
function spyLog(): { log: LinkConversionDeps["log"]; warns: Array<Record<string, unknown>> } {
  const warns: Array<Record<string, unknown>> = [];
  return { warns, log: { info: () => {}, warn: (o: object) => void warns.push(o as Record<string, unknown>), error: () => {} } };
}

describe("#269 one-time internal link conversion", () => {
  it("personal note: links the owner can see are converted, invisible ones stay, tables are converted, styles dropped; the pre-conversion version is saved first; note_links only grows; no attribution, no AI record; untouched blocks aren't rewritten; marked done", async () => {
    const ctx = await buildCollabTestApp();
    const alice = await ctx.createUser({ email: "lc-a@example.com", password: PASSWORD });
    const bob = await ctx.createUser({ email: "lc-b@example.com", password: PASSWORD });
    const a = await seedNote(ctx.db, { ownerId: alice.id }, { title: "A", slug: "a" });
    const shared = await seedNote(ctx.db, { ownerId: bob.id }, { title: "Shared" });
    await seedShare(ctx.db, shared.id, alice.id, "viewer");
    const secret = await seedNote(ctx.db, { ownerId: bob.id }, { title: "Secret" });
    const host = await seedNote(ctx.db, { ownerId: alice.id }, { title: "Host" });
    const [{ handle }] = await ctx.db.select({ handle: users.handle }).from(users).where(eq(users.id, alice.id));
    await seedOldNote(ctx.db, host.id, [
      "untouched paragraph",
      "",
      `see [A](/n/${handle}/a) and [**b**old](${ORIGIN}/notes/${a.id}#b-h1) and [s](/notes/${shared.id}) and [x](/notes/${secret.id})`,
      "",
      "| c |",
      "| --- |",
      `| [t](/notes/${a.id}) |`,
    ].join("\n"));
    await pending(ctx, host.id);
    const before = (await loadDoc(ctx.db, host.id))!;
    const untouchedBefore = itemIdOf(before, 0);

    const summary = await run(ctx);

    const doc = (await loadDoc(ctx.db, host.id))!;
    const wl = wikilinks(doc);
    expect(wl.map(w => [w.targetNoteId, w.label ?? "", w.anchorBlockId ?? ""])).toEqual([
      [a.id, "", ""],
      [a.id, "bold", "h1"],
      [shared.id, "s", ""],
      [a.id, "t", ""],
    ]);
    expect(linkHrefs(doc)).toEqual([`/notes/${secret.id}`]);
    expect(itemIdOf(doc, 0)).toBe(untouchedBefore);
    // Only manual rows are asserted, not when the post-conversion auto version is cut (before #272 it is cut right when offline, after #272 it is left to the scanner).
    const manual = (await versionsOf(ctx.db, host.id)).filter(v => v.kind === "manual");
    expect(manual.map(v => v.name)).toEqual([LINK_CONVERSION_VERSION_NAME]);
    // That version was cut before the conversion: its snapshot has no wikilink and still has the original ordinary link.
    const snap = versionDoc(manual[0]!);
    expect(wikilinks(snap)).toEqual([]);
    expect(new Set(linkHrefs(snap))).toEqual(new Set([`/n/${handle}/a`, `${ORIGIN}/notes/${a.id}#b-h1`, `/notes/${shared.id}`, `/notes/${secret.id}`, `/notes/${a.id}`]));
    expect(await linksOf(ctx, host.id)).toEqual([a.id, shared.id].sort());
    const [n] = await ctx.db.select({ at: notes.lastEditedAt, by: notes.lastEditedBy }).from(notes).where(eq(notes.id, host.id));
    expect(n).toEqual({ at: null, by: null });
    expect(await ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, host.id))).toEqual([]);
    expect(await statusOf(ctx, host.id)).toEqual({ status: "done", attempts: 0, converted: 4, unresolved: 1 });
    expect(summary).toMatchObject({ scanned: 1, notesConverted: 1, linksConverted: 4, unresolved: 1, retry: 0, failed: 0 });
  });

  it("group note: only links whose target is in the same group are converted; other groups and /n/ personal notes stay", async () => {
    const ctx = await buildCollabTestApp();
    const alice = await ctx.createUser({ email: "lc-g@example.com", password: PASSWORD });
    const g = await seedGroup(ctx.db, "G", [{ userId: alice.id, role: "admin" }]);
    const h = await seedGroup(ctx.db, "H", [{ userId: alice.id, role: "admin" }]);
    const same = await seedNote(ctx.db, { groupId: g.id }, { title: "Same", slug: "same" });
    const otherGroup = await seedNote(ctx.db, { groupId: h.id }, { title: "Other", slug: "other" });
    const personal = await seedNote(ctx.db, { ownerId: alice.id }, { title: "Mine", slug: "mine" });
    const [{ handle }] = await ctx.db.select({ handle: users.handle }).from(users).where(eq(users.id, alice.id));
    const host = await seedNote(ctx.db, { groupId: g.id }, { title: "Host" });
    await seedOldNote(ctx.db, host.id, `[s](/g/${g.id}/same) [o](/g/${h.id}/other) [m](/n/${handle}/mine)`);
    await pending(ctx, host.id);
    await run(ctx);
    const doc = (await loadDoc(ctx.db, host.id))!;
    expect(wikilinks(doc).map(w => w.targetNoteId)).toEqual([same.id]);
    expect(linkHrefs(doc)).toEqual([`/g/${h.id}/other`, `/n/${handle}/mine`]);
    expect(await linksOf(ctx, host.id)).toEqual([same.id]);
    expect([otherGroup.id, personal.id].every(id => !wikilinks(doc).some(w => w.targetNoteId === id))).toBe(true);
  });

  it("pre-conversion version: base has the same content and the user already named it -> name unchanged, no extra row; base has no name -> renamed to the pre-conversion name", async () => {
    const ctx = await buildCollabTestApp();
    const alice = await ctx.createUser({ email: "lc-v@example.com", password: PASSWORD });
    const a = await seedNote(ctx.db, { ownerId: alice.id }, { title: "A" });
    const named = await seedNote(ctx.db, { ownerId: alice.id }, { title: "Named" });
    const unnamed = await seedNote(ctx.db, { ownerId: alice.id }, { title: "Unnamed" });
    for (const n of [named, unnamed]) {
      await seedOldNote(ctx.db, n.id, `[x](/notes/${a.id})`);
      await pending(ctx, n.id);
    }
    const versions = depsOf(ctx).versions;
    for (const [n, name] of [[named, "My name"], [unnamed, null]] as const) {
      const { doc, transient } = await versions.docFor(n.id);
      // Both notes use manual (the unnamed one passes name: null): an auto version without a base for a note that isn't loaded is always judged clean and returns null, so the precondition would fail.
      const r = await versions.cutIfDirty(n.id, doc, { kind: "manual", name, transient });
      expect(r && "row" in r).toBe(true);
    }
    await run(ctx);
    // Only manual rows are looked at (when the post-conversion auto version is cut isn't asserted); the manual row's snapshot is still the ordinary link.
    const manualOf = async (id: string) => (await versionsOf(ctx.db, id)).filter(v => v.kind === "manual");
    const namedManual = await manualOf(named.id);
    expect(namedManual.map(v => v.name)).toEqual(["My name"]);
    expect(wikilinks(versionDoc(namedManual[0]!))).toEqual([]);
    const unnamedManual = await manualOf(unnamed.id);
    expect(unnamedManual.map(v => v.name)).toEqual([LINK_CONVERSION_VERSION_NAME]);
    expect(wikilinks(versionDoc(unnamedManual[0]!))).toEqual([]);
  });

  it("rerun: done rows aren't processed again; after setting a row back to pending and rerunning - zero content writes, note_links only fills gaps; a note whose merge was persisted but whose note_links weren't written (pre-scan 0) gets its link rows", async () => {
    const ctx = await buildCollabTestApp();
    const alice = await ctx.createUser({ email: "lc-r@example.com", password: PASSWORD });
    const a = await seedNote(ctx.db, { ownerId: alice.id }, { title: "A" });
    const host = await seedNote(ctx.db, { ownerId: alice.id }, { title: "Host" });
    await seedOldNote(ctx.db, host.id, `[x](/notes/${a.id})`);
    await pending(ctx, host.id);
    await run(ctx);
    expect((await run(ctx)).scanned).toBe(0);
    const versionsAfterFirst = await versionsOf(ctx.db, host.id);
    const bytes1 = Buffer.from(Y.encodeStateAsUpdate((await loadDoc(ctx.db, host.id))!)).toString("base64");
    await ctx.db.delete(noteLinks).where(eq(noteLinks.sourceNoteId, host.id));
    await ctx.db.update(noteLinkConversion).set({ status: "pending" }).where(eq(noteLinkConversion.noteId, host.id));
    // The second round has no ordinary internal links left, so no new version is saved.
    const second = await run(ctx);
    expect(Buffer.from(Y.encodeStateAsUpdate((await loadDoc(ctx.db, host.id))!)).toString("base64")).toBe(bytes1);
    expect(await linksOf(ctx, host.id)).toEqual([a.id]);
    expect(second).toMatchObject({ scanned: 1, notesConverted: 0, linksConverted: 0 });
    // Compare before and after rather than asserting a total (the auto version cut after the first round depends on #272).
    const versionsAfterSecond = await versionsOf(ctx.db, host.id);
    expect(versionsAfterSecond.map(v => v.id)).toEqual(versionsAfterFirst.map(v => v.id));
    expect(versionsAfterSecond.filter(v => v.name === LINK_CONVERSION_VERSION_NAME)).toHaveLength(1);

    const already = await seedNote(ctx.db, { ownerId: alice.id }, { title: "Already" });
    await seedDoc(ctx.db, already.id, wikilinkDoc([a.id]));
    await pending(ctx, already.id);
    await run(ctx);
    expect(await linksOf(ctx, already.id)).toEqual([a.id]);
    expect(await statusOf(ctx, already.id)).toMatchObject({ status: "done" });
  });

  it("FingerprintMismatch twice -> retry (attempts 1), content unchanged", async () => {
    let target = "";
    let aliceId = "";
    let ctxRef: Ctx | null = null;
    let mergeAttempts = 0;
    const ctx = await buildCollabTestApp({
      editingTestHooks: {
        beforeMerge: async () => {
          mergeAttempts += 1;
          // Insert a paragraph into the live doc before merging: the whole-note fingerprint must then mismatch.
          const direct = await ctxRef!.collab.hocuspocus.openDirectConnection(target, { userId: aliceId });
          await direct.transact(doc => {
            const g = doc.getXmlFragment(YDOC_FRAGMENT).get(0) as Y.XmlElement;
            const c = new Y.XmlElement("blockContainer");
            c.setAttribute("id", `ins-${Math.random().toString(36).slice(2)}`);
            c.insert(0, [new Y.XmlElement("paragraph")]);
            g.insert(g.length, [c]);
          });
          await direct.disconnect();
        },
      },
    });
    ctxRef = ctx;
    const alice = await ctx.createUser({ email: "lc-f@example.com", password: PASSWORD });
    aliceId = alice.id;
    const a = await seedNote(ctx.db, { ownerId: alice.id }, { title: "A" });
    const host = await seedNote(ctx.db, { ownerId: alice.id }, { title: "Host" });
    target = host.id;
    await seedOldNote(ctx.db, host.id, `[x](/notes/${a.id})`);
    await pending(ctx, host.id);
    const spy = spyLog();
    await run(ctx, { ...depsOf(ctx), log: spy.log });
    // A fingerprint mismatch restarts from the beginning - exactly two merges (no restart, or two or more restarts, both go red).
    expect(mergeAttempts).toBe(2);
    expect(await statusOf(ctx, host.id)).toMatchObject({ status: "retry", attempts: 1 });
    expect(wikilinks((await loadDoc(ctx.db, host.id))!)).toEqual([]);
    // A non-exception retry also logs one warn, shaped only { noteId, stage, err } (no href/title/text).
    expect(spy.warns).toEqual([{ noteId: host.id, stage: "merge", err: "fingerprint-mismatch" }]);
  });

  it("uninitialized -> retry; unexpected exception -> retry, 3rd -> failed, never processed again", async () => {
    const ctx = await buildCollabTestApp();
    const alice = await ctx.createUser({ email: "lc-u@example.com", password: PASSWORD });
    const a = await seedNote(ctx.db, { ownerId: alice.id }, { title: "A" });
    const h1 = await seedNote(ctx.db, { ownerId: alice.id }, { title: "H1" });
    await seedOldNote(ctx.db, h1.id, `[x](/notes/${a.id})`);
    await pending(ctx, h1.id);
    const real = depsOf(ctx);
    const spy = spyLog();
    await run(ctx, { ...real, log: spy.log, versions: { docFor: real.versions.docFor, cutIfDirty: async () => ({ skipped: "uninitialized" as const }) } });
    expect(await statusOf(ctx, h1.id)).toMatchObject({ status: "retry", attempts: 1 });
    expect(spy.warns).toEqual([{ noteId: h1.id, stage: "version", err: "version-skipped" }]);

    const throwing = { ...real, versions: { docFor: real.versions.docFor, cutIfDirty: async () => { throw new Error("boom"); } } };
    await run(ctx, throwing);
    expect(await statusOf(ctx, h1.id)).toMatchObject({ status: "retry", attempts: 2 });
    await run(ctx, throwing);
    expect(await statusOf(ctx, h1.id)).toMatchObject({ status: "failed", attempts: 3 });
    const fourth = await run(ctx, throwing);
    expect(fourth.scanned).toBe(0);
  });

  it("a hand-written retry row with attempts already at 3 isn't a candidate: not processed, state and content unchanged", async () => {
    const ctx = await buildCollabTestApp();
    const alice = await ctx.createUser({ email: "lc-m@example.com", password: PASSWORD });
    const a = await seedNote(ctx.db, { ownerId: alice.id }, { title: "A" });
    const host = await seedNote(ctx.db, { ownerId: alice.id }, { title: "Host" });
    await seedOldNote(ctx.db, host.id, `[x](/notes/${a.id})`);
    await ctx.db.insert(noteLinkConversion).values({ noteId: host.id, status: "retry", attempts: 3 });
    const summary = await run(ctx);
    expect(summary.scanned).toBe(0);
    expect(await statusOf(ctx, host.id)).toEqual({ status: "retry", attempts: 3, converted: 0, unresolved: 0 });
    expect(linkHrefs((await loadDoc(ctx.db, host.id))!)).toEqual([`/notes/${a.id}`]);
    expect(await versionsOf(ctx.db, host.id)).toEqual([]);
  });

  it("abort midway: the in-flight note keeps no marker (stays pending), content unchanged", async () => {
    const ctx = await buildCollabTestApp();
    const alice = await ctx.createUser({ email: "lc-x@example.com", password: PASSWORD });
    const a = await seedNote(ctx.db, { ownerId: alice.id }, { title: "A" });
    const host = await seedNote(ctx.db, { ownerId: alice.id }, { title: "Host" });
    await seedOldNote(ctx.db, host.id, `[x](/notes/${a.id})`);
    await pending(ctx, host.id);
    const controller = new AbortController();
    const real = depsOf(ctx);
    const aborting = {
      ...real,
      versions: {
        docFor: real.versions.docFor,
        cutIfDirty: async (...args: Parameters<typeof real.versions.cutIfDirty>) => {
          controller.abort();
          return real.versions.cutIfDirty(...args);
        },
      },
    };
    await run(ctx, aborting, controller.signal);
    expect(await statusOf(ctx, host.id)).toEqual({ status: "pending", attempts: 0, converted: 0, unresolved: 0 });
    expect(wikilinks((await loadDoc(ctx.db, host.id))!)).toEqual([]);
  });

  it("a note created after the migration (no row) is never processed and never gets the pre-conversion version", async () => {
    const ctx = await buildCollabTestApp();
    const alice = await ctx.createUser({ email: "lc-n@example.com", password: PASSWORD });
    const a = await seedNote(ctx.db, { ownerId: alice.id }, { title: "A" });
    const late = await seedNote(ctx.db, { ownerId: alice.id }, { title: "Late" });
    await seedOldNote(ctx.db, late.id, `[x](/notes/${a.id})`);
    const summary = await run(ctx);
    expect(summary.scanned).toBe(0);
    expect(linkHrefs((await loadDoc(ctx.db, late.id))!)).toEqual([`/notes/${a.id}`]);
    expect(await versionsOf(ctx.db, late.id)).toEqual([]);
  });

  it("internal ordinary link to itself -> converted to a self-link wikilink; note_links doesn't write itself; marked done", async () => {
    const ctx = await buildCollabTestApp();
    const alice = await ctx.createUser({ email: "lc-s@example.com", password: PASSWORD });
    const self = await seedNote(ctx.db, { ownerId: alice.id }, { title: "Self", slug: "self" });
    const [{ handle }] = await ctx.db.select({ handle: users.handle }).from(users).where(eq(users.id, alice.id));
    await seedOldNote(ctx.db, self.id, `[top](/notes/${self.id}#b-abc) [me](/n/${handle}/self)`);
    await pending(ctx, self.id);
    await run(ctx);
    expect(wikilinks((await loadDoc(ctx.db, self.id))!).map(w => w.targetNoteId)).toEqual([self.id, self.id]);
    expect(await linksOf(ctx, self.id)).toEqual([]);
    expect(await statusOf(ctx, self.id)).toMatchObject({ status: "done", converted: 2 });
  });

  it("DB error in the version-cutting stage: the real pino output of a single-note failure only has noteId/stage/error class and SQLSTATE, no note text or query params", async () => {
    const ctx = await buildCollabTestApp();
    const alice = await ctx.createUser({ email: "lc-l@example.com", password: PASSWORD });
    const a = await seedNote(ctx.db, { ownerId: alice.id }, { title: "A" });
    const host = await seedNote(ctx.db, { ownerId: alice.id }, { title: "Host" });
    const MARK = "ZQXLEAKMARK7731";
    await seedOldNote(ctx.db, host.id, `${MARK} [x](/notes/${a.id})`);
    await pending(ctx, host.id);
    // Real pino (its default err serializer writes out every enumerable field such as message/params): measures what actually appears in a self-hoster's log.
    const lines: string[] = [];
    const log = pino({ level: "info" }, { write: (s: string) => void lines.push(s) });
    // Make the `note_versions` INSERT for the pre-conversion version blow up: drizzle wraps it in DrizzleQueryError whose params contain the whole ydoc (MARK is plain text).
    await ctx.db.execute(sql`create or replace function knb_lc_boom() returns trigger as $$ begin raise exception 'boom'; end $$ language plpgsql`);
    await ctx.db.execute(sql`create trigger knb_lc_boom_trg before insert on note_versions for each row execute function knb_lc_boom()`);
    try {
      await run(ctx, { ...depsOf(ctx), log });
    } finally {
      await ctx.db.execute(sql`drop trigger if exists knb_lc_boom_trg on note_versions`);
    }
    const out = lines.join("\n");
    expect(out).not.toContain(MARK);
    expect(out).not.toMatch(/Failed query|params/);
    const failed = lines.map(l => JSON.parse(l) as Record<string, unknown>).filter(o => o.msg === "站內連結轉換：單篇失敗");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ noteId: host.id, stage: "version", err: { name: "DrizzleQueryError", code: "P0001" } });
    expect(Object.keys(failed[0]!.err as object).sort()).toEqual(["code", "name"]);
    expect(await statusOf(ctx, host.id)).toMatchObject({ status: "retry", attempts: 1 });
  });
});

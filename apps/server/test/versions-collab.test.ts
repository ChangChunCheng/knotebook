// Version history x real Hocuspocus. Since #272 the only automatic rule is: persist writes pending, the scanner cuts after quiet time X; leaving (unload) cuts nothing.
// This file sets X to 0 and calls `scanDue()` manually. Assertions always say whether they mean an "increment" or a "total".
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT, topLevelContainers } from "@knotebook/shared";
import { notes } from "../src/db/schema.js";
import { EditorSession } from "../src/notes/editing/session.js";
import { versionFingerprint } from "../src/notes/version-fingerprint.js";
import { docText, seedContent, waitFor } from "./editing-helpers.js";
import { buildCollabTestApp, testEditingRuntime } from "./helpers.js";
import { NO_PENDING, pendingOf, seedOldNote, versionsOf, waitForPending } from "./version-helpers.js";

const PASSWORD = "correct-horse-battery";

async function setup(opts: Parameters<typeof buildCollabTestApp>[0] = {}) {
  const ctx = await buildCollabTestApp({ versionAutoWaitMs: 0, ...opts });
  const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
  const note = await ctx.createNote(u.id);
  const session = await ctx.loginAs("a@example.com", PASSWORD);
  const unloaded = () => waitFor("落盤並卸載", 10_000, () => ctx.collab.hocuspocus.documents.size === 0);
  const scan = () => ctx.collab.versions.scanDue();
  return { ctx, u, note, session, unloaded, scan };
}
async function typeInFirst(ctx: Awaited<ReturnType<typeof setup>>["ctx"], noteId: string, doc: Y.Doc, fn: (t: Y.XmlText) => void, sentinel: (s: string) => boolean): Promise<void> {
  const p = topLevelContainers(doc.getXmlFragment(YDOC_FRAGMENT))[0]!.get(0) as Y.XmlElement;
  doc.transact(() => fn(p.get(0) as Y.XmlText));
  await waitFor("server 收到編輯", 5_000, () => sentinel(docText(ctx.collab.hocuspocus.documents.get(noteId)!)));
}

describe("#272: cut when editing stops, not on leaving", () => {
  it("WS edit -> pending after persist, 0 versions now; scan -> +1 version, editors is that user; edit and scan again -> +1 more; scanning after leaving adds none", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "第一段種子文字");
    await waitForPending(s.ctx.db, s.note.id);
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
    await s.scan();
    expect(await versionsOf(s.ctx.db, s.note.id)).toHaveLength(1);
    expect(await pendingOf(s.ctx.db, s.note.id)).toEqual(NO_PENDING);
    await typeInFirst(s.ctx, s.note.id, client.doc, t => t.insert(0, "再改"), x => x.includes("再改"));
    await waitForPending(s.ctx.db, s.note.id);
    await s.scan();
    const rows = await versionsOf(s.ctx.db, s.note.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.editors).toEqual([{ user_id: s.u.id, agent_label: null }]);
    client.disconnect();
    await s.unloaded();
    await s.scan();
    expect(await versionsOf(s.ctx.db, s.note.id)).toHaveLength(2);
  });

  it("all disconnect -> no cut, pending remains; 1 version only after the scan", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "不等五分鐘的內容");
    client.disconnect();
    await s.unloaded();
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
    const p = await pendingOf(s.ctx.db, s.note.id);
    expect(p.at).not.toBeNull();
    expect(p.editors).toEqual([{ user_id: s.u.id, agent_label: null }]);
    await s.scan();
    const rows = await versionsOf(s.ctx.db, s.note.id);
    expect(rows.map(r => [r.seq, r.kind])).toEqual([[1, "auto"]]);
    expect(rows[0]!.editors).toEqual([{ user_id: s.u.id, agent_label: null }]);
  });
});

describe("no versions appear from nothing (WS form; scan after leaving)", () => {
  it("viewer opens an old note then closes -> total 0, nothing pending", async () => {
    const s = await setup();
    await seedOldNote(s.ctx.db, s.note.id, "舊筆記內容");
    const v = await s.ctx.createUser({ email: "v@example.com", password: PASSWORD });
    await s.ctx.share(s.note.id, v.id, "viewer");
    const viewer = await s.ctx.loginAs("v@example.com", PASSWORD);
    const c = await viewer.connect(s.note.id);
    c.disconnect();
    await s.unloaded();
    expect(await pendingOf(s.ctx.db, s.note.id)).toEqual(NO_PENDING);
    await s.scan();
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
  });

  it("editor opens an old note, changes one character, closes -> total 1 after the scan, content is the changed one", async () => {
    const s = await setup();
    await seedOldNote(s.ctx.db, s.note.id, "舊筆記內容");
    const c = await s.session.connect(s.note.id);
    await typeInFirst(s.ctx, s.note.id, c.doc, t => t.insert(0, "新"), x => x.includes("新舊筆記內容"));
    const after = versionFingerprint(s.ctx.collab.hocuspocus.documents.get(s.note.id)!.getXmlFragment(YDOC_FRAGMENT));
    c.disconnect();
    await s.unloaded();
    await s.scan();
    const rows = await versionsOf(s.ctx.db, s.note.id);
    expect(rows).toHaveLength(1);
    const v1 = new Y.Doc();
    Y.applyUpdate(v1, rows[0]!.ydoc);
    expect(versionFingerprint(v1.getXmlFragment(YDOC_FRAGMENT))).toBe(after);
  });

  it("editor opens an old note, types one character and deletes it, closes -> total 0 after the scan, pending cleared", async () => {
    const s = await setup();
    await seedOldNote(s.ctx.db, s.note.id, "舊筆記內容");
    const c = await s.session.connect(s.note.id);
    await typeInFirst(s.ctx, s.note.id, c.doc, t => t.insert(0, "Ω"), x => x.includes("Ω"));
    await typeInFirst(s.ctx, s.note.id, c.doc, t => t.delete(0, 1), x => !x.includes("Ω"));
    c.disconnect();
    await s.unloaded();
    await s.scan();
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
    expect(await pendingOf(s.ctx.db, s.note.id)).toEqual(NO_PENDING);
  });

  it("WS client opens a vacuum note, writes back one empty paragraph (the shape a browser normalizes on mount), disconnects -> nothing pending, total 0 after the scan", async () => {
    const s = await setup();
    const c = await s.session.connect(s.note.id);
    // The server-side headless EditorSession only mounts and does not write back (after mount the client fragment is still empty), so this writes "one empty paragraph with
    // default attributes" explicitly - the shape a browser normalizes back when opening a vacuum note.
    const ed = await EditorSession.open(testEditingRuntime, c.doc);
    try {
      ed.editor.replaceBlocks(ed.editor.document, [{ type: "paragraph" }]);
    } finally {
      ed.close();
    }
    await waitFor("server 收到正規化段落", 5_000, () => topLevelContainers(s.ctx.collab.hocuspocus.documents.get(s.note.id)!.getXmlFragment(YDOC_FRAGMENT)).length === 1);
    c.disconnect();
    await s.unloaded();
    expect(await pendingOf(s.ctx.db, s.note.id)).toEqual(NO_PENDING);
    await s.scan();
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
  });

  it("open a vacuum note, type one character and delete it, disconnect -> total 0 after the scan", async () => {
    const s = await setup();
    const c = await seedContent(s.ctx, s.session, s.note.id, "Ω");
    await typeInFirst(s.ctx, s.note.id, c.doc, t => t.delete(0, t.length), x => !x.includes("Ω"));
    c.disconnect();
    await s.unloaded();
    await s.scan();
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
  });
});

describe("note deleted while pending", () => {
  it("the scan skips quietly: no error-level log, zero rows (CASCADE), the document unloads as usual", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "會被刪掉的筆記內容");
    await waitForPending(s.ctx.db, s.note.id);
    await s.ctx.db.delete(notes).where(eq(notes.id, s.note.id));
    expect(await s.scan()).toBe(0);
    client.disconnect();
    await s.unloaded();
    expect(s.ctx.collabLogs.filter(l => l.level === "error")).toEqual([]);
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
  });
});

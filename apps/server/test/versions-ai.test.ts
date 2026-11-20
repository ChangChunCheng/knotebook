// Version history x AI/MCP/REST writes (#272: before and after an AI or direct write no cut is made immediately, only pending is recorded; the scanner cuts after quiet time X -
// a human and the AI in the same quiet period end up in the same version). This file's harness sets X to 0 and calls `scanDue()` manually for every scan.
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT, topLevelBlocks } from "@knotebook/shared";
import { noteAiEdits, notes, users } from "../src/db/schema.js";
import { directTarget, withDirectConnection, type DirectCtx } from "../src/notes/editing/session.js";
import { VACUUM_VERSION_FINGERPRINT } from "../src/notes/version-fingerprint.js";
import { bearer, docText, getContent, seedContent, seedTokenForUser, waitFor } from "./editing-helpers.js";
import { buildCollabTestApp, type CollabTestCtx, type TestClient } from "./helpers.js";
import { NO_PENDING, pendingOf, seedOldNote, versionsOf, waitForPending } from "./version-helpers.js";

const PASSWORD = "correct-horse-battery";
const LABEL_TOKEN = "Claude Code (knotebook)";

async function setup() {
  const ctx = await buildCollabTestApp({ versionAutoWaitMs: 0 });
  const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
  const note = await ctx.createNote(u.id);
  const session = await ctx.loginAs("a@example.com", PASSWORD);
  const { token } = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write", LABEL_TOKEN);
  const content = async () => (await getContent(ctx.app, note.id, token)).json();
  const edit = (body: Record<string, unknown>) => ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(token), payload: body });
  const unloaded = () => waitFor("落盤並卸載", 10_000, () => ctx.collab.hocuspocus.documents.size === 0);
  const scan = () => ctx.collab.versions.scanDue();
  return { ctx, u, note, session, token, content, edit, unloaded, scan };
}
const human = (userId: string) => ({ user_id: userId, agent_label: null });
const hasAgent = (userId: string) => (e: { user_id: string; agent_label: string | null }) => e.user_id === userId && e.agent_label !== null;

async function typeFirst(ctx: CollabTestCtx, noteId: string, client: TestClient, fn: (t: Y.XmlText) => void, until: (s: string) => boolean): Promise<void> {
  const p = topLevelBlocks(client.doc.getXmlFragment(YDOC_FRAGMENT))[0]!.get(0) as Y.XmlElement;
  client.doc.transact(() => fn(p.get(0) as Y.XmlText));
  await waitFor("server 收到", 5_000, () => until(docText(ctx.collab.hocuspocus.documents.get(noteId)!)));
}

describe("#272: AI writes no longer cut a version at once", () => {
  it("human unsaved + AI write -> 0 versions right now; after leaving and scanning -> 1 version, human and AI in the same one, content has both sides (a cut before the write would add one more)", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "人打的未存內容");
    expect((await s.edit({ op: "append", markdown: "AI 加的一段" })).statusCode).toBe(201);
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
    const p = await waitForPending(s.ctx.db, s.note.id, x => x.editors.some(hasAgent(s.u.id)));
    expect(p.editors).toContainEqual(human(s.u.id));
    client.disconnect();
    await s.unloaded();
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
    await s.scan();
    const rows = await versionsOf(s.ctx.db, s.note.id);
    expect(rows.map(r => [r.seq, r.kind])).toEqual([[1, "auto"]]);
    expect(rows[0]!.editors).toContainEqual(human(s.u.id));
    expect(rows[0]!.editors.some(hasAgent(s.u.id))).toBe(true);
    const v1 = new Y.Doc();
    Y.applyUpdate(v1, rows[0]!.ydoc);
    expect(docText(v1)).toContain("人打的未存內容");
    expect(docText(v1)).toContain("AI 加的一段");
  });

  it("already saved manually, then an AI write -> no new version now; +1 after the scan, editors has only the AI (a person who did not edit after the save is not on the list)", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "先存起來的內容");
    await waitForPending(s.ctx.db, s.note.id); // write the seed batch's persists into pending first, then save manually (saving clears pending)
    const live = s.ctx.collab.hocuspocus.documents.get(s.note.id)!;
    await s.ctx.collab.versions.cutIfDirty(s.note.id, live, { kind: "manual" });
    expect(await versionsOf(s.ctx.db, s.note.id)).toHaveLength(1);
    expect(await pendingOf(s.ctx.db, s.note.id)).toEqual(NO_PENDING);
    expect((await s.edit({ op: "append", markdown: "AI 第二段" })).statusCode).toBe(201);
    expect(await versionsOf(s.ctx.db, s.note.id)).toHaveLength(1);
    await waitForPending(s.ctx.db, s.note.id);
    await s.scan();
    const rows = await versionsOf(s.ctx.db, s.note.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.editors).toHaveLength(1);
    expect(rows[1]!.editors.every(hasAgent(s.u.id))).toBe(true);
    client.disconnect();
  });

  it("an old note with no base, written straight into note_states, gets an AI direct-connection write (nobody has it open) -> 0 versions now; after the scan 1 version, editors has only the AI", async () => {
    const s = await setup();
    await seedOldNote(s.ctx.db, s.note.id, "功能上線前就有的筆記");
    expect((await s.edit({ op: "append", markdown: "AI 補一段" })).statusCode).toBe(201);
    await s.unloaded();
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
    await s.scan();
    const rows = await versionsOf(s.ctx.db, s.note.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.editors).toHaveLength(1);
    expect(rows[0]!.editors[0]!.agent_label).not.toBeNull();
  });

  it("a rejected write (if_match mismatch) cuts no version and the AI does not enter the pending list", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "人打的未存內容");
    const res = await s.edit({ op: "replace_all", markdown: "x", if_match: "0000000000000000" });
    expect(res.statusCode).toBe(409);
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
    const p = await waitForPending(s.ctx.db, s.note.id);
    expect(p.editors).toEqual([human(s.u.id)]);
    client.disconnect();
  });

  it("auto-save off (personal space) -> an AI write leaves nothing pending, the scan gives 0 versions", async () => {
    const s = await setup();
    await s.ctx.db.update(users).set({ autoVersions: false }).where(eq(users.id, s.u.id));
    const client = await seedContent(s.ctx, s.session, s.note.id, "人打的未存內容");
    expect((await s.edit({ op: "append", markdown: "AI" })).statusCode).toBe(201);
    client.disconnect();
    await s.unloaded();
    expect(await pendingOf(s.ctx.db, s.note.id)).toEqual(NO_PENDING);
    await s.scan();
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
  });
});

describe("create_note with content", () => {
  it("POST /api/notes with content (token) -> 0 versions now, pending reference fingerprint = vacuum; after the scan 1 version, editors has only the AI", async () => {
    const s = await setup();
    const res = await s.ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(s.token), payload: { title: "新", content: "AI 建的筆記內容" } });
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    await s.unloaded();
    expect(await versionsOf(s.ctx.db, id)).toEqual([]);
    expect((await pendingOf(s.ctx.db, id)).ref).toBe(VACUUM_VERSION_FINGERPRINT);
    await s.scan();
    const rows = await versionsOf(s.ctx.db, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.editors).toHaveLength(1);
    expect(rows[0]!.editors[0]!.agent_label).not.toBeNull();
  });
});

describe("editor attribution", () => {
  it("a person editing over WS (the result of selecting an AI box takes this path too) + cookie POST /edits -> after the scan the version's editors is only {user_id, agent_label: null}", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "人在瀏覽器打的");
    const res = await s.session.fetch(`/api/notes/${s.note.id}/edits`, { method: "POST", body: JSON.stringify({ op: "append", markdown: "cookie 直寫的一段" }) });
    expect(res.status).toBe(201);
    client.disconnect();
    await s.unloaded();
    await s.scan();
    const rows = await versionsOf(s.ctx.db, s.note.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.editors).toEqual([human(s.u.id)]);
  });

  it("PAT POST /edits (token has an agent name) -> after the scan editors contains {user_id, agent_label} (the same agent name this write recorded)", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "人打的");
    expect((await s.edit({ op: "append", markdown: "PAT 寫的" })).statusCode).toBe(201);
    const [rec] = await s.ctx.db.select({ label: noteAiEdits.agentLabel }).from(noteAiEdits).where(eq(noteAiEdits.noteId, s.note.id));
    expect(rec!.label).not.toBeNull();
    client.disconnect();
    await s.unloaded();
    await s.scan();
    const rows = await versionsOf(s.ctx.db, s.note.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.editors).toHaveLength(2);
    expect(rows[0]!.editors).toContainEqual(human(s.u.id));
    expect(rows[0]!.editors).toContainEqual({ user_id: s.u.id, agent_label: rec!.label });
  });
});

describe("AI edit log unchanged", () => {
  it("reverting an AI edit while a human change is pending -> no new version now; there is an op='revert' row and the original row has reverted_at; pending editors gains the reverter", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "撤回測試原文");
    const ai = await s.edit({ op: "append", markdown: "AI 這段會被撤回" });
    expect(ai.statusCode).toBe(201);
    const editId = ai.json().editId as string;
    await waitForPending(s.ctx.db, s.note.id, x => x.editors.some(hasAgent(s.u.id)));
    await s.scan();
    expect(await versionsOf(s.ctx.db, s.note.id)).toHaveLength(1);
    await typeFirst(s.ctx, s.note.id, client, t => t.insert(0, "人又改"), x => x.includes("人又改"));
    await waitForPending(s.ctx.db, s.note.id, x => x.editors.length === 1);
    expect((await pendingOf(s.ctx.db, s.note.id)).editors).toEqual([human(s.u.id)]);
    const rv = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits/${editId}/revert`, headers: bearer(s.token) });
    expect(rv.statusCode).toBe(201);
    expect(await versionsOf(s.ctx.db, s.note.id)).toHaveLength(1);
    const recs = await s.ctx.db.select({ id: noteAiEdits.id, op: noteAiEdits.op, revertedAt: noteAiEdits.revertedAt }).from(noteAiEdits).where(eq(noteAiEdits.noteId, s.note.id));
    expect(recs.filter(r => r.op === "revert")).toHaveLength(1);
    expect(recs.find(r => r.id === editId)!.revertedAt).not.toBeNull();
    const p = await waitForPending(s.ctx.db, s.note.id, x => x.editors.some(hasAgent(s.u.id)));
    expect(p.editors).toHaveLength(2);
    expect(p.editors[0]).toEqual(human(s.u.id));
    expect(p.editors[1]).toMatchObject({ user_id: s.u.id });
    expect(p.editors[1]!.agent_label).not.toBeNull();
    client.disconnect();
  });
});

describe("attribution gate: direct connections always look at applied", () => {
  it("version-apply: applied=false does not attribute; applied=true attributes the person, token and agent label are null", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "落款測試內容");
    const lastAt = async () => (await s.ctx.db.select({ at: notes.lastEditedAt }).from(notes).where(eq(notes.id, s.note.id)))[0]!.at;
    // Wait first for the seed batch's debounced store to be attributed (2 s) - otherwise it could land between the two reads below and turn "no attribution" into "attributed".
    await expect.poll(async () => (await lastAt()) !== null, { timeout: 10_000 }).toBe(true);
    const before = await lastAt();
    const ctx: DirectCtx = { source: "version-apply", userId: s.u.id, tokenId: null, agentLabel: null, applied: false };
    await withDirectConnection(directTarget(s.ctx.collab, s.ctx.db), s.note.id, ctx, () => undefined);
    expect(await lastAt()).toEqual(before);
    const ok: DirectCtx = { ...ctx, applied: true };
    await withDirectConnection(directTarget(s.ctx.collab, s.ctx.db), s.note.id, ok, () => undefined);
    const [row] = await s.ctx.db
      .select({ by: notes.lastEditedBy, tokenId: notes.lastEditedTokenId, label: notes.lastEditedAgentLabel })
      .from(notes)
      .where(eq(notes.id, s.note.id));
    expect(row).toEqual({ by: s.u.id, tokenId: null, label: null });
    client.disconnect();
  });

  it("beforeDisconnect runs after transact succeeds and before disconnect, receiving fn's return value; it does not run when fn throws", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "鉤子順序內容");
    const order: string[] = [];
    const ctx: DirectCtx = { source: "version-apply", userId: s.u.id, tokenId: null, agentLabel: null, applied: false };
    // Assertions inside the hook are swallowed by withDirectConnection (only logged), so only record here and assert afterwards.
    await withDirectConnection(directTarget(s.ctx.collab, s.ctx.db), s.note.id, ctx, () => 42, {
      beforeDisconnect: async r => {
        order.push(`bd:${r}:loaded=${s.ctx.collab.hocuspocus.documents.has(s.note.id)}`);
      },
    });
    expect(order).toEqual(["bd:42:loaded=true"]);
    await expect(withDirectConnection(directTarget(s.ctx.collab, s.ctx.db), s.note.id, ctx, () => { throw new Error("boom"); }, {
      beforeDisconnect: async () => { order.push("不該跑"); },
    })).rejects.toThrow("boom");
    expect(order).toEqual(["bd:42:loaded=true"]);
    client.disconnect();
  });
});

describe("guards after the split", () => {
  it("applyEdit's afterBlockIds/fingerprint behaviour unchanged (the fingerprint read after the write equals the reply)", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "# A\n\n第一段");
    const c = await s.content();
    const res = await s.edit({ op: "replace_all", markdown: "# B\n\n新內容", if_match: c.fingerprint });
    expect(res.statusCode).toBe(201);
    await waitFor("provider 收到", 3_000, () => docText(client.doc).includes("新內容"));
    expect((await s.content()).fingerprint).toBe(res.json().fingerprint);
    expect(topLevelBlocks(client.doc.getXmlFragment(YDOC_FRAGMENT)).length).toBeGreaterThan(0);
    client.disconnect();
  });
});

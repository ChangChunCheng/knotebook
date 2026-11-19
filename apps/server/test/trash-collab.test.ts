// Always wired to real hooks (`createCollabHooks`): the default noop hooks' DELETE opens no gate, kicks no connection, and restore does not release the gate.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { COLLAB_CLOSE_NOTE_DELETED, YDOC_FRAGMENT, type NoteDto } from "@knotebook/shared";
import { createCollabHooks } from "../src/collab/hooks-impl.js";
import { COLLAB_REJECT_FORBIDDEN, COLLAB_REJECT_NOTE_DELETING } from "../src/collab/server.js";
import { EditorSession } from "../src/notes/editing/session.js";
import { getContent, seedTokenForUser, waitFor } from "./editing-helpers.js";
import { buildCollabTestApp, testEditingRuntime, type CollabTestCtx } from "./helpers.js";
import { trashCols } from "./trash-helpers.js";

const PASSWORD = "correct-horse-battery";

function buildApp(): Promise<CollabTestCtx> {
  return buildCollabTestApp({ collabHooks: (server, log) => createCollabHooks(server, log) });
}

function insertParagraph(doc: Y.Doc, text: string): void {
  const element = new Y.XmlElement("paragraph");
  element.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [element]);
}

async function noteStateHas(ctx: CollabTestCtx, noteId: string, text: string): Promise<boolean> {
  const { rows } = await ctx.db.$client.query<{ ydoc: Buffer }>(`select ydoc from note_states where note_id = $1`, [noteId]);
  if (!rows[0]) return false;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, rows[0].ydoc);
  return doc.getXmlFragment(YDOC_FRAGMENT).toString().includes(text);
}

describe("#181 collab and trash", () => {
  it("move to trash kicks connections (CLOSE note-deleted); a new connection within the TTL is refused with note-deleting; after the gate expires it is refused with forbidden", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-cl1@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("owner-cl1@example.com", PASSWORD);
    const client = await session.connect(note.id);

    const del = await session.fetch(`/api/notes/${note.id}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    await waitFor("在線者收到 CLOSE(note-deleted)", 10_000, () => client.closes.some(c => c.reason === COLLAB_CLOSE_NOTE_DELETED));
    expect(ctx.collab.connectionsOfNote(note.id).size).toBe(0);
    expect((await trashCols(ctx.db.$client, note.id))?.deleted_at).not.toBeNull();

    await expect(session.connect(note.id)).rejects.toThrow(COLLAB_REJECT_NOTE_DELETING);
    ctx.collab.unmarkDeleting(note.id); // simulates TTL expiry
    await expect(session.connect(note.id)).rejects.toThrow(COLLAB_REJECT_FORBIDDEN);
  });

  it("move to trash -> restore -> connects and syncs at once (the gate is released by onNotesRestored, no TTL wait)", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-cl2@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("owner-cl2@example.com", PASSWORD);

    expect((await session.fetch(`/api/notes/${note.id}`, { method: "DELETE" })).status).toBe(204);
    expect(ctx.collab.isDeleting(note.id)).toBe(true);
    const res = await session.fetch("/api/trash/restore", { method: "POST", body: JSON.stringify({ ids: [note.id] }) });
    expect(res.status).toBe(200);
    expect(ctx.collab.isDeleting(note.id)).toBe(false);

    const a = await session.connect(note.id);
    const b = await session.connect(note.id);
    insertParagraph(a.doc, "CL2 還原後的字");
    await waitFor("另一端收到", 10_000, () => b.doc.getXmlFragment(YDOC_FRAGMENT).toString().includes("CL2 還原後的字"));
  });

  it("after move to trash, a direct connection writes and persists -> no throw, note_states has that text, still in trash, not in the list; after restore /content reads it", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-cl3@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("owner-cl3@example.com", PASSWORD);
    expect((await session.fetch(`/api/notes/${note.id}`, { method: "DELETE" })).status).toBe(204);

    const TEXT = "CL3 落盤進垃圾桶筆記的字";
    const src = new Y.Doc();
    const s = await EditorSession.open(testEditingRuntime, src);
    try {
      s.editor.replaceBlocks(s.editor.document, [{ type: "paragraph", content: TEXT }]);
    } finally {
      s.close();
    }
    // The test opens the connection directly (bypassing withDirectConnection's re-confirmation): simulates a store arriving sporadically after the gate.
    const direct = await ctx.collab.hocuspocus.openDirectConnection(note.id, { userId: owner.id });
    await direct.transact(doc => {
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(src));
    });
    await expect(direct.disconnect()).resolves.toBeUndefined();

    expect(await noteStateHas(ctx, note.id, TEXT)).toBe(true);
    expect((await trashCols(ctx.db.$client, note.id))?.deleted_at).not.toBeNull();
    const list = (await (await session.fetch("/api/notes")).json()) as NoteDto[];
    expect(list.map(n => n.id)).not.toContain(note.id);

    const res = await session.fetch("/api/trash/restore", { method: "POST", body: JSON.stringify({ ids: [note.id] }) });
    expect(res.status).toBe(200);
    const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read");
    const content = await getContent(ctx.app, note.id, token);
    expect(content.statusCode, content.body).toBe(200);
    expect(content.body).toContain(TEXT);
  });
});

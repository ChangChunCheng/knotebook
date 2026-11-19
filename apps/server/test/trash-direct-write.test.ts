// Re-confirmation of direct-connection writes is centralized in `withDirectConnection`: if the gate is open or the note is already in trash it throws
// `NoteGoneError`, and does so before opening the direct connection (the document is not loaded back into memory). Real hooks (`createCollabHooks`; the
// default noop hooks open no gate, see `noopCollabHooks` in `test/helpers.ts`). The third case verifies the premise the re-confirmation relies on: the unload
// polling of a move to trash waits while a direct connection holds the document, and the move commits only after the write has persisted.
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { Document } from "@hocuspocus/server";
import { createCollabHooks } from "../src/collab/hooks-impl.js";
import { NoteGoneError, directTarget, withDirectConnection, type DirectCtx } from "../src/notes/editing/session.js";
import { loadDoc } from "./copy-helpers.js";
import { sleep } from "./group-helpers.js";
import { buildCollabTestApp, type CollabTestCtx } from "./helpers.js";
import { markRestored, markTrashed, trashCols } from "./trash-helpers.js";

const PASSWORD = "correct-horse-battery";

function buildApp(): Promise<CollabTestCtx> {
  return buildCollabTestApp({ collabHooks: (server, log) => createCollabHooks(server, log) });
}

async function setup(email: string) {
  const ctx = await buildApp();
  const u = await ctx.createUser({ email, password: PASSWORD });
  const note = await ctx.createNote(u.id);
  const aiCtx: DirectCtx = { source: "ai-edit", userId: u.id, tokenId: null, agentLabel: null, applied: false };
  const open = vi.spyOn(ctx.collab.hocuspocus, "openDirectConnection");
  return { ctx, u, note, aiCtx, open };
}

async function stateOf(pool: Pool, noteId: string): Promise<{ ydoc: string; version: number } | undefined> {
  const { rows } = await pool.query<{ ydoc: string; version: number }>(
    `select encode(ydoc, 'hex') as ydoc, version from note_states where note_id = $1`,
    [noteId],
  );
  return rows[0];
}

/** A function that changes the document: if the re-confirmation failed to block, disconnect would persist this. */
const write = (doc: Document): string => {
  doc.getMap("dw").set("k", "v");
  return "written";
};

describe("#181 re-confirmation of direct-connection writes", () => {
  it("gate already open -> NoteGoneError, note_states unchanged, no direct connection opened", async () => {
    const { ctx, note, aiCtx, open } = await setup("dw1@example.com");
    const before = await stateOf(ctx.db.$client, note.id);

    await ctx.collab.markDeleting(note.id);
    await expect(withDirectConnection(directTarget(ctx.collab, ctx.db), note.id, aiCtx, write)).rejects.toBeInstanceOf(NoteGoneError);

    expect(open).not.toHaveBeenCalled();
    expect(await stateOf(ctx.db.$client, note.id)).toEqual(before);
  });

  it("already in trash -> NoteGoneError, note_states unchanged, no direct connection opened; after restore writes work as usual", async () => {
    const { ctx, u, note, aiCtx, open } = await setup("dw2@example.com");
    const before = await stateOf(ctx.db.$client, note.id);

    await markTrashed(ctx.db.$client, note.id, u.id);
    await expect(withDirectConnection(directTarget(ctx.collab, ctx.db), note.id, aiCtx, write)).rejects.toBeInstanceOf(NoteGoneError);

    expect(open).not.toHaveBeenCalled();
    expect(await stateOf(ctx.db.$client, note.id)).toEqual(before);

    // Control: the spy is really attached to the production hocuspocus (otherwise 'not called' above is vacuously true).
    await markRestored(ctx.db.$client, note.id);
    await expect(withDirectConnection(directTarget(ctx.collab, ctx.db), note.id, aiCtx, write)).resolves.toBe("written");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("a move started while a direct connection holds the document -> the move commits only after this write has persisted (the premise the re-confirmation relies on)", async () => {
    const { ctx, note, aiCtx } = await setup("dw3@example.com");
    const session = await ctx.loginAs("dw3@example.com", PASSWORD);
    const TEXT = "DW3 直連持有中寫入的字";
    let del: Promise<Response> | undefined;
    let seenDuring: Awaited<ReturnType<typeof trashCols>>;

    const out = await withDirectConnection(
      directTarget(ctx.collab, ctx.db),
      note.id,
      aiCtx,
      doc => {
        doc.getText("dw3").insert(0, TEXT);
        return "written";
      },
      {
        beforeDisconnect: async () => {
          del = session.fetch(`/api/notes/${note.id}`, { method: "DELETE" });
          await sleep(800);
          seenDuring = await trashCols(ctx.db.$client, note.id);
        },
      },
    );

    // The premise itself: the move did not commit while the direct connection held the document - the unload polling is waiting for it.
    expect(seenDuring!.deleted_at).toBeNull();
    expect(out).toBe("written");
    expect((await del!).status).toBe(204);
    expect((await trashCols(ctx.db.$client, note.id))?.deleted_at).not.toBeNull();
    expect((await loadDoc(ctx.db, note.id))!.getText("dw3").toString()).toBe(TEXT);
  });
});

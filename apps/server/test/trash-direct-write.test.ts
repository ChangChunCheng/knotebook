// #181 §6.2-11（M-B）：直連寫入的重確認統一在 `withDirectConnection`——閘門開著或筆記已在垃圾桶就丟
// `NoteGoneError`，而且在開直連之前就擋（不把文件載回記憶體）。真 hooks（`createCollabHooks`；預設 noop hooks 不開閘門，見 `test/helpers.ts` 的 `noopCollabHooks`）。
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { Document } from "@hocuspocus/server";
import { createCollabHooks } from "../src/collab/hooks-impl.js";
import { NoteGoneError, directTarget, withDirectConnection, type DirectCtx } from "../src/notes/editing/session.js";
import { buildCollabTestApp, type CollabTestCtx } from "./helpers.js";
import { markRestored, markTrashed } from "./trash-helpers.js";

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

/** `note_states` 該篇的現值（沒有列 → undefined）。 */
async function stateOf(pool: Pool, noteId: string): Promise<{ ydoc: string; version: number } | undefined> {
  const { rows } = await pool.query<{ ydoc: string; version: number }>(
    `select encode(ydoc, 'hex') as ydoc, version from note_states where note_id = $1`,
    [noteId],
  );
  return rows[0];
}

/** 會改動文件的 fn：重確認沒擋住時，disconnect 會把這筆落盤。 */
const write = (doc: Document): string => {
  doc.getMap("dw").set("k", "v");
  return "written";
};

describe("#181 直連寫入的重確認", () => {
  it("DW1：閘門已開 → NoteGoneError，note_states 不變、未開直連", async () => {
    const { ctx, note, aiCtx, open } = await setup("dw1@example.com");
    const before = await stateOf(ctx.db.$client, note.id);

    await ctx.collab.markDeleting(note.id);
    await expect(withDirectConnection(directTarget(ctx.collab, ctx.db), note.id, aiCtx, write)).rejects.toBeInstanceOf(NoteGoneError);

    expect(open).not.toHaveBeenCalled();
    expect(await stateOf(ctx.db.$client, note.id)).toEqual(before);
  });

  it("DW2：已在垃圾桶 → NoteGoneError，note_states 不變、未開直連；還原後照常寫入", async () => {
    const { ctx, u, note, aiCtx, open } = await setup("dw2@example.com");
    const before = await stateOf(ctx.db.$client, note.id);

    await markTrashed(ctx.db.$client, note.id, u.id);
    await expect(withDirectConnection(directTarget(ctx.collab, ctx.db), note.id, aiCtx, write)).rejects.toBeInstanceOf(NoteGoneError);

    expect(open).not.toHaveBeenCalled();
    expect(await stateOf(ctx.db.$client, note.id)).toEqual(before);

    // 對照：spy 確實掛在生產用的那顆 hocuspocus 上（否則上面的「未呼叫」恆真）。
    await markRestored(ctx.db.$client, note.id);
    await expect(withDirectConnection(directTarget(ctx.collab, ctx.db), note.id, aiCtx, write)).resolves.toBe("written");
    expect(open).toHaveBeenCalledTimes(1);
  });
});

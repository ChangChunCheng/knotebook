/**
 * `DELETE /api/notes/:id` moves the note to the trash: `trashNotesInTx` takes `FOR UPDATE` on the note row first, while the upload
 * transaction (`insertUploadInTx`) reads the note with `SELECT ... WHERE deleted_at IS NULL FOR KEY SHARE`, which conflicts with it ->
 * it waits for the trashing to commit, re-evaluates the condition, reads 0 rows -> TxAbort 404 not_found (the route unlinks the file first).
 * Trashing doesn't delete uploads, so the "orphan file" shape only remains for permanent deletion (a trashed note can't be uploaded to anyway: authorization is none).
 */
import { readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Pool } from "pg";
import { notes, uploads } from "../src/db/schema.js";
import { buildTestApp } from "./helpers.js";
import { cookieOf, seedNote, seedUser, sleep, spyCollabHooks } from "./group-helpers.js";
import { PNG, seedUpload } from "./copy-helpers.js";

const BOUNDARY = "kbNoteDeleteRaceBoundary";
function pngMultipart(): Buffer {
  return Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`, "utf-8"),
    PNG,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`, "utf-8"),
  ]);
}
const upload = async (app: FastifyInstance, noteId: string, userId: string) =>
  app.inject({
    method: "POST",
    url: `/api/notes/${noteId}/uploads`,
    cookies: await cookieOf(userId),
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    payload: pngMultipart(),
  });

/** Waits until at least `n` connections are waiting on locks on this test DB, or `other` has finished (same as `waitForWaiters` in groups-v2-delete-race.test.ts). */
async function waitForWaiters(pool: Pool, n: number, other?: Promise<unknown>, timeoutMs = 5_000): Promise<"blocked" | "settled"> {
  let settled = false;
  void other?.then(() => { settled = true; }, () => { settled = true; });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (settled) return "settled";
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (rows[0]!.n >= n) return "blocked";
    await sleep(20);
  }
  throw new Error(`waitForWaiters(${n}) 逾時（${timeoutMs}ms）`);
}

describe("#188 single delete x upload", () => {
  it("single DELETE (trash) holding the note's FOR UPDATE while an upload targets the same note -> the upload's note KEY SHARE read waits for the trashing to commit -> trashing 204, upload 404 not_found (0 rows read -> TxAbort, route already unlinked); uploads keeps only the original row, no orphan file on disk", async () => {
    // Hold the trashing transaction at "has the note FOR UPDATE, UPDATE not yet run" (`note-trash-locked` hook) and fire the upload in
    // that window: its authorization is outside the transaction and passes because the note is still alive; the in-transaction
    // `FOR KEY SHARE` read conflicts with FOR UPDATE, so after the trashing commits `deleted_at IS NULL` fails -> 404.
    // The hook does not wait for the upload to finish (it is waiting for this transaction's lock), only for it to reach the lock wait.
    // Without FOR UPDATE in `trashNotesInTx` the interleave assertion fails (the upload isn't blocked and settles).
    const holder: { app?: FastifyInstance; pool?: Pool; noteId?: string; userId?: string; up?: Promise<LightMyRequestResponse>; interleave?: string } = {};
    const { app, db, uploadsDir } = await buildTestApp({
      collabHooks: spyCollabHooks(),
      groupTestHook: async point => {
        if (point !== "note-trash-locked" || holder.up) return;
        holder.up = upload(holder.app!, holder.noteId!, holder.userId!);
        holder.interleave = await waitForWaiters(holder.pool!, 1, holder.up);
      },
    });
    const pool = db.$client;
    const a = await seedUser(db);
    const n = await seedNote(db, { ownerId: a.id });
    const u0 = await seedUpload(db, uploadsDir, n.id, a.id);
    Object.assign(holder, { app, pool, noteId: n.id, userId: a.id });

    const delRes = await app.inject({ method: "DELETE", url: `/api/notes/${n.id}`, cookies: await cookieOf(a.id) });
    const upRes = await holder.up!;

    expect(holder.interleave).toBe("blocked");
    expect(delRes.statusCode).toBe(204);
    expect(upRes.statusCode).toBe(404);
    // Byte-identical to the 404 for a note that never existed (same shape as the 404 case in uploads.test.ts).
    const missing = await upload(app, "22222222-2222-2222-2222-222222222222", a.id);
    expect(missing.statusCode).toBe(404);
    expect(upRes.body).toBe(missing.body);
    expect((await db.select({ deletedAt: notes.deletedAt }).from(notes))[0]?.deletedAt).not.toBeNull();
    expect((await db.select({ id: uploads.id }).from(uploads)).map(r => r.id)).toEqual([u0]);
    expect(await readdir(uploadsDir)).toEqual([u0]);
  });
});

/** The hook is called directly (the routes' call sites are verified by the spy test and the end-to-end kick test). */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { COLLAB_CLOSE_REVOKED } from "@knotebook/shared";
import type { CollabHooks } from "../src/collab/hooks.js";
import { createCollabHooks, REVERIFY_DEADLINE_MS } from "../src/collab/hooks-impl.js";
import { noteShares } from "../src/db/schema.js";
import { buildCollabTestApp } from "./helpers.js";

const PASSWORD = "correct-horse-battery";

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(label: string, timeoutMs: number, check: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(25);
  }
  throw new Error(`等待逾時（${timeoutMs}ms）：${label}`);
}

describe("#103 CollabHooks.onGroupAccessChanged", () => {
  it("revalidates only the intersection of noteIds x userIds: wrong note or wrong person are untouched; only the named people are revalidated and closed", async () => {
    let hooks!: CollabHooks;
    const ctx = await buildCollabTestApp({ collabHooks: (server, log) => (hooks = createCollabHooks(server, log)) });
    const owner = await ctx.createUser({ email: "owner-gh1@example.com", password: PASSWORD });
    const a = await ctx.createUser({ email: "a-gh1@example.com", password: PASSWORD });
    const b = await ctx.createUser({ email: "b-gh1@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const other = await ctx.createNote(owner.id);
    await ctx.share(note.id, a.id, "editor");
    await ctx.share(note.id, b.id, "editor");
    const aClient = await (await ctx.loginAs("a-gh1@example.com", PASSWORD)).connect(note.id);
    const bClient = await (await ctx.loginAs("b-gh1@example.com", PASSWORD)).connect(note.id);

    // Delete DB rows directly (bypassing routes, triggering no hook): both people have no role now, only the named person gets revalidated.
    await ctx.db.delete(noteShares).where(eq(noteShares.noteId, note.id));
    hooks.onGroupAccessChanged([other.id], [a.id]); // wrong note
    hooks.onGroupAccessChanged([note.id], [owner.id]); // wrong person (owner has no connection)
    await sleep(REVERIFY_DEADLINE_MS + 1_000);
    expect(aClient.closes).toEqual([]);
    expect(bClient.closes).toEqual([]);

    hooks.onGroupAccessChanged([note.id, note.id], [a.id]);
    await waitFor("a 被 close(knotebook:revoked)", 10_000, () => aClient.closes.some(c => c.reason === COLLAB_CLOSE_REVOKED));
    await sleep(REVERIFY_DEADLINE_MS + 1_000);
    expect(bClient.closes).toEqual([]);
  });

  it("empty lists and nonexistent ids don't throw", async () => {
    let hooks!: CollabHooks;
    await buildCollabTestApp({ collabHooks: (server, log) => (hooks = createCollabHooks(server, log)) });
    expect(() => hooks.onGroupAccessChanged([], [])).not.toThrow();
    expect(() => hooks.onGroupAccessChanged([randomUUID()], [randomUUID()])).not.toThrow();
  });
});

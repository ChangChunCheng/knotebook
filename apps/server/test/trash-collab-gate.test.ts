import { describe, expect, it } from "vitest";
import { createCollabHooks } from "../src/collab/hooks-impl.js";
import { buildCollabTestApp, type CollabTestCtx } from "./helpers.js";
import { markTrashed } from "./trash-helpers.js";

const PASSWORD = "correct-horse-battery";

// Real hooks, although these two cases only call `ctx.collab` directly.
function buildApp(): Promise<CollabTestCtx> {
  return buildCollabTestApp({ collabHooks: (server, log) => createCollabHooks(server, log) });
}

describe("#181 collab delete gate and trash", () => {
  it("isDeleting reflects the gate (false before mark, true after mark, false after unmark)", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-cg1@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);

    expect(ctx.collab.isDeleting(note.id)).toBe(false);
    await ctx.collab.markDeleting(note.id);
    expect(ctx.collab.isDeleting(note.id)).toBe(true);
    ctx.collab.unmarkDeleting(note.id);
    expect(ctx.collab.isDeleting(note.id)).toBe(false);
  });

  it("releaseDeletingGate does not release the gate for a trashed note; a live note is released as usual", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-cg2@example.com", password: PASSWORD });
    const trashed = await ctx.createNote(owner.id);
    const live = await ctx.createNote(owner.id);

    // The earlier DELETE succeeds in moving to trash; the later one that gets 404 inside the transaction must not release the gate.
    const epoch = await ctx.collab.markDeleting(trashed.id);
    await markTrashed(ctx.db.$client, trashed.id, owner.id);
    await expect(ctx.collab.releaseDeletingGate(trashed.id, epoch)).resolves.toBe(false);
    expect(ctx.collab.isDeleting(trashed.id)).toBe(true);

    const liveEpoch = await ctx.collab.markDeleting(live.id);
    await expect(ctx.collab.releaseDeletingGate(live.id, liveEpoch)).resolves.toBe(true);
    expect(ctx.collab.isDeleting(live.id)).toBe(false);
  });
});

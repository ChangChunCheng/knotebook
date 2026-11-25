import { describe, expect, it } from "vitest";
import type { TestClient } from "./helpers.js";
import { broadcastCommentChange } from "../src/comments/broadcast.js";
import type { GroupTestHook } from "../src/groups/test-hook.js";
import { buildCollabTestApp } from "./helpers.js";
import { sleep } from "./group-helpers.js";

const PASSWORD = "correct-horse-battery";

interface CommentMessage {
  type: string;
  op: string;
  commentId: string;
}

/** Everything the server sends this client as a stateless message, parsed. */
function recordMessages(client: TestClient): CommentMessage[] {
  const out: CommentMessage[] = [];
  client.provider.on("stateless", ({ payload }: { payload: string }) => out.push(JSON.parse(payload) as CommentMessage));
  return out;
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

async function setup(opts: { groupTestHook?: GroupTestHook } = {}) {
  const ctx = await buildCollabTestApp({ groupTestHook: opts.groupTestHook });
  const alice = await ctx.createUser({ email: "alice@example.com", password: PASSWORD });
  const bob = await ctx.createUser({ email: "bob@example.com", password: PASSWORD });
  const note = await ctx.createNote(alice.id);
  await ctx.share(note.id, bob.id, "viewer");
  const aliceSession = await ctx.loginAs("alice@example.com", PASSWORD);
  const bobSession = await ctx.loginAs("bob@example.com", PASSWORD);
  const send = (method: string, path: string, body?: unknown) =>
    aliceSession.fetch(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { ctx, note, aliceSession, bobSession, send };
}

describe("comment live signal", () => {
  it("reaches every connection on the note, a read-only viewer's included, for create, edit and delete, with no text in it", async () => {
    const { note, aliceSession, bobSession, send } = await setup();
    const a = await aliceSession.connect(note.id);
    const b = await bobSession.connect(note.id);
    const forAlice = recordMessages(a);
    const forBob = recordMessages(b);

    const created = (await (await send("POST", `/api/notes/${note.id}/comments`, { body: "secret text" })).json()) as { id: string };
    await until(() => forBob.length === 1 && forAlice.length === 1, "created");
    expect(forBob[0]).toEqual({ type: "comment", op: "created", commentId: created.id });
    expect(JSON.stringify(forBob)).not.toContain("secret");

    expect((await send("PATCH", `/api/comments/${created.id}`, { body: "changed" })).status).toBe(200);
    await until(() => forBob.length === 2, "edited");
    expect(forBob[1]).toEqual({ type: "comment", op: "edited", commentId: created.id });

    expect((await send("DELETE", `/api/comments/${created.id}`)).status).toBe(204);
    await until(() => forBob.length === 3 && forAlice.length === 3, "deleted");
    expect(forBob[2]).toEqual({ type: "comment", op: "deleted", commentId: created.id });
  });

  it("goes to the connections of that note only, and nothing is sent when the document isn't loaded", async () => {
    const { ctx, note, aliceSession, send } = await setup();
    const other = await ctx.createNote((await ctx.createUser({ email: "carol@example.com", password: PASSWORD })).id);
    const carolSession = await ctx.loginAs("carol@example.com", PASSWORD);
    const elsewhere = recordMessages(await carolSession.connect(other.id));

    // No connection on `note`: the document isn't loaded, so the post succeeds and nobody is told.
    expect(ctx.collab.hocuspocus.documents.get(note.id)).toBeUndefined();
    expect((await send("POST", `/api/notes/${note.id}/comments`, { body: "while nobody is here" })).status).toBe(201);
    const late = await aliceSession.connect(note.id);
    const lateMessages = recordMessages(late);
    await sleep(300);
    expect(lateMessages).toEqual([]);
    expect(elsewhere).toEqual([]);

    expect(() => broadcastCommentChange(undefined, note.id, "created", "x")).not.toThrow();
    expect(() => broadcastCommentChange(ctx.collab, "00000000-0000-4000-8000-000000000000", "deleted", "x")).not.toThrow();
  });

  it("is sent after the commit, not while the transaction is open, and not at all when the write is refused", async () => {
    let parked: (() => void) | null = null;
    let gate = false;
    const { note, aliceSession, bobSession, send } = await setup({
      groupTestHook: async point => {
        if (point !== "comment-locked" || !gate) return;
        await new Promise<void>(resolve => {
          parked = resolve;
        });
      },
    });
    const watcher = recordMessages(await bobSession.connect(note.id));
    await aliceSession.connect(note.id);

    gate = true;
    const pending = send("POST", `/api/notes/${note.id}/comments`, { body: "held" });
    await until(() => parked !== null, "the transaction to park");
    await sleep(300);
    expect(watcher).toEqual([]);
    gate = false;
    parked!();
    const made = (await (await pending).json()) as { id: string };
    await until(() => watcher.length === 1, "created after commit");
    expect(watcher[0]).toEqual({ type: "comment", op: "created", commentId: made.id });

    const refused = await send("POST", `/api/notes/${note.id}/comments`, { body: "x", replyToId: "00000000-0000-4000-8000-000000000000" });
    expect(refused.status).toBe(400);
    expect((await send("PATCH", `/api/comments/${made.id}`, { body: "" })).status).toBe(400);
    expect((await bobSession.fetch(`/api/comments/${made.id}`, { method: "DELETE" })).status).toBe(403);
    await sleep(300);
    expect(watcher).toHaveLength(1);
  });
});

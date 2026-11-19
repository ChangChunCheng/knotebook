import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { COLLAB_REJECT_NOTE_DELETING } from "../src/collab/server.js";
import { buildCollabTestApp } from "./helpers.js";

const PASSWORD = "correct-horse-battery";

// Connections always use connect() without override (real token via POST /api/notes/:id/collab-token); the index keys by userId, so two identities need two real users (owner + shared editor).

// Used in this file only to recognise "this CLOSE was sent by us on purpose". The real revocation reason constants
// (COLLAB_CLOSE_REVOKED etc., from @knotebook/shared) are what the revocation flow sends.
const TEST_CLOSE_REASON = "knotebook:test-closed";

/**
 * Polls until the condition holds. Collaboration converges asynchronously, so assertions can't use a fixed sleep (red/green would depend on machine speed)
 * nor check only once - always poll within a deadline and fail with the label on timeout.
 */
async function waitFor(label: string, timeoutMs: number, check: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`等待逾時（${timeoutMs}ms）：${label}`);
}

function stateVector(doc: Y.Doc): string {
  return Buffer.from(Y.encodeStateVector(doc)).toString("hex");
}

function insertParagraph(doc: Y.Doc, text: string): void {
  const element = new Y.XmlElement("paragraph");
  element.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [element]);
}

describe("Hocuspocus v4 x Fastify collab sync", () => {
  it("two clients on the same note: A's edit converges to B within 3 s", async () => {
    const ctx = await buildCollabTestApp();
    const alice = await ctx.createUser({ email: "alice@example.com", password: PASSWORD });
    const note = await ctx.createNote(alice.id);
    const session = await ctx.loginAs("alice@example.com", PASSWORD);

    const a = await session.connect(note.id);
    const b = await session.connect(note.id);

    insertParagraph(a.doc, "hello from A");

    await waitFor("B 的 state vector 收斂到與 A 相同", 3_000, () => stateVector(b.doc) === stateVector(a.doc));
    expect(b.doc.getXmlFragment(YDOC_FRAGMENT).toString()).toBe("<paragraph>hello from A</paragraph>");
  });

  it("connection index grows and shrinks with connect/disconnect (foundation of revocation)", async () => {
    const ctx = await buildCollabTestApp();
    const alice = await ctx.createUser({ email: "alice@example.com", password: PASSWORD });
    const bob = await ctx.createUser({ email: "bob@example.com", password: PASSWORD });
    const note = await ctx.createNote(alice.id);
    await ctx.share(note.id, bob.id, "editor");
    const aliceSession = await ctx.loginAs("alice@example.com", PASSWORD);
    const bobSession = await ctx.loginAs("bob@example.com", PASSWORD);

    const a = await aliceSession.connect(note.id);
    await bobSession.connect(note.id);

    expect(ctx.collab.connectionsOfNote(note.id).size).toBe(2);
    expect(ctx.collab.connectionsOf(alice.id).size).toBe(1);
    expect(ctx.collab.connectionsOf(bob.id).size).toBe(1);

    const handle = [...ctx.collab.connectionsOf(alice.id)][0];
    expect(handle.noteId).toBe(note.id);
    expect(handle.userId).toBe(alice.id);

    a.disconnect();

    await waitFor("A 斷線後索引移除該連線", 3_000, () => ctx.collab.connectionsOf(alice.id).size === 0);
    expect(ctx.collab.connectionsOfNote(note.id).size).toBe(1);
  });

  it("the same socket unsubscribing and resubscribing to the same note: the index points to the live connection, no stale registration left", async () => {
    const ctx = await buildCollabTestApp();
    const alice = await ctx.createUser({ email: "alice@example.com", password: PASSWORD });
    const note = await ctx.createNote(alice.id);
    const session = await ctx.loginAs("alice@example.com", PASSWORD);

    const a = await session.connect(note.id);

    // detach -> attach is the shape of the SPA navigating between notes: the **same socket** (socketId unchanged) first sends CLOSE to unsubscribe,
    // then subscribes to the same note again, so both registrations share the same (socketId, documentName) composite key.
    a.provider.detach();
    a.provider.attach();

    await waitFor("重訂後索引恰有一條連線", 5_000, () => ctx.collab.connectionsOfNote(note.id).size === 1);
    expect(ctx.collab.connectionsOf(alice.id).size).toBe(1);

    // What's left in the index must be the **live** one: close through it and the client must really receive it. If the index wrongly kept the old handle
    // (already removed from the document), the hasConnection guard of `Connection.close` would silently do nothing - revocation would miss a user still editing.
    const handle = [...ctx.collab.connectionsOfNote(note.id)][0];
    handle.close(TEST_CLOSE_REASON);

    await waitFor("client 收到指定 reason 的應用層 CLOSE", 3_000, () =>
      a.closes.some(one => one.reason === TEST_CLOSE_REASON)
    );
  });

  it("onNextTokenSync is called when the token triggered by requestToken arrives, and only once", async () => {
    const ctx = await buildCollabTestApp();
    const alice = await ctx.createUser({ email: "alice@example.com", password: PASSWORD });
    const note = await ctx.createNote(alice.id);
    const session = await ctx.loginAs("alice@example.com", PASSWORD);

    await session.connect(note.id);
    const handle = [...ctx.collab.connectionsOf(alice.id)][0];

    // Two callbacks registered on one connection: both must fire (the deadline may be registered twice within 5 s; if the implementation overwrote with a single cb,
    // the first timer would never be cleared and a successfully revalidated user would be killed by mistake).
    let first = 0;
    let second = 0;
    ctx.collab.onNextTokenSync(handle, () => { first += 1; });
    ctx.collab.onNextTokenSync(handle, () => { second += 1; });

    handle.requestToken();

    await waitFor("onNextTokenSync 的兩個回呼都被觸發", 3_000, () => first === 1 && second === 1);

    // One-shot: a registered callback is cleared after firing, so a second token arrival doesn't call it again.
    handle.requestToken();
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(first).toBe(1);
    expect(second).toBe(1);
  });

  it("new connections are rejected during markDeleting, restored after unmarkDeleting", async () => {
    const ctx = await buildCollabTestApp();
    const alice = await ctx.createUser({ email: "alice@example.com", password: PASSWORD });
    const note = await ctx.createNote(alice.id);
    const session = await ctx.loginAs("alice@example.com", PASSWORD);

    await ctx.collab.markDeleting(note.id);
    await expect(session.connect(note.id)).rejects.toThrow(COLLAB_REJECT_NOTE_DELETING);

    ctx.collab.unmarkDeleting(note.id);
    const a = await session.connect(note.id);
    expect(a.provider.isAuthenticated).toBe(true);
  });
});

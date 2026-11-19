import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT, MAX_LINK_TARGETS, type Role } from "@knotebook/shared";
import { createCollabHooks } from "../src/collab/hooks-impl.js";
import { docClock } from "../src/collab/store.js";
import { notes, noteLinks } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { buildCollabTestApp, COLLAB_TOKEN_INIT, type CollabTestCtx, type HttpSession, type TestClient } from "./helpers.js";

/** #372: message of 409 not_loaded (the two causes share one sentence). */
const NOT_LOADED_MESSAGE =
  "Link updates need the note open in the editor: it isn't loaded on the server, or you have no open editor connection to it. Open the note and try again.";

const PASSWORD = "correct-horse-battery";

/**
 * Always builds the app with the **real** CollabHooks (like collab-revocation.test.ts): the default `noopCollabHooks.linkSyncGate` always returns `{ ok: false }`,
 * which would make the "in memory but no connection -> 409" and "after unload -> 409" cases falsely green (409 whether or not a gate query was really sent) -
 * this file tests exactly the real in-memory state after `createCollabHooks` delegates to `CollabServer.linkSyncState`.
 */
function buildApp(): Promise<CollabTestCtx> {
  return buildCollabTestApp({ collabHooks: (server, log) => createCollabHooks(server, log) });
}

/** Polls until the condition holds (as in collab-revocation/collab-store: collaboration convergence can't be asserted with a fixed sleep). */
async function waitFor(label: string, timeoutMs: number, check: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(25);
  }
  throw new Error(`等待逾時（${timeoutMs}ms）：${label}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Hand-builds a wikilink node at the Y.Doc level (nodeName "wikilink", attr targetNoteId, fragment YDOC_FRAGMENT from shared) - independent of apps/web's
 * BlockNote schema/spec; it only makes the document content really change (advances docClock) and lets the two-client convergence case verify
 * that Yjs-level sync itself is correct.
 */
function insertWikilink(doc: Y.Doc, targetNoteId: string): void {
  const element = new Y.XmlElement("wikilink");
  element.setAttribute("targetNoteId", targetNoteId);
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [element]);
}

function extractWikilinkTargets(doc: Y.Doc): string[] {
  const targets: string[] = [];
  const walk = (node: Y.XmlFragment | Y.XmlElement): void => {
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlElement) {
        if (child.nodeName === "wikilink") {
          const targetNoteId = child.getAttribute("targetNoteId");
          if (typeof targetNoteId === "string") targets.push(targetNoteId);
        }
        walk(child);
      }
    }
  };
  walk(doc.getXmlFragment(YDOC_FRAGMENT));
  return targets;
}

/** Gets a token via the real `POST /api/notes/:id/collab-token` (counts against the per-user limiter). */
async function fetchToken(session: HttpSession, noteId: string): Promise<string> {
  const res = await session.fetch(`/api/notes/${noteId}/collab-token`, COLLAB_TOKEN_INIT);
  if (!res.ok) throw new Error(`取得 collab token 失敗（${res.status}）：${await res.text()}`);
  const body = (await res.json()) as { token: string; role: Role };
  return body.token;
}

/** Real `POST /api/notes/:id/links`: reproduces client submission semantics with a manual POST (no code dependency on the client). */
function postLinks(session: HttpSession, noteId: string, targetIds: string[]): Promise<Response> {
  return session.fetch(`/api/notes/${noteId}/links`, {
    method: "POST",
    body: JSON.stringify({ link_target_ids: targetIds }),
  });
}

async function linkedTargets(db: Db, sourceId: string): Promise<string[]> {
  const rows = await db.select({ targetNoteId: noteLinks.targetNoteId }).from(noteLinks).where(eq(noteLinks.sourceNoteId, sourceId));
  return rows.map(r => r.targetNoteId).sort();
}

async function readLinksClock(db: Db, noteId: string): Promise<number> {
  const [row] = await db.select({ linksClock: notes.linksClock }).from(notes).where(eq(notes.id, noteId));
  return row?.linksClock ?? 0;
}

/**
 * Waits until the server side (`CollabServer.linkSyncState` - the same function `linkSyncGate` actually delegates to) really sees `expectedClock`: a client's local insert
 * reaches the server's canonical Y.Doc only after a real WS round trip, so "client.doc already has the edit" doesn't mean the server received it.
 * Used as the sync point instead of an arbitrary sleep - it polls exactly the logic `POST /links` calls.
 */
async function waitForServerClock(ctx: CollabTestCtx, noteId: string, userId: string, expectedClock: number): Promise<void> {
  await waitFor(`server 端 linkSyncState 收斂到 clock=${expectedClock}`, 10_000, () => {
    const state = ctx.collab.linkSyncState(noteId, userId);
    return state.ok && state.clock === expectedClock;
  });
}

/**
 * Disconnects everything and waits until the document is really unloaded from memory - template copied from `beforeNoteDeleted` in `hooks-impl.ts`:
 * `flushPendingStores` runs the debounced store immediately, and `unloadDocument` silently no-ops while a store is in flight
 * (`shouldUnloadDocument` false), so it is polled and retried.
 *
 * Steps: first each `TestClient` this test built `disconnect()`s itself (provider.destroy() + socket.destroy(), no auto-reconnect - this is "all disconnected",
 * not "asking them to reconnect"); then `hocuspocus.closeConnections(noteId)` as a backstop (v4.5.0 public API, should be a no-op by now; it only proves this runbook
 * path doesn't depend on the client handles held by this test, since a real runbook script may only know the noteId).
 */
async function disconnectAllAndUnload(ctx: CollabTestCtx, noteId: string, clients: readonly TestClient[]): Promise<void> {
  for (const client of clients) client.disconnect();
  ctx.collab.hocuspocus.closeConnections(noteId);
  ctx.collab.hocuspocus.flushPendingStores();

  const tryUnload = (): void => {
    const doc = ctx.collab.hocuspocus.documents.get(noteId);
    if (doc) void ctx.collab.hocuspocus.unloadDocument(doc).catch(() => {});
  };
  tryUnload();

  await waitFor("文件從記憶體卸載", 10_000, () => {
    if (!ctx.collab.hocuspocus.documents.has(noteId)) return true;
    tryUnload();
    return false;
  });
}

describe("links collab integration - real Hocuspocus gate, real provider", () => {
  it("two-client convergence: a wikilink element inserted by hand at the Y.Doc level converges between two clients", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-links1@example.com", password: PASSWORD });
    const other = await ctx.createUser({ email: "other-links1@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const target = await ctx.createNote(owner.id, "Target");
    await ctx.share(note.id, other.id, "editor");

    const ownerSession = await ctx.loginAs("owner-links1@example.com", PASSWORD);
    const otherSession = await ctx.loginAs("other-links1@example.com", PASSWORD);
    const ownerClient = await ownerSession.connect(note.id);
    const otherClient = await otherSession.connect(note.id);

    insertWikilink(ownerClient.doc, target.id);

    await waitFor("wikilink 收斂到另一 client", 10_000, () => extractWikilinkTargets(otherClient.doc).includes(target.id));
    expect(extractWikilinkTargets(otherClient.doc)).toEqual(extractWikilinkTargets(ownerClient.doc));
  });

  it("first submit after synced converges: first submit after the connection is synced returns 204, note_links is written", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-links2@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const target = await ctx.createNote(owner.id, "Target");
    const session = await ctx.loginAs("owner-links2@example.com", PASSWORD);
    const client = await session.connect(note.id);

    insertWikilink(client.doc, target.id);
    const expectedClock = docClock(client.doc);
    await waitForServerClock(ctx, note.id, owner.id, expectedClock);

    const res = await postLinks(session, note.id, [target.id]);
    expect(res.status).toBe(204);
    expect(await linkedTargets(ctx.db, note.id)).toEqual([target.id]);
    expect(await readLinksClock(ctx.db, note.id)).toBe(expectedClock);
  });

  it("submitter's own connection not yet registered in the index -> 409 (temporary version of the same gate branch as the no-connection case); converges right after registration, still converges when retried after 1s", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-links3@example.com", password: PASSWORD });
    const editor = await ctx.createUser({ email: "editor-links3@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const target = await ctx.createNote(owner.id, "Target");
    await ctx.share(note.id, editor.id, "editor");
    // The target must be shared with the editor too - otherwise the batch authorization query of writeNoteLinks would silently filter it out
    // (see "target without access -> silently filtered" in notes-links.test.ts), which is unrelated to the gate convergence under test
    // and would turn the final note_links assertion into a false negative.
    await ctx.share(target.id, editor.id, "viewer");

    const ownerSession = await ctx.loginAs("owner-links3@example.com", PASSWORD);
    const editorSession = await ctx.loginAs("editor-links3@example.com", PASSWORD);

    // The owner connects first so the document is in memory, and edits once so docClock > 0 - otherwise the case degrades to the `0 <= 0` boundary
    // (and would pass by coincidence even if the CAS gate were removed entirely).
    const ownerClient = await ownerSession.connect(note.id);
    insertWikilink(ownerClient.doc, target.id);
    const editClock = docClock(ownerClient.doc);
    await waitForServerClock(ctx, note.id, owner.id, editClock);

    // What this case really tests: stalling the editor's tokenFn below creates the *state* "document in memory but the editor's own connection not yet registered in
    // the byNote index" - the very same gate branch as the "in memory but submitter has no connection" case, except that here the unregistered state is temporary
    // and resolves by itself. This is a state-equivalent proxy, **not** a reproduction of the "synced hits connected" timing: `onOpen` of `@hocuspocus/provider` 4.5.0
    // is `await this.sendToken(); this.startSync();`, so `sendToken()` doesn't resolve until `gate` is released and `startSync()` (the whole y-protocol sync, ending in
    // the client's "synced" event) hasn't begun inside the window; this client has never synced at that point.
    //
    // The real "synced hits connected" window is inside `@hocuspocus/server` 4.5.0 `setUpNewConnection`: queued messages are drained and applied first, and only **then**
    // `await this.hooks("connected", ...)` - where our `connected` hook registers the connection into `byNote` (see collab/server.ts). That window is entirely inside one
    // async call of Hocuspocus with no I/O or public API to pause at, so it can't be hit deterministically from this side; it would take monkeypatching
    // `Hocuspocus.prototype`, beyond the "real provider + public API reproducing client semantics" boundary of this test.
    let releaseToken: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      releaseToken = resolve;
    });
    const editorConnectPromise = editorSession.connect(note.id, {
      tokenFn: async () => {
        await gate;
        return fetchToken(editorSession, note.id);
      },
    });
    // If the assertions below fail first and nobody awaits this promise (the gate is never released), avoid an unhandled rejection polluting the test output.
    void editorConnectPromise.catch(() => {});

    const raced = await postLinks(editorSession, note.id, [target.id]);
    expect(raced.status).toBe(409);
    expect(await raced.json()).toMatchObject({ error: { code: "not_loaded" } });
    expect(await linkedTargets(ctx.db, note.id)).toEqual([]);

    releaseToken();
    const editorClient = await editorConnectPromise;

    // Pins what the client actually relies on: after synced, by the time the next HTTP request arrives this connection's registration is already done -
    // it should converge with no extra wait, not "converging only because we happened to wait 1 second".
    const immediate = await postLinks(editorSession, note.id, [target.id]);
    expect(immediate.status).toBe(204);
    expect(await linkedTargets(ctx.db, note.id)).toEqual([target.id]);

    // Retry after another 1s still converges - together covering "converges on 1s retry", proving the immediate convergence above isn't a flash in the pan.
    await sleep(1_000);
    const retried = await postLinks(editorSession, note.id, [target.id]);
    expect(retried.status).toBe(204);
    expect(await linkedTargets(ctx.db, note.id)).toEqual([target.id]);

    editorClient.disconnect();
    ownerClient.disconnect();
  });

  it("in memory but submitter has no connection -> 409 not_loaded", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-links4@example.com", password: PASSWORD });
    const editor = await ctx.createUser({ email: "editor-links4@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const target = await ctx.createNote(owner.id, "Target");
    await ctx.share(note.id, editor.id, "editor");

    const ownerSession = await ctx.loginAs("owner-links4@example.com", PASSWORD);
    const editorSession = await ctx.loginAs("editor-links4@example.com", PASSWORD);

    // The owner connects so the document is really in memory; the editor never connected - unlike the previous case (a temporary race that converges),
    // this verifies that even when the document is loaded, a user with no registered connection never gets a clock.
    const ownerClient = await ownerSession.connect(note.id);
    expect(ctx.collab.hocuspocus.documents.has(note.id)).toBe(true);

    const res = await postLinks(editorSession, note.id, [target.id]);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "not_loaded", message: NOT_LOADED_MESSAGE } });
    expect(await linkedTargets(ctx.db, note.id)).toEqual([]);

    ownerClient.disconnect();
  });

  it("after unload -> 409 not_loaded", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-links5@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const target = await ctx.createNote(owner.id, "Target");
    const session = await ctx.loginAs("owner-links5@example.com", PASSWORD);
    const client = await session.connect(note.id);

    await disconnectAllAndUnload(ctx, note.id, [client]);
    expect(ctx.collab.hocuspocus.documents.has(note.id)).toBe(false);

    const res = await postLinks(session, note.id, [target.id]);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "not_loaded", message: NOT_LOADED_MESSAGE } });
    expect(await linkedTargets(ctx.db, note.id)).toEqual([]);
  });

  it("a later submit is idempotent: the CAS hit really rewrites (note_links deleted by hand between two submits, the second still rebuilds it)", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-links6@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const target = await ctx.createNote(owner.id, "Target");
    const session = await ctx.loginAs("owner-links6@example.com", PASSWORD);
    const client = await session.connect(note.id);

    insertWikilink(client.doc, target.id);
    const expectedClock = docClock(client.doc);
    await waitForServerClock(ctx, note.id, owner.id, expectedClock);

    const res1 = await postLinks(session, note.id, [target.id]);
    expect(res1.status).toBe(204);
    const clockAfterFirst = await readLinksClock(ctx.db, note.id);
    expect(clockAfterFirst).toBe(expectedClock);
    expect(await linkedTargets(ctx.db, note.id)).toEqual([target.id]);

    // No new edit - docClock unchanged, so the second submit gets the same clock as the already committed links_clock, and the `<=` gate still accepts
    // a same-clock resend (LWW). But asserting only "same final state after two submits" would pass by coincidence even if CAS were wrongly changed to strict `<`
    // (a same-clock resend judged a no-op and not rewritten at all) - with no new edit the state stays put and can't expose a difference. So delete the
    // `note_links` row by hand between the two submits (leaving `links_clock`), making "the second really executed the write" vs "wrongly judged a no-op"
    // observable in the final state: the former rebuilds the row, the latter leaves it deleted.
    await ctx.db.delete(noteLinks).where(eq(noteLinks.sourceNoteId, note.id));
    expect(await linkedTargets(ctx.db, note.id)).toEqual([]);

    const res2 = await postLinks(session, note.id, [target.id]);
    expect(res2.status).toBe(204);
    expect(await readLinksClock(ctx.db, note.id)).toBe(clockAfterFirst);
    expect(await linkedTargets(ctx.db, note.id)).toEqual([target.id]);

    client.disconnect();
  });

  it("clamp convergence (guard): after links_clock is artificially raised, onLoadDocument on unload+reconnect clamps it back to docClock with LEAST, and later submits still converge", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-links7@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const target = await ctx.createNote(owner.id, "Target");
    const session = await ctx.loginAs("owner-links7@example.com", PASSWORD);
    const client = await session.connect(note.id);

    insertWikilink(client.doc, target.id);
    const editClock = docClock(client.doc);
    await waitForServerClock(ctx, note.id, owner.id, editClock);

    const res1 = await postLinks(session, note.id, [target.id]);
    expect(res1.status).toBe(204);
    const committedClock = await readLinksClock(ctx.db, note.id);
    expect(committedClock).toBe(editClock);

    // Artificially set links_clock far above any value docClock can reach - if the clamp in onLoadDocument wrongly used GREATEST (instead of the right LEAST),
    // this value would survive unchanged after reconnecting.
    const inflated = committedClock + 1_000_000;
    await ctx.db.update(notes).set({ linksClock: inflated }).where(eq(notes.id, note.id));
    expect(await readLinksClock(ctx.db, note.id)).toBe(inflated);

    // Fully disconnect and wait for unload: the document is really unloaded from memory, so the next connection really re-runs onLoadDocument.
    await disconnectAllAndUnload(ctx, note.id, [client]);
    expect(ctx.collab.hocuspocus.documents.has(note.id)).toBe(false);

    const reconnected = await session.connect(note.id);
    const reloadedClock = docClock(reconnected.doc);

    // Clamp assertion: must equal docClock exactly (not just "became smaller"): that is what tells
    // LEAST (right: clamp back to docClock) from GREATEST (wrong: keeps the raised value).
    const clampedClock = await readLinksClock(ctx.db, note.id);
    expect(clampedClock).toBeLessThanOrEqual(reloadedClock);
    expect(clampedClock).toBe(reloadedClock);
    expect(clampedClock).toBeLessThan(inflated);

    const res2 = await postLinks(session, note.id, [target.id]);
    expect(res2.status).toBe(204);
    expect(await linkedTargets(ctx.db, note.id)).toEqual([target.id]);

    reconnected.disconnect();
  });

  it("submit converges after the restore runbook (including the links_clock=0 reset)", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-links8@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const target = await ctx.createNote(owner.id, "Target");
    const session = await ctx.loginAs("owner-links8@example.com", PASSWORD);
    const client = await session.connect(note.id);

    insertWikilink(client.doc, target.id);
    const editClock = docClock(client.doc);
    await waitForServerClock(ctx, note.id, owner.id, editClock);

    const res1 = await postLinks(session, note.id, [target.id]);
    expect(res1.status).toBe(204);
    expect(await readLinksClock(ctx.db, note.id)).toBe(editClock);

    // Restore runbook: closeConnections (v4.5.0 public API, see disconnectAllAndUnload) -> flushPendingStores -> poll unloadDocument until really unloaded ->
    // reset links_clock to 0 directly outside the transaction (simulates one step of the restore/rebuild-index runbook).
    await disconnectAllAndUnload(ctx, note.id, [client]);
    expect(ctx.collab.hocuspocus.documents.has(note.id)).toBe(false);

    await ctx.db.update(notes).set({ linksClock: 0 }).where(eq(notes.id, note.id));
    expect(await readLinksClock(ctx.db, note.id)).toBe(0);

    const reconnected = await session.connect(note.id);
    // The LEAST(0, docClock) clamp in onLoadDocument at reconnect never pulls 0 upward - 0 is already the lower bound of every docClock,
    // so it should stay 0 after reconnecting (not "clamped back to some positive value").
    expect(await readLinksClock(ctx.db, note.id)).toBe(0);

    const res2 = await postLinks(session, note.id, [target.id]);
    expect(res2.status).toBe(204);
    expect(await linkedTargets(ctx.db, note.id)).toEqual([target.id]);
    expect(await readLinksClock(ctx.db, note.id)).toBe(docClock(reconnected.doc));

    reconnected.disconnect();
  });
});

describe("#240 case of link_target_ids", () => {
  it("an uppercase own id and case duplicates: no self link written, targets land as usual", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-r9@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const target = await ctx.createNote(owner.id, "Target");
    const session = await ctx.loginAs("owner-r9@example.com", PASSWORD);
    const client = await session.connect(note.id);
    insertWikilink(client.doc, target.id);
    await waitForServerClock(ctx, note.id, owner.id, docClock(client.doc));
    const res = await postLinks(session, note.id, [note.id.toUpperCase(), target.id, target.id.toUpperCase()]);
    // Placed first: without the lowercasing, the uppercase own id passes the JS filter, is normalized to lowercase by the DB in the authorization query, and writes a row with source = target.
    expect(await linkedTargets(ctx.db, note.id)).toEqual([target.id]);
    expect(res.status).toBe(204);
  });

  it("MAX_LINK_TARGETS distinct ids + an uppercase variant of one of them -> 204 (no longer a false 400)", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-r9b@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const target = await ctx.createNote(owner.id, "Target");
    const session = await ctx.loginAs("owner-r9b@example.com", PASSWORD);
    const client = await session.connect(note.id);
    insertWikilink(client.doc, target.id);
    await waitForServerClock(ctx, note.id, owner.id, docClock(client.doc));
    const ids = Array.from({ length: MAX_LINK_TARGETS }, () => randomUUID());
    const res = await postLinks(session, note.id, [...ids, ids[0]!.toUpperCase()]);
    expect(res.status).toBe(204);
    expect(await linkedTargets(ctx.db, note.id)).toEqual([]); // the random ids don't exist -> authorization intersection is empty -> the whole set is replaced with empty
  });
});

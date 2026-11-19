import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as Y from "yjs";
import { COLLAB_CLOSE_REVOKED, NOTE_SCHEMA_VERSION, YDOC_FRAGMENT } from "@knotebook/shared";
import { signCollabToken } from "../src/collab/token.js";
import {
  COLLAB_REJECT_FORBIDDEN,
  COLLAB_REJECT_INVALID_TOKEN,
  COLLAB_REJECT_NOTE_DELETING,
  COLLAB_REJECT_SERVER_ERROR,
} from "../src/collab/server.js";
import { notes } from "../src/db/schema.js";
import { buildCollabTestApp, COLLAB_TOKEN_INIT, testConfig, testSessionId } from "./helpers.js";

const PASSWORD = "correct-horse-battery";

/**
 * Polls until the condition holds (as in collab-sync.test.ts): collaboration converges asynchronously, so assertions can't use a fixed
 * sleep nor check only once - always poll within a deadline and fail with the label on timeout.
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

describe("collab auth: onAuthenticate / onTokenSync real verification", () => {
  it("owner can connect and write; viewer connects but its writes are dropped at the protocol layer (another client doesn't see them)", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth1@example.com", password: PASSWORD });
    const viewerUser = await ctx.createUser({ email: "viewer-auth1@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    await ctx.share(note.id, viewerUser.id, "viewer");

    const ownerSession = await ctx.loginAs("owner-auth1@example.com", PASSWORD);
    const viewerSession = await ctx.loginAs("viewer-auth1@example.com", PASSWORD);

    const ownerClient = await ownerSession.connect(note.id);
    const viewerClient = await viewerSession.connect(note.id);

    insertParagraph(ownerClient.doc, "from owner");
    await waitFor(
      "viewer 收斂到 owner 的寫入",
      3_000,
      () => stateVector(viewerClient.doc) === stateVector(ownerClient.doc)
    );
    expect(viewerClient.doc.getXmlFragment(YDOC_FRAGMENT).toString()).toBe("<paragraph>from owner</paragraph>");

    // A viewer's write: the protocol layer should drop it (see the messageYjsUpdate/messageYjsSyncStep2 branches of Hocuspocus
    // `connection.readOnly`), neither persisted nor broadcast to the owner.
    insertParagraph(viewerClient.doc, "from viewer");
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(ownerClient.doc.getXmlFragment(YDOC_FRAGMENT).toString()).not.toContain("from viewer");
  });

  it("forged token (bad signature) is refused", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth2@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("owner-auth2@example.com", PASSWORD);

    const forged = await signCollabToken("f".repeat(64), { noteId: note.id, userId: owner.id, role: "owner", tv: 0, sid: testSessionId(owner.id), sv: NOTE_SCHEMA_VERSION });

    await expect(session.connect(note.id, { tokenOverride: forged })).rejects.toThrow(COLLAB_REJECT_INVALID_TOKEN);
  });

  it("a stranger with a validly signed token claiming role:'owner' -> resolveRole is re-run and gives 'none', still refused (the role inside the token isn't an authorization basis)", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth3@example.com", password: PASSWORD });
    const stranger = await ctx.createUser({ email: "stranger-auth3@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("stranger-auth3@example.com", PASSWORD);

    // The signature is valid (signed with the real appSecret) but the stranger has no permission on this note - role:'owner' is only a (false)
    // snapshot from issuing time; the server must not trust it and must re-run resolveRole to refuse.
    const forgedRole = await signCollabToken(testConfig.appSecret, {
      noteId: note.id,
      userId: stranger.id,
      role: "owner",
      tv: 0,
      sid: testSessionId(stranger.id),
      sv: NOTE_SCHEMA_VERSION,
    });

    // issue #35: the only real "authorization denied": the note exists and the token is valid, but this person has no role.
    await expect(session.connect(note.id, { tokenOverride: forgedRole })).rejects.toThrow(COLLAB_REJECT_FORBIDDEN);
  });

  it("after a share is revoked, reconnecting with the pre-revocation token (within TTL) is refused", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth4@example.com", password: PASSWORD });
    const editorUser = await ctx.createUser({ email: "editor-auth4@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    await ctx.share(note.id, editorUser.id, "editor");

    const ownerSession = await ctx.loginAs("owner-auth4@example.com", PASSWORD);
    const editorSession = await ctx.loginAs("editor-auth4@example.com", PASSWORD);

    // Take a valid token before revoking (valid for the whole 120 s TTL).
    const tokenRes = await editorSession.fetch(`/api/notes/${note.id}/collab-token`, COLLAB_TOKEN_INIT);
    expect(tokenRes.status).toBe(200);
    const { token: staleToken } = (await tokenRes.json()) as { token: string };

    const delRes = await ownerSession.fetch(`/api/notes/${note.id}/shares/${editorUser.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(204);

    await expect(editorSession.connect(note.id, { tokenOverride: staleToken })).rejects.toThrow(
      COLLAB_REJECT_FORBIDDEN
    );
  });

  it("token.noteId != document name -> refused", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth5@example.com", password: PASSWORD });
    const noteA = await ctx.createNote(owner.id);
    const noteB = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("owner-auth5@example.com", PASSWORD);

    const tokenForB = await signCollabToken(testConfig.appSecret, {
      noteId: noteB.id,
      userId: owner.id,
      role: "owner",
      tv: 0,
      sid: testSessionId(owner.id),
      sv: NOTE_SCHEMA_VERSION,
    });

    await expect(session.connect(noteA.id, { tokenOverride: tokenForB })).rejects.toThrow(COLLAB_REJECT_INVALID_TOKEN);
  });

  it("after the deleting gate expires, a deleted note and an 'exists but no permission' note are refused for the same reason - no existence oracle (issue #35)", async () => {
    // The window "note fully deleted, gate cleared, client only now reconnects" would otherwise be reported as "you lost access".
    // The fix lengthens the gate TTL to cover the client's longest restart backoff (see DELETING_GATE_TTL_MS), **rather than** adding a
    // "note doesn't exist" refusal reason: that would let any signed-in user ask for any UUID "does this note exist?", which REST
    // deliberately doesn't distinguish (always 404 / always 200+role:'none'). This test pins that the two are indistinguishable.
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth15@example.com", password: PASSWORD });
    await ctx.createUser({ email: "stranger-auth15@example.com", password: PASSWORD });
    const deletedNote = await ctx.createNote(owner.id);
    const othersNote = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("stranger-auth15@example.com", PASSWORD);

    // Deleting the row directly without touching the gate = the end state where the deletion flow finished long ago and the TTL has passed.
    await ctx.db.delete(notes).where(eq(notes.id, deletedNote.id));

    const deletedReason = await session.connect(deletedNote.id).then(
      () => "connected",
      (err: Error) => err.message
    );
    const existingReason = await session.connect(othersNote.id).then(
      () => "connected",
      (err: Error) => err.message
    );
    expect(deletedReason).toContain(COLLAB_REJECT_FORBIDDEN);
    // Byte-identical (except noteId): the observable behaviour is the same, so nobody can ask whether this id exists.
    expect(deletedReason.replace(deletedNote.id, "")).toBe(existingReason.replace(othersNote.id, ""));
  });

  it("the deleting gate verifies the token before answering - without a valid token one can't ask whether the note is being deleted", async () => {
    // The gate is what reveals that some noteId exists and was just deleted, so it sits after token
    // verification: to ask, one must first hold a token validly signed for this note.
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth18@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("owner-auth18@example.com", PASSWORD);

    await ctx.collab.markDeleting(note.id);

    const forged = await signCollabToken("f".repeat(64), { noteId: note.id, userId: owner.id, role: "owner", tv: 0, sid: testSessionId(owner.id), sv: NOTE_SCHEMA_VERSION });
    await expect(session.connect(note.id, { tokenOverride: forged })).rejects.toThrow(COLLAB_REJECT_INVALID_TOKEN);
    await expect(session.connect(note.id)).rejects.toThrow(COLLAB_REJECT_NOTE_DELETING);
  });

  it("the deleting gate says note-deleting only to people who could already see the note (otherwise it is an existence oracle)", async () => {
    // The gate must tell collaborators "the note was deleted" without letting anyone ask "does this exist?" with a UUID.
    // The audience list is captured before the deletion transaction (markDeleting -> loadNoteAudience); only people on the list hear it.
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth20@example.com", password: PASSWORD });
    const editorUser = await ctx.createUser({ email: "editor-auth20@example.com", password: PASSWORD });
    await ctx.createUser({ email: "stranger-auth20@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    await ctx.share(note.id, editorUser.id, "editor");

    await ctx.collab.markDeleting(note.id);

    const editorSession = await ctx.loginAs("editor-auth20@example.com", PASSWORD);
    const strangerSession = await ctx.loginAs("stranger-auth20@example.com", PASSWORD);

    await expect(editorSession.connect(note.id)).rejects.toThrow(COLLAB_REJECT_NOTE_DELETING);
    // Stranger: can get a valid token (the endpoint returns 200 to everyone) but only hears forbidden - identical to "the note
    // doesn't exist at all", so nothing can be asked.
    await expect(strangerSession.connect(note.id)).rejects.toThrow(COLLAB_REJECT_FORBIDDEN);
  });

  it("when the audience list can't be fetched, 'has a role' takes over - a stranger still hears only forbidden", async () => {
    // When the audience query of `markDeleting` fails (DB hiccup) the gate's value is null. If that fallback resolved to "everyone hears
    // note-deleting", one hiccup would tell the world "this id was just deleted" for a full two minutes.
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth21@example.com", password: PASSWORD });
    await ctx.createUser({ email: "stranger-auth21@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);

    // Make the audience query really blow up (drop the note_shares table), so the gate remembers only the key and its value is null.
    await ctx.db.execute(sql`ALTER TABLE note_shares RENAME TO note_shares_hidden`);
    try {
      await ctx.collab.markDeleting(note.id);
    } finally {
      await ctx.db.execute(sql`ALTER TABLE note_shares_hidden RENAME TO note_shares`);
    }
    expect(ctx.collabLogs.some(one => one.level === "warn")).toBe(true);

    const ownerSession = await ctx.loginAs("owner-auth21@example.com", PASSWORD);
    const strangerSession = await ctx.loginAs("stranger-auth21@example.com", PASSWORD);

    // The owner can still be found to have a role => hears the real reason.
    await expect(ownerSession.connect(note.id)).rejects.toThrow(COLLAB_REJECT_NOTE_DELETING);
    // A stranger has no role => hears only forbidden, learns nothing about this note.
    await expect(strangerSession.connect(note.id)).rejects.toThrow(COLLAB_REJECT_FORBIDDEN);
  });

  it("gate release: release only removes its own gate, and only while the note still exists", async () => {
    // These three are invariants of the whole "deletion failed -> release the gate" path; if any one breaks, the only symptom is
    // "collaborators occasionally see the wrong message", so each one is asserted here.
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth22@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("owner-auth22@example.com", PASSWORD);

    // Normal: a gate it opened itself, note still there -> released, connection recovers.
    const epoch = await ctx.collab.markDeleting(note.id);
    await expect(session.connect(note.id)).rejects.toThrow(COLLAB_REJECT_NOTE_DELETING);
    await expect(ctx.collab.releaseDeletingGate(note.id, epoch)).resolves.toBe(true);
    const client = await session.connect(note.id);
    client.disconnect();

    // Someone else's gate can't be released (after a concurrent second deletion takes over, the first one's failure must not open the gate).
    const second = await ctx.collab.markDeleting(note.id);
    await expect(ctx.collab.releaseDeletingGate(note.id, epoch)).resolves.toBe(false);
    await expect(session.connect(note.id)).rejects.toThrow(COLLAB_REJECT_NOTE_DELETING);

    // The note is really gone -> not released (otherwise a reconnecting collaborator would hear "you lost access").
    await ctx.db.delete(notes).where(eq(notes.id, note.id));
    await expect(ctx.collab.releaseDeletingGate(note.id, second)).resolves.toBe(false);
    await expect(session.connect(note.id)).rejects.toThrow(COLLAB_REJECT_NOTE_DELETING);
  });

  it("the gate's audience list is merged, not overwritten (concurrent deletions must not wipe collaborators off the list)", async () => {
    // The audience query of the later `markDeleting` may land after the earlier one's commit and return an empty set.
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth23@example.com", password: PASSWORD });
    const editorUser = await ctx.createUser({ email: "editor-auth23@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    await ctx.share(note.id, editorUser.id, "editor");
    const editorSession = await ctx.loginAs("editor-auth23@example.com", PASSWORD);

    await ctx.collab.markDeleting(note.id);
    // Second time: the note row is already gone (simulates the previous one having committed) -> the audience query returns an empty set.
    await ctx.db.delete(notes).where(eq(notes.id, note.id));
    await ctx.collab.markDeleting(note.id);

    // Merged: the editor stays on the list and hears the real reason; overwritten: they would hear forbidden.
    await expect(editorSession.connect(note.id)).rejects.toThrow(COLLAB_REJECT_NOTE_DELETING);
  });

  it("a refusal leaves one structured log line: noteId/userId/cause/reason, no token (issue #37)", async () => {
    // After issue #6 was fixed, the consequence of a refusal changed from "the user is stuck on connecting (they report it, and the maintainer
    // can watch the screen live)" to "the user is automatically redirected away", and all they'll say is "I was suddenly kicked out".
    // CollabAuthError's message is deliberately left empty (to avoid Hocuspocus's unconditional console.error), so without this log line
    // neither side leaves a single bit.
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth16@example.com", password: PASSWORD });
    const stranger = await ctx.createUser({ email: "stranger-auth16@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("stranger-auth16@example.com", PASSWORD);

    const forgedRole = await signCollabToken(testConfig.appSecret, {
      noteId: note.id,
      userId: stranger.id,
      role: "owner",
      tv: 0,
      sid: testSessionId(stranger.id),
      sv: NOTE_SCHEMA_VERSION,
    });
    await expect(session.connect(note.id, { tokenOverride: forgedRole })).rejects.toThrow(COLLAB_REJECT_FORBIDDEN);

    const line = ctx.collabLogs.find(one => one.obj.cause === "no-role");
    expect(line).toBeDefined();
    expect(line!.level).toBe("info");
    expect(line!.obj).toMatchObject({
      phase: "handshake",
      noteId: note.id,
      userId: stranger.id,
      cause: "no-role",
      reason: COLLAB_REJECT_FORBIDDEN,
    });
    // The fields are a closed set: token content (credentials) must not enter the log.
    expect(Object.keys(line!.obj).sort()).toEqual(["cause", "noteId", "phase", "reason", "userId"]);

    // And `bad-token` **must not** go to info: /collab's upgrade needs no session and Hocuspocus doesn't close the socket on auth failure -
    // trading an empty-token message for an info line would let an anonymous peer decide the log volume.
    const forged = await signCollabToken("f".repeat(64), { noteId: note.id, userId: stranger.id, role: "owner", tv: 0, sid: testSessionId(stranger.id), sv: NOTE_SCHEMA_VERSION });
    await expect(session.connect(note.id, { tokenOverride: forged })).rejects.toThrow(COLLAB_REJECT_INVALID_TOKEN);
    const badToken = ctx.collabLogs.find(one => one.obj.cause === "bad-token");
    expect(badToken?.level).toBe("debug");
  });

  it("onAuthenticate hitting an unexpected exception -> server-error (not revocation), and leaves an error-level log", async () => {
    // This refusal reason leaves a tab stuck on "connecting" forever, the kind the maintainer most needs to find: it must go
    // through the same exit (the `cause` field) as the other refusals, otherwise the grep the docs teach misses exactly it.
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth19@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("owner-auth19@example.com", PASSWORD);

    // First get a valid token (the gate is still fine at this point - it also guards REST's authenticate).
    const tokenRes = await session.fetch(`/api/notes/${note.id}/collab-token`, COLLAB_TOKEN_INIT);
    const { token } = (await tokenRes.json()) as { token: string };

    ctx.breakGate(new Error("db went away"));
    await expect(session.connect(note.id, { tokenOverride: token })).rejects.toThrow(COLLAB_REJECT_SERVER_ERROR);

    const line = ctx.collabLogs.find(one => one.obj.cause === "server-error");
    expect(line?.level).toBe("error");
    // userId must be present (the docs' troubleshooting guide promises every line identifies who, and this is the kind it tells maintainers
    // to grep first) - `claims` is inside the try, so the identity must be hoisted somewhere the catch can see.
    expect(line?.obj).toMatchObject({ noteId: note.id, userId: owner.id, reason: COLLAB_REJECT_SERVER_ERROR });
    expect(line?.obj.err).toBeInstanceOf(Error);
  });

  it("a gate failure is logged as session-revoked, but what the client receives is still invalid-token (the two layers deliberately differ)", async () => {
    // "Account disabled / tokenVersion expired" is for the client just "this token can't be used" - it fetches again, gets 401 and runs the
    // logout flow; but maintainers must be able to tell it apart from "bad signature".
    const ctx = await buildCollabTestApp();
    await ctx.createUser({ email: "admin-auth17@example.com", password: PASSWORD, isAdmin: true });
    const target = await ctx.createUser({ email: "target-auth17@example.com", password: PASSWORD });
    const note = await ctx.createNote(target.id);

    const adminSession = await ctx.loginAs("admin-auth17@example.com", PASSWORD);
    const targetSession = await ctx.loginAs("target-auth17@example.com", PASSWORD);

    // As in the onAuthenticate disabled-account case below: sign a tv=0 token by hand, to avoid the collab-token path caching the gate result first.
    const preDisableToken = await signCollabToken(testConfig.appSecret, {
      noteId: note.id,
      userId: target.id,
      role: "owner",
      tv: 0,
      sid: testSessionId(target.id),
      sv: NOTE_SCHEMA_VERSION,
    });
    expect((await adminSession.fetch(`/api/admin/users/${target.id}/disable`, { method: "POST" })).status).toBe(204);

    await expect(targetSession.connect(note.id, { tokenOverride: preDisableToken })).rejects.toThrow(
      COLLAB_REJECT_INVALID_TOKEN
    );

    const line = ctx.collabLogs.find(one => one.obj.cause === "session-revoked");
    expect(line?.obj).toMatchObject({ noteId: note.id, userId: target.id, reason: COLLAB_REJECT_INVALID_TOKEN });
  });

  it("connectionsOf grows and shrinks correctly after connect/disconnect (two real users)", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth6@example.com", password: PASSWORD });
    const editorUser = await ctx.createUser({ email: "editor-auth6@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    await ctx.share(note.id, editorUser.id, "editor");

    const ownerSession = await ctx.loginAs("owner-auth6@example.com", PASSWORD);
    const editorSession = await ctx.loginAs("editor-auth6@example.com", PASSWORD);

    const ownerClient = await ownerSession.connect(note.id);
    await editorSession.connect(note.id);

    expect(ctx.collab.connectionsOfNote(note.id).size).toBe(2);
    expect(ctx.collab.connectionsOf(owner.id).size).toBe(1);
    expect(ctx.collab.connectionsOf(editorUser.id).size).toBe(1);

    const handle = [...ctx.collab.connectionsOf(owner.id)][0];
    expect(handle.noteId).toBe(note.id);
    expect(handle.userId).toBe(owner.id);

    ownerClient.disconnect();

    await waitFor("owner 斷線後索引移除該連線", 3_000, () => ctx.collab.connectionsOf(owner.id).size === 0);
    expect(ctx.collab.connectionsOfNote(note.id).size).toBe(1);
  });

  it("onTokenSync revalidation: after requestToken sending a post-revocation new token (even when claiming role:'owner') -> connection is closed with COLLAB_CLOSE_REVOKED", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth7@example.com", password: PASSWORD });
    const editorUser = await ctx.createUser({ email: "editor-auth7@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    await ctx.share(note.id, editorUser.id, "editor");

    const ownerSession = await ctx.loginAs("owner-auth7@example.com", PASSWORD);
    const editorSession = await ctx.loginAs("editor-auth7@example.com", PASSWORD);

    let revoked = false;
    const editorClient = await editorSession.connect(note.id, {
      tokenFn: async () => {
        if (revoked) {
          // After revocation still sign a validly signed token claiming role:'owner' - verifies onTokenSync re-runs resolveRole instead of
          // trusting the role in the token (the same applies to the revalidation path).
          return signCollabToken(testConfig.appSecret, { noteId: note.id, userId: editorUser.id, role: "owner", tv: 0, sid: testSessionId(editorUser.id), sv: NOTE_SCHEMA_VERSION });
        }
        const res = await editorSession.fetch(`/api/notes/${note.id}/collab-token`, COLLAB_TOKEN_INIT);
        if (!res.ok) throw new Error(`取得 collab token 失敗（${res.status}）：${await res.text()}`);
        const body = (await res.json()) as { token: string };
        return body.token;
      },
    });

    const delRes = await ownerSession.fetch(`/api/notes/${note.id}/shares/${editorUser.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(204);
    revoked = true;

    const handle = [...ctx.collab.connectionsOf(editorUser.id)][0];
    handle.requestToken();

    await waitFor("撤權後的 onTokenSync 以 COLLAB_CLOSE_REVOKED 關閉該連線", 3_000, () =>
      editorClient.closes.some(one => one.reason === COLLAB_CLOSE_REVOKED)
    );
  });

  it("the onNextTokenSync callback also fires when revalidation is rejected (close), not skipped because of the rejection", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth11@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("owner-auth11@example.com", PASSWORD);

    let swapped = false;
    const client = await session.connect(note.id, {
      tokenFn: async () => {
        if (swapped) {
          // noteId mismatch - guarantees the close branch of onTokenSync is hit (whether via the userId comparison or the noteId comparison,
          // both trigger the same close here; what matters is that this path really is rejected).
          return signCollabToken(testConfig.appSecret, {
            noteId: "00000000-0000-0000-0000-000000000000",
            userId: owner.id,
            role: "owner",
            tv: 0,
            sid: testSessionId(owner.id),
            sv: NOTE_SCHEMA_VERSION,
          });
        }
        const res = await session.fetch(`/api/notes/${note.id}/collab-token`, COLLAB_TOKEN_INIT);
        if (!res.ok) throw new Error(`取得 collab token 失敗（${res.status}）：${await res.text()}`);
        const body = (await res.json()) as { token: string };
        return body.token;
      },
    });

    swapped = true;
    const handle = [...ctx.collab.connectionsOf(owner.id)][0];

    let fired = false;
    ctx.collab.onNextTokenSync(handle, () => {
      fired = true;
    });

    handle.requestToken();

    // Without hoist-take-and-clear-before-verify + dispatch in finally, `handle.close()` would synchronously trigger unregister(), which deletes
    // this key from tokenSyncCallbacks first, so `fired` would never become true here (timeout) - the regression this test catches.
    await waitFor("重驗被拒的路徑仍觸發 onNextTokenSync 回呼", 3_000, () => fired);
    await waitFor("連線確實被 close(COLLAB_CLOSE_REVOKED)（不是誤判其他成功路徑）", 3_000, () =>
      client.closes.some(one => one.reason === COLLAB_CLOSE_REVOKED)
    );
  });

  it("onAuthenticate: after the account is disabled (tv bump + gate.invalidate), reconnecting with a token signed before disabling is refused", async () => {
    const ctx = await buildCollabTestApp();
    await ctx.createUser({ email: "admin-auth12@example.com", password: PASSWORD, isAdmin: true });
    const target = await ctx.createUser({ email: "target-auth12@example.com", password: PASSWORD });
    const note = await ctx.createNote(target.id);

    const adminSession = await ctx.loginAs("admin-auth12@example.com", PASSWORD);
    const targetSession = await ctx.loginAs("target-auth12@example.com", PASSWORD);

    // Hand-sign a valid token before disabling (tv=0, not yet bumped) - deliberately not via `POST .../collab-token`: that path first calls
    // `gate.check` through `authenticate` and caches the "not yet disabled" result (TTL 60s), making the disabling below look ineffective
    // (hitting the same cache trap instead of verifying what we want to test).
    const preDisableToken = await signCollabToken(testConfig.appSecret, {
      noteId: note.id,
      userId: target.id,
      role: "owner",
      tv: 0,
      sid: testSessionId(target.id),
      sv: NOTE_SCHEMA_VERSION,
    });

    const disableRes = await adminSession.fetch(`/api/admin/users/${target.id}/disable`, { method: "POST" });
    expect(disableRes.status).toBe(204);

    // resolveRole still judges the target as owner (disabling doesn't affect note ownership) - so failing here can only be because gate.check
    // judges revoked (tv mismatch), precisely hitting the gate branch of server.ts.
    await expect(targetSession.connect(note.id, { tokenOverride: preDisableToken })).rejects.toThrow(
      COLLAB_REJECT_INVALID_TOKEN
    );
  });

  it("onTokenSync: a connected user who gets disabled -> revalidation (the same old-tv token) -> close(COLLAB_CLOSE_REVOKED)", async () => {
    const ctx = await buildCollabTestApp();
    await ctx.createUser({ email: "admin-auth13@example.com", password: PASSWORD, isAdmin: true });
    const target = await ctx.createUser({ email: "target-auth13@example.com", password: PASSWORD });
    const note = await ctx.createNote(target.id);

    const adminSession = await ctx.loginAs("admin-auth13@example.com", PASSWORD);
    const targetSession = await ctx.loginAs("target-auth13@example.com", PASSWORD);

    // Always connect with the same token (still valid at this point, tv=0), and resend that same one on every later requestToken - so the only
    // variable that changes after disabling is tv/disabledAt in the DB, precisely isolating the gate.check branch of onTokenSync
    // (role will still be 'owner', unaffected by disabling).
    const fixedToken = await signCollabToken(testConfig.appSecret, {
      noteId: note.id,
      userId: target.id,
      role: "owner",
      tv: 0,
      sid: testSessionId(target.id),
      sv: NOTE_SCHEMA_VERSION,
    });

    const targetClient = await targetSession.connect(note.id, { tokenFn: async () => fixedToken });

    const disableRes = await adminSession.fetch(`/api/admin/users/${target.id}/disable`, { method: "POST" });
    expect(disableRes.status).toBe(204);

    const handle = [...ctx.collab.connectionsOf(target.id)][0];
    handle.requestToken();

    await waitFor("停用後重驗被 close(COLLAB_CLOSE_REVOKED)", 3_000, () =>
      targetClient.closes.some(one => one.reason === COLLAB_CLOSE_REVOKED)
    );
  });

  it("onTokenSync: revalidation with a validly signed token of another user who really has permission is still treated as impersonation and closed; identity takeover isn't accepted", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth14@example.com", password: PASSWORD });
    const editorUser = await ctx.createUser({ email: "editor-auth14@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    // editorUser has **real** legitimate permission on this note - if the userId comparison were removed, resolveRole/gate.check would both pass
    // for editorUser, and the owner's connection would be silently taken over as editorUser's identity/permissions without being closed, so the test
    // really fails (any random role:none stranger would produce the same close and couldn't tell whether the comparison itself works).
    await ctx.share(note.id, editorUser.id, "editor");

    const ownerSession = await ctx.loginAs("owner-auth14@example.com", PASSWORD);

    let swapped = false;
    const ownerClient = await ownerSession.connect(note.id, {
      tokenFn: async () => {
        if (swapped) {
          return signCollabToken(testConfig.appSecret, {
            noteId: note.id,
            userId: editorUser.id,
            role: "editor",
            tv: 0,
            sid: testSessionId(editorUser.id),
            sv: NOTE_SCHEMA_VERSION,
          });
        }
        const res = await ownerSession.fetch(`/api/notes/${note.id}/collab-token`, COLLAB_TOKEN_INIT);
        if (!res.ok) throw new Error(`取得 collab token 失敗（${res.status}）：${await res.text()}`);
        const body = (await res.json()) as { token: string };
        return body.token;
      },
    });

    swapped = true;
    const handle = [...ctx.collab.connectionsOf(owner.id)][0];
    handle.requestToken();

    await waitFor("借殼身分的 token 被 close(COLLAB_CLOSE_REVOKED)，owner 的連線沒有被 editorUser 接管", 3_000, () =>
      ownerClient.closes.some(one => one.reason === COLLAB_CLOSE_REVOKED)
    );

    // This line must be visible: a bad-token at handshake goes to debug (log amplifier for anonymous sockets), but a bad-token at **revalidation**
    // kicks an already authenticated connection - the user sees "you lost access" and is redirected away - and the identity is already known.
    const line = ctx.collabLogs.find(one => one.obj.phase === "reverify" && one.obj.cause === "bad-token");
    expect(line?.level).toBe("info");
    expect(line?.obj).toMatchObject({ noteId: note.id, userId: owner.id });
  });

  it("#240 connecting with an uppercase documentName is refused (the token was signed from the same uppercase id, claims already lowercase)", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-r7@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("owner-r7@example.com", PASSWORD);
    // The default token logic = POST /api/notes/<uppercase>/collab-token, then the same uppercase string as the documentName.
    await expect(session.connect(note.id.toUpperCase())).rejects.toThrow(COLLAB_REJECT_INVALID_TOKEN);
    expect(ctx.collab.hocuspocus.documents.has(note.id.toUpperCase())).toBe(false);
  });
});

/**
 * issue #50: a signed-in user floods a legitimate connection with messages that can't be handled (unknown message type / non-Token Auth subtype) -
 * Hocuspocus only console.errors and carries on, the connection never closes and no throttle of ours applies. The message precheck (classifyClientMessage)
 * swallows and counts them before they reach Hocuspocus, and after BOGUS_MESSAGE_LIMIT messages terminates the connection, leaving one log line with process-wide throttling.
 */
describe("message precheck: flooding unknown types -> forced disconnect (issue #50)", () => {
  /** Hand-built wire message (varString(docName) + varUint(type)) - same method as the unit test. */
  function bogusFrame(docName: string, type: number): Uint8Array {
    const name = new TextEncoder().encode(docName);
    return new Uint8Array([name.length, ...name, type]);
  }

  it("type with no handler on a legitimate connection (9=Ping, the one that reproduced #50): disconnect at the limit, exactly one log line, other connections on the same document keep syncing", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "flood-owner@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("flood-owner@example.com", PASSWORD);
    const flooder = await session.connect(note.id);
    const bystander = await session.connect(note.id);
    expect(ctx.collab.connectionsOfNote(note.id).size).toBe(2);

    // Take the flooder's underlying ws (the provider explicitly holds websocketProvider, whose webSocket is the real socket).
    const rawWs = (flooder.provider.configuration as unknown as { websocketProvider: { webSocket: { send(d: Uint8Array): void } } })
      .websocketProvider.webSocket;

    // type 9 (Ping) has a name in the enum but no case in MessageReceiver's switch - exactly the kind that "using the enum range as an
    // allow list" can't stop.
    for (let i = 0; i < 10; i += 1) rawWs.send(bogusFrame(note.id, 9));

    // terminate is a hard disconnect by the server - wait for the flooder's connection to vanish from the index.
    await waitFor("flooder 連線被強制斷線", 5_000, () => ctx.collab.connectionsOfNote(note.id).size === 1);

    const lines = ctx.collabLogs.filter(one => one.msg.includes("強制斷線") && !one.msg.includes("上限"));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.obj).toMatchObject({ noteId: note.id, bogusCount: 10, lastType: 9 });

    // The other connection on the same document isn't just alive, it really syncs: after writing, wait until the server-side document converges
    // to the same state vector (as in collab-sync's convergence assertions, no fixed sleep).
    insertParagraph(bystander.doc, "bystander still syncing");
    const serverDoc = () => ctx.collab.hocuspocus.documents.get(note.id);
    await waitFor("bystander 的編輯同步到 server", 5_000, () => {
      const doc = serverDoc();
      return doc !== undefined && stateVector(doc) === stateVector(bystander.doc);
    });
    expect(ctx.collab.connectionsOfNote(note.id).size).toBe(1);
  });

  it("fewer than the limit of no-handler types doesn't disconnect (grace for rolling upgrades), a legitimate Sync still passes", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "flood-owner2@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("flood-owner2@example.com", PASSWORD);
    const client = await session.connect(note.id);

    const rawWs = (client.provider.configuration as unknown as { websocketProvider: { webSocket: { send(d: Uint8Array): void } } })
      .websocketProvider.webSocket;
    for (let i = 0; i < 5; i += 1) rawWs.send(bogusFrame(note.id, 99));

    // The connection can still edit normally - real sync convergence is the evidence of "not disconnected" (stronger than a fixed sleep: it also
    // proves legitimate Sync messages pass the precheck and 5 bogus messages didn't trigger terminate).
    insertParagraph(client.doc, "still editable");
    const serverDoc = () => ctx.collab.hocuspocus.documents.get(note.id);
    await waitFor("編輯同步到 server（連線未被斷）", 5_000, () => {
      const doc = serverDoc();
      return doc !== undefined && stateVector(doc) === stateVector(client.doc);
    });
    expect(ctx.collab.connectionsOfNote(note.id).size).toBe(1);
    expect(ctx.collabLogs.filter(one => one.msg.includes("強制斷線"))).toHaveLength(0);
  });
});

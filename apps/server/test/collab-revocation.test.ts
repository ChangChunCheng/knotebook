import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { COLLAB_CLOSE_NOTE_DELETED, COLLAB_CLOSE_REVOKED, YDOC_FRAGMENT, type Role } from "@knotebook/shared";
import { COLLAB_REJECT_FORBIDDEN, COLLAB_REJECT_NOTE_DELETING } from "../src/collab/server.js";
import { createCollabHooks, REVERIFY_DEADLINE_MS } from "../src/collab/hooks-impl.js";
import { buildCollabTestApp, COLLAB_TOKEN_INIT, type CollabTestCtx, type HttpSession } from "./helpers.js";

const PASSWORD = "correct-horse-battery";

/**
 * Always builds the app with the **real** CollabHooks. The default `noopCollabHooks` would turn the call sites of shares PUT/DELETE, admin disable, password change
 * and notes DELETE into no-ops - the revocation path would never trigger and every assertion would be meaninglessly green (all it measures is "nobody touched this connection").
 */
function buildApp(): Promise<CollabTestCtx> {
  return buildCollabTestApp({ collabHooks: (server, log) => createCollabHooks(server, log) });
}

/**
 * Polls until the condition holds (as in collab-sync/collab-auth): collaboration converges asynchronously, so assertions can't use a fixed
 * sleep nor check only once - always poll within a deadline and fail with the label on timeout.
 */
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

function stateVector(doc: Y.Doc): string {
  return Buffer.from(Y.encodeStateVector(doc)).toString("hex");
}

function insertParagraph(doc: Y.Doc, text: string): void {
  const element = new Y.XmlElement("paragraph");
  element.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [element]);
}

/** Gets a token via the real `POST /api/notes/:id/collab-token` (counts against the per-user limiter). */
async function fetchToken(session: HttpSession, noteId: string): Promise<string> {
  const res = await session.fetch(`/api/notes/${noteId}/collab-token`, COLLAB_TOKEN_INIT);
  if (!res.ok) throw new Error(`取得 collab token 失敗（${res.status}）：${await res.text()}`);
  const body = (await res.json()) as { token: string; role: Role };
  return body.token;
}

/**
 * End-to-end verification of the revocation SLA (share revoked <= 10 s). Every "how soon after revocation does it take effect" assertion is <= 10 s -
 * the promised upper bound; the real mechanism is "requestToken + 5 s deadline", normally far faster.
 */
describe("revocation SLA: CollabHooks", () => {
  it("share revoked: the revoked user receives CLOSE(revoked) and later edits aren't persisted; another editor on the same document is unaffected (must not broadcast to the whole note)", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-case1@example.com", password: PASSWORD });
    const victim = await ctx.createUser({ email: "victim-case1@example.com", password: PASSWORD });
    const bystander = await ctx.createUser({ email: "bystander-case1@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    await ctx.share(note.id, victim.id, "editor");
    await ctx.share(note.id, bystander.id, "editor");

    const ownerSession = await ctx.loginAs("owner-case1@example.com", PASSWORD);
    const victimSession = await ctx.loginAs("victim-case1@example.com", PASSWORD);
    const bystanderSession = await ctx.loginAs("bystander-case1@example.com", PASSWORD);

    const ownerClient = await ownerSession.connect(note.id);
    const victimClient = await victimSession.connect(note.id);
    const bystanderClient = await bystanderSession.connect(note.id);

    const started = Date.now();
    const delRes = await ownerSession.fetch(`/api/notes/${note.id}/shares/${victim.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(204);

    await waitFor("被撤者收到 CLOSE(knotebook:revoked)", 10_000, () =>
      victimClient.closes.some(one => one.reason === COLLAB_CLOSE_REVOKED)
    );
    expect(Date.now() - started).toBeLessThan(10_000);

    // Later edits aren't persisted - the server has removed that connection from the document, so later update messages aren't applied
    // and thus aren't broadcast to anyone still online.
    insertParagraph(victimClient.doc, "from revoked user");
    await sleep(1_000);
    expect(ownerClient.doc.getXmlFragment(YDOC_FRAGMENT).toString()).not.toContain("from revoked user");
    expect(bystanderClient.doc.getXmlFragment(YDOC_FRAGMENT).toString()).not.toContain("from revoked user");

    // The other editor on the same document is completely unaffected (not closed, and can still write and converge).
    expect(bystanderClient.closes).toEqual([]);
    insertParagraph(bystanderClient.doc, "from bystander");
    await waitFor(
      "未被撤權的 editor 仍可寫入並收斂到 owner",
      10_000,
      () => stateVector(ownerClient.doc) === stateVector(bystanderClient.doc)
    );
    expect(ownerClient.doc.getXmlFragment(YDOC_FRAGMENT).toString()).toContain("from bystander");
  });

  it("uncooperative client (no response to the token request after auth): closed with close(revoked) when the 5 s deadline expires", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-case2@example.com", password: PASSWORD });
    const victim = await ctx.createUser({ email: "victim-case2@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    await ctx.share(note.id, victim.id, "editor");

    const ownerSession = await ctx.loginAs("owner-case2@example.com", PASSWORD);
    const victimSession = await ctx.loginAs("victim-case2@example.com", PASSWORD);

    // The first (connection) token is obtained normally; every call triggered later by the server's requestToken returns a promise that **never resolves** -
    // so the provider never sends an AuthenticationMessage, equivalent to a non-cooperative client that doesn't respond to the token request message
    // after the auth handshake. What strips this connection is then the deadline timer.
    let uncooperative = false;
    const victimClient = await victimSession.connect(note.id, {
      tokenFn: async () => {
        if (uncooperative) return new Promise<string>(() => {});
        return fetchToken(victimSession, note.id);
      },
    });
    uncooperative = true;

    const started = Date.now();
    const delRes = await ownerSession.fetch(`/api/notes/${note.id}/shares/${victim.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(204);

    await waitFor("不合作的 client 仍在 SLA 內被 close(knotebook:revoked)", 10_000, () =>
      victimClient.closes.some(one => one.reason === COLLAB_CLOSE_REVOKED)
    );

    // Lower-bound assertion: the close must be caused by the deadline expiring, not by some token round-trip path - if the implementation set the deadline too short
    // (or just closed without waiting for the client) this fails. A timer can't fire earlier than its set value, so the lower bound is safe;
    // the upper bound is covered by the SLA assertion above.
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(REVERIFY_DEADLINE_MS - 500);

    // Deadline expiry is the path where a **legitimate user is most likely to be kicked by mistake** (the client was merely stuck in token backoff and couldn't answer
    // within 5 seconds) while the user sees "you lost access" - it must leave a signal (issue #37).
    const line = ctx.collabLogs.find(one => one.obj.phase === "deadline");
    expect(line?.level).toBe("info");
    expect(line?.obj).toMatchObject({ cause: "no-reverify", noteId: note.id, userId: victim.id });
  });

  it("revocation during a connection (onTokenSync closing the connection) also leaves a phase:'reverify' log (issue #37)", async () => {
    // "Why was I suddenly kicked out" most often comes from this path, not the handshake - the docs' troubleshooting guide tells maintainers
    // to grep `"cause"`, so it must be greppable.
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-case9@example.com", password: PASSWORD });
    const editorUser = await ctx.createUser({ email: "editor-case9@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    await ctx.share(note.id, editorUser.id, "editor");

    const ownerSession = await ctx.loginAs("owner-case9@example.com", PASSWORD);
    const editorSession = await ctx.loginAs("editor-case9@example.com", PASSWORD);
    const editorClient = await editorSession.connect(note.id);

    const del = await ownerSession.fetch(`/api/notes/${note.id}/shares/${editorUser.id}`, { method: "DELETE" });
    expect(del.status).toBe(204);

    await waitFor("被撤者收到 CLOSE(revoked)", 10_000, () =>
      editorClient.closes.some(one => one.reason === COLLAB_CLOSE_REVOKED)
    );
    const line = ctx.collabLogs.find(one => one.obj.phase === "reverify");
    expect(line?.level).toBe("info");
    expect(line?.obj).toMatchObject({ noteId: note.id, userId: editorUser.id, cause: "no-role" });
  });

  it("disabled user: that user's connections on two different notes are both stripped (across documents)", async () => {
    const ctx = await buildApp();
    await ctx.createUser({ email: "admin-case3@example.com", password: PASSWORD, isAdmin: true });
    const owner = await ctx.createUser({ email: "owner-case3@example.com", password: PASSWORD });
    const target = await ctx.createUser({ email: "target-case3@example.com", password: PASSWORD });
    // One of their own, one shared - only across documents can it be tested that onUserRevoked goes through connectionsOf(userId)
    // rather than one document's connection list.
    const ownNote = await ctx.createNote(target.id);
    const sharedNote = await ctx.createNote(owner.id);
    await ctx.share(sharedNote.id, target.id, "editor");

    const adminSession = await ctx.loginAs("admin-case3@example.com", PASSWORD);
    const targetSession = await ctx.loginAs("target-case3@example.com", PASSWORD);

    const ownClient = await targetSession.connect(ownNote.id);
    const sharedClient = await targetSession.connect(sharedNote.id);
    expect(ctx.collab.connectionsOf(target.id).size).toBe(2);

    const started = Date.now();
    const disableRes = await adminSession.fetch(`/api/admin/users/${target.id}/disable`, { method: "POST" });
    expect(disableRes.status).toBe(204);

    // After disabling, the user gets 401 even on the token endpoint (gate.invalidate + tv bump), and the provider's token function can't get a token so nothing is sent back -
    // this connection is therefore stripped via the deadline branch. Connections on both notes must drop within the SLA.
    await waitFor("自有筆記的連線被 close(knotebook:revoked)", 10_000, () =>
      ownClient.closes.some(one => one.reason === COLLAB_CLOSE_REVOKED)
    );
    await waitFor("被分享筆記的連線被 close(knotebook:revoked)", 10_000, () =>
      sharedClient.closes.some(one => one.reason === COLLAB_CLOSE_REVOKED)
    );
    expect(Date.now() - started).toBeLessThan(10_000);

    await waitFor("兩條連線都已從索引移除", 10_000, () => ctx.collab.connectionsOf(target.id).size === 0);
  });

  it("#286: setting a new password via a reset link -> the user's existing collab connections are closed with close(knotebook:revoked) within 10 seconds", async () => {
    const ctx = await buildApp();
    await ctx.createUser({ email: "admin-case14@example.com", password: PASSWORD, isAdmin: true });
    const target = await ctx.createUser({ email: "target-case14@example.com", password: PASSWORD });
    const note = await ctx.createNote(target.id);

    const adminSession = await ctx.loginAs("admin-case14@example.com", PASSWORD);
    const targetSession = await ctx.loginAs("target-case14@example.com", PASSWORD);
    const client = await targetSession.connect(note.id);
    expect(ctx.collab.connectionsOf(target.id).size).toBe(1);

    const issued = await adminSession.fetch(`/api/admin/users/${target.id}/password-reset`, {
      method: "POST",
      body: JSON.stringify({ expiresInHours: 1 }),
    });
    expect(issued.status).toBe(201);
    const { token } = (await issued.json()) as { token: string };

    const started = Date.now();
    // No-login endpoint: no cookie at all.
    const done = await fetch(`${ctx.baseUrl}/api/auth/password-reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, newPassword: "brand-new-password-286" }),
    });
    expect(done.status).toBe(200);

    await waitFor("重設後既有連線被 close(knotebook:revoked)", 10_000, () =>
      client.closes.some(one => one.reason === COLLAB_CLOSE_REVOKED)
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    await waitFor("連線已從索引移除", 10_000, () => ctx.collab.connectionsOf(target.id).size === 0);
  });

  it("token endpoint temporarily 5xx: during the client's retry the server not yet having the revalidation result doesn't kill by mistake (the timer is revoked when it returns within the deadline)", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-case4@example.com", password: PASSWORD });
    const editorUser = await ctx.createUser({ email: "editor-case4@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    await ctx.share(note.id, editorUser.id, "editor");

    const ownerSession = await ctx.loginAs("owner-case4@example.com", PASSWORD);
    const editorSession = await ctx.loginAs("editor-case4@example.com", PASSWORD);

    // The first token fetch during revalidation simulates hitting a 5xx: the client's retry strategy waits 1.5 s and calls the endpoint again (really again).
    // 1.5 s < 5 s deadline, and this connection's permissions haven't changed at all, so it must not be closed.
    let armed = false;
    let attempts = 0;
    const ownerClient = await ownerSession.connect(note.id);
    const editorClient = await editorSession.connect(note.id, {
      tokenFn: async () => {
        if (armed) {
          attempts += 1;
          if (attempts === 1) await sleep(1_500);
        }
        return fetchToken(editorSession, note.id);
      },
    });
    armed = true;

    // The role doesn't change (editor -> editor), but PUT /shares always calls onShareChanged - revalidation succeeds,
    // used purely to push this connection into the "requestToken + deadline" flow.
    const putRes = await ownerSession.fetch(`/api/notes/${note.id}/shares`, {
      method: "PUT",
      body: JSON.stringify({ email: "editor-case4@example.com", role: "editor" }),
    });
    expect(putRes.status).toBe(200);

    // Assert only after the deadline has passed: if the timer wasn't revoked by onNextTokenSync (or the revoked timer was another connection's),
    // a revoked entry would show up here.
    await sleep(REVERIFY_DEADLINE_MS + 1_500);
    expect(editorClient.closes).toEqual([]);
    expect(attempts).toBeGreaterThanOrEqual(1);

    // The connection is not only "not closed" but still really usable.
    insertParagraph(editorClient.doc, "still editing");
    await waitFor("未被誤殺的連線仍可寫入並收斂到 owner", 10_000, () =>
      ownerClient.doc.getXmlFragment(YDOC_FRAGMENT).toString().includes("still editing")
    );
  });

  it("limiter boundary: the user has used 59/60 collab-token quota, and revocation revalidation still completes within the deadline (not dragged down by throttling)", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-case5@example.com", password: PASSWORD });
    const victim = await ctx.createUser({ email: "victim-case5@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    await ctx.share(note.id, victim.id, "editor");

    const ownerSession = await ctx.loginAs("owner-case5@example.com", PASSWORD);
    const victimSession = await ctx.loginAs("victim-case5@example.com", PASSWORD);

    // The connection itself uses up the 1st quota.
    const victimClient = await victimSession.connect(note.id);

    // Then burn 58 more by hand -> cumulative 59/60, so the revalidation is exactly the 60th (still within the limit).
    for (let i = 0; i < 58; i += 1) {
      const res = await victimSession.fetch(`/api/notes/${note.id}/collab-token`, COLLAB_TOKEN_INIT);
      expect(res.status).toBe(200);
    }

    const started = Date.now();
    const delRes = await ownerSession.fetch(`/api/notes/${note.id}/shares/${victim.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(204);

    await waitFor("配額邊界上的重驗仍以 close(knotebook:revoked) 收場", 10_000, () =>
      victimClient.closes.some(one => one.reason === COLLAB_CLOSE_REVOKED)
    );

    // Upper-bound assertion: this close must come from "the token really came back and revalidation judged no permission", not from the deadline fallback path -
    // the latter means the client couldn't get a token at the quota boundary (the SLA still holds but is 5 seconds slower, and the nature is
    // "speculative stripping" rather than "stripping after verification").
    expect(Date.now() - started).toBeLessThan(REVERIFY_DEADLINE_MS - 500);

    // Corroborates that the quota really was used up to the 60th (the revalidation also went through the same endpoint): the next one exceeds the limit.
    const overRes = await victimSession.fetch(`/api/notes/${note.id}/collab-token`, COLLAB_TOKEN_INIT);
    expect(overRes.status).toBe(429);
  });

  it("deleting a note: connected users receive CLOSE(note-deleted), DELETE returns 204 within the SLA, reconnecting during deletion is refused, after deletion the token is 200+role:'none' but can't connect, GET 404", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-case6@example.com", password: PASSWORD });
    const editorUser = await ctx.createUser({ email: "editor-case6@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    await ctx.share(note.id, editorUser.id, "editor");

    const ownerSession = await ctx.loginAs("owner-case6@example.com", PASSWORD);
    const editorSession = await ctx.loginAs("editor-case6@example.com", PASSWORD);

    const ownerClient = await ownerSession.connect(note.id);
    const editorClient = await editorSession.connect(note.id);
    insertParagraph(ownerClient.doc, "doomed content");
    await waitFor("兩端先收斂（確保文件真的在記憶體中且有內容）", 10_000, () =>
      editorClient.doc.getXmlFragment(YDOC_FRAGMENT).toString().includes("doomed content")
    );

    const started = Date.now();
    const delRes = await ownerSession.fetch(`/api/notes/${note.id}`, { method: "DELETE" });
    const elapsed = Date.now() - started;

    // DELETE must not hang (the polling in beforeNoteDeleted has an upper bound; on timeout it logs an error and lets it through).
    expect(delRes.status).toBe(204);
    expect(elapsed).toBeLessThan(10_000);

    await waitFor("owner 端收到 CLOSE(knotebook:note-deleted)", 10_000, () =>
      ownerClient.closes.some(one => one.reason === COLLAB_CLOSE_NOTE_DELETED)
    );
    await waitFor("editor 端收到 CLOSE(knotebook:note-deleted)", 10_000, () =>
      editorClient.closes.some(one => one.reason === COLLAB_CLOSE_NOTE_DELETED)
    );
    expect(ctx.collab.connectionsOfNote(note.id).size).toBe(0);
    expect(ctx.collab.hocuspocus.documents.has(note.id)).toBe(false);

    // The deleting gate is still in place (within TTL, see DELETING_GATE_TTL_MS): a reconnect now is always refused with note-deleting.
    // Deliberately tested after the DELETE response rather than concurrently with it - the relative timing depends on each side's own DB round trips
    // and would be a nondeterministic test; the gate's TTL keeps the "being deleted" state after the response, so what is tested here is the same gate
    // and the same refusal path.
    await expect(editorSession.connect(note.id)).rejects.toThrow(COLLAB_REJECT_NOTE_DELETING);

    // Contract: for "has a session but no permission on that note (including deleted)", the token endpoint always returns 200 + role:'none',
    // never an error status (not a permission-probing oracle).
    const tokenRes = await editorSession.fetch(`/api/notes/${note.id}/collab-token`, COLLAB_TOKEN_INIT);
    expect(tokenRes.status).toBe(200);
    const tokenBody = (await tokenRes.json()) as { token: string; role: Role };
    expect(tokenBody.role).toBe("none");

    // After the gate expires (simulating TTL expiry) this token still can't connect: what stops it is onAuthenticate re-running resolveRole
    // (note in the trash -> 'none', #181), not the deleting gate. The reason is therefore `forbidden` - identical to "the note exists but you have no permission",
    // so existence can't be asked (the trade-off of issue #35: the "note was deleted" message is the gate's job within the TTL, see DELETING_GATE_TTL_MS).
    ctx.collab.unmarkDeleting(note.id);
    await expect(editorSession.connect(note.id, { tokenOverride: tokenBody.token })).rejects.toThrow(
      COLLAB_REJECT_FORBIDDEN
    );

    const getRes = await editorSession.fetch(`/api/notes/${note.id}`);
    expect(getRes.status).toBe(404);
  });

  for (const variant of ["upper-note", "upper-user"] as const) {
    it(`#240 DELETE /shares with an uppercase${variant === "upper-note" ? " :id" : " :userId"}: the revoked user gets CLOSE(revoked) within 10 seconds, bystanders unaffected`, async () => {
      const ctx = await buildApp();
      const tag = `r4${variant}`;
      const owner = await ctx.createUser({ email: `owner-${tag}@example.com`, password: PASSWORD });
      const victim = await ctx.createUser({ email: `victim-${tag}@example.com`, password: PASSWORD });
      const bystander = await ctx.createUser({ email: `by-${tag}@example.com`, password: PASSWORD });
      const note = await ctx.createNote(owner.id);
      await ctx.share(note.id, victim.id, "editor");
      await ctx.share(note.id, bystander.id, "editor");
      const ownerSession = await ctx.loginAs(`owner-${tag}@example.com`, PASSWORD);
      const victimClient = await (await ctx.loginAs(`victim-${tag}@example.com`, PASSWORD)).connect(note.id);
      const bystanderClient = await (await ctx.loginAs(`by-${tag}@example.com`, PASSWORD)).connect(note.id);
      const noteSeg = variant === "upper-note" ? note.id.toUpperCase() : note.id;
      const userSeg = variant === "upper-user" ? victim.id.toUpperCase() : victim.id;
      const del = await ownerSession.fetch(`/api/notes/${noteSeg}/shares/${userSeg}`, { method: "DELETE" });
      expect(del.status).toBe(204);
      await waitFor("被撤者收到 CLOSE(revoked)", 10_000, () => victimClient.closes.some(c => c.reason === COLLAB_CLOSE_REVOKED));
      await sleep(1_000);
      expect(bystanderClient.closes).toEqual([]);
    });
  }

  it("#240 DELETE /api/notes/<uppercase>: online users receive CLOSE(note-deleted)", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-r8@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const ownerSession = await ctx.loginAs("owner-r8@example.com", PASSWORD);
    const ownerClient = await ownerSession.connect(note.id);
    const del = await ownerSession.fetch(`/api/notes/${note.id.toUpperCase()}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    await waitFor("在線者收到 CLOSE(note-deleted)", 10_000, () => ownerClient.closes.some(c => c.reason === COLLAB_CLOSE_NOTE_DELETED));
    expect(ctx.collab.hocuspocus.documents.has(note.id)).toBe(false);
  });
});

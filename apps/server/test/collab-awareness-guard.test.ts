// #312: collaborators can no longer forge awareness. The server rebuilds each state from "who this connection is" and only accepts valid cursors,
// not letting a connection rewrite someone else's, the server's or too many clientIDs. Forgery is always sent from the underlying socket as hand-built messages
// (`awareness-wire.ts`); normal updates go through the provider. For "nothing arrived" scenarios, the same sender then sends a valid marker update and the assertion waits for it -
// messages on one socket are processed in order, so the marker arriving means the earlier one has been handled.
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { inArray } from "drizzle-orm";
import { WebSocket } from "ws";
import { SITE_LIMITS, YDOC_FRAGMENT, collabUserColor } from "@knotebook/shared";
import { createCollabHooks } from "../src/collab/hooks-impl.js";
import { users } from "../src/db/schema.js";
import { presenceClientId } from "../src/notes/editing/presence.js";
import { collabMaxPayloadBytes } from "../src/notes/note-size.js";
import { buildCollabTestApp, testConfig, type TestClient } from "./helpers.js";
import { getContent, seedTokenForUser, tick, waitFor } from "./editing-helpers.js";
import { awarenessFrame, sendRaw } from "./awareness-wire.js";

const PASSWORD = "correct-horse-battery";
const WARN_MSG = "collab awareness 含不合規內容，已丟棄或改寫";

type Peer =
  | { user?: { id?: string; name?: string; color?: string }; knotebook?: { kind?: string; role?: string }; cursor?: unknown }
  | undefined;

const idOf = (c: TestClient): number => c.provider.awareness!.clientID;
const peer = (observer: TestClient, clientId: number): Peer => observer.provider.awareness!.getStates().get(clientId) as Peer;
const clockAt = (observer: TestClient, clientId: number): number | undefined => observer.provider.awareness!.meta.get(clientId)?.clock;
/** awareness goes through JSON: convert Yjs objects to the same plain JSON before comparing. */
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Sent cursor -> what the server is expected to forward (normalized, no null fields). */
const expectedCursor = new WeakMap<object, unknown>();
const sameCursor = (observed: unknown, sent: object): boolean => {
  if (!expectedCursor.has(sent)) throw new Error("sameCursor: no expected cursor recorded for this sent cursor");
  return isDeepStrictEqual(observed, expectedCursor.get(sent));
};

/**
 * Builds a real cursor with Yjs on the client's own doc: the index-th character of the first text (the text is written on the first call).
 * What is sent is the shape y-prosemirror actually sends: the RelativePosition object itself (unused type/tname/item are null),
 * not the result of relativePositionToJSON. With `root`, the position of the root fragment is used instead (tname set, type null).
 */
function yCursor(doc: Y.Doc, index: number, root = false): { anchor: unknown; head: unknown } {
  const fragment = doc.getXmlFragment(YDOC_FRAGMENT);
  if (fragment.length === 0 && !root) {
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("0123456789".repeat(5))]);
    fragment.insert(0, [paragraph]);
  }
  const target = root ? fragment : ((fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText);
  const rel = Y.createRelativePositionFromTypeIndex(target, index);
  const wire = plain({ anchor: rel, head: rel });
  expectedCursor.set(wire, plain({ anchor: Y.relativePositionToJSON(rel), head: Y.relativePositionToJSON(rel) }));
  return wire;
}

async function scene(tag: string, opts: Parameters<typeof buildCollabTestApp>[0] = {}) {
  const ctx = await buildCollabTestApp(opts);
  const email = (who: string) => `${who}-${tag}@example.com`;
  const A = await ctx.createUser({ email: email("owner"), password: PASSWORD });
  const B = await ctx.createUser({ email: email("editor"), password: PASSWORD });
  const C = await ctx.createUser({ email: email("other"), password: PASSWORD });
  const V = await ctx.createUser({ email: email("viewer"), password: PASSWORD });
  const note = await ctx.createNote(A.id);
  await ctx.share(note.id, B.id, "editor");
  await ctx.share(note.id, C.id, "editor");
  await ctx.share(note.id, V.id, "viewer");
  const rows = await ctx.db
    .select({ id: users.id, displayName: users.displayName, handle: users.handle })
    .from(users)
    .where(inArray(users.id, [A.id, B.id, C.id, V.id]));
  const row = (id: string) => rows.find(r => r.id === id)!;

  const sessionA = await ctx.loginAs(email("owner"), PASSWORD);
  const sessionB = await ctx.loginAs(email("editor"), PASSWORD);
  const a = await sessionA.connect(note.id);
  const b = await sessionB.connect(note.id);
  // Each sets user in the shape the web does; starts only after they see each other (both clientIDs are already registered on their own connections)
  a.provider.setAwarenessField("user", { id: A.id, name: "A", color: "#000000" });
  b.provider.setAwarenessField("user", { id: B.id, name: "B", color: "#000000" });
  await waitFor("A 看到 B", 5_000, () => peer(a, idOf(b))?.user?.id === B.id);
  await waitFor("B 看到 A", 5_000, () => peer(b, idOf(a))?.user?.id === A.id);

  const warns = () => ctx.collabLogs.filter(l => l.level === "warn" && l.msg === WARN_MSG);
  const warnIssues = () => warns().flatMap(l => l.obj.issues as string[]);
  const connectAs = async (who: "other" | "viewer" | "editor") => (await ctx.loginAs(email(who), PASSWORD)).connect(note.id);

  let markers = 0;
  /** sender sends a valid marker cursor and waits for observer to see it - everything sent from sender before is handled by then. */
  async function mark(sender: TestClient, observer: TestClient): Promise<void> {
    markers += 1;
    const cursor = yCursor(sender.doc, markers);
    sender.provider.setAwarenessField("cursor", cursor);
    await waitFor(`標記 ${markers} 到達`, 5_000, () => sameCursor(peer(observer, idOf(sender))?.cursor, cursor));
  }

  return { ctx, A, B, C, V, note, row, email, sessionA, sessionB, a, b, warns, warnIssues, connectAs, mark };
}

describe("collab awareness forgery protection (#312)", () => {
  it("self-reported user/knotebook/extra fields are all replaced by server values, valid cursor forwarded as is; logs one user-mismatch line", async () => {
    const s = await scene("aw1");
    const cursor = yCursor(s.b.doc, 4);
    s.b.provider.awareness!.setLocalState({
      user: { id: s.A.id, name: "A", color: "red;background-image:url(https://example.invalid/x)" },
      knotebook: { v: 1, kind: "agent", handle: "x", label: "y" },
      extra: "x".repeat(2000),
      cursor,
    });
    await waitFor("A 收到 B 的游標", 5_000, () => sameCursor(peer(s.a, idOf(s.b))?.cursor, cursor));
    expect(peer(s.a, idOf(s.b))).toEqual({
      user: { id: s.B.id, name: s.row(s.B.id).displayName, color: collabUserColor(s.B.id) },
      knotebook: { v: 1, kind: "user", role: "editor", avatar: null, since: expect.any(Number) },
      cursor: expectedCursor.get(cursor),
    });
    expect(s.warns()).toHaveLength(1);
    expect(s.warnIssues()).not.toContain("bad-cursor");
    expect(s.warns()[0]!.obj).toMatchObject({ noteId: s.note.id, userId: s.B.id });
    expect(s.warnIssues()).toContain("user-mismatch");
  });

  it("an editor rewriting someone else's clientID (high clock) -> others still see the real owner's state; logs foreign-client", async () => {
    const s = await scene("aw2");
    const c = await s.connectAs("other");
    c.provider.setAwarenessField("user", { id: s.C.id, name: "C", color: "#000000" });
    await waitFor("C 看到 A", 5_000, () => peer(c, idOf(s.a))?.user?.id === s.A.id);
    sendRaw(s.b, awarenessFrame(s.note.id, [{ clientId: idOf(s.a), clock: 1000, state: { user: { id: s.B.id, name: "spoof" } } }]));
    await s.mark(s.b, c);
    expect(peer(c, idOf(s.a))?.user).toMatchObject({ id: s.A.id, name: s.row(s.A.id).displayName });
    expect(clockAt(c, idOf(s.a))).toBeLessThan(1000);
    expect(s.warnIssues()).toContain("foreign-client");
  });

  it("rewriting the AI agent avatar's clientID -> still the AI's name and agent marker; logs server-client", async () => {
    const s = await scene("aw3");
    const { token, tokenId } = await seedTokenForUser(s.ctx.db, s.A.id, "notes:read notes:write", "Claude Code");
    const aiId = presenceClientId(s.note.id, tokenId);
    const aiName = `${s.row(s.A.id).handle} (claude)`;
    await getContent(s.ctx.app, s.note.id, token);
    await tick();
    await waitFor("A 看到 AI", 5_000, () => peer(s.a, aiId)?.user?.name === aiName);
    sendRaw(s.b, awarenessFrame(s.note.id, [{ clientId: aiId, clock: 1_000_000, state: { user: { id: s.B.id, name: "spoof" } } }]));
    await s.mark(s.b, s.a);
    expect(peer(s.a, aiId)?.user?.name).toBe(aiName);
    expect(peer(s.a, aiId)?.knotebook?.kind).toBe("agent");
    expect(clockAt(s.a, aiId)).toBeLessThan(1_000_000);
    expect(s.warnIssues()).toContain("server-client");
  });

  it("closing the connection that squatted on the AI clientID doesn't remove the AI's state with it", async () => {
    const s = await scene("aw3b");
    const { token, tokenId } = await seedTokenForUser(s.ctx.db, s.A.id, "notes:read notes:write", "Claude Code");
    const aiId = presenceClientId(s.note.id, tokenId);
    const aiName = `${s.row(s.A.id).handle} (claude)`;
    // A fresh connection that hasn't registered any clientID sends this id before the AI appears
    const squatter = await s.sessionB.connect(s.note.id);
    sendRaw(squatter, awarenessFrame(s.note.id, [{ clientId: aiId, clock: 1, state: { user: { id: s.B.id, name: "B" } } }]));
    await waitFor("佔位的狀態到達 A", 5_000, () => peer(s.a, aiId)?.user?.id === s.B.id);
    // The AI's first write has the same clock as the placeholder, A ignores it; only the second read sees it (clock being beaten to it is a known limitation)
    await getContent(s.ctx.app, s.note.id, token);
    await tick();
    await getContent(s.ctx.app, s.note.id, token);
    await tick();
    await waitFor("A 看到 AI", 5_000, () => peer(s.a, aiId)?.user?.name === aiName);
    const before = s.ctx.collab.connectionsOfNote(s.note.id).size;
    squatter.disconnect();
    await waitFor("server 移除佔位的連線", 5_000, () => s.ctx.collab.connectionsOfNote(s.note.id).size === before - 1);
    await s.mark(s.b, s.a);
    expect(peer(s.a, aiId)?.user?.name).toBe(aiName);
    expect(peer(s.a, aiId)?.knotebook?.kind).toBe("agent");
  });

  it("one message with three new clientIDs -> at most one accepted, the person's own as usual; logs client-limit", async () => {
    const s = await scene("aw4");
    const ids = [4_000_000_001, 4_000_000_002, 4_000_000_003];
    sendRaw(s.b, awarenessFrame(s.note.id, ids.map(clientId => ({ clientId, clock: 1, state: { user: { id: s.B.id, name: "x" } } }))));
    await s.mark(s.b, s.a);
    const seen = ids.filter(id => s.a.provider.awareness!.getStates().has(id));
    expect(seen.length).toBeLessThanOrEqual(1);
    expect(peer(s.a, idOf(s.b))?.user?.id).toBe(s.B.id);
    // The three problems in one message are deduplicated to one log line
    expect(s.warns()).toHaveLength(1);
    expect(s.warns()[0]!.obj.issues).toEqual(["client-limit"]);
  });

  it("invalid cursors always become null; later valid cursors are forwarded as is; logs bad-cursor", async () => {
    const s = await scene("aw5");
    const bad: unknown[] = [{}, { anchor: 1, head: 1 }, { anchor: { tname: "other" }, head: { tname: "other" } }];
    for (const cursor of bad) {
      await s.mark(s.b, s.a); // First switch to a valid cursor, otherwise one can't tell whether this message became null
      s.b.provider.setAwarenessField("cursor", cursor);
      await waitFor(`A 看到 ${JSON.stringify(cursor)} 變成 null`, 5_000, () => {
        const st = peer(s.a, idOf(s.b));
        return st !== undefined && st.cursor === null;
      });
      expect(peer(s.a, idOf(s.b))?.user?.id).toBe(s.B.id);
    }
    const good = yCursor(s.b.doc, 30);
    s.b.provider.setAwarenessField("cursor", good);
    await waitFor("合法游標到達", 5_000, () => sameCursor(peer(s.a, idOf(s.b))?.cursor, good));
    expect(s.warnIssues()).toContain("bad-cursor");
  });

  it("the root fragment position (tname set, type null) is also forwarded as is, no bad-cursor logged", async () => {
    const s = await scene("aw1b");
    const cursor = yCursor(s.b.doc, 0, true);
    s.b.provider.setAwarenessField("cursor", cursor);
    await waitFor("A 收到 B 的根位置游標", 5_000, () => sameCursor(peer(s.a, idOf(s.b))?.cursor, cursor));
    expect(JSON.stringify(cursor)).toContain('"type":null');
    expect(s.warnIssues()).not.toContain("bad-cursor");
  });

  it("viewer impersonating and claiming to be owner -> shown as themselves, role viewer; name displays as usual, cursor always null (read-only connections don't share position)", async () => {
    const s = await scene("aw6");
    const v = await s.connectAs("viewer");
    // Read-only connections don't write the doc: build the cursor with the root fragment position (also a valid Yjs relative position)
    const pos = plain(Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(v.doc.getXmlFragment(YDOC_FRAGMENT), 0)));
    v.provider.awareness!.setLocalState({
      user: { id: s.A.id, name: "boss", color: "#000000" },
      knotebook: { v: 1, kind: "user", role: "owner", avatar: null, since: 1 },
      cursor: { anchor: pos, head: pos },
    });
    await waitFor("A 看到 viewer", 5_000, () => peer(s.a, idOf(v)) !== undefined);
    const st = peer(s.a, idOf(v));
    expect(st?.user).toEqual({ id: s.V.id, name: s.row(s.V.id).displayName, color: collabUserColor(s.V.id) });
    expect(st?.knotebook?.role).toBe("viewer");
    expect(st?.cursor).toBeNull();
    expect(s.warnIssues()).toContain("user-mismatch");
  });

  it("the same person's second login takes over the first connection's clientID -> accepted and not logged; afterwards both connections' states are visible", async () => {
    const s = await scene("aw7");
    const first = idOf(s.b);
    await s.mark(s.b, s.a); // this text is also where the cursors below land
    // The second login only connects and sets no state: the empty state the provider sends isn't registered, so at takeover time it has no clientID of its own yet
    const b2 = await s.connectAs("editor");
    const taken = yCursor(s.b.doc, 7);
    sendRaw(b2, awarenessFrame(s.note.id, [{ clientId: first, clock: 100, state: { user: { id: s.B.id, name: "B" }, cursor: taken } }]));
    await waitFor("A 看到接手後的狀態", 5_000, () => sameCursor(peer(s.a, first)?.cursor, taken));
    expect(peer(s.a, first)?.user?.id).toBe(s.B.id);
    expect(s.warns()).toHaveLength(0);

    // The first connection takes its own id back first (its clock must catch up with the takeover's clock, otherwise its update is ignored)
    await waitFor("第一條連線收到接手的 clock", 5_000, () => (clockAt(s.b, first) ?? 0) >= 100);
    const back = yCursor(s.b.doc, 8);
    s.b.provider.setAwarenessField("cursor", back);
    await waitFor("A 看到第一條連線拿回 id", 5_000, () => sameCursor(peer(s.a, first)?.cursor, back));
    // The second connection only now sets its own state
    b2.provider.setAwarenessField("user", { id: s.B.id, name: "B", color: "#000000" });
    await waitFor("A 看到第二條連線自己的 id", 5_000, () => peer(s.a, idOf(b2))?.user?.id === s.B.id);
    expect(peer(s.a, first)?.user?.id).toBe(s.B.id);
    expect(idOf(b2)).not.toBe(first);
    expect(s.warns()).toHaveLength(0);
  });

  it("owner downgrades an editor to viewer -> the next update after revalidation shows viewer, cursor becomes null", async () => {
    const s = await scene("aw8", { collabHooks: (server, log) => createCollabHooks(server, log) });
    await s.mark(s.b, s.a);
    expect(peer(s.a, idOf(s.b))?.knotebook?.role).toBe("editor");
    const res = await s.sessionA.fetch(`/api/notes/${s.note.id}/shares`, {
      method: "PUT",
      body: JSON.stringify({ email: s.email("editor"), role: "viewer" }),
    });
    expect(res.status).toBe(200);
    await waitFor("B 那條連線完成重驗", 10_000, () =>
      [...s.ctx.collab.connectionsOfNote(s.note.id)].some(h => h.userId === s.B.id && h.presenceRole === "viewer")
    );
    s.b.provider.setAwarenessField("cursor", yCursor(s.b.doc, 9));
    await waitFor("A 看到 B 變成 viewer", 5_000, () => peer(s.a, idOf(s.b))?.knotebook?.role === "viewer");
    expect(peer(s.a, idOf(s.b))?.cursor).toBeNull();
    expect(peer(s.a, idOf(s.b))?.user?.id).toBe(s.B.id);
  });
});

describe("WebSocket message size (#312)", () => {
  it("a message one byte over the limit -> connection closes with 1009", async () => {
    const ctx = await buildCollabTestApp();
    const raw = new WebSocket(ctx.baseUrl.replace(/^http/, "ws") + "/collab");
    const closed = new Promise<number>((resolve, reject) => {
      raw.once("close", code => resolve(code));
      raw.once("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      raw.once("open", () => resolve());
      raw.once("error", reject);
    });
    raw.send(Buffer.alloc(collabMaxPayloadBytes(testConfig.limitEnv.noteMaxBytes) + 1));
    expect(await closed).toBe(1009);
  });

  it("an editor writing a 5 MiB paragraph at once -> still syncs to the server, connection not closed", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "size-owner@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("size-owner@example.com", PASSWORD);
    const client = await session.connect(note.id);

    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("x".repeat(SITE_LIMITS.noteMaxBytes.max))]);
    client.doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [paragraph]);

    const stateVector = (d: Y.Doc) => Buffer.from(Y.encodeStateVector(d)).toString("hex");
    await waitFor("5 MiB 的編輯同步到 server", 15_000, () => {
      const doc = ctx.collab.hocuspocus.documents.get(note.id);
      return doc !== undefined && stateVector(doc) === stateVector(client.doc);
    });
    expect(ctx.collab.connectionsOfNote(note.id).size).toBe(1);
  });
});

// #293 online avatar list: awareness forwarding for viewers and removal when offline.
// Much of what this file guards is library facts of Hocuspocus/y-protocols (the product code has no corresponding line); which step guards which:
// - read-only connections' awareness is still forwarded -> first case
// - closing a connection removes the clientIDs it registered -> step 1 of the reconnect case (5 s window), and the abnormal-disconnect case
// - a reconnect's resend reuses the old clock and is ignored -> step 2 of the reconnect case, and the control case
// - clock+1 is accepted -> step 3 of the reconnect case; after the observer clears old meta, reconnecting shows others at once -> the observer-reconnect case
// - state rewritten after reconnect is bound to the new connection (#312), removed as soon as that connection closes, no longer waiting for the 30 s outdatedTimeout -> step 4 of the reconnect case (within 5 s)
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { buildCollabTestApp, type TestClient } from "./helpers.js";
import { waitFor } from "./editing-helpers.js";

const PASSWORD = "correct-horse-battery";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const socketOf = (c: TestClient) => c.provider.configuration.websocketProvider;

type PeerState = { knotebook?: { role?: string }; user?: { id?: string } } | undefined;
const sawViewer = (st: PeerState, viewerUserId: string) => st?.knotebook?.role === "viewer" && st.user?.id === viewerUserId;

async function scene(tag: string) {
  const ctx = await buildCollabTestApp();
  const owner = await ctx.createUser({ email: `owner-${tag}@example.com`, password: PASSWORD });
  const viewer = await ctx.createUser({ email: `viewer-${tag}@example.com`, password: PASSWORD });
  const note = await ctx.createNote(owner.id);
  await ctx.share(note.id, viewer.id, "viewer");
  const ownerClient = await (await ctx.loginAs(`owner-${tag}@example.com`, PASSWORD)).connect(note.id);
  const viewerClient = await (await ctx.loginAs(`viewer-${tag}@example.com`, PASSWORD)).connect(note.id);
  const viewerId = viewerClient.provider.awareness!.clientID;
  const ownerStates = () => ownerClient.provider.awareness!.getStates();
  const ownerSeesViewer = () => ownerStates().has(viewerId);
  viewerClient.provider.setAwarenessField("knotebook", { v: 1, kind: "user", role: "viewer", avatar: null, since: 1 });
  viewerClient.provider.setAwarenessField("user", { id: viewer.id, name: "V", color: "#000000" });
  // The two fields are two awareness messages: received only when both have arrived, don't read in between
  await waitFor("owner 收到 viewer 的狀態", 5_000, () => sawViewer(ownerStates().get(viewerId) as PeerState, viewer.id));
  return { ctx, viewer, ownerClient, viewerClient, viewerId, ownerStates, ownerSeesViewer };
}

/** Copy of the web `useLocalPresenceField` onClose cleanup (server tests don't import web): deletes remote meta that no longer has state. */
function clearStaleRemoteMeta(c: TestClient): void {
  c.provider.on("close", () => {
    const a = c.provider.awareness!;
    for (const id of [...a.meta.keys()]) if (id !== a.clientID && !a.states.has(id)) a.meta.delete(id);
  });
}

describe("collab awareness (#293)", () => {
  it("viewer's awareness is forwarded to people on the same note; this connection really is read-only", async () => {
    const s = await scene("ca1");
    const st = s.ownerStates().get(s.viewerId) as PeerState;
    expect(st?.knotebook?.role).toBe("viewer");
    expect(st?.user?.id).toBe(s.viewer.id);
    // Counter-proof of read-only: the viewer's Y.Doc writes don't reach the owner (same method as collab-auth) - it doesn't hold because it is secretly an editor
    const el = new Y.XmlElement("paragraph");
    el.insert(0, [new Y.XmlText("from viewer")]);
    s.viewerClient.doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [el]);
    await sleep(500);
    expect(s.ownerClient.doc.getXmlFragment(YDOC_FRAGMENT).toString()).not.toContain("from viewer");
  });

  it("abnormal disconnect (no removal message sent) is also removed, within 35 s", async () => {
    const s = await scene("ca2");
    const t0 = Date.now();
    socketOf(s.viewerClient).destroy(); // don't call provider.destroy(): simulates the tab being closed
    await waitFor("owner 端移除 viewer", 40_000, () => !s.ownerSeesViewer());
    const ms = Date.now() - t0;
    console.log("abrupt close removal ms", ms);
    expect(ms).toBeLessThan(35_000);
    s.viewerClient.disconnect();
  }); // the abnormal-disconnect and reconnect cases set no per-test timeout and use the global 120 s: they must wait the full 30 s awareness timeout plus scenario setup and each waitFor, 60 s is too tight

  it("a reconnect's resend is ignored, clock+1 rewrite brings it back; after an abnormal disconnect, closing removes it (within 5 s)", async () => {
    const s = await scene("ca3");
    const sock = socketOf(s.viewerClient);
    sock.disconnect();
    await waitFor("owner 端失去 viewer", 5_000, () => !s.ownerSeesViewer());
    void sock.connect();
    await waitFor("viewer 重新認證並同步", 5_000, () => s.viewerClient.provider.isAuthenticated && s.viewerClient.provider.synced);
    await sleep(2_000);
    // Library behaviour: onOpen's resend reuses the old clock and the server ignores the whole entry - the reason the web side's "force rewrite on reconnect" exists
    expect(s.ownerSeesViewer()).toBe(false);
    const a = s.viewerClient.provider.awareness!;
    a.setLocalState({ ...a.getLocalState()! }); // simulates useLocalPresenceField's rewrite (clock+1)
    await waitFor("owner 端 viewer 回來", 5_000, s.ownerSeesViewer);
    const t0 = Date.now();
    sock.destroy();
    // The rewritten state is already registered on the new connection: closing the connection removes it, no reliance on awareness's 30 s timeout
    await waitFor("移除", 40_000, () => !s.ownerSeesViewer());
    const ms = Date.now() - t0;
    console.log("reconnected abrupt close removal ms", ms);
    expect(ms).toBeLessThan(5_000);
    s.viewerClient.disconnect();
  });

  it("observer reconnecting itself: onClose clears remote old meta -> after reconnect it immediately sees those who were present", async () => {
    const s = await scene("ca4");
    clearStaleRemoteMeta(s.ownerClient);
    const sock = socketOf(s.ownerClient);
    sock.disconnect();
    await waitFor("owner 端失去 viewer", 5_000, () => !s.ownerSeesViewer());
    void sock.connect();
    await waitFor("owner 重新認證並同步", 5_000, () => s.ownerClient.provider.isAuthenticated && s.ownerClient.provider.synced);
    const t0 = Date.now();
    await waitFor("owner 重連後看到 viewer", 5_000, s.ownerSeesViewer);
    console.log("[CA4] observer reconnect, viewer back after ms", Date.now() - t0);
  });

  it("control: without clearing remote old meta -> still doesn't see those who were present 2 s after reconnect", async () => {
    const s = await scene("ca4b");
    const sock = socketOf(s.ownerClient);
    sock.disconnect();
    await waitFor("owner 端失去 viewer", 5_000, () => !s.ownerSeesViewer());
    void sock.connect();
    await waitFor("owner 重新認證並同步", 5_000, () => s.ownerClient.provider.isAuthenticated && s.ownerClient.provider.synced);
    await sleep(2_000);
    expect(s.ownerSeesViewer()).toBe(false);
  });
});

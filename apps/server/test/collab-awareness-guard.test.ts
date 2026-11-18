// #312：協作者不能再偽造 awareness。server 依「這條連線是誰」重建每筆狀態，只接受合法的游標，
// 不讓連線改寫別人的、server 的或過多的 clientID。偽造一律從底層 socket 直接送手工組的訊息
// （`awareness-wire.ts`），正常更新走 provider。「什麼都沒送到」的情境，一律再由同一個送出者送一個
// 合法的標記更新、等它到了才斷言——同一條 socket 的訊息依序處理，標記到了代表之前那則已經處理完。
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { inArray } from "drizzle-orm";
import { YDOC_FRAGMENT, collabUserColor } from "@knotebook/shared";
import { createCollabHooks } from "../src/collab/hooks-impl.js";
import { users } from "../src/db/schema.js";
import { presenceClientId } from "../src/notes/editing/presence.js";
import { buildCollabTestApp, type TestClient } from "./helpers.js";
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
/** awareness 走 JSON：比對前先把 Yjs 物件轉成同樣的純 JSON。 */
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** 用 Yjs 在 client 自己的 doc 上建一個真的游標：第一段文字的第 index 個字元（第一次呼叫時寫入這段文字）。 */
function yCursor(doc: Y.Doc, index: number): { anchor: unknown; head: unknown } {
  const fragment = doc.getXmlFragment(YDOC_FRAGMENT);
  if (fragment.length === 0) {
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("0123456789".repeat(5))]);
    fragment.insert(0, [paragraph]);
  }
  const text = (fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText;
  const pos = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, index));
  return plain({ anchor: pos, head: pos });
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
  // 照 web 的形狀各自設定 user；彼此看到之後才開始（兩人的 clientID 此時都已登記在自己的連線上）
  a.provider.setAwarenessField("user", { id: A.id, name: "A", color: "#000000" });
  b.provider.setAwarenessField("user", { id: B.id, name: "B", color: "#000000" });
  await waitFor("A 看到 B", 5_000, () => peer(a, idOf(b))?.user?.id === B.id);
  await waitFor("B 看到 A", 5_000, () => peer(b, idOf(a))?.user?.id === A.id);

  const warns = () => ctx.collabLogs.filter(l => l.level === "warn" && l.msg === WARN_MSG);
  const warnIssues = () => warns().flatMap(l => l.obj.issues as string[]);
  const connectAs = async (who: "other" | "viewer" | "editor") => (await ctx.loginAs(email(who), PASSWORD)).connect(note.id);

  let markers = 0;
  /** sender 送一個合法的標記游標，等 observer 看到——之前從 sender 送出的訊息此時都已處理完。 */
  async function mark(sender: TestClient, observer: TestClient): Promise<void> {
    markers += 1;
    const cursor = yCursor(sender.doc, markers);
    sender.provider.setAwarenessField("cursor", cursor);
    await waitFor(`標記 ${markers} 到達`, 5_000, () => isDeepStrictEqual(peer(observer, idOf(sender))?.cursor, cursor));
  }

  return { ctx, A, B, C, V, note, row, email, sessionA, sessionB, a, b, warns, warnIssues, connectAs, mark };
}

describe("collab awareness 防偽（#312）", () => {
  it("AW1 自報的 user／knotebook／多餘欄位全被 server 值取代，合法游標原樣轉發；記一行 user-mismatch", async () => {
    const s = await scene("aw1");
    const cursor = yCursor(s.b.doc, 4);
    s.b.provider.awareness!.setLocalState({
      user: { id: s.A.id, name: "A", color: "red;background-image:url(https://example.invalid/x)" },
      knotebook: { v: 1, kind: "agent", handle: "x", label: "y" },
      extra: "x".repeat(2000),
      cursor,
    });
    await waitFor("A 收到 B 的游標", 5_000, () => isDeepStrictEqual(peer(s.a, idOf(s.b))?.cursor, cursor));
    expect(peer(s.a, idOf(s.b))).toEqual({
      user: { id: s.B.id, name: s.row(s.B.id).displayName, color: collabUserColor(s.B.id) },
      knotebook: { v: 1, kind: "user", role: "editor", avatar: null, since: expect.any(Number) },
      cursor,
    });
    expect(s.warns()).toHaveLength(1);
    expect(s.warns()[0]!.obj).toMatchObject({ noteId: s.note.id, userId: s.B.id });
    expect(s.warnIssues()).toContain("user-mismatch");
  });

  it("AW2 編輯者改寫別人的 clientID（高 clock）→ 其他人仍看到本人的狀態；記 foreign-client", async () => {
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

  it("AW3 改寫 AI 代理頭像的 clientID → 仍是 AI 的名字與 agent 標記；記 server-client", async () => {
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

  it("AW3b 先佔了 AI clientID 的連線關閉時，不會把 AI 的狀態一起移除", async () => {
    const s = await scene("aw3b");
    const { token, tokenId } = await seedTokenForUser(s.ctx.db, s.A.id, "notes:read notes:write", "Claude Code");
    const aiId = presenceClientId(s.note.id, tokenId);
    const aiName = `${s.row(s.A.id).handle} (claude)`;
    // 一條還沒登記任何 clientID 的新連線，在 AI 出現之前先送這個 id
    const squatter = await s.sessionB.connect(s.note.id);
    sendRaw(squatter, awarenessFrame(s.note.id, [{ clientId: aiId, clock: 1, state: { user: { id: s.B.id, name: "B" } } }]));
    await waitFor("佔位的狀態到達 A", 5_000, () => peer(s.a, aiId)?.user?.id === s.B.id);
    // AI 第一次寫的 clock 與佔位相同，A 會忽略；第二次讀才看得到（clock 搶先是已知限制）
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

  it("AW4 一則訊息帶三個新 clientID → 最多一個被接受，本人照常；記 client-limit", async () => {
    const s = await scene("aw4");
    const ids = [4_000_000_001, 4_000_000_002, 4_000_000_003];
    sendRaw(s.b, awarenessFrame(s.note.id, ids.map(clientId => ({ clientId, clock: 1, state: { user: { id: s.B.id, name: "x" } } }))));
    await s.mark(s.b, s.a);
    const seen = ids.filter(id => s.a.provider.awareness!.getStates().has(id));
    expect(seen.length).toBeLessThanOrEqual(1);
    expect(peer(s.a, idOf(s.b))?.user?.id).toBe(s.B.id);
    // 同一則訊息的三個問題去重後只寫一行
    expect(s.warns()).toHaveLength(1);
    expect(s.warns()[0]!.obj.issues).toEqual(["client-limit"]);
  });

  it("AW5 不合法的游標一律變成 null；之後的合法游標原樣轉發；記 bad-cursor", async () => {
    const s = await scene("aw5");
    const bad: unknown[] = [{}, { anchor: 1, head: 1 }, { anchor: { tname: "other" }, head: { tname: "other" } }];
    for (const cursor of bad) {
      await s.mark(s.b, s.a); // 先換成一個合法游標，才分得出這一則有沒有變成 null
      s.b.provider.setAwarenessField("cursor", cursor);
      await waitFor(`A 看到 ${JSON.stringify(cursor)} 變成 null`, 5_000, () => {
        const st = peer(s.a, idOf(s.b));
        return st !== undefined && st.cursor === null;
      });
      expect(peer(s.a, idOf(s.b))?.user?.id).toBe(s.B.id);
    }
    const good = yCursor(s.b.doc, 30);
    s.b.provider.setAwarenessField("cursor", good);
    await waitFor("合法游標到達", 5_000, () => isDeepStrictEqual(peer(s.a, idOf(s.b))?.cursor, good));
    expect(s.warnIssues()).toContain("bad-cursor");
  });

  it("AW6 viewer 冒名、自稱 owner → 顯示為本人、角色 viewer；名字照常顯示，游標一律為 null（唯讀連線不分享位置）", async () => {
    const s = await scene("aw6");
    const v = await s.connectAs("viewer");
    // 唯讀連線不寫 doc：游標用根 fragment 的位置建（同樣是合法的 Yjs 相對位置）
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

  it("AW7 同一人的第二個登入接手第一條連線的 clientID → 接受且不記日誌；之後兩條連線各自的狀態都看得到", async () => {
    const s = await scene("aw7");
    const first = idOf(s.b);
    await s.mark(s.b, s.a); // 這段文字也是下面游標的落點
    // 第二個登入只連上、不設任何狀態：provider 送的空狀態不登記，所以接手時它還沒有自己的 clientID
    const b2 = await s.connectAs("editor");
    const taken = yCursor(s.b.doc, 7);
    sendRaw(b2, awarenessFrame(s.note.id, [{ clientId: first, clock: 100, state: { user: { id: s.B.id, name: "B" }, cursor: taken } }]));
    await waitFor("A 看到接手後的狀態", 5_000, () => isDeepStrictEqual(peer(s.a, first)?.cursor, taken));
    expect(peer(s.a, first)?.user?.id).toBe(s.B.id);
    expect(s.warns()).toHaveLength(0);

    // 第一條連線先拿回自己的 id（它的 clock 要先跟上那則接手的 clock，否則它的更新會被忽略）
    await waitFor("第一條連線收到接手的 clock", 5_000, () => (clockAt(s.b, first) ?? 0) >= 100);
    const back = yCursor(s.b.doc, 8);
    s.b.provider.setAwarenessField("cursor", back);
    await waitFor("A 看到第一條連線拿回 id", 5_000, () => isDeepStrictEqual(peer(s.a, first)?.cursor, back));
    // 第二條連線這時才設定自己的狀態
    b2.provider.setAwarenessField("user", { id: s.B.id, name: "B", color: "#000000" });
    await waitFor("A 看到第二條連線自己的 id", 5_000, () => peer(s.a, idOf(b2))?.user?.id === s.B.id);
    expect(peer(s.a, first)?.user?.id).toBe(s.B.id);
    expect(idOf(b2)).not.toBe(first);
    expect(s.warns()).toHaveLength(0);
  });

  it("AW8 owner 把編輯者降為 viewer → 重驗後的下一則更新顯示 viewer，游標變 null", async () => {
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

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { SESSION_COOKIE } from "@knotebook/shared";
import { presenceClientId } from "../src/notes/editing/presence.js";
import { EditorSession } from "../src/notes/editing/session.js";
import { buildCollabTestApp, testEditingRuntime, signTestSession } from "./helpers.js";
import { bearer, docText, getContent, seedContent, seedTokenForUser, tick, waitFor } from "./editing-helpers.js";

const PASSWORD = "correct-horse-battery";

async function scene(opts: Parameters<typeof buildCollabTestApp>[0] = {}) {
  const ctx = await buildCollabTestApp(opts);
  const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
  const note = await ctx.createNote(u.id);
  const session = await ctx.loginAs("a@example.com", PASSWORD);
  // Headings are at the same level: `## B` would be merged into A's section by sectionize and outline[2] would be undefined
  const client = await seedContent(ctx, session, note.id, "# A\n\n第一段內容\n\n# B\n\n第二段內容");
  const { token, tokenId } = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write", "Claude Code");
  const id = presenceClientId(note.id, tokenId);
  // handle isn't the email local part: the `users.handle` DB default is 'user-<8hex>' and ctx.createUser doesn't set it.
  // Hardcoding "a" fails; loosening to expect.any(String) drops the whole guard that the name tag points at the right person (#137).
  const ownerHandle = (await ctx.app.inject({ method: "GET", url: `/api/notes/${note.id}`, headers: bearer(token) })).json().ownerHandle as string;
  const expectedName = `${ownerHandle} (claude)`;
  const remote = () => client.provider.awareness!.getStates().get(id) as { user?: { name: string; color: string }; cursor?: { anchor: unknown } } | undefined;
  const remoteClock = () => client.provider.awareness!.meta.get(id)?.clock;
  const cursorText = () => {
    const r = remote();
    if (!r?.cursor) return null;
    const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(r.cursor.anchor as never), client.doc);
    return abs ? (abs.type as Y.XmlText).toString() : null;
  };
  const outline = async () => (await getContent(ctx.app, note.id, token)).json().outline as Array<{ sectionId: string; heading: string; fingerprint: string }>;
  return { ctx, u, note, session, client, token, tokenId, id, ownerHandle, expectedName, remote, remoteClock, cursorText, outline };
}

describe("presence: side by side", () => {
  it("first item of _top is a columns row -> cursor lands on the first column's first block text (not that column's last block, not the last column)", async () => {
    const s = await scene();
    const ses = await EditorSession.open(testEditingRuntime, s.client.doc);
    try {
      ses.editor.replaceBlocks(ses.editor.document, [
        { id: "r", type: "columnList", children: [
          { id: "rc0", type: "column", props: { width: 1 }, children: [{ id: "ra", type: "paragraph", content: "左一" }, { id: "ra2", type: "paragraph", content: "左二" }] },
          { id: "rc1", type: "column", props: { width: 1 }, children: [{ id: "rb", type: "paragraph", content: "右二" }] },
        ] },
        { id: "h", type: "heading", props: { level: 1 }, content: "標題文字" },
        { id: "p", type: "paragraph", content: "段落文字" },
      ] as never);
    } finally {
      ses.close();
    }
    await waitFor("server 收到列", 5_000, () => docText(s.ctx.collab.hocuspocus.documents.get(s.note.id)!).includes("段落文字"));
    await getContent(s.ctx.app, s.note.id, s.token, "_top"); await tick();
    await waitFor("游標到左一", 2_000, () => s.cursorText() === "左一");
    s.client.disconnect();
  });
});

describe("presence", () => {
  it("token read -> provider shows `handle (label)` and color, cursor at document start; ?section= -> that section's first block; _top -> document start", async () => {
    const s = await scene();
    await getContent(s.ctx.app, s.note.id, s.token); await tick();
    await waitFor("名字到達", 2_000, () => s.remote()?.user?.name === s.expectedName);
    expect(s.remote()!.user!.color).toBe("#7c3aed");
    expect(s.cursorText()).toContain("A");
    const o = await s.outline();
    expect(o).toHaveLength(3); // _top / A / B; same-level headings are a premise, without this the two parts below mean nothing
    await getContent(s.ctx.app, s.note.id, s.token, o[2]!.sectionId); await tick();
    await waitFor("游標到 B", 2_000, () => (s.cursorText() ?? "").includes("B"));
    await getContent(s.ctx.app, s.note.id, s.token, "_top"); await tick();
    await waitFor("游標回文件開頭", 2_000, () => (s.cursorText() ?? "").includes("A"));
    s.client.disconnect();
  });

  it("cookie writes and cookie reads set no presence; GET /edits doesn't refresh it (judged by clock, not sleep)", async () => {
    const s = await scene();
    const cookie = `${SESSION_COOKIE}=${await signTestSession({ userId: s.u.id, tv: 0 })}`;
    // The three "must not touch" actions run first, then the one that should touch. Awareness updates arrive in order over the same
    // socket, so once the last one arrived, any stray touch by the first three is already reflected in the clock.
    //
    // The first request (a write via browser login) guards that a cookie write still gives 201 and doesn't shift the token's clock.
    // Removing `request.tokenId &&` does not make this case fail: cookie implies agentLabel null, which the second condition also
    // blocks; even with both conditions removed the cookie path touches with a different tokenId, hence a different clientId, which
    // the clock assertion below can't see. What really blocks it is `tsc`, see the comment at that spot in routes/notes.ts. The
    // `toBe(1)` below actually guards the third request (GET /edits with a token), which a stray touch would turn into 2.
    expect((await s.ctx.app.inject({
      method: "POST", url: `/api/notes/${s.note.id}/edits`, headers: { cookie },
      payload: { op: "append", markdown: "使用者自己在編輯器外用 cookie 寫的一行" },
    })).statusCode).toBe(201);
    expect((await s.ctx.app.inject({ method: "GET", url: `/api/notes/${s.note.id}/content`, headers: { cookie } })).statusCode).toBe(200);
    expect((await s.ctx.app.inject({ method: "GET", url: `/api/notes/${s.note.id}/edits`, headers: bearer(s.token) })).statusCode).toBe(200);
    await getContent(s.ctx.app, s.note.id, s.token); await tick();
    await waitFor("名字到達", 2_000, () => s.remote()?.user?.name === s.expectedName);
    // This file's first touch of this (noteId, tokenId): the clock must be 1; if any of the three above touched, it would be 2.
    expect(s.remoteClock()).toBe(1);
    // The clock assertion above structurally can't see "both conditions removed": the cookie path touches with a tokenId different
    // from `s.tokenId`, hence a different clientId, so the clock never notices an extra stranger client. The real discriminating
    // power is here: the **set** of client ids in awareness must be exactly two: the browser itself (the local doc's clientID,
    // registered by Awareness's constructor with an empty state) plus this token. Any path that should not touch but does would add an id here.
    const clientIds = [...s.client.provider.awareness!.getStates().keys()].sort((a, b) => a - b);
    expect(clientIds).toEqual([s.client.provider.awareness!.clientID, s.id].sort((a, b) => a - b));
    s.client.disconnect();
  });

  it("write -> presence appears only if the document is still loaded, cursor on the first block written this time; append likewise; with nobody online a write sets no presence and leaves no document in memory", async () => {
    const s = await scene();
    // Three discriminating designs; missing any gives a false green:
    //   (1) In this fixture doc-start and A's first block are the same block (the document starts with `# A`), so writes target
    //       section B: writing A can't tell "correct target" from "fell back to doc start".
    //   (2) The replaced heading is `# B2`, a different string from the original `# B`. So "looked up the old section_id, not found,
    //       fell back to doc start" and "correctly landed on the newly written heading" are two exclusive strings, `A` vs `B2`;
    //       keeping `# B` couldn't tell them apart if the implementation used the old id and happened to resolve old text at the same position.
    //   (3) Before append, move the cursor back to doc start, otherwise the append assertion passes even if the cursor didn't move.
    const o = await s.outline();                 // reading the whole note puts the cursor at document start (heading "A")
    const b = o[2]!;                             // every outline row carries its fingerprint, no need to read ?section= again
    expect((await s.ctx.app.inject({
      method: "POST", url: `/api/notes/${s.note.id}/edits`, headers: bearer(s.token),
      payload: { op: "replace_section", section_id: b.sectionId, markdown: "# B2\n\nAI 改過的第二段", if_match: b.fingerprint },
    })).statusCode).toBe(201);
    await tick();
    await waitFor("名字到達", 2_000, () => s.remote()?.user?.name === s.expectedName);
    // replace_section replaced the heading too, so the old section_id no longer exists; if the target still used it, cursorFor
    // wouldn't find it and would fall back to doc start (= "A"), failing this.
    await waitFor("游標落在新寫下的 B2 heading", 2_000, () => (s.cursorText() ?? "").includes("B2"));
    expect(s.cursorText()).not.toContain("A");
    // Move the cursor back to doc start first so the append landing point discriminates
    await getContent(s.ctx.app, s.note.id, s.token, "_top"); await tick();
    await waitFor("游標回文件開頭", 2_000, () => (s.cursorText() ?? "").includes("A"));
    expect((await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits`, headers: bearer(s.token), payload: { op: "append", markdown: "追加一行" } })).statusCode).toBe(201);
    await tick();
    await waitFor("append → 游標在剛追加的那一行", 2_000, () => (s.cursorText() ?? "").includes("追加一行"));
    s.client.disconnect();
    await waitFor("落盤並卸載", 10_000, () => s.ctx.collab.hocuspocus.documents.size === 0);

    // Nobody online: a write creates no presence and leaves no document in memory
    const t = await scene();
    t.client.disconnect();
    await waitFor("落盤並卸載", 10_000, () => t.ctx.collab.hocuspocus.documents.size === 0);
    expect((await t.ctx.app.inject({ method: "POST", url: `/api/notes/${t.note.id}/edits`, headers: bearer(t.token), payload: { op: "append", markdown: "沒人在線的追加" } })).statusCode).toBe(201);
    await waitFor("落盤並卸載", 10_000, () => t.ctx.collab.hocuspocus.documents.size === 0);
  });

  it("after undo the cursor falls back to document start and no longer rests on the undone line (undo is one of three outward actions)", async () => {
    const s = await scene();
    const created = await s.ctx.app.inject({
      method: "POST", url: `/api/notes/${s.note.id}/edits`, headers: bearer(s.token),
      payload: { op: "append", markdown: "即將被撤回的一行" },
    });
    expect(created.statusCode).toBe(201);
    const editId = (created.json() as { editId: string }).editId;
    await tick();
    // Push the cursor to the appended line first, so "stays put" and "falls back to doc start" are two exclusive strings
    await waitFor("游標先落在剛追加的那一行", 2_000, () => (s.cursorText() ?? "").includes("即將被撤回的一行"));
    expect((await s.ctx.app.inject({
      method: "POST", url: `/api/notes/${s.note.id}/edits/${editId}/revert`, headers: bearer(s.token),
    })).statusCode).toBe(201);
    await tick();
    await waitFor("撤回後游標回文件開頭", 2_000, () => (s.cursorText() ?? "").includes("A"));
    expect(s.cursorText()).not.toContain("即將被撤回的一行");
    s.client.disconnect();
  });

  it("after idle stop, re-touch on the same connected provider makes the name tag reappear (clock not reset, idleMs injected)", async () => {
    const s = await scene({ presence: { idleMs: 200 } });
    await getContent(s.ctx.app, s.note.id, s.token); await tick();
    await waitFor("名字到達", 2_000, () => s.remote()?.user?.name === s.expectedName);
    await waitFor("閒置消失", 3_000, () => s.remote() === undefined);
    const afterStop = s.remoteClock()!;
    await getContent(s.ctx.app, s.note.id, s.token); await tick();
    await waitFor("重現", 2_000, () => s.remote()?.user?.name === s.expectedName);
    expect(s.remoteClock()!).toBeGreaterThan(afterStop); // a restarted clock would be silently dropped by the provider
    s.client.disconnect();
  });

  it("after 35 s the browser side still contains that clientID (heartbeat outlasts outdatedTimeout 30 s)", async () => {
    const s = await scene();
    await getContent(s.ctx.app, s.note.id, s.token); await tick();
    await waitFor("名字到達", 2_000, () => s.remote()?.user?.name === s.expectedName);
    await new Promise(r => setTimeout(r, 35_000));
    expect(s.remote()?.user?.name).toBe(s.expectedName);
    s.client.disconnect();
  }); // no per-test timeout, the global 120 s applies: it waits a fixed 35 s and 60 s would leave only about 25 s for scene setup, too tight on a busy machine

  it("#240 Bearer read with an uppercase id -> presence appears under the lowercase id with the right name tag", async () => {
    const s = await scene();
    await getContent(s.ctx.app, s.note.id.toUpperCase(), s.token); await tick();
    await waitFor("名字到達", 2_000, () => s.remote()?.user?.name === s.expectedName);
    s.client.disconnect();
  });

  it("AI state seen by the browser carries the `knotebook` agent marker (#293), and `user` has only name/color", async () => {
    const s = await scene();
    await getContent(s.ctx.app, s.note.id, s.token); await tick();
    await waitFor("名字到達", 2_000, () => s.remote()?.user?.name === s.expectedName);
    const st = s.client.provider.awareness!.getStates().get(s.id) as Record<string, unknown>;
    expect(st.knotebook).toEqual({ v: 1, kind: "agent", handle: s.ownerHandle, label: "claude" });
    expect(Object.keys(st.user as object).sort()).toEqual(["color", "name"]);
    s.client.disconnect();
  });
});

import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { SESSION_COOKIE, YDOC_FRAGMENT } from "@knotebook/shared";
import { notes } from "../src/db/schema.js";
import type { EditingTestHooks } from "../src/notes/editing/apply.js";
import { EditorSession } from "../src/notes/editing/session.js";
import { buildCollabTestApp, testEditingRuntime, signTestSession } from "./helpers.js";
import { bearer, docText, getContent, seedContent, seedTokenForUser, waitFor } from "./editing-helpers.js";

const PASSWORD = "correct-horse-battery";
type Ctx = Awaited<ReturnType<typeof buildCollabTestApp>>;
const cookieFor = async (userId: string) => `${SESSION_COOKIE}=${await signTestSession({ userId, tv: 0 })}`;
const row = (ctx: Ctx, id: string) => ctx.db.select().from(notes).where(eq(notes.id, id)).then(r => r[0]!);
/** Waits after disconnect: size 0 means onStoreDocument (including the last_edited UPDATE) has been awaited. */
const settled = (ctx: Ctx) => waitFor("落盤並卸載", 10_000, () => ctx.collab.hocuspocus.documents.size === 0);

describe("last edit signature", () => {
  it("human edit in the editor -> at set, by=human, token/label NULL; AI write -> token/label set; rejected path (live 409) leaves it unchanged", async () => {
    // The hook needs the result of `buildCollabTestApp` yet must be handed in before the app is built: pass an empty object (same
    // reference all the way to `applyDeps.testHooks`) and attach `beforeMerge` afterwards; `deps.testHooks?.beforeMerge` is read at
    // call time, so attaching late works.
    const hooks: EditingTestHooks = {};
    const ctx = await buildCollabTestApp({ editingTestHooks: hooks });
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const session = await ctx.loginAs("a@example.com", PASSWORD);
    let client = await seedContent(ctx, session, note.id, "# A\n\n一");
    // This hook acts only on the final (rejection) step: the middle AI append happens after the client disconnected, where injecting
    // would never reach the server and the built-in waitFor would time out. Controlled by a flag, not timing.
    let injectConcurrent = false;
    // try/finally (lease on the module-level singleton runtime), and wait until the **server** has received it (the change arrives over WS)
    hooks.beforeMerge = async () => {
      if (!injectConcurrent) return;
      const s = await EditorSession.open(testEditingRuntime, client.doc);
      try {
        s.editor.updateBlock(s.editor.document[1]!.id, { content: "併發" });
      } finally {
        s.close();
      }
      await waitFor("server 收到併發編輯", 5_000, () => docText(ctx.collab.hocuspocus.documents.get(note.id)!).includes("併發"));
    };
    // Store debounce is 2 s: disconnect triggers an immediate store, then wait for the document to unload (store awaited).
    client.disconnect(); await settled(ctx);
    let r = await row(ctx, note.id);
    expect(r.lastEditedAt).not.toBeNull(); expect(r.lastEditedBy).toBe(u.id); expect(r.lastEditedTokenId).toBeNull(); expect(r.lastEditedAgentLabel).toBeNull();
    const { token, tokenId } = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write", "Claude Code");
    const c = (await getContent(ctx.app, note.id, token)).json();
    const humanAt = r.lastEditedAt!.getTime();
    expect((await ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(token), payload: { op: "append", markdown: "AI" } })).statusCode).toBe(201);
    r = await row(ctx, note.id);
    expect(r.lastEditedTokenId).toBe(tokenId); expect(r.lastEditedAgentLabel).toBe("claude"); expect(r.lastEditedAt!.getTime()).toBeGreaterThan(humanAt);
    const aiAt = r.lastEditedAt!.getTime();
    client = await session.connect(note.id);
    injectConcurrent = true; // from here on, beforeMerge injects the concurrent edit
    const a = (await getContent(ctx.app, note.id, token)).json().outline[1];
    const res = await ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(token), payload: { op: "replace_section", section_id: a.sectionId, markdown: "# A\n\nx", if_match: a.fingerprint } });
    expect(res.statusCode).toBe(409);
    expect((await row(ctx, note.id)).lastEditedAt!.getTime()).toBe(aiAt); // applied=false -> not written
    expect(c.lastEdited).not.toBeNull();
  });

  it("GET /api/notes returns lastEdited per note; :ref and by-path are non-null after an AI write; PATCH keeps it; POST without content -> null, with content -> matches the DB", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write", "Bot");
    const cookie = await cookieFor(u.id);
    const plain = await ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(token), payload: { title: "P" } });
    expect(plain.json().lastEdited).toBeNull();
    const withContent = await ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(token), payload: { title: "C", content: "hi" } });
    const dto = withContent.json();
    // The handle can't be hardcoded as `"a"`: `ctx.createUser` passes none and the column takes the DB default
    // (`'user-' || substr(gen_random_uuid()::text, 1, 8)`, different every time). This note's owner is the editor, so use the
    // `ownerHandle` from the same response as expected (as by-path below does). Not `expect.any(String)`: that would drop the guard
    // that the signature points at the right editor (a missing `editorHandle` relation in `toNoteDto` yields an empty string, which this cell catches).
    expect(dto.lastEdited).toMatchObject({ byHandle: dto.ownerHandle, agentLabel: "bot" });
    const id = dto.id;
    const list = (await ctx.app.inject({ method: "GET", url: "/api/notes", headers: { cookie } })).json();
    expect(list.find((n: { id: string }) => n.id === id).lastEdited.agentLabel).toBe("bot");
    expect((await ctx.app.inject({ method: "GET", url: `/api/notes/${id}`, headers: { cookie } })).json().lastEdited.agentLabel).toBe("bot");
    expect((await ctx.app.inject({ method: "GET", url: `/api/notes/by-path/${dto.ownerHandle}/${dto.slug}`, headers: { cookie } })).json().lastEdited.agentLabel).toBe("bot");
    const patched = await ctx.app.inject({ method: "PATCH", url: `/api/notes/${id}`, headers: { cookie }, payload: { title: "C2" } });
    // Asserting only agentLabel isn't enough: PATCH's signature handle is looked up separately after `.returning()` (`editorHandleOf`),
    // so a lookup miss (byHandle becoming an empty string) would go undetected. Same form as the POST cell: expect the ownerHandle from the same response.
    expect(patched.json().lastEdited).toMatchObject({ byHandle: dto.ownerHandle, agentLabel: "bot" });
  });

  it("read false-green guard (addition): 20 consecutive reads leave last_edited_* unchanged", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const { token } = await seedTokenForUser(ctx.db, u.id);
    expect((await ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(token), payload: { op: "append", markdown: "x" } })).statusCode).toBe(201);
    const before = await row(ctx, note.id);
    for (let i = 0; i < 20; i += 1) await getContent(ctx.app, note.id, token);
    const after = await row(ctx, note.id);
    expect(after.lastEditedAt!.getTime()).toBe(before.lastEditedAt!.getTime());
  });

  it("onStoreDocument UPDATE failure only warns and note_states is still persisted; a non-string lastContext.userId skips the UPDATE", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const session = await ctx.loginAs("a@example.com", PASSWORD);
    // Making the notes UPDATE fail: deleting the FK target of last_edited_by isn't viable (cascade), so a pg trigger makes the
    // UPDATE fail and is removed after persisting. Always use the `sql` template (repo convention, see collab-auth.test.ts), never concatenate ids into raw strings.
    await ctx.db.execute(sql`create or replace function knb_boom() returns trigger as $$ begin raise exception 'boom'; end $$ language plpgsql`);
    await ctx.db.execute(sql`create trigger knb_boom_trg before update of last_edited_at on notes for each row execute function knb_boom()`);
    // The seed isn't "x": seedContent's sentinel is the last line's visible text, while docText() is the whole XML string, whose
    // attribute names like `textColor` already contain `x`, so a one-char ASCII sentinel would match immediately and wait for nothing.
    const client = await seedContent(ctx, session, note.id, "觸發器種子");
    client.disconnect(); await settled(ctx);
    expect((await ctx.db.execute(sql`select 1 from note_states where note_id = ${note.id}`)).rowCount).toBe(1);
    expect((await row(ctx, note.id)).lastEditedAt).toBeNull();
    expect(ctx.collabLogs.some(l => l.level === "warn" && /last_edited/.test(l.msg))).toBe(true);
    await ctx.db.execute(sql`drop trigger knb_boom_trg on notes`);
    // userId not a string: a direct context without userId (onStoreDocument's first guard)
    const direct = await ctx.collab.hocuspocus.openDirectConnection(note.id, {} as never);
    await direct.transact(doc => { doc.getXmlFragment(YDOC_FRAGMENT); }); await direct.disconnect();
    expect((await row(ctx, note.id)).lastEditedAt).toBeNull();
  });
});

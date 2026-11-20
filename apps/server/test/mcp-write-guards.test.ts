import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { noteAiEdits, noteStates, notes } from "../src/db/schema.js";
import { EDIT_LIMIT, FixedWindowLimiter } from "../src/http/rate-limit.js";
import { NOTE_NOT_FOUND_MESSAGE } from "../src/mcp/note-read.js";
import { writeFailureMessage } from "../src/mcp/write-messages.js";
import { presenceClientId } from "../src/notes/editing/presence.js";
import { NUL } from "../src/notes/schemas.js";
import { buildCollabTestApp, type CollabTestCtx, type HttpSession } from "./helpers.js";
import { bearer, docText, getContent, seedContent, seedTokenForUser, waitFor } from "./editing-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import type { FastifyInstance } from "fastify";
import { ERROR_CODES } from "@knotebook/shared";

const PASSWORD = "correct-horse-battery";

interface ToolResultBody {
  isError?: true;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown> & { code?: string; message?: string };
}

interface ToolCall {
  status: number;
  result: ToolResultBody;
}

interface EditPayload extends Record<string, unknown> {
  editId: string;
  fingerprint: string;
  outline: { sections: Array<{ sectionId: string; level: number; heading: string; chars: number; fingerprint?: string }>; truncated: boolean };
  unboundWikilinks: number;
}

async function callTool(app: FastifyInstance, token: string, name: string, args: unknown = {}): Promise<ToolCall> {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), { token });
  return { status: res.statusCode, result: res.json().result };
}

function payloadOf<T>(call: ToolCall): T {
  expect(call.status).toBe(200);
  expect(call.result.isError).toBeUndefined();
  expect(call.result.content[0]!.text).toBe(JSON.stringify(call.result.structuredContent));
  return call.result.structuredContent as unknown as T;
}

function errorOf(call: ToolCall): Record<string, unknown> & { code?: string; message?: string } {
  expect(call.status).toBe(200);
  expect(call.result.isError).toBe(true);
  expect(call.result.content[0]!.text).toBe(JSON.stringify(call.result.structuredContent));
  return call.result.structuredContent!;
}

const editNote = (app: FastifyInstance, token: string, args: Record<string, unknown>) => callTool(app, token, "edit_note", args);
const createNote = (app: FastifyInstance, token: string, args: Record<string, unknown> = {}) => callTool(app, token, "create_note", args);

/** Outline read via REST: an independent source of truth for `sectionId`/`fingerprint`. */
async function restOutline(app: FastifyInstance, noteId: string, token: string) {
  const res = await getContent(app, noteId, token);
  expect(res.statusCode).toBe(200);
  return res.json() as {
    markdown: string;
    fingerprint: string;
    outline: Array<{ sectionId: string; level: number; heading: string; chars: number; fingerprint: string }>;
  };
}

const countNotes = async (ctx: CollabTestCtx, ownerId: string): Promise<number> =>
  (await ctx.db.select().from(notes).where(eq(notes.ownerId, ownerId))).length;

interface Scene {
  ctx: CollabTestCtx;
  ownerId: string;
  session: HttpSession;
  token: string;
  tokenId: string;
  noteId: string;
  disconnect: () => void;
}

/** Headings must all be the same level: `## B` would be sectionized into A's section. */
const THREE_SECTIONS = "# A\n\n第一段內容\n\n# B\n\n第二段內容\n\n# C\n\n第三段內容";

/** PAT named "Claude Code" gives agent label "claude". */
async function scene(
  markdown: string | null = THREE_SECTIONS,
  opts: Parameters<typeof buildCollabTestApp>[0] = {}
): Promise<Scene> {
  const ctx = await buildCollabTestApp(opts);
  const email = `o-${randomUUID()}@example.com`;
  const owner = await ctx.createUser({ email, password: PASSWORD });
  const note = await ctx.createNote(owner.id);
  const { token, tokenId } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write", "Claude Code");
  const session = await ctx.loginAs(email, PASSWORD);
  let disconnect = (): void => {};
  if (markdown !== null) {
    const client = await seedContent(ctx, session, note.id, markdown);
    disconnect = () => client.disconnect();
  }
  return { ctx, ownerId: owner.id, session, token, tokenId, noteId: note.id, disconnect };
}

/** `documents.get(noteId)` may be `undefined` (note never opened by anyone): doc text then counts as empty and awareness keys as empty. */
interface SideEffectSnapshot {
  editsCount: number;
  docText: string;
  documentsSize: number;
  awarenessKeys: number[];
}

async function snapshot(ctx: CollabTestCtx, noteId: string): Promise<SideEffectSnapshot> {
  const doc = ctx.collab.hocuspocus.documents.get(noteId);
  return {
    editsCount: (await ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, noteId))).length,
    docText: doc ? docText(doc) : "",
    documentsSize: ctx.collab.hocuspocus.documents.size,
    awarenessKeys: doc ? [...doc.awareness.getStates().keys()].sort() : [],
  };
}

async function expectNoSideEffects(ctx: CollabTestCtx, noteId: string, before: SideEffectSnapshot): Promise<void> {
  const after = await snapshot(ctx, noteId);
  expect(after.editsCount, "無新 note_ai_edits 列").toBe(before.editsCount);
  expect(after.docText, "live doc 內容位元組不變").toBe(before.docText);
  expect(after.documentsSize, "hocuspocus.documents 未因此新增文件").toBe(before.documentsSize);
  // Key-set comparison only discriminates when awareness was empty at `before`; where an earlier successful call made it non-empty
  // (see the fingerprint_mismatch case), a stray touch would only update that clientId's state in place, so that case compares deeply. In the side-by-side cases that call this after a successful append, the key-set comparison can't see such an in-place touch either.
  expect(after.awarenessKeys, "無新名牌加入 awareness（本檔全是拒絕案）").toEqual(before.awarenessKeys);
}

describe("rejections: four zero-side-effect checks per case", () => {
  // Unlike `mcp-tools-list.test.ts`, which asserts only note_ai_edits, this runs all four zero-side-effect checks.
  it("insufficient scope (read-only credential calls edit_note) -> SDK error (no structuredContent), no side effects", async () => {
    const s = await scene();
    const { token: ro } = await seedTokenForUser(s.ctx.db, s.ownerId, "notes:read", "Reader");
    const before = await snapshot(s.ctx, s.noteId);

    const call = await editNote(s.ctx.app, ro, { note_id: s.noteId, op: "append", markdown: "不該寫進去" });
    await expectNoSideEffects(s.ctx, s.noteId, before);

    expect(call.status).toBe(200);
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0]!.text).toContain("Tool edit_note not found");
    expect(call.result.structuredContent).toBeUndefined();
    s.disconnect();
  });

  it("viewer calls edit_note -> forbidden, no side effects", async () => {
    const s = await scene();
    const viewer = await s.ctx.createUser({ email: `v-${randomUUID()}@example.com`, password: PASSWORD });
    await s.ctx.share(s.noteId, viewer.id, "viewer");
    const { token: viewerToken } = await seedTokenForUser(s.ctx.db, viewer.id, "notes:read notes:write", "Viewer PAT");
    const before = await snapshot(s.ctx, s.noteId);

    const call = await editNote(s.ctx.app, viewerToken, { note_id: s.noteId, op: "append", markdown: "不該寫進去" });
    await expectNoSideEffects(s.ctx, s.noteId, before);

    const err = errorOf(call);
    expect(err.code).toBe("forbidden");
    s.disconnect();
  });

  // Also holds its own `edit` limiter to check it is charged after the role check (a role===none 404 must not consume it): this catches moving the edit limiter before resolveRole,
  // which a limit:0 case can't.
  it("role none (someone else's private note) -> not_found with exactly the same message as a missing note, edit limiter untouched, no side effects", async () => {
    const edit = new FixedWindowLimiter(EDIT_LIMIT);
    const s = await scene(THREE_SECTIONS, { limiters: { edit } });
    const stranger = await s.ctx.createUser({ email: `x-${randomUUID()}@example.com`, password: PASSWORD });
    const strangerNote = await s.ctx.createNote(stranger.id);
    const before = await snapshot(s.ctx, strangerNote.id);

    const call = await editNote(s.ctx.app, s.token, { note_id: strangerNote.id, op: "append", markdown: "不該寫進去" });
    await expectNoSideEffects(s.ctx, strangerNote.id, before);
    // Ordering guard: the `edit` limiter is still full; its key is the bare userId (`ctx.userId`).
    let left = 0;
    while (edit.consume(s.ownerId)) left += 1;
    expect(left, "role===none 的 404 不得啃掉 edit 桶").toBe(EDIT_LIMIT.limit);

    const err = errorOf(call);
    expect(err.code).toBe("not_found");
    expect(err.message).toBe(NOTE_NOT_FOUND_MESSAGE);
    s.disconnect();
  });

  // limit:0 makes consume() always false, so this case cannot detect the edit limiter moving before the role check
  // (the role===none case above covers that).
  it("edit limiter exhausted -> too_many_requests, no side effects", async () => {
    const s = await scene(THREE_SECTIONS, { limiters: { edit: new FixedWindowLimiter({ limit: 0, windowMs: 600_000 }) } });
    const before = await snapshot(s.ctx, s.noteId);

    const call = await editNote(s.ctx.app, s.token, { note_id: s.noteId, op: "append", markdown: "不該寫進去" });
    await expectNoSideEffects(s.ctx, s.noteId, before);

    const err = errorOf(call);
    expect(err.code).toBe("too_many_requests");
    s.disconnect();
  });

  it("queue wait timeout (editingQueueWaitMs: 50 with beforeMerge stuck) -> edit_note returns server_busy, no side effects", async () => {
    let entered = false;
    let release: () => void = () => {};
    const hold = new Promise<void>(r => {
      release = r;
    });
    const s = await scene(THREE_SECTIONS, {
      editingQueueWaitMs: 50,
      editingTestHooks: {
        beforeMerge: async () => {
          entered = true;
          await hold;
        },
      },
    });
    const before = await snapshot(s.ctx, s.noteId);

    const first = editNote(s.ctx.app, s.token, { note_id: s.noteId, op: "append", markdown: "first" });
    await waitFor("first 已卡在 beforeMerge（佔住佇列）", 2_000, () => entered);

    const call = await editNote(s.ctx.app, s.token, { note_id: s.noteId, op: "append", markdown: "不該寫進去" });
    await expectNoSideEffects(s.ctx, s.noteId, before);

    const err = errorOf(call);
    expect(err.code).toBe("server_busy");

    release();
    await first; // let the first request finish so no dangling promise leaks into the next case
    s.disconnect();
  });

  // `insufficient_scope` is unreachable over HTTP: a read-only credential has no edit_note to call, and a read-write one passes
  // requireWriteScope's session/scope check, so this case covers only forbidden and fingerprint_mismatch.
  it("both write-side errors we produce (forbidden, fingerprint_mismatch) are in ERROR_CODES, and content mirrors structuredContent", async () => {
    const s1 = await scene();
    const viewer = await s1.ctx.createUser({ email: `v-${randomUUID()}@example.com`, password: PASSWORD });
    await s1.ctx.share(s1.noteId, viewer.id, "viewer");
    const { token: viewerToken } = await seedTokenForUser(s1.ctx.db, viewer.id, "notes:read notes:write", "Viewer PAT");
    const forbiddenCall = await editNote(s1.ctx.app, viewerToken, { note_id: s1.noteId, op: "append", markdown: "x" });
    expect(forbiddenCall.result.isError).toBe(true);
    expect(forbiddenCall.result.content[0]!.text).toBe(JSON.stringify(forbiddenCall.result.structuredContent));
    expect(ERROR_CODES).toContain(forbiddenCall.result.structuredContent!.code);
    expect(forbiddenCall.result.structuredContent!.code).toBe("forbidden");
    s1.disconnect();

    const s2 = await scene();
    const before = await restOutline(s2.ctx.app, s2.noteId, s2.token);
    payloadOf<EditPayload>(await editNote(s2.ctx.app, s2.token, { note_id: s2.noteId, op: "append", markdown: "先改一次" }));
    const last = before.outline[before.outline.length - 1]!;
    const mismatchCall = await editNote(s2.ctx.app, s2.token, {
      note_id: s2.noteId,
      op: "replace_section",
      section_id: last.sectionId,
      markdown: "不該寫進去",
      if_match: last.fingerprint,
    });
    expect(mismatchCall.result.isError).toBe(true);
    expect(mismatchCall.result.content[0]!.text).toBe(JSON.stringify(mismatchCall.result.structuredContent));
    expect(ERROR_CODES).toContain(mismatchCall.result.structuredContent!.code);
    expect(mismatchCall.result.structuredContent!.code).toBe("fingerprint_mismatch");
    s2.disconnect();
  });

  // Awareness is already non-empty at `before`: the preceding successful append (needed to make `last.fingerprint` stale) touched
  // presence. A stray touch on the fingerprint_mismatch path would only update the same clientId's state in place (key set
  // unchanged), so snapshot()'s key-set comparison cannot catch it; compare that clientId's whole state (structuredClone) instead.
  it("stale if_match -> fingerprint_mismatch, no side effects (presence compared deeply)", async () => {
    const s = await scene();
    const before0 = await restOutline(s.ctx.app, s.noteId, s.token);
    payloadOf<EditPayload>(await editNote(s.ctx.app, s.token, { note_id: s.noteId, op: "append", markdown: "先改一次" }));
    const last = before0.outline[before0.outline.length - 1]!;

    const doc = () => s.ctx.collab.hocuspocus.documents.get(s.noteId)!;
    const clientId = presenceClientId(s.noteId, s.tokenId);
    const stateBefore = structuredClone(doc().awareness.getStates().get(clientId));
    expect(
      stateBefore,
      "前提：先前那發成功的 append 已經讓這顆 token 的名牌現身，否則下面的深度比對是恆真的"
    ).toBeDefined();
    const before = await snapshot(s.ctx, s.noteId);

    const call = await editNote(s.ctx.app, s.token, {
      note_id: s.noteId,
      op: "replace_section",
      section_id: last.sectionId,
      markdown: "不該寫進去",
      if_match: last.fingerprint,
    });

    await expectNoSideEffects(s.ctx, s.noteId, before);
    expect(doc().awareness.getStates().get(clientId), "presence 的 state 沒有再被 touch（深度比對）").toEqual(stateBefore);

    const err = errorOf(call);
    expect(err.code).toBe("fingerprint_mismatch");
    s.disconnect();
  });

  // `create_note` must carry `content`; the test owns `tokenWrite` and consume()s its single slot directly, avoiding a wasted successful call.
  it("both write tools: tokenWrite limiter (limit: 1) exhausted -> blocked", async () => {
    {
      const tokenWrite = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
      const s = await scene(THREE_SECTIONS, { limiters: { tokenWrite } });
      tokenWrite.consume(`token:${s.ownerId}`);
      const before = await snapshot(s.ctx, s.noteId);

      const call = await editNote(s.ctx.app, s.token, { note_id: s.noteId, op: "append", markdown: "不該寫進去" });
      await expectNoSideEffects(s.ctx, s.noteId, before);

      const err = errorOf(call);
      expect(err.code).toBe("too_many_requests");
      s.disconnect();
    }
    {
      const tokenWrite = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
      const s = await scene(null, { limiters: { tokenWrite } });
      tokenWrite.consume(`token:${s.ownerId}`);
      const before = await countNotes(s.ctx, s.ownerId);

      const call = await createNote(s.ctx.app, s.token, { title: "T", content: "內容" });
      expect(await countNotes(s.ctx, s.ownerId), "notes 表零新增列").toBe(before);

      const err = errorOf(call);
      expect(err.code).toBe("too_many_requests");
      s.disconnect();
    }
  });

  // Catches a change of the charging order: the first request hits someone else's private note (role===none) -> not_found, but
  // `tokenWrite` is consumed (`requireWriteScope` runs before `resolveRole`, matching the REST preHandler order); the next
  // valid edit_note on the caller's own note is blocked with too_many_requests. A case that targets only visible notes can't detect this order.
  it("edit_note charging order: the role=none request still consumes tokenWrite despite its 404, so the next valid request is blocked", async () => {
    const tokenWrite = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
    const s = await scene(THREE_SECTIONS, { limiters: { tokenWrite } });
    const stranger = await s.ctx.createUser({ email: `x-${randomUUID()}@example.com`, password: PASSWORD });
    const strangerNote = await s.ctx.createNote(stranger.id);

    const first = await editNote(s.ctx.app, s.token, { note_id: strangerNote.id, op: "append", markdown: "x" });
    expect(errorOf(first).code).toBe("not_found");

    const before = await snapshot(s.ctx, s.noteId);
    const second = await editNote(s.ctx.app, s.token, { note_id: s.noteId, op: "append", markdown: "應該被擋" });
    await expectNoSideEffects(s.ctx, s.noteId, before);

    const err = errorOf(second);
    expect(err.code).toBe("too_many_requests");
    s.disconnect();
  });
});

describe("serialization", () => {
  // Assert concurrency itself, not result codes: A (REST) stalls in `beforeMerge`, B (MCP) is issued meanwhile, and B must not
  // enter `beforeMerge` (inFlight/maxInFlight counters). Catches MCP and REST using separate write queue instances.
  it("REST and MCP writes to the same note stay serialized (inFlight counters, not result codes)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>(r => {
      releaseA = r;
    });
    let firstCall = true;
    const beforeMerge = async (): Promise<void> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (firstCall) {
        firstCall = false;
        await gateA;
      }
      inFlight -= 1;
    };
    const s = await scene(THREE_SECTIONS, { editingTestHooks: { beforeMerge } });
    const rest = await restOutline(s.ctx.app, s.noteId, s.token);

    const a = s.ctx.app.inject({
      method: "POST",
      url: `/api/notes/${s.noteId}/edits`,
      headers: bearer(s.token),
      payload: { op: "replace_all", markdown: "# A 改的\n\nA 的內容", if_match: rest.fingerprint },
    });
    await waitFor("A 已卡在 beforeMerge（佔住佇列）", 2_000, () => inFlight === 1);

    // B: MCP edit_note on the same note with the same if_match, which A's hold makes stale.
    const b = editNote(s.ctx.app, s.token, {
      note_id: s.noteId,
      op: "replace_all",
      markdown: "# B 改的\n\nB 的內容",
      if_match: rest.fingerprint,
    });

    await new Promise(r => setTimeout(r, 30)); // long enough for B to reach beforeMerge in parallel if serialization were broken
    expect(inFlight, "前提守衛：A 此刻確實還卡著，否則整案空轉").toBe(1);
    expect(maxInFlight, "B 在 A 還卡著時沒有進入 beforeMerge").toBe(1);

    releaseA();
    const aRes = await a;
    expect(aRes.statusCode, "A 的 REST 寫入成功").toBe(201);
    const bCall = await b;
    // Incidental assertion (not a guard): the loser (B, stale if_match) gets one of these codes.
    expect(bCall.result.isError).toBe(true);
    expect(["fingerprint_mismatch", "section_not_found", "server_busy"]).toContain(bCall.result.structuredContent!.code);
    expect(maxInFlight).toBe(1);
    s.disconnect();
  });
});

describe("truncated section and zero-read bypass", () => {
  it("truncated section: read_note_section returns no fingerprint; a guessed if_match on replace_section -> fingerprint_mismatch", async () => {
    const LONG = "L".repeat(9_000);
    const s = await scene(`# Long\n\n${LONG}`);
    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    const target = rest.outline[1]!; // the "Long" section

    const page = payloadOf<{ section: { fingerprint?: string }; truncated: boolean }>(
      await callTool(s.ctx.app, s.token, "read_note_section", { note_id: s.noteId, section_id: target.sectionId })
    );
    expect(page.truncated).toBe(true);
    expect(page.section.fingerprint).toBeUndefined();

    // A guessed/stale if_match: valid format (16 hex) but the caller never actually read it.
    const guessed = "0".repeat(16);
    const call = await editNote(s.ctx.app, s.token, {
      note_id: s.noteId,
      op: "replace_section",
      section_id: target.sectionId,
      markdown: "# Long\n\n改過",
      if_match: guessed,
    });
    const err = errorOf(call);
    expect(err.code).toBe("fingerprint_mismatch");
    s.disconnect();
  });

  // Expected to succeed (zero-read bypass), intentionally and not a hole: the user sees the junk in the note and note_ai_edits has
  // a row, so it can be undone. `markdown: "\n"` can't be used (`isBlankParseResult` returns empty_content); the data is a real
  // non-empty block, in a note that already has content and <= 100 sections (`THREE_SECTIONS`).
  it("append without reading succeeds and returns the whole-note fingerprint; replace_all with it also succeeds", async () => {
    const s = await scene(THREE_SECTIONS);
    const appended = payloadOf<EditPayload>(
      await editNote(s.ctx.app, s.token, { note_id: s.noteId, op: "append", markdown: "# 零讀取追加\n\n沒讀過就寫的內容" })
    );
    expect(appended.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    const edits = await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.noteId));
    expect(edits).toHaveLength(1);
    expect(edits[0]!.op).toBe("append");

    const replaced = payloadOf<EditPayload>(
      await editNote(s.ctx.app, s.token, { note_id: s.noteId, op: "replace_all", markdown: "# X\n\nxxx", if_match: appended.fingerprint })
    );
    expect(replaced.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    s.disconnect();
  });
});

// MCP and REST share parseMarkdownForNote.
const ROW2 = `<div data-kb-columns style="display:flex;gap:16px">\n<div data-kb-column style="flex:1">\n\nA\n\n</div>\n<div data-kb-column style="flex:1">\n\nB\n\n</div>\n</div>`;
const FIVE_COLS = `<div data-kb-columns style="display:flex;gap:16px">\n${[1, 2, 3, 4, 5].map(i => `<div data-kb-column style="flex:1">\n\nc${i}\n\n</div>`).join("\n")}\n</div>`;
const FLEX_DIV = '<div style="display:flex"><div><p>L</p></div><div><p>R</p></div></div>';
const FIGURE_IMG = '<figure><img alt="p" src="/api/uploads/u9" width="300"></figure>';
const BARE_IMG = '<img alt="p" src="/api/uploads/u9" width="300">';
/** Verbatim REST 400 message (unsupported_columns). */
const REST_COLUMNS_MESSAGE =
  "That markdown has layout or editor-internal HTML this editor cannot store, so nothing was written. Write side-by-side columns exactly as GET /api/notes/:id/content returns them: <div data-kb-columns style=\"display:flex;gap:16px\"> holding 2 to 4 <div data-kb-column style=\"flex:N\"> columns, N from 0.1 to 10 with at most two decimal places, with a blank line after each column's opening tag and another before its </div>, at the top level of the markdown, not nested inside a list, a quote or anything else. Other <div> elements cannot use display:flex or display:grid, and no element can carry data-node-type.";
const REST_SIZE_MESSAGE =
  "An image width or table column width in that markdown is not in a form this editor can store, so nothing was written. Write sizes exactly as GET /api/notes/:id/content returns them, as whole numbers of pixels from 32 to 4000: an image's width on the <img> inside a <figure> that is outside any table, the <img> carrying only alt (optional), src and width, in that order, and a table's column widths as colwidth on its first row's cells, one comma-separated value for each column a cell spans, left empty for a column with no width.";

describe("side-by-side and size: writes reject unsupported shapes", () => {
  const stateOf = async (s: Scene) => {
    const [r] = await s.ctx.db.select({ y: noteStates.ydoc }).from(noteStates).where(eq(noteStates.noteId, s.noteId));
    return r ? Buffer.from(r.y).toString("base64") : null;
  };
  const editsOf = async (s: Scene) => (await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.noteId))).length;
  const restEdit = (s: Scene, payload: Record<string, unknown>) =>
    s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.noteId}/edits`, headers: bearer(s.token), payload });

  it("MCP edit_note append of five columns -> unsupported_columns, verbatim message, note_states byte-identical, only the earlier successful edit recorded (false-green guard: a valid two-column append on the same path succeeds)", async () => {
    const s = await scene();
    const ok = payloadOf<EditPayload>(await editNote(s.ctx.app, s.token, { note_id: s.noteId, op: "append", markdown: ROW2 }));
    expect(ok.editId).toBeTruthy();
    expect(await editsOf(s)).toBe(1);
    const before = await snapshot(s.ctx, s.noteId);
    const stateBefore = await stateOf(s);

    const err = errorOf(await editNote(s.ctx.app, s.token, { note_id: s.noteId, op: "append", markdown: FIVE_COLS }));
    expect(err.code).toBe("unsupported_columns");
    expect(err.message).toBe(writeFailureMessage("unsupported_columns"));
    expect(err.message).toContain("side-by-side columns"); // the code and sentence aren't mismatched (both from writeFailureMessage above; verbatim text is pinned by write-messages.test.ts)

    await expectNoSideEffects(s.ctx, s.noteId, before);
    expect(await stateOf(s)).toBe(stateBefore);
    expect(await editsOf(s)).toBe(1);
    s.disconnect();
  });

  it("REST POST /api/notes with a display:flex div -> 400 unsupported_columns, verbatim message, no note created", async () => {
    const s = await scene();
    const okRes = await s.ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(s.token), payload: { title: "OK", content: ROW2 } });
    expect(okRes.statusCode).toBe(201);
    const before = await countNotes(s.ctx, s.ownerId);

    const res = await s.ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(s.token), payload: { title: "Flex", content: FLEX_DIV } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("unsupported_columns");
    expect(res.json().error.message).toBe(REST_COLUMNS_MESSAGE);
    expect(await countNotes(s.ctx, s.ownerId)).toBe(before);
    s.disconnect();
  });

  it("REST POST /api/notes/:id/edits append of a bare img with width -> 400 unsupported_size, verbatim message, note_states unchanged", async () => {
    const s = await scene();
    expect((await restEdit(s, { op: "append", markdown: FIGURE_IMG })).statusCode).toBe(201);
    const before = await snapshot(s.ctx, s.noteId);
    const stateBefore = await stateOf(s);

    const res = await restEdit(s, { op: "append", markdown: BARE_IMG });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("unsupported_size");
    expect(res.json().error.message).toBe(REST_SIZE_MESSAGE);

    await expectNoSideEffects(s.ctx, s.noteId, before);
    expect(await stateOf(s)).toBe(stateBefore);
    s.disconnect();
  });

  it("MCP create_note with a bare img with width -> unsupported_size, verbatim message, no note created (false-green guard: the <figure> form succeeds)", async () => {
    const s = await scene();
    payloadOf(await createNote(s.ctx.app, s.token, { title: "Fig", content: FIGURE_IMG }));
    const before = await countNotes(s.ctx, s.ownerId);

    const err = errorOf(await createNote(s.ctx.app, s.token, { title: "Bare", content: BARE_IMG }));
    expect(err.code).toBe("unsupported_size");
    expect(err.message).toBe(writeFailureMessage("unsupported_size"));
    expect(err.message).toContain("image width");
    expect(await countNotes(s.ctx, s.ownerId)).toBe(before);
    s.disconnect();
  });

  it("input on which core parse throws (<div data-content-type=\"paragraph\">) -> REST 400 unsupported_block (not 500), nothing written", async () => {
    const s = await scene();
    expect((await restEdit(s, { op: "append", markdown: "普通的一段" })).statusCode).toBe(201);
    const before = await snapshot(s.ctx, s.noteId);
    const stateBefore = await stateOf(s);

    const res = await restEdit(s, { op: "append", markdown: '<div data-content-type="paragraph">x</div>' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("unsupported_block");

    await expectNoSideEffects(s.ctx, s.noteId, before);
    expect(await stateOf(s)).toBe(stateBefore);
    s.disconnect();
  });
});

describe("schema rejections over HTTP persist nothing (schema half in test/unit/mcp-write-schemas.test.ts)", () => {
  // The schema-level safeParse assertion lives in `test/unit/mcp-write-schemas.test.ts`; this covers the same payload through
  // tools/call, which needs `buildCollabTestApp()` (real DB). That conflicts with `vitest.unit.config.ts` deliberately having no
  // `globalSetup` (so `test:unit` never uses docker), hence this existing integration file.
  it("markdown containing NUL: over HTTP too an SDK error (no structuredContent) and no new note_ai_edits row", async () => {
    const s = await scene(null);
    const before = await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.noteId));

    const call = await editNote(s.ctx.app, s.token, { note_id: s.noteId, op: "append", markdown: "x" + NUL });
    expect(call.status).toBe(200);
    expect(call.result.isError).toBe(true);
    // The SDK itself rejects input-schema failures: no `structuredContent`, since our handler is never called and `toolError()` never runs.
    expect(call.result.structuredContent).toBeUndefined();

    const after = await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.noteId));
    expect(after).toHaveLength(before.length);
    s.disconnect();
  });

  it("create_note with an empty-string title: over HTTP too an SDK error, no new notes row", async () => {
    const s = await scene(null);
    const before = await countNotes(s.ctx, s.ownerId);

    const call = await createNote(s.ctx.app, s.token, { title: "" });
    expect(call.status).toBe(200);
    expect(call.result.isError).toBe(true);
    expect(call.result.structuredContent).toBeUndefined();

    expect(await countNotes(s.ctx, s.ownerId)).toBe(before);
    s.disconnect();
  });
});

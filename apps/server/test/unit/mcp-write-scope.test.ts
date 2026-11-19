/**
 * #108: the three things `requireWriteScope()` does (scope check, session skip, `tokenWrite` charge) and the shape of the limiter key.
 *
 * The second call is what reaches the `insufficient_scope` branch: on `/api/mcp` tools are **registered after scope filtering**, so a read-only credential
 * has no `edit_note` to call (it gets the SDK's "Tool edit_note not found"), and the session path returns at step 1. **That branch can't be reached over HTTP**,
 * so the integration cases can't be cited as covering it.
 *
 * Why ctx is constructed directly instead of going through HTTP: this function takes an `McpToolCtx`, and its four fields (`authKind`/`tokenScope`/
 * `limiters.tokenWrite`/`userId`) are everything it reads; calling it alone is its natural interface (the same as the "every tool can be called alone"
 * design in the header of `mcp/context.ts`).
 */
import { describe, expect, it } from "vitest";
import { FixedWindowLimiter } from "../../src/http/rate-limit.js";
import type { TokenScope } from "@knotebook/shared";
import {
  canDeleteNotes,
  canMoveNotes,
  DELETE_SCOPE_MESSAGE,
  INSUFFICIENT_SCOPE_MESSAGE,
  requireDeleteScope,
  requireMoveScope,
  requireWriteScope,
} from "../../src/mcp/write-scope.js";
import { moveNoteToGroupTool, MOVE_NEEDS_MOVE_MESSAGE } from "../../src/mcp/tools/move-note-to-group.js";
import { deleteNoteTool } from "../../src/mcp/tools/delete-note.js";
import { restoreNoteTool } from "../../src/mcp/tools/restore-note.js";
import type { McpToolCtx } from "../../src/mcp/context.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";

/**
 * The cast is deliberate: `McpToolCtx` also has `db`/`writes`/`log` etc. fields that this function doesn't read at all, and building them would blur what it
 * really reads. The cost: if `requireWriteScope` later reads a fifth field, this fails at runtime (dereferencing `undefined`), not at tsc.
 */
function ctxWith(over: {
  authKind: "token" | "session";
  tokenScope: McpToolCtx["tokenScope"];
  tokenWrite: FixedWindowLimiter;
}): McpToolCtx {
  return {
    userId: USER_ID,
    authKind: over.authKind,
    tokenScope: over.tokenScope,
    limiters: { tokenWrite: over.tokenWrite },
  } as unknown as McpToolCtx;
}

const oneShot = () => new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });

describe("#108 requireWriteScope", () => {
  it("session credential: passes straight through, and the tokenWrite limiter is not touched at all (full identity, as in bearer.ts)", () => {
    const tokenWrite = oneShot();
    const ctx = ctxWith({ authKind: "session", tokenScope: null, tokenWrite });
    expect(requireWriteScope(ctx)).toBeNull();
    expect(requireWriteScope(ctx)).toBeNull();
    // After two calls the limiter is still full: proves it really wasn't charged, rather than 'happened to not be full yet'.
    expect(tokenWrite.consume(`token:${USER_ID}`)).toBe(true);
  });

  it("read-only token: insufficient_scope + remedy wording, and the 403 doesn't eat the limiter", () => {
    const tokenWrite = oneShot();
    const err = requireWriteScope(ctxWith({ authKind: "token", tokenScope: "notes:read", tokenWrite }));
    expect(err).not.toBeNull();
    expect(err!.structuredContent.code).toBe("insufficient_scope");
    // Remedy wording: the message must be non-empty and point at the settings page (strings the model sees are always English).
    expect(err!.structuredContent.message).toContain("notes:write");
    expect(err!.structuredContent.message).toContain("Settings");
    expect(tokenWrite.consume(`token:${USER_ID}`)).toBe(true);
  });

  it("read-write token: passes, and the limiter is one slot lower", () => {
    const tokenWrite = oneShot();
    expect(requireWriteScope(ctxWith({ authKind: "token", tokenScope: "notes:read notes:write", tokenWrite }))).toBeNull();
    expect(tokenWrite.consume(`token:${USER_ID}`)).toBe(false);
  });

  it("limiter exhausted: too_many_requests", () => {
    const tokenWrite = oneShot();
    const ctx = ctxWith({ authKind: "token", tokenScope: "notes:read notes:write", tokenWrite });
    expect(requireWriteScope(ctx)).toBeNull();
    const err = requireWriteScope(ctx);
    expect(err!.structuredContent.code).toBe("too_many_requests");
  });

  // Catches the limiter key being written as a bare userId: the four cases above look identical either way; the difference is whether MCP and REST
  // share one ledger (`bearer.ts` uses `token:${userId}`).
  it("the limiter key is literally `token:${userId}`, the same ledger as bearer.ts", () => {
    const tokenWrite = oneShot();
    // The REST side uses up the only slot first.
    expect(tokenWrite.consume(`token:${USER_ID}`)).toBe(true);
    const err = requireWriteScope(ctxWith({ authKind: "token", tokenScope: "notes:read notes:write", tokenWrite }));
    expect(err!.structuredContent.code).toBe("too_many_requests");
  });
});

const MSG = "test message";

describe("#239 canMoveNotes", () => {
  it("four cells + the drift shape", () => {
    expect(canMoveNotes({ authKind: "session", tokenScope: null })).toBe(true);
    expect(canMoveNotes({ authKind: "token", tokenScope: "notes:read" })).toBe(false);
    expect(canMoveNotes({ authKind: "token", tokenScope: "notes:read notes:write" })).toBe(false);
    expect(canMoveNotes({ authKind: "token", tokenScope: "notes:read notes:write notes:move" })).toBe(true);
    // CHECK drift shape: move without write must not pass.
    expect(canMoveNotes({ authKind: "token", tokenScope: "notes:read notes:move" as TokenScope })).toBe(false);
  });
});

describe("#239 requireMoveScope", () => {
  it("read-write credential: insufficient_scope + the caller's message, and tokenWrite isn't charged", () => {
    const tokenWrite = oneShot();
    const err = requireMoveScope(ctxWith({ authKind: "token", tokenScope: "notes:read notes:write", tokenWrite }), MSG);
    expect(err!.structuredContent.code).toBe("insufficient_scope");
    expect(err!.structuredContent.message).toBe(MSG);
    expect(tokenWrite.consume(`token:${USER_ID}`)).toBe(true);
  });
  it("read-only credential: returns the write remedy message (not the caller's message)", () => {
    const err = requireMoveScope(ctxWith({ authKind: "token", tokenScope: "notes:read", tokenWrite: oneShot() }), MSG);
    expect(err!.structuredContent.message).not.toBe(MSG);
    expect(err!.structuredContent.message).toContain("notes:write");
  });
  it("read-write-move: passes and charges one slot; session: passes without charging", () => {
    const tw = oneShot();
    expect(requireMoveScope(ctxWith({ authKind: "token", tokenScope: "notes:read notes:write notes:move", tokenWrite: tw }), MSG)).toBeNull();
    expect(tw.consume(`token:${USER_ID}`)).toBe(false);
    const ts = oneShot();
    expect(requireMoveScope(ctxWith({ authKind: "session", tokenScope: null, tokenWrite: ts }), MSG)).toBeNull();
    expect(ts.consume(`token:${USER_ID}`)).toBe(true);
  });
});

const R = "notes:read";
const RW = "notes:read notes:write";
const RWM = "notes:read notes:write notes:move";
const RWD = "notes:read notes:write notes:delete";
const RWMD = "notes:read notes:write notes:move notes:delete";

// #181: the two scope branches of requireDeleteScope can't be reached over HTTP (delete_note/restore_note are only registered when canDeleteNotes);
// this section is where they are exercised; the tokenWrite charge is reachable over HTTP (also covered by mcp-trash-tools.test.ts).
describe("#181 canDeleteNotes", () => {
  it("five forms + session + two drift shapes", () => {
    expect(canDeleteNotes({ authKind: "session", tokenScope: null })).toBe(true);
    expect(canDeleteNotes({ authKind: "token", tokenScope: R })).toBe(false);
    expect(canDeleteNotes({ authKind: "token", tokenScope: RW })).toBe(false);
    expect(canDeleteNotes({ authKind: "token", tokenScope: RWM })).toBe(false);
    expect(canDeleteNotes({ authKind: "token", tokenScope: RWD })).toBe(true);
    expect(canDeleteNotes({ authKind: "token", tokenScope: RWMD })).toBe(true);
    // CHECK drift shape: delete without write must not pass (same as canMoveNotes).
    expect(canDeleteNotes({ authKind: "token", tokenScope: "notes:read notes:delete" as TokenScope })).toBe(false);
    expect(canDeleteNotes({ authKind: "token", tokenScope: "notes:read notes:move notes:delete" as TokenScope })).toBe(false);
  });
});

describe("#181 requireDeleteScope", () => {
  it("session: passes, and tokenWrite isn't touched at all", () => {
    const tw = oneShot();
    const ctx = ctxWith({ authKind: "session", tokenScope: null, tokenWrite: tw });
    expect(requireDeleteScope(ctx)).toBeNull();
    expect(requireDeleteScope(ctx)).toBeNull();
    expect(tw.consume(`token:${USER_ID}`)).toBe(true);
  });
  it("read-only credential: insufficient_scope + the write remedy sentence, and tokenWrite isn't charged", () => {
    const tw = oneShot();
    const err = requireDeleteScope(ctxWith({ authKind: "token", tokenScope: R, tokenWrite: tw }));
    expect(err?.structuredContent).toEqual({ code: "insufficient_scope", message: INSUFFICIENT_SCOPE_MESSAGE });
    expect(tw.consume(`token:${USER_ID}`)).toBe(true);
  });
  it.each<TokenScope>([RW, RWM])("%s: insufficient_scope + DELETE_SCOPE_MESSAGE, and tokenWrite isn't charged", (scope) => {
    const tw = oneShot();
    const err = requireDeleteScope(ctxWith({ authKind: "token", tokenScope: scope, tokenWrite: tw }));
    expect(err?.structuredContent).toEqual({ code: "insufficient_scope", message: DELETE_SCOPE_MESSAGE });
    expect(tw.consume(`token:${USER_ID}`)).toBe(true);
  });
  it.each<TokenScope>([RWD, RWMD])("%s: passes, and the `token:${userId}` slot is charged", (scope) => {
    const tw = oneShot();
    expect(requireDeleteScope(ctxWith({ authKind: "token", tokenScope: scope, tokenWrite: tw }))).toBeNull();
    expect(tw.consume(`token:${USER_ID}`)).toBe(false);
  });
  it("the limiter key is literally `token:${userId}`: REST uses the only slot first -> too_many_requests", () => {
    const tw = oneShot();
    expect(tw.consume(`token:${USER_ID}`)).toBe(true);
    const err = requireDeleteScope(ctxWith({ authKind: "token", tokenScope: RWD, tokenWrite: tw }));
    expect(err?.structuredContent.code).toBe("too_many_requests");
  });
});

// The scope branch of move_note_to_group can't be reached over HTTP (not registered), so this is where it is exercised.
// `ctxWith` has no `db`: if the implementation touched the DB before the scope check this case would blow up on `undefined`, which is exactly the order being pinned.
describe("#239 moveNoteToGroupTool", () => {
  it("read-write credential calling it directly -> insufficient_scope, message verbatim, before touching the DB", async () => {
    const r = await moveNoteToGroupTool(
      { note_id: "11111111-1111-4111-8111-111111111111", group_id: "22222222-2222-4222-8222-222222222222" },
      ctxWith({ authKind: "token", tokenScope: "notes:read notes:write", tokenWrite: oneShot() }),
    );
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({
      code: "insufficient_scope",
      message: MOVE_NEEDS_MOVE_MESSAGE,
    });
  });
});

// #181 (same as above): the first action of delete_note/restore_note is requireDeleteScope: both the zero side effects of DELETE_SCOPE_MESSAGE's "nothing was changed"
// and of a tokenWrite rejection rely on that order. `db`/`limiters.edit` are probes that record and throw on any touch: they must not be touched when scope or tokenWrite rejects.
describe("#181 the two trash tools: requireDeleteScope runs before any DB access and the edit limiter", () => {
  const NOTE = { note_id: "33333333-3333-4333-8333-333333333333" };
  function probeCtx(tokenScope: TokenScope, tokenWrite: FixedWindowLimiter) {
    const touched: string[] = [];
    const trap = (label: string) =>
      new Proxy({}, { get: (_t, key) => { touched.push(`${label}.${String(key)}`); throw new Error(`touched ${label}.${String(key)}`); } });
    const ctx = { ...ctxWith({ authKind: "token", tokenScope, tokenWrite }), db: trap("db") } as McpToolCtx;
    (ctx.limiters as Record<string, unknown>).edit = trap("edit");
    return { ctx, touched };
  }
  const tools = [["delete_note", deleteNoteTool], ["restore_note", restoreNoteTool]] as const;
  it.each(tools)("%s: read-write-move (no delete) -> insufficient_scope + DELETE_SCOPE_MESSAGE, db/edit untouched, tokenWrite not charged", async (_n, tool) => {
    const tw = oneShot();
    const { ctx, touched } = probeCtx(RWM, tw);
    await expect(tool(NOTE, ctx)).resolves.toMatchObject({ isError: true, structuredContent: { code: "insufficient_scope", message: DELETE_SCOPE_MESSAGE } });
    expect(touched).toEqual([]);
    expect(tw.consume(`token:${USER_ID}`)).toBe(true);
  });
  it.each(tools)("%s: read-write-delete but tokenWrite exhausted -> too_many_requests, db/edit untouched", async (_n, tool) => {
    const tw = oneShot();
    expect(tw.consume(`token:${USER_ID}`)).toBe(true);
    const { ctx, touched } = probeCtx(RWD, tw);
    await expect(tool(NOTE, ctx)).resolves.toMatchObject({ isError: true, structuredContent: { code: "too_many_requests" } });
    expect(touched).toEqual([]);
  });
});

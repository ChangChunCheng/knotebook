/**
 * The whole family uses `buildCollabTestApp` (the production shape): by the tool registration rules `edit_note`, like the two read tools, is **only registered when both
 * `collab` and `editing` exist** (it writes the live doc).
 *
 * **A read-only token gets the SDK's "Tool not found", not `insufficient_scope`**: `McpServer`'s tool list is its registry and `register.ts` already filters `edit_note` out
 * by scope, so `tools/call` takes the SDK's unknown-tool branch and **never reaches our handler**. The `insufficient_scope` branch is dead code over HTTP; its only guard is
 * the second call of `test/unit/mcp-write-scope.test.ts`. What these tests still discriminate is the **four zero-side-effect checks of a rejection**.
 *
 * callTool/payloadOf/errorOf are copies of the same helpers in several other MCP test files, deliberately not moved into mcp-helpers.ts (a few lines each).
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { noteAiEdits } from "../src/db/schema.js";
import { presenceClientId } from "../src/notes/editing/presence.js";
import { MCP_PAGE_MAX } from "../src/mcp/limits.js";
import { buildCollabTestApp, type CollabTestCtx, type HttpSession } from "./helpers.js";
import { bearer, docText, getContent, seedContent, seedTokenForUser, tick, waitFor } from "./editing-helpers.js";
import { INITIALIZE, mcpPost, rpc } from "./mcp-helpers.js";
import { loadDoc, xmlOf } from "./copy-helpers.js";
import type { FastifyInstance } from "fastify";

const PASSWORD = "correct-horse-battery";

interface ToolResultBody {
  isError?: true;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown> & { code?: string; message?: string };
}

interface ToolCall {
  status: number;
  result: ToolResultBody;
  /** The whole wire body as a string, for scans that no fingerprint or markdown may appear anywhere in the response. */
  raw: string;
}

interface EditPayload extends Record<string, unknown> {
  editId: string;
  fingerprint: string;
  outline: { sections: Array<{ sectionId: string; level: number; heading: string; chars: number; fingerprint?: string }>; truncated: boolean };
  unboundWikilinks: number;
}

async function callTool(app: FastifyInstance, token: string, name: string, args: unknown = {}): Promise<ToolCall> {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), { token });
  return { status: res.statusCode, result: res.json().result, raw: res.body };
}

/** `structuredContent` of a successful call; also guards the mirror equality. */
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

/** The same outline from REST: the **independent** truth for `sectionId`/`fingerprint` (a section fingerprint over MCP is only obtainable after reading that section or after a successful write; tests don't take detours to guess it). */
async function restOutline(app: FastifyInstance, noteId: string, token: string) {
  const res = await getContent(app, noteId, token);
  expect(res.statusCode).toBe(200);
  return res.json() as {
    markdown: string;
    fingerprint: string;
    outline: Array<{ sectionId: string; level: number; heading: string; chars: number; fingerprint: string }>;
  };
}

interface Scene {
  ctx: CollabTestCtx;
  ownerId: string;
  ownerHandle: string;
  email: string;
  session: HttpSession;
  token: string;
  tokenId: string;
  noteId: string;
  disconnect: () => void;
}

/** owner + one read-write PAT (token name fixed to "Claude Code" => agent label "claude") + one note with content. */
async function scene(markdown: string | null, opts: Parameters<typeof buildCollabTestApp>[0] = {}): Promise<Scene> {
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
  const ownerHandle = (await ctx.app.inject({ method: "GET", url: `/api/notes/${note.id}`, headers: bearer(token) })).json()
    .ownerHandle as string;
  return { ctx, ownerId: owner.id, ownerHandle, email, session, token, tokenId, noteId: note.id, disconnect };
}

/** Headings must all be the same level: `## B` is merged into section A by sectionize. */
const THREE_SECTIONS = "# A\n\n第一段內容\n\n# B\n\n第二段內容\n\n# C\n\n第三段內容";

/** 250 sections (headings uniquely numbered): the truncated-true case needs at least 221 sections - the outline has **251** entries (`sectionize()` unconditionally puts `_top` at index 0),
 *  and `slice(120, 220)` takes 100 entries, so `251 > 220` holds. With 150 sections the outline has only 151 entries and `151 > 151` is false: **arithmetically impossible**. */
const BIG_SECTIONS = 250;
const bigMarkdown = () =>
  Array.from({ length: BIG_SECTIONS }, (_, i) => `# ${String(i).padStart(4, "0")}\n\nbody-${String(i).padStart(4, "0")}`).join("\n\n");

describe("#108 edit_note: persistence of the five ops and parity with REST", () => {
  // Per op, two notes with **identical seeds**: one through MCP, one through REST, comparing the **exported markdown** (block ids are random so `docText()` can't compare;
  // markdown is the id-free truth). **Response shapes aren't compared**: MCP's success response differs field by field from `NoteEditResultDto` (guarded by the response-shape test);
  // this test guards "the persisted result is the same".
  it("one call per op: after the MCP and REST writes the exported markdown is identical, and each leaves one note_ai_edits row", async () => {
    const s = await scene(THREE_SECTIONS);
    const app = s.ctx.app;
    const NEW = "# B2\n\n改過的第二段";

    for (const op of ["replace_all", "replace_section", "insert_after", "append", "delete_section"] as const) {
      const mine = await s.ctx.createNote(s.ownerId);
      const theirs = await s.ctx.createNote(s.ownerId);
      const c1 = await seedContent(s.ctx, s.session, mine.id, THREE_SECTIONS);
      const c2 = await seedContent(s.ctx, s.session, theirs.id, THREE_SECTIONS);

      const build = async (noteId: string): Promise<Record<string, unknown>> => {
        const rest = await restOutline(app, noteId, s.token);
        const target = rest.outline[2]!; // the B section
        switch (op) {
          case "replace_all":
            return { op, markdown: NEW, if_match: rest.fingerprint };
          case "replace_section":
            return { op, section_id: target.sectionId, markdown: NEW, if_match: target.fingerprint };
          case "insert_after":
            return { op, section_id: target.sectionId, markdown: NEW, if_match: target.fingerprint };
          case "append":
            return { op, markdown: NEW };
          case "delete_section":
            return { op, section_id: target.sectionId, if_match: target.fingerprint };
        }
      };

      payloadOf<EditPayload>(await editNote(app, s.token, { note_id: mine.id, ...(await build(mine.id)) }));
      const rest = await app.inject({
        method: "POST",
        url: `/api/notes/${theirs.id}/edits`,
        headers: bearer(s.token),
        payload: await build(theirs.id),
      });
      expect(rest.statusCode, `${op} 的 REST 對照發`).toBe(201);

      const a = (await restOutline(app, mine.id, s.token)).markdown;
      const b = (await restOutline(app, theirs.id, s.token)).markdown;
      expect(a, `${op} 的落盤內容`).toBe(b);
      // Both paths leave one record with the same op (an MCP write is indistinguishable from REST in `note_ai_edits`).
      for (const id of [mine.id, theirs.id]) {
        const rows = await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, id));
        expect(rows).toHaveLength(1);
        expect(rows[0]!.op).toBe(op);
      }
      c1.disconnect();
      c2.disconnect();
    }
    s.disconnect();
  });
});

describe("#108 edit_note: shape of the success response", () => {
  it("top-level key set is exactly {editId, fingerprint, outline, unboundWikilinks}; outline has only {sections, truncated}; every entry has a fingerprint", async () => {
    const s = await scene(THREE_SECTIONS);
    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    const out = payloadOf<EditPayload>(
      await editNote(s.ctx.app, s.token, {
        note_id: s.noteId,
        op: "replace_section",
        section_id: rest.outline[2]!.sectionId,
        markdown: "# B2\n\n改過",
        if_match: rest.outline[2]!.fingerprint,
      })
    );
    expect(Object.keys(out).sort()).toEqual(["editId", "fingerprint", "outline", "unboundWikilinks"].sort());
    // **No `nextSectionOffset`** (without a continuation entry point, don't return a cursor that no tool can take).
    expect(Object.keys(out.outline).sort()).toEqual(["sections", "truncated"].sort());
    expect(out.outline.sections.length).toBeGreaterThan(0);
    for (const entry of out.outline.sections) {
      // **Explicit exception**: only `edit_note`'s success response carries per-section fingerprints (parity with REST).
      expect(entry.fingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(Object.keys(entry).sort()).toEqual(["chars", "fingerprint", "heading", "level", "sectionId"].sort());
    }
    expect(out.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(out.unboundWikilinks).toBe(0);
    s.disconnect();
  });

  it("append succeeds without section_id and without if_match (optional + key-by-key spreading)", async () => {
    const s = await scene(THREE_SECTIONS);
    const out = payloadOf<EditPayload>(
      await editNote(s.ctx.app, s.token, { note_id: s.noteId, op: "append", markdown: "追加一行" })
    );
    expect(out.editId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await restOutline(s.ctx.app, s.noteId, s.token)).markdown).toContain("追加一行");
    s.disconnect();
  });

  // **These two calls are the only guard for that trap**: `.strict()` looks at `Object.keys`, so spreading the whole args (without filtering `undefined`) makes
  // `{op:"append", section_id: undefined}` fail as `unrecognized_keys`, and every valid `append`/`delete_section` would degrade to `invalid_body`.
  it("conditional key-by-key spreading: append without section_id and delete_section without markdown both succeed", async () => {
    const s = await scene(THREE_SECTIONS);
    payloadOf<EditPayload>(await editNote(s.ctx.app, s.token, { note_id: s.noteId, op: "append", markdown: "追加一行" }));
    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    payloadOf<EditPayload>(
      await editNote(s.ctx.app, s.token, {
        note_id: s.noteId,
        op: "delete_section",
        section_id: rest.outline[2]!.sectionId,
        if_match: rest.outline[2]!.fingerprint,
      })
    );
    expect((await restOutline(s.ctx.app, s.noteId, s.token)).markdown).not.toContain("第二段內容");
    s.disconnect();
  });
});

describe("#108 edit_note: rejection side of the required matrix", () => {
  // **This call guards "skipping the fingerprint check and writing directly"**, a data-correctness gate, not a shape check. The tool's input schema declares `if_match` as
  // `.optional()` (it really is optional for `append`), so the SDK's `validateToolInput` **lets through** a `replace_section` without `if_match`; the **only** thing
  // stopping it on the MCP path is the shared `editBodySchema` (per-op required matrix) at step 2 of the handler. If that check fails, the whole section is overwritten
  // without a fingerprint comparison and with no error.
  // The assertion order is deliberately "four side effects first, error shape after": `errorOf()` aborts the whole `it` at the `isError` line, so the four checks after it
  // would never run when the regression happens and the failure message wouldn't point at the cause.
  it("replace_section without if_match -> invalid_body, the message names the missing field, and all four side-effect checks are zero", async () => {
    const s = await scene(THREE_SECTIONS);
    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    const doc = () => s.ctx.collab.hocuspocus.documents.get(s.noteId)!;
    const before = docText(doc());
    const docsBefore = s.ctx.collab.hocuspocus.documents.size;
    // This call uses the **read-write token that just did `restOutline`**, so its name tag is already on awareness, and the write's touch uses the **same `(noteId, tokenId)`**,
    // which only updates the state of the same clientId in place. **Comparing key sets alone can't catch "presence was touched"** (even when the regression lets the write
    // really succeed, the key set is unchanged), so this compares **that client's entire state deeply**: `PresenceRegistry.emit` writes a new `beat` every time
    // (`presence.ts` says `beat` is functional, not decoration), which a touch always changes.
    // **The other test doesn't have this problem**: its caller is another read-only token with a different clientId, so the key set itself is a live criterion. The correct
    // shapes of the two tests differ; don't copy one into the other.
    const rwClientId = presenceClientId(s.noteId, s.tokenId);
    const keysBefore = [...doc().awareness.getStates().keys()].sort();
    const stateBefore = structuredClone(doc().awareness.getStates().get(rwClientId));
    expect(stateBefore, "前提：讀寫 token 的名牌此刻已在 awareness 上，否則下面那條深度比對是恆真的").toBeDefined();

    const call = await editNote(s.ctx.app, s.token, {
      note_id: s.noteId,
      op: "replace_section",
      section_id: rest.outline[2]!.sectionId,
      markdown: "# 不該寫進去",
    });

    // Four zero-side-effect checks: no new `note_ai_edits` row, live doc content unchanged, no extra entry in `documents`, no new name tag **and** the existing name tag wasn't touched.
    expect(await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.noteId))).toHaveLength(0);
    expect(docText(doc())).toBe(before);
    expect(s.ctx.collab.hocuspocus.documents.size).toBe(docsBefore);
    expect([...doc().awareness.getStates().keys()].sort()).toEqual(keysBefore);
    expect(doc().awareness.getStates().get(rwClientId)).toEqual(stateBefore);

    const err = errorOf(call);
    expect(err.code).toBe("invalid_body");
    // The message must name the missing field so the model knows what it left out.
    expect(err.message).toContain("if_match");
    expect(err.message).toContain("replace_section");
    s.disconnect();
  });
});

describe("#108 edit_note: page rule", () => {
  // The three page-taking checks are **one `it` sharing a single 250-section `seedContent`**; splitting would seed several times.
  //
  // **`sections[0]` on the page at offset 0 is always `_top`, not the first numbered section**: `sectionize()` unconditionally puts
  // `{sectionId:"_top", level:0, heading:"", chars:0}` at outline index 0 (even for an empty document), so the three offset-0 checks assert `sectionId === "_top"`, not a heading.
  // **Only the `replace_section` check uses `heading`, and rightly**: its offset is not 0 (the index of the section it lands on), `_top` isn't on that page, and the new
  // section's `sectionId` is a uuid generated at write time, which the test can't know beforehand.
  //
  // **The order is deliberate**: `replace_section` -> `delete_section` -> `append` -> `replace_all` (append after delete_section). The requirement "take the whole-note
  // `fingerprint` from the `append` response and send a successful `replace_all`" conflicts with a `delete_section` in between, which would make that fingerprint stale.
  // `replace_all` still goes last (it replaces all 250 sections); the order of delete/append doesn't matter for the three page checks.
  it("250 sections: replace_section pages from the landing point and is truncated; delete_section / append / replace_all page from section 0", async () => {
    const s = await scene(bigMarkdown());
    const app = s.ctx.app;
    const before = await restOutline(app, s.noteId, s.token);
    expect(before.outline).toHaveLength(BIG_SECTIONS + 1); // `_top` + 250 sections

    const marker = `WRITTEN-MARKER-${randomUUID()}`;
    const target = before.outline[120]!;
    expect(target.heading).toBe("0119");
    const written = payloadOf<EditPayload>(
      await editNote(app, s.token, {
        note_id: s.noteId,
        op: "replace_section",
        section_id: target.sectionId,
        markdown: `# ${marker}\n\n改過的內容`,
        if_match: target.fingerprint,
      })
    );
    // Starting with a heading => `afterBlockIds[0]` is that new heading and it forms its own section => offset = 120.
    expect(written.outline.sections[0]!.heading).toBe(marker);
    expect(written.outline.sections).toHaveLength(MCP_PAGE_MAX);
    expect(written.outline.truncated).toBe(true);
    // The landing page **doesn't contain** `_top`: positive evidence that it isn't page 0.
    expect(written.outline.sections.map(x => x.sectionId)).not.toContain("_top");

    // insert_after is section-scoped as well -> the landing page (the `.describe()` tells the model verbatim "replace_section **and insert_after**", so this can't test only replace_section).
    // Without `insert_after` in `SECTION_SCOPED` only these two lines go red (`expected '' to be 'INSERTED-MARKER-...'`); without them that half of the declaration has no guard.
    const insertMarker = `INSERTED-MARKER-${randomUUID()}`;
    const insertTarget = (await restOutline(app, s.noteId, s.token)).outline[150]!;
    const inserted = payloadOf<EditPayload>(
      await editNote(app, s.token, {
        note_id: s.noteId,
        op: "insert_after",
        section_id: insertTarget.sectionId,
        markdown: `# ${insertMarker}\n\n插入的內容`,
        if_match: insertTarget.fingerprint,
      })
    );
    expect(inserted.outline.sections[0]!.heading).toBe(insertMarker);
    expect(inserted.outline.sections.map(x => x.sectionId)).not.toContain("_top");

    const mid = (await restOutline(app, s.noteId, s.token)).outline[200]!;
    const deleted = payloadOf<EditPayload>(
      await editNote(app, s.token, { note_id: s.noteId, op: "delete_section", section_id: mid.sectionId, if_match: mid.fingerprint })
    );
    // `delete_section`'s `afterBlockIds` is always empty -> `afterSectionIndex` is null -> page 0. "The deleted section no longer exists", so "the page containing the landing point" is undefined for it (deliberate).
    expect(deleted.outline.sections[0]!.sectionId).toBe("_top");
    expect(deleted.outline.truncated).toBe(true);

    // append -> offset 0 and that page **doesn't contain** the section just appended. "Starts with a unique heading" is **necessary** here: an append that doesn't start with a heading is merged into the
    // last section and the heading wouldn't exist, making "the page doesn't contain the marker" vacuously true.
    const appendMarker = `APPENDED-MARKER-${randomUUID()}`;
    const appended = payloadOf<EditPayload>(
      await editNote(app, s.token, { note_id: s.noteId, op: "append", markdown: `# ${appendMarker}\n\n追加的內容` })
    );
    expect(appended.outline.sections[0]!.sectionId).toBe("_top");
    expect(appended.outline.sections.map(x => x.heading)).not.toContain(appendMarker);
    // The whole-note `fingerprint` is a **scalar** unaffected by paging: it is still returned on a note with more than 100 sections (the counterpart of the read test).
    expect(appended.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(appended.fingerprint).not.toBe(before.fingerprint);
    // That section really was written (the marker is only absent from **this page**, not unwritten).
    expect((await restOutline(app, s.noteId, s.token)).markdown).toContain(appendMarker);

    const all = payloadOf<EditPayload>(
      await editNote(app, s.token, {
        note_id: s.noteId,
        op: "replace_all",
        markdown: "# X\n\nxxx\n\n# Y\n\nyyy",
        if_match: appended.fingerprint,
      })
    );
    expect(all.outline.sections[0]!.sectionId).toBe("_top");
    expect(all.outline.sections.map(x => x.heading)).toEqual(["", "X", "Y"]);
    expect(all.outline.truncated).toBe(false);
    s.disconnect();
  });
});

describe("#108 edit_note: error side", () => {
  it("stale if_match -> fingerprint_mismatch, structuredContent is exactly {code, message, outline}, the whole response has no fingerprint or markdown", async () => {
    const s = await scene(THREE_SECTIONS);
    const before = await restOutline(s.ctx.app, s.noteId, s.token);
    // First change the last section with a successful append so its fingerprint goes stale.
    payloadOf<EditPayload>(await editNote(s.ctx.app, s.token, { note_id: s.noteId, op: "append", markdown: "先改一次" }));
    // `replace_section` compares fingerprints **per section**, so target the changed one: `append` merges the new block into the last section (section C), so use the last outline entry.
    const last = before.outline[before.outline.length - 1]!;
    const call = await editNote(s.ctx.app, s.token, {
      note_id: s.noteId,
      op: "replace_section",
      section_id: last.sectionId,
      markdown: "# 不該寫進去",
      if_match: last.fingerprint,
    });
    const err = errorOf(call);
    expect(err.code).toBe("fingerprint_mismatch");
    expect(Object.keys(err).sort()).toEqual(["code", "message", "outline"].sort());
    const outline = err.outline as { sections: Array<Record<string, unknown>>; truncated: boolean };
    expect(Object.keys(outline).sort()).toEqual(["sections", "truncated"].sort());
    // **This line is the only guard for the error-side page rule**: the page is the index of the requested `section_id` in the **current** outline (here 3, the last section);
    // if it degraded to always 0, `sections[0]` would become `_top`. Without it that rule is **unobservable** on a three-section note (4 outline entries, fits one page).
    expect(outline.sections[0]!.sectionId).toBe(last.sectionId);
    // **The error side never carries a fingerprint**: your view is stale, and handing out a fresh token would invite blind retries.
    for (const entry of outline.sections) {
      expect(Object.keys(entry).sort()).toEqual(["chars", "heading", "level", "sectionId"].sort());
    }
    // Non-heuristic second check: the **field name** `"fingerprint"` must never appear, and likewise `markdown` (the response contains no markdown, so it goes through `loadNoteDoc` +
    // `outlineOf`, not `readNoteContent`, which would mount the editor and export the whole note).
    expect(call.raw).not.toContain('"fingerprint"');
    expect(call.raw).not.toContain('"markdown"');
    // The real values are scanned too (hiding one in a heading also counts as a hit).
    const after = await restOutline(s.ctx.app, s.noteId, s.token);
    for (const fp of [after.fingerprint, ...after.outline.map(o => o.fingerprint)]) {
      expect(fp).toMatch(/^[0-9a-f]{16}$/);
      expect(call.raw).not.toContain(fp);
    }
    // The rejected call adds no `note_ai_edits` row; the one row is from the earlier append.
    const rows = await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.noteId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.op).toBe("append");
    expect(after.markdown).not.toContain("不該寫進去");
    s.disconnect();
  });
  it("<script> / <style> / <iframe> / <object> mixed into the text -> unsupported_block rejects the whole write; content unchanged, zero records", async () => {
    const s = await scene(THREE_SECTIONS);
    const before = await restOutline(s.ctx.app, s.noteId, s.token);
    const last = before.outline[before.outline.length - 1]!;
    const cases: Array<Record<string, unknown>> = [
      { op: "append", markdown: "新段落\n\n<script>alert(1)</script>" },
      { op: "replace_section", section_id: last.sectionId, if_match: last.fingerprint, markdown: "# C\n\n<style>p{color:red}</style>改過" },
      { op: "replace_all", if_match: before.fingerprint, markdown: '# 全換\n\n文字 <iframe src="https://example.com"></iframe> 文字' },
      { op: "append", markdown: '- 清單 <object data="x"></object>' },
    ];
    for (const c of cases) {
      const err = errorOf(await editNote(s.ctx.app, s.token, { note_id: s.noteId, ...c }));
      expect(err.code, JSON.stringify(c)).toBe("unsupported_block");
    }
    expect((await restOutline(s.ctx.app, s.noteId, s.token)).markdown).toBe(before.markdown);
    expect(await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.noteId))).toHaveLength(0);
    s.disconnect();
  });
});

describe("#108 edit_note: records, undo and presence", () => {
  it("after an MCP write, REST's edit records show that row (agentLabel non-null, revertable) and it can be undone", async () => {
    const s = await scene(THREE_SECTIONS);
    const out = payloadOf<EditPayload>(
      await editNote(s.ctx.app, s.token, { note_id: s.noteId, op: "append", markdown: "AI 追加的一行" })
    );
    const list = await s.ctx.app.inject({ method: "GET", url: `/api/notes/${s.noteId}/edits`, headers: bearer(s.token) });
    expect(list.statusCode).toBe(200);
    const edits = list.json().edits as Array<{ id: string; op: string; agentLabel: string | null; revertable: boolean }>;
    expect(edits).toHaveLength(1);
    expect(edits[0]!.id).toBe(out.editId);
    expect(edits[0]!.op).toBe("append");
    // #106: an MCP write is indistinguishable from a REST write in the records; the name tag is likewise derived from the PAT name.
    expect(edits[0]!.agentLabel).toBe("claude");
    expect(edits[0]!.revertable).toBe(true);

    const revert = await s.ctx.app.inject({
      method: "POST",
      url: `/api/notes/${s.noteId}/edits/${out.editId}/revert`,
      headers: bearer(s.token),
    });
    expect(revert.statusCode).toBe(201);
    expect((await restOutline(s.ctx.app, s.noteId, s.token)).markdown).not.toContain("AI 追加的一行");
    s.disconnect();
  });

  it("MCP replace_section -> presence lands on the first block after the write, not on the old heading's id", async () => {
    const s = await scene(THREE_SECTIONS);
    const client = await s.session.connect(s.noteId);
    const clientId = presenceClientId(s.noteId, s.tokenId);
    const remote = () =>
      client.provider.awareness!.getStates().get(clientId) as { user?: { name: string }; cursor?: { anchor: unknown } } | undefined;
    const cursorText = (): string | null => {
      const r = remote();
      if (!r?.cursor) return null;
      const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(r.cursor.anchor as never), client.doc);
      return abs ? (abs.type as Y.XmlText).toString() : null;
    };

    // Read the whole note first to pull the cursor to the document start (heading "A"), so the call below has discriminating power.
    await getContent(s.ctx.app, s.noteId, s.token);
    await tick();
    await waitFor("游標先在文件開頭", 2_000, () => (cursorText() ?? "").includes("A"));

    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    payloadOf<EditPayload>(
      await editNote(s.ctx.app, s.token, {
        note_id: s.noteId,
        op: "replace_section",
        section_id: rest.outline[2]!.sectionId,
        markdown: "# B2\n\nAI 改過的第二段",
        if_match: rest.outline[2]!.fingerprint,
      })
    );
    await tick();
    await waitFor("名字到達", 2_000, () => remote()?.user?.name === `${s.ownerHandle} (claude)`);
    // `replace_section` replaced the heading too, so the old section_id no longer exists. If the target still used it (assembling `{kind:"section", sectionId: args.section_id}` by hand
    // **compiles**), cursorFor wouldn't find it and would fall back to the document start (= "A"), and this goes red.
    await waitFor("游標落在新寫下的 B2 heading", 2_000, () => (cursorText() ?? "").includes("B2"));
    expect(cursorText()).not.toContain("A");
    client.disconnect();
  });
});

describe("#108 edit_note: declaration and scope filtering", () => {
  // **This test is the only guard for that symptom**: passing the whole `editBodySchema` (a zod v3 discriminatedUnion) as `inputSchema` to `registerTool` **doesn't throw and runtime
  // validation still works**, but the advertised JSON Schema silently becomes `{"type":"object","properties":{}}` (the model sees no fields).
  // On today's wiring the same regression also turns eight other tests red, but that is coincidence, not a guard: the raw shape has `note_id` and every union branch is `.strict()`, so
  // every call is judged `unrecognized_keys`; once the union gains a `note_id` key those eight go green and only this test stays red.
  it("tools/list's edit_note.inputSchema.properties contains all six field names (#180 added title)", async () => {
    const s = await scene(null);
    const res = await mcpPost(s.ctx.app, rpc("tools/list"), { token: s.token });
    expect(res.statusCode).toBe(200);
    const tools = res.json().result.tools as Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>;
    const entry = tools.find(t => t.name === "edit_note");
    expect(entry, "讀寫憑證的 tools/list 必須含 edit_note").toBeDefined();
    expect(Object.keys(entry!.inputSchema!.properties ?? {}).sort()).toEqual(
      ["if_match", "markdown", "note_id", "op", "section_id", "title"].sort()
    );
  });

  // **Not `insufficient_scope`** (see the file header): registration already filters by scope, so a read-only token gets the SDK's `isError` + "Tool edit_note not found" and **no** `structuredContent`.
  // The real value of this test is the four zero-side-effect checks in its second half.
  it("read-only token: tools/list doesn't contain edit_note, calling it directly gets the SDK's not-found form, with zero side effects", async () => {
    const s = await scene(THREE_SECTIONS);
    const { token: ro, tokenId: roTokenId } = await seedTokenForUser(s.ctx.db, s.ownerId, "notes:read", "Reader");
    const list = await mcpPost(s.ctx.app, rpc("tools/list"), { token: ro });
    const names = (list.json().result.tools as { name: string }[]).map(t => t.name);
    expect(names).not.toContain("edit_note");

    const before = docText(s.ctx.collab.hocuspocus.documents.get(s.noteId)!);
    const docsBefore = s.ctx.collab.hocuspocus.documents.size;
    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    const call = await editNote(s.ctx.app, ro, {
      note_id: s.noteId,
      op: "replace_section",
      section_id: rest.outline[2]!.sectionId,
      markdown: "# 不該寫進去",
      if_match: rest.outline[2]!.fingerprint,
    });
    expect(call.status).toBe(200);
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0]!.text).toContain("Tool edit_note not found");
    expect(call.result.structuredContent).toBeUndefined();

    expect(await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.noteId))).toHaveLength(0);
    expect(docText(s.ctx.collab.hocuspocus.documents.get(s.noteId)!)).toBe(before);
    expect(s.ctx.collab.hocuspocus.documents.size).toBe(docsBefore);
    // **`awareness.getStates().size === 0` can't be asserted here**, and not because the seed left a browser connection (`seedContent` leaves awareness empty: that provider sets no awareness
    // state). The real reason is that the token-authenticated `GET /content` above (`restOutline`) touched read presence, so awareness currently holds exactly the name tag of the **read-write token**.
    // So the right form is to pin **the set of client identities**: the read-only token's name tag must not appear.
    const doc = s.ctx.collab.hocuspocus.documents.get(s.noteId)!;
    expect([...doc.awareness.getStates().keys()].sort()).toEqual([presenceClientId(s.noteId, s.tokenId)]);
    expect([...doc.awareness.getStates().keys()]).not.toContain(presenceClientId(s.noteId, roTokenId));
    s.disconnect();
  });

  // `instructions` is **either-or per request** (not additive): the two share one BASE and the tail is chosen by token - the read-write one has only 23 characters of headroom,
  // and one more sentence would break 1000. The read-write variant mentions `create_note` on purpose.
  // **This test asserts string contents only; don't add a "tools/list contains create_note" assertion here.**
  it("instructions is either-or: the read-only version has the disposition wording and doesn't mention write tools, the read-write version talks about write tools, both at most 1000", async () => {
    const s = await scene(null);
    const { token: ro } = await seedTokenForUser(s.ctx.db, s.ownerId, "notes:read", "Reader");

    const rw = (await mcpPost(s.ctx.app, INITIALIZE, { token: s.token })).json().result.instructions as string;
    const readOnly = (await mcpPost(s.ctx.app, INITIALIZE, { token: ro })).json().result.instructions as string;

    expect(rw).toContain("edit_note");
    expect(rw).toContain("create_note");
    expect(rw).toContain("notes:write");
    expect(rw.length).toBeLessThanOrEqual(1000);

    // Disposition wording: the `insufficient_scope` path never reaches the model over HTTP, so `instructions` is the only place it can land. Describing tools a read-only token doesn't have
    // is the same kind of mistake as advertising a capability we can't deliver, so this version **deliberately doesn't name** the two write tools.
    expect(readOnly).toContain("Settings");
    expect(readOnly).toContain("notes:write");
    expect(readOnly).not.toContain("edit_note");
    expect(readOnly).not.toContain("create_note");
    expect(readOnly.length).toBeLessThanOrEqual(1000);
    // The two versions really differ (if both sides returned the same constant everything above would still be green, except this line).
    expect(readOnly).not.toBe(rw);
  });
});

describe("#241: append with ifMatch (misspelled if_match)", () => {
  it("first assert content unchanged and zero new note_ai_edits rows, then the SDK input-validation error (no structuredContent, message contains ifMatch)", async () => {
    const s = await scene(THREE_SECTIONS);
    const before = await restOutline(s.ctx.app, s.noteId, s.token);
    const call = await editNote(s.ctx.app, s.token, {
      note_id: s.noteId, op: "append", markdown: "不該寫進去的一行", ifMatch: "0000000000000000",
    });
    // Side effects first: with the raw shape `ifMatch` is silently dropped and the append is written anyway; these two lines are that harm.
    expect((await restOutline(s.ctx.app, s.noteId, s.token)).markdown).toBe(before.markdown);
    expect(await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.noteId))).toHaveLength(0);
    expect(call.status).toBe(200);
    expect(call.result.isError).toBe(true);
    expect(call.result.structuredContent).toBeUndefined();
    expect(call.result.content[0]!.text).toContain("ifMatch");
    s.disconnect();
  });
});

describe("#240 uppercase note_id (MCP write)", () => {
  it("WS online, MARK only in the live doc: an append with an uppercase note_id writes into the lowercase live doc", async () => {
    const s = await scene(null);
    const MARK = `MARK-${randomUUID()}`;
    const Y_TEXT = `Y-${randomUUID()}`;
    const client = await seedContent(s.ctx, s.session, s.noteId, `# Head\n\n${MARK}`);
    const out = await editNote(s.ctx.app, s.token, { note_id: s.noteId.toUpperCase(), op: "append", markdown: Y_TEXT });
    // Ordered first: with the lowercasing removed, the write lands in a separately opened uppercase doc and the lowercase live doc never receives it.
    expect(docText(s.ctx.collab.hocuspocus.documents.get(s.noteId)!)).toContain(Y_TEXT);
    payloadOf<EditPayload>(out);
    expect(docText(s.ctx.collab.hocuspocus.documents.get(s.noteId)!)).toContain(MARK);
    await waitFor("WS client 收到 AI 的寫入", 5_000, () => docText(client.doc).includes(Y_TEXT));
    expect(s.ctx.collab.hocuspocus.documents.has(s.noteId.toUpperCase())).toBe(false);
    client.disconnect();
    await waitFor("落盤並卸載", 10_000, () => s.ctx.collab.hocuspocus.documents.size === 0);
    const xml = xmlOf((await loadDoc(s.ctx.db, s.noteId))!);
    expect(xml).toContain(MARK);
    expect(xml).toContain(Y_TEXT);
  });
});

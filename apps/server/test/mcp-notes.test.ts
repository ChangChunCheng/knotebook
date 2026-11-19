/**
 * This family defaults to `buildCollabTestApp` (the production shape); **only the sentinel-scan test uses `buildTestApp`**, because only it accepts `options.logger`
 * (`buildCollabTestApp` hard-codes `{ logger: false }`), and by the registration rules these two tools still register on an app without collab.
 */
import { Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { canonicalNotePath } from "@knotebook/shared";
import { notes, users } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import type { Db } from "../src/db/index.js";
import { buildCollabTestApp, buildTestApp, type CollabTestCtx } from "./helpers.js";
import { seedContent, seedTokenForUser } from "./editing-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { waitIndexed } from "./search-helpers.js";
import type { FastifyInstance } from "fastify";

const PASSWORD = "correct-horse-battery";
const NUL = String.fromCharCode(0);

/** The index signature is deliberate: key-set assertions must see extra fields. */
type Summary = Record<string, unknown> & {
  id: string;
  title: string;
  role: string;
  owner: { kind: string; handle?: string; id?: string; name?: string };
  url: string;
};

/** `result` of `tools/call`; `structuredContent` is absent when the SDK produces the error itself. */
interface ToolResultBody {
  isError?: true;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown> & { code?: string };
}

interface ToolPayload extends Record<string, unknown> {
  notes: Summary[];
  nextCursor?: string | null;
  truncated?: boolean;
  matchesTruncated?: true;
}

interface ToolCall {
  status: number;
  result: ToolResultBody;
  /** The whole wire body as a string (for the sentinel scan). */
  raw: string;
}

async function callTool(app: FastifyInstance, token: string, name: string, args: unknown = {}): Promise<ToolCall> {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), { token });
  return { status: res.statusCode, result: res.json().result, raw: res.body };
}

/** `structuredContent` of a successful call; also guards the mirror equality. */
function payloadOf(call: ToolCall): ToolPayload {
  expect(call.status).toBe(200);
  expect(call.result.isError).toBeUndefined();
  expect(call.result.content[0]!.text).toBe(JSON.stringify(call.result.structuredContent));
  return call.result.structuredContent as unknown as ToolPayload;
}

/** Ranking assertions need a deterministic `updated_at`, so it is written per note instead of relying on `defaultNow()`'s adjacent timestamps. */
async function setUpdatedAt(db: Db, noteId: string, iso: string): Promise<void> {
  await db.update(notes).set({ updatedAt: new Date(iso) }).where(eq(notes.id, noteId));
}

/**
 * `updated_at` with microsecond precision. **Don't use drizzle's `.set({ updatedAt: new Date(...) })`**: a JS `Date` has only milliseconds, so the written value
 * has already lost its microseconds and the test would measure nothing. Microseconds are **the production norm**: every production write point goes through pg's `now()`,
 * so **all notes' `updated_at` are microsecond values**.
 */
async function setUpdatedAtMicros(db: Db, noteId: string, literal: string): Promise<void> {
  await db.execute(sql`update notes set updated_at = ${literal}::timestamptz where id = ${noteId}::uuid`);
}

async function handleOf(db: Db, userId: string): Promise<string> {
  const [row] = await db.select({ handle: users.handle }).from(users).where(eq(users.id, userId));
  return row!.handle;
}

async function slugOf(db: Db, noteId: string): Promise<string> {
  const [row] = await db.select({ slug: notes.slug }).from(notes).where(eq(notes.id, noteId));
  return row!.slug;
}

async function scenario(ctx: CollabTestCtx): Promise<{
  ownerId: string;
  otherId: string;
  token: string;
  otherToken: string;
}> {
  const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
  const other = await ctx.createUser({ email: `x-${randomUUID()}@example.com`, password: PASSWORD });
  const { token } = await seedTokenForUser(ctx.db, owner.id);
  const { token: otherToken } = await seedTokenForUser(ctx.db, other.id);
  return { ownerId: owner.id, otherId: other.id, token, otherToken };
}

describe("#108 list_notes", () => {
  it("returns own + shared notes in a deterministic order, each row with url/role/owner", async () => {
    const ctx = await buildCollabTestApp();
    const { ownerId, otherId, token } = await scenario(ctx);
    const mine = await ctx.createNote(ownerId, "Mine");
    const theirs = await ctx.createNote(otherId, "Theirs");
    const invisible = await ctx.createNote(otherId, "Invisible");
    await ctx.share(theirs.id, ownerId, "viewer");
    await setUpdatedAt(ctx.db, mine.id, "2026-01-02T00:00:00.000Z");
    await setUpdatedAt(ctx.db, theirs.id, "2026-01-01T00:00:00.000Z");

    const out = payloadOf(await callTool(ctx.app, token, "list_notes"));
    expect(out.notes.map(n => n.id)).toEqual([mine.id, theirs.id]);
    expect(out.notes.map(n => n.id)).not.toContain(invisible.id);
    expect(out.nextCursor).toBeNull();

    const ownerHandle = await handleOf(ctx.db, ownerId);
    const otherHandle = await handleOf(ctx.db, otherId);
    expect(out.notes[0].role).toBe("owner");
    expect(out.notes[0].owner).toEqual({ kind: "user", handle: ownerHandle });
    expect(out.notes[0].url).toBe(canonicalNotePath({ ownerHandle, groupId: null, slug: await slugOf(ctx.db, mine.id) }));
    expect(out.notes[1].role).toBe("viewer");
    expect(out.notes[1].owner).toEqual({ kind: "user", handle: otherHandle });
    expect(out.notes[1].url).toBe(
      canonicalNotePath({ ownerHandle: otherHandle, groupId: null, slug: await slugOf(ctx.db, theirs.id) })
    );
  });

  it("ties on the same updatedAt are broken by id desc (secondary sort key)", async () => {
    const ctx = await buildCollabTestApp();
    const { ownerId, token } = await scenario(ctx);
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const note = await ctx.createNote(ownerId, `Same ${i}`);
      await setUpdatedAt(ctx.db, note.id, "2026-02-02T00:00:00.000Z");
      ids.push(note.id);
    }
    const out = payloadOf(await callTool(ctx.app, token, "list_notes"));
    expect(out.notes.map(n => n.id)).toEqual([...ids].sort().reverse());
  });

  it("limit/cursor paging joins up: three pages make the full set with no duplicates or omissions, the last page's nextCursor is null", async () => {
    const ctx = await buildCollabTestApp();
    const { ownerId, token } = await scenario(ctx);
    const all: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const note = await ctx.createNote(ownerId, `P${i}`);
      await setUpdatedAt(ctx.db, note.id, `2026-03-0${i + 1}T00:00:00.000Z`);
      all.push(note.id);
    }
    const expected = [...all].reverse();

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page += 1) {
      const out: ToolPayload = payloadOf(
        await callTool(ctx.app, token, "list_notes", cursor === null ? { limit: 2 } : { limit: 2, cursor })
      );
      seen.push(...out.notes.map(n => n.id));
      cursor = out.nextCursor ?? null;
      if (page < 2) expect(typeof cursor).toBe("string");
      else expect(cursor).toBeNull();
    }
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(5);
  });

  // Guards a **silent omission**: `notes.updated_at` is a `timestamptz` (microseconds) while the cursor goes through JS `Date` -> `toISOString()` (milliseconds). If the sort key
  // stays at microseconds while the cursor only has milliseconds, `(updated_at, id) < (cursor.ts, cursor.id)` cuts off in bulk the rows that are in the same millisecond with a smaller
  // microsecond value - **no error, no duplicates, just missing**. The fix is to `date_trunc('milliseconds', ...)` both the sort key and the keyset to the cursor's precision.
  // The exposure is higher than it looks: all notes' `updated_at` come from pg's `now()` = microseconds.
  it("the cursor doesn't drop rows because of updated_at's microsecond precision (sort key and cursor share one precision)", async () => {
    const ctx = await buildCollabTestApp();
    const { ownerId, token } = await scenario(ctx);
    const a = await ctx.createNote(ownerId, "Micro A");
    const b = await ctx.createNote(ownerId, "Micro B");
    // Two different microsecond values inside the same millisecond (.123): the cursor encoding writes both as `...00.123Z`.
    await setUpdatedAtMicros(ctx.db, a.id, "2026-04-01T00:00:00.123456Z");
    await setUpdatedAtMicros(ctx.db, b.id, "2026-04-01T00:00:00.123200Z");

    const p1 = payloadOf(await callTool(ctx.app, token, "list_notes", { limit: 1 }));
    expect(p1.notes).toHaveLength(1);
    expect(typeof p1.nextCursor).toBe("string");
    const p2 = payloadOf(await callTool(ctx.app, token, "list_notes", { limit: 1, cursor: p1.nextCursor! }));
    // The union of the two pages must equal the full set: when rows are lost the second page is empty, with no error signal.
    expect([...p1.notes, ...p2.notes].map(n => n.id)).toEqual([a.id, b.id].sort().reverse());
    expect(p2.nextCursor).toBeNull();
  });

  it("four bad cursors (garbage / decodes to a non-uuid / not a date / NUL after the timestamp) -> tool error invalid_body", async () => {
    const ctx = await buildCollabTestApp();
    const { ownerId, token } = await scenario(ctx);
    await ctx.createNote(ownerId, "One");
    await ctx.createNote(ownerId, "Two"); // two notes are needed to get a nextCursor, so the control below holds
    const encode = (s: string): string => Buffer.from(s, "utf8").toString("base64url");
    const bad = [
      "not-a-cursor!!",
      encode("2026-01-01T00:00:00.000Z|not-a-uuid"),
      encode(`not-a-date|${randomUUID()}`),
      // **The NUL must follow the timestamp, not sit in the id field**: this call is the only guard for `decodeCursor`'s `noNul`, and where it lands decides whether it discriminates:
      //   - in the id field (`...000Z|<NUL>`) -> `UUID_RE` rejects it, so removing `noNul` stays green;
      //   - after the timestamp -> `new Date("2099-01-01T00:00:00.000Z" + NUL)` is **still valid** (`toISOString()` returns `2099-01-01T00:00:00.000Z`) and `UUID_RE` doesn't
      //     cover the id field, so `noNul` is the only one of the three checks that stops it. Without `if (!noNul(decoded))` it returns a whole page of notes (the date is in the future,
      //     so the keyset predicate lets everything through).
      // Since the folders feature, the timestamp part goes through `parseCursorTimestamp` (format + round trip), which also rejects this call, so `noNul` is no longer the only guard
      // for this landing point (the comment on `decodeCursor` in `list-notes.ts` says the same).
      encode(`2099-01-01T00:00:00.000Z${NUL}|${randomUUID()}`),
    ];
    for (const cursor of bad) {
      const call = await callTool(ctx.app, token, "list_notes", { cursor });
      expect(call.status).toBe(200);
      expect(call.result.isError).toBe(true);
      expect(call.result.structuredContent!.code).toBe("invalid_body");
    }
    // Control: a valid cursor still succeeds - the four calls above aren't "every cursor is rejected".
    const first = payloadOf(await callTool(ctx.app, token, "list_notes", { limit: 1 }));
    expect(payloadOf(await callTool(ctx.app, token, "list_notes", { cursor: first.nextCursor! }))).toBeTruthy();
  });

  // A timestamp part that JS `new Date` accepts but pg's `::timestamptz` can't parse must be invalid_body, not internal.
  it("timestamp parts not in the site's issued shape (+275760-..., -000001-..., 0000-..., a loose 2026) -> invalid_body, not internal", async () => {
    const ctx = await buildCollabTestApp();
    const { ownerId, token } = await scenario(ctx);
    await ctx.createNote(ownerId, "One");
    const encode = (s: string): string => Buffer.from(s, "utf8").toString("base64url");
    for (const ts of ["+275760-09-13T00:00:00.000Z", "-000001-01-01T00:00:00.000Z", "0000-01-01T00:00:00.000Z", "2026"]) {
      const call = await callTool(ctx.app, token, "list_notes", { cursor: encode(`${ts}|${randomUUID()}`) });
      expect(call.status).toBe(200);
      expect(call.result.isError, ts).toBe(true);
      expect(call.result.structuredContent, ts).toEqual({ code: "invalid_body", message: "The `cursor` value is not one this server issued. Omit it to start over." });
    }
  });

  // `Buffer.from(..., "base64url")` silently skips characters outside the alphabet, so a real cursor followed by `!!` would still page; list_trash and list_folders reject it.
  it("a real cursor followed by !! -> invalid_body, field-for-field identical to the error list_trash returns for the same string; the real cursor itself still pages", async () => {
    const ctx = await buildCollabTestApp();
    const { ownerId, token } = await scenario(ctx);
    await ctx.createNote(ownerId, "One");
    await ctx.createNote(ownerId, "Two");
    const first = payloadOf(await callTool(ctx.app, token, "list_notes", { limit: 1 }));
    expect(typeof first.nextCursor).toBe("string"); // precondition: a cursor was really obtained
    expect(payloadOf(await callTool(ctx.app, token, "list_notes", { limit: 1, cursor: first.nextCursor! })).notes).toHaveLength(1);
    const cursor = `${first.nextCursor!}!!`;
    const notesCall = await callTool(ctx.app, token, "list_notes", { limit: 1, cursor });
    const trashCall = await callTool(ctx.app, token, "list_trash", { cursor });
    expect(notesCall.status).toBe(200);
    expect(notesCall.result).toEqual(trashCall.result);
    expect(notesCall.result.isError).toBe(true);
    expect(notesCall.result.structuredContent).toEqual({ code: "invalid_body", message: "The `cursor` value is not one this server issued. Omit it to start over." });
  });

  it("title is cut to 200 after escaping and carries titleTruncated", async () => {
    const ctx = await buildCollabTestApp();
    const { ownerId, token } = await scenario(ctx);
    const title = "T".repeat(260_000);
    await ctx.createNote(ownerId, title);
    const out = payloadOf(await callTool(ctx.app, token, "list_notes"));
    expect(out.notes[0].title.length).toBe(200);
    expect(out.notes[0].title).toBe("T".repeat(200));
    expect(out.notes[0].titleTruncated).toBe(true);
  });

  it("key sets of the top level and of every row match exactly (kills \"copy NoteDto\")", async () => {
    const ctx = await buildCollabTestApp();
    const { ownerId, token } = await scenario(ctx);
    await ctx.createNote(ownerId, "K");
    const out = payloadOf(await callTool(ctx.app, token, "list_notes"));
    expect(Object.keys(out).sort()).toEqual(["nextCursor", "notes"]);
    expect(Object.keys(out.notes[0]).sort()).toEqual(
      ["folder", "id", "lastEdited", "owner", "role", "slug", "title", "updatedAt", "url"].sort()
    );
    // When not truncated the `titleTruncated` key is **absent** (not `undefined`).
    expect("titleTruncated" in out.notes[0]!).toBe(false);
    expect(out.notes[0]!.lastEdited).toBeNull();
    expect(out.notes[0]!.updatedAt).toBe(new Date(String(out.notes[0]!.updatedAt)).toISOString());
  });
});

describe("#108 search_notes", () => {
  it("query inputs %, _ and NUL: the first two are literal characters, NUL is blocked outside the handler", async () => {
    const seenTools: string[] = [];
    const ctx = await buildCollabTestApp({ mcpTestHooks: { beforeTool: name => void seenTools.push(name) } });
    const { ownerId, token } = await scenario(ctx);
    await ctx.createNote(ownerId, "Q3 50% growth");
    await ctx.createNote(ownerId, "50 percent growth");
    await ctx.createNote(ownerId, "a_b config");
    await ctx.createNote(ownerId, "axb config");

    // `%` is a literal character: it only matches the row whose title really contains `50%`; using `LIKE` without escaping would match another row too.
    const pct = payloadOf(await callTool(ctx.app, token, "search_notes", { query: "50%" }));
    expect(pct.notes.map(n => n.title)).toEqual(["Q3 50% growth"]);
    // A lone `%` likewise: `LIKE '%'` would match all four rows, while non-pattern matching only matches the one with a literal `%`.
    const onlyPct = payloadOf(await callTool(ctx.app, token, "search_notes", { query: "%" }));
    expect(onlyPct.notes.map(n => n.title)).toEqual(["Q3 50% growth"]);
    // `_` is literal: `LIKE 'a_b%'` would also match `axb`.
    const underscore = payloadOf(await callTool(ctx.app, token, "search_notes", { query: "a_b" }));
    expect(underscore.notes.map(n => n.title)).toEqual(["a_b config"]);

    // The positive controls (the three calls above) already prove `search_notes` really goes through `runTool()`; the count being **unchanged** after the NUL call proves it was blocked **outside** the handler (zod input schema).
    const before = seenTools.filter(n => n === "search_notes").length;
    expect(before).toBe(3);
    const nul = await callTool(ctx.app, token, "search_notes", { query: `a${NUL}b` });
    expect(nul.status).toBe(200);
    expect(nul.result.isError).toBe(true);
    // `.refine(noNul)` is **invisible** in the JSON Schema (zod's refine has no matching keyword), but the SDK's `validateToolInput` does run it - so it's zod, not the JSON Schema, that blocks NUL.
    expect(nul.result.content[0]!.text).toContain("Input validation error");
    expect(seenTools.filter(n => n === "search_notes").length).toBe(3);
  });

  it("response has no nextCursor/cursor, only truncated", async () => {
    const ctx = await buildCollabTestApp();
    const { ownerId, token } = await scenario(ctx);
    for (let i = 0; i < 3; i += 1) await ctx.createNote(ownerId, `dup ${i}`);
    const full = payloadOf(await callTool(ctx.app, token, "search_notes", { query: "dup" }));
    expect(Object.keys(full).sort()).toEqual(["notes", "truncated"]);
    expect(full.notes.map(n => [n.matchedOn, n.matches])).toEqual([["title", []], ["title", []], ["title", []]]);
    expect(full.truncated).toBe(false);
    expect(full.notes).toHaveLength(3);

    const capped = payloadOf(await callTool(ctx.app, token, "search_notes", { query: "dup", limit: 2 }));
    expect(capped.notes).toHaveLength(2);
    expect(capped.truncated).toBe(true);
    expect(Object.keys(capped)).not.toContain("nextCursor");
    expect(JSON.stringify(capped)).not.toMatch(/"(next)?[cC]ursor"/);
  });

  it("ranking: exact -> prefix -> substring, within a group updatedAt desc, id desc", async () => {
    const ctx = await buildCollabTestApp();
    const { ownerId, token } = await scenario(ctx);
    const exact = await ctx.createNote(ownerId, "report");
    const prefix = await ctx.createNote(ownerId, "report of Q3");
    const substrOld = await ctx.createNote(ownerId, "the report draft");
    const substrNew = await ctx.createNote(ownerId, "annual report 2026");
    await setUpdatedAt(ctx.db, exact.id, "2026-01-01T00:00:00.000Z");
    await setUpdatedAt(ctx.db, prefix.id, "2026-01-01T00:00:00.000Z");
    await setUpdatedAt(ctx.db, substrOld.id, "2026-01-01T00:00:00.000Z");
    await setUpdatedAt(ctx.db, substrNew.id, "2026-06-01T00:00:00.000Z");

    const out = payloadOf(await callTool(ctx.app, token, "search_notes", { query: "report" }));
    expect(out.notes.map(n => n.id)).toEqual([exact.id, prefix.id, substrNew.id, substrOld.id]);
  });

  it("case-insensitive; body matches rank after title matches (#93)", async () => {
    const ctx = await buildCollabTestApp();
    const { ownerId, token } = await scenario(ctx);
    const owner = await ctx.db.select({ email: users.email }).from(users).where(eq(users.id, ownerId));
    const titled = await ctx.createNote(ownerId, "Quarterly PLAN");
    const bodyOnly = await ctx.createNote(ownerId, "unrelated");
    const session = await ctx.loginAs(owner[0]!.email, PASSWORD);
    const client = await seedContent(ctx, session, bodyOnly.id, "# unrelated\n\nquarterly plan lives in the body\n");
    client.disconnect();
    await waitIndexed(ctx.db, bodyOnly.id, b => b.includes("quarterly plan lives in the body"));

    const out = payloadOf(await callTool(ctx.app, token, "search_notes", { query: "quarterly plan" }));
    expect(out.notes.map(n => n.id)).toEqual([titled.id, bodyOnly.id]);
    expect(out.notes.map(n => n.matchedOn)).toEqual(["title", "body"]);
    expect((out.notes[1]!.matches as Array<{ snippet: string }>)[0]!.snippet.toLowerCase()).toContain("quarterly plan");
  });

  it("search scope = notes the caller can see (other people's private notes don't appear)", async () => {
    const ctx = await buildCollabTestApp();
    const { ownerId, otherId, token, otherToken } = await scenario(ctx);
    const secret = await ctx.createNote(otherId, "secret roadmap");
    const shared = await ctx.createNote(otherId, "shared roadmap");
    await ctx.share(shared.id, ownerId, "editor");

    const mine = payloadOf(await callTool(ctx.app, token, "search_notes", { query: "roadmap" }));
    expect(mine.notes.map(n => n.id)).toEqual([shared.id]);
    expect(mine.notes[0].role).toBe("editor");

    const list = payloadOf(await callTool(ctx.app, token, "list_notes"));
    expect(list.notes.map(n => n.id)).not.toContain(secret.id);

    // Control: the secret's owner can see it, so the above isn't "that note can't be found".
    const theirs = payloadOf(await callTool(ctx.app, otherToken, "search_notes", { query: "roadmap" }));
    expect(theirs.notes.map(n => n.id).sort()).toEqual([secret.id, shared.id].sort());
  });
});

describe("#108 shared wiring of the two tools", () => {
  // These sentences are the **only** disposition for a shape the model would hit without any error:
  // - `list_notes`: keyset paging isn't a snapshot, so a note created or renamed during paging is silently missed. The old wording said "editing while listing drops rows", but
  //   `edit_note` never touches `notes.updated_at` (cause and verification are in the header of `tools/list-notes.ts`), so the assertion is the **whole new sentence verbatim** on the wire; it also pins
  //   "Editing a note's content does not move it." on the next line, so both the real cause and the deliberately negated false cause are guarded. "renaming it" covers both PATCH kinds (title and URL alias).
  //   The **third cause sentence** is pinned whole as well (a note that becomes visible during paging because it was shared, moved into one of your groups, or a group was joined, appears at its own position):
  //   the header of `list-notes.ts` claims this test guards it.
  // - `search_notes` (#93): the sentence about searching titles only was removed; the ranking sentence is pinned instead, and the old sentence is pinned absent (re-adding the negated false statement must go red).
  // Without this test, deleting them turns nothing red. It asserts the `tools/list` **sent on the wire**, not the source constant, so a corrected constant that isn't wired into `registerTool` is also caught.
  it("tools/list's three sentences appear verbatim on the wire (paging warning and the third cause, the ranking sentence of #93)", async () => {
    const ctx = await buildCollabTestApp();
    const { token } = await scenario(ctx);
    const res = await mcpPost(ctx.app, rpc("tools/list"), { token });
    expect(res.statusCode).toBe(200);
    const tools = res.json().result.tools as { name: string; description: string }[];
    const byName = (name: string): string => tools.find(t => t.name === name)!.description;
    expect(byName("list_notes")).toContain(
      "creating a note, or renaming it, moves it to the top of this order, above the cursor you are holding, " +
        "so no later page shows it."
    );
    expect(byName("list_notes")).toContain("Editing a note's content does not move it.");
    expect(byName("list_notes")).toContain(
      "While you page, a note shared with you, a note moved into one of your groups, or the notes of a group you join appear at their own unchanged positions, which may already be above your cursor."
    );
    expect(byName("search_notes")).toContain(
      "Notes whose title matches come first — exact titles, then titles that start with your text, then the rest — then notes that match only in the body."
    );
    expect(byName("search_notes")).not.toContain("Searches note titles only");
  });

  it("#175: list_notes' visibility wording covers groups and no longer only says \"other people shared with you\"", async () => {
    const ctx = await buildCollabTestApp();
    const { token } = await scenario(ctx);
    const res = await mcpPost(ctx.app, rpc("tools/list"), { token });
    const tools = res.json().result.tools as { name: string; description: string }[];
    const listNotes = tools.find(t => t.name === "list_notes")!.description;
    expect(listNotes).toContain("the ones you own, the notes of your groups, and the ones shared with you");
    expect(listNotes).toContain("Each result carries `owner` (a person or one of your groups) and `role`");
    expect(listNotes).not.toContain("ownerHandle");
    expect(listNotes).not.toContain("the ones other people shared with you");
  });

  it("doesn't charge the contentRead limiter", async () => {
    const ctx = await buildCollabTestApp({ limiters: { contentRead: new FixedWindowLimiter({ limit: 1, windowMs: 600_000 }) } });
    const { ownerId, token } = await scenario(ctx);
    await ctx.createNote(ownerId, "bucket");
    for (let i = 0; i < 5; i += 1) {
      expect(payloadOf(await callTool(ctx.app, token, "list_notes")).notes).toHaveLength(1);
      expect(payloadOf(await callTool(ctx.app, token, "search_notes", { query: "bucket" })).notes).toHaveLength(1);
    }
  });

  it("#93: search_notes charges its own search limiter (60/min); exhausted -> too_many_requests with the verbatim message; list_notes is unaffected; the limiter is keyed per user", async () => {
    const ctx = await buildCollabTestApp({ limiters: { search: new FixedWindowLimiter({ limit: 1, windowMs: 600_000 }) } });
    const { ownerId, otherId, token, otherToken } = await scenario(ctx);
    await ctx.createNote(ownerId, "bucket");
    await ctx.createNote(otherId, "bucket other");
    expect(payloadOf(await callTool(ctx.app, token, "search_notes", { query: "bucket" })).notes).toHaveLength(1);
    const second = await callTool(ctx.app, token, "search_notes", { query: "bucket" });
    expect(second.status).toBe(200);
    expect(second.result.isError).toBe(true);
    expect(second.result.structuredContent).toEqual({
      code: "too_many_requests",
      message: "Too many searches right now. Wait a moment before searching again.",
    });
    expect(payloadOf(await callTool(ctx.app, token, "list_notes")).notes).toHaveLength(1);
    // The first user's limiter is exhausted; the second user's first search still succeeds (key = userId, not one limiter site-wide).
    const otherFirst = payloadOf(await callTool(ctx.app, otherToken, "search_notes", { query: "bucket" }));
    expect(otherFirst.notes.map(n => n.title)).toEqual(["bucket other"]);
    const otherSecond = await callTool(ctx.app, otherToken, "search_notes", { query: "bucket" });
    expect(otherSecond.result.structuredContent?.code).toBe("too_many_requests");
  });

  it("runTool() coverage: the names beforeTool sees are exactly {list_notes, search_notes}", async () => {
    const seen: string[] = [];
    const ctx = await buildCollabTestApp({ mcpTestHooks: { beforeTool: name => void seen.push(name) } });
    const { ownerId, token } = await scenario(ctx);
    await ctx.createNote(ownerId, "coverage");
    payloadOf(await callTool(ctx.app, token, "list_notes"));
    payloadOf(await callTool(ctx.app, token, "search_notes", { query: "coverage" }));
    // A tool not wrapped in `runTool()` has no try/catch, and an uncaught exception would be sent into the model's context by the SDK as is (the sentinel test guards exactly that),
    // so "every tool goes through runTool" needs a guard of its own.
    expect([...new Set(seen)].sort()).toEqual(["list_notes", "search_notes"]);
  });

  it("both kinds of errors we produce carry an ERROR_CODES code, and content and structuredContent are equivalent", async () => {
    const ctx = await buildCollabTestApp({
      mcpTestHooks: {
        beforeTool: name => {
          if (name === "search_notes") throw new Error("forced");
        },
      },
    });
    const { ownerId, token } = await scenario(ctx);
    await ctx.createNote(ownerId, "e29b");

    const invalid = await callTool(ctx.app, token, "list_notes", { cursor: "!!!" });
    const internal = await callTool(ctx.app, token, "search_notes", { query: "e29b" });
    for (const [call, code] of [
      [invalid, "invalid_body"],
      [internal, "internal"],
    ] as const) {
      expect(call.result.isError).toBe(true);
      expect(call.result.structuredContent!.code).toBe(code);
      expect(call.result.content[0]!.text).toBe(JSON.stringify(call.result.structuredContent));
    }
  });

  it("handler throws an exception containing a sentinel string -> code internal, the body doesn't contain the sentinel, log.error was called", async () => {
    const sentinel = `SENTINEL-${randomUUID()}`;
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const { app, db } = await buildTestApp(
      {
        mcpTestHooks: {
          beforeTool: () => {
            throw new Error(sentinel);
          },
        },
      },
      { logger: { level: "error", stream } }
    );
    const [user] = await db.insert(users).values({ email: `s-${randomUUID()}@example.com`, displayName: "S" }).returning();
    const { token } = await seedTokenForUser(db, user!.id);

    const call = await callTool(app, token, "list_notes");
    expect(call.status).toBe(200);
    expect(call.result.isError).toBe(true);
    expect(call.result.structuredContent!.code).toBe("internal");
    // Kills "no try/catch, letting the exception bubble to the SDK": written that way the original error.message goes into `content[0].text` as is.
    expect(call.raw).not.toContain(sentinel);
    expect(lines.join("")).toContain(sentinel);
    expect(lines.some(l => l.includes(`"tool":"list_notes"`))).toBe(true);
  });

  // The next three are **SDK characterization tests with zero discrimination against our implementation**: they assert fixed strings the SDK builds itself. They exist to pin the boundary between
  // the protocol-level error envelope and an SDK-produced tool error - both are 200 over HTTP, only the body shape differs. `toContain` pins only the phrase and the version is pinned by the lockfile;
  // if one goes red after an SDK upgrade, the SDK changed a string, we didn't break anything.
  // The unknown-JSON-RPC-method case is green even with zero tools registered (`resources/list` returns `-32601` either way): it guards the boundary, not our implementation;
  // the other two need at least one registered tool.
  it("tools/call on an unregistered name -> 200, isError, structuredContent absent", async () => {
    const ctx = await buildCollabTestApp();
    const { token } = await scenario(ctx);
    const call = await callTool(ctx.app, token, "nope");
    expect(call.status).toBe(200);
    expect(call.result.isError).toBe(true);
    expect("structuredContent" in call.result).toBe(false);
    expect(call.result.content[0]!.text).toContain("Tool ");
    expect(call.result.content[0]!.text).toContain(" not found");
  });

  it("input schema mismatch (limit as a string) -> 200, isError, structuredContent absent", async () => {
    const ctx = await buildCollabTestApp();
    const { token } = await scenario(ctx);
    const call = await callTool(ctx.app, token, "list_notes", { limit: "50" });
    expect(call.status).toBe(200);
    expect(call.result.isError).toBe(true);
    expect("structuredContent" in call.result).toBe(false);
    expect(call.result.content[0]!.text).toContain("Input validation error");
  });

  it("unknown JSON-RPC method -> 200 + a real error envelope (error present, no result)", async () => {
    const ctx = await buildCollabTestApp();
    const { token } = await scenario(ctx);
    const res = await mcpPost(ctx.app, rpc("resources/list", undefined, 7), { token });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result).toBeUndefined();
    expect(body.error.code).toBe(-32601);
  });
});

describe("folders: list_notes pages by size (pageCutShort)", () => {
  const seedPlain = (db: Db, ownerId: string, n: number) =>
    db.$client.query(
      `insert into notes (owner_id, title, slug) select $1::uuid, 'ln ' || g, 'ln-' || g || '-' || substr(md5(random()::text), 1, 8) from generate_series(1, $2::int) g`,
      [ownerId, n],
    );

  it("100 ordinary notes, limit 100 -> one page, no pageCutShort key (key set verbatim)", async () => {
    const ctx = await buildCollabTestApp();
    const { ownerId, token } = await scenario(ctx);
    await seedPlain(ctx.db, ownerId, 100);
    const out = payloadOf(await callTool(ctx.app, token, "list_notes", { limit: 100 }));
    expect(Object.keys(out)).toEqual(["notes", "nextCursor"]);
    expect(out.notes).toHaveLength(100);
    expect(out.nextCursor).toBeNull();
  });

  it("ordinary data, limit 30 -> 30 notes, no pageCutShort key, nextCursor non-null", async () => {
    const ctx = await buildCollabTestApp();
    const { ownerId, token } = await scenario(ctx);
    await seedPlain(ctx.db, ownerId, 40);
    const out = payloadOf(await callTool(ctx.app, token, "list_notes", { limit: 30 }));
    expect(Object.keys(out)).toEqual(["notes", "nextCursor"]);
    expect(out.notes).toHaveLength(30);
    expect(out.nextCursor).not.toBeNull();
  });

  it("tools/list: the description carries the short-page sentence; the pageCutShort description is verbatim", async () => {
    const ctx = await buildCollabTestApp();
    const { token } = await scenario(ctx);
    const res = await mcpPost(ctx.app, rpc("tools/list"), { token });
    expect(res.statusCode).toBe(200);
    type Tool = { name: string; description: string; outputSchema: { properties: Record<string, { description?: string }> } };
    const tool = (res.json().result.tools as Tool[]).find(t => t.name === "list_notes")!;
    expect(tool.description).toContain(
      "A page can hold fewer notes than `limit` when the notes are large — `pageCutShort` is then true — so keep paging until `nextCursor` is null.",
    );
    expect(tool.outputSchema.properties.pageCutShort!.description).toBe(
      "Present, and true, when this page was cut short to keep the reply small; more follow, so keep paging with `nextCursor`.",
    );
  });
});

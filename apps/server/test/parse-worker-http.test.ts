/**
 * Main-thread stall is measured as event-loop pauses (the larger of the max actual interval of a 10 ms timer and
 * `monitorEventLoopDelay`'s max), not by `inject` duration: an in-process `inject` merely starts later while the main thread is
 * blocked and can't see the stall.
 */
import { afterAll, describe, expect, it } from "vitest";
import type * as Y from "yjs";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { loadConfig } from "../src/config.js";
import { noteAiEdits, notes } from "../src/db/schema.js";
import { PARSER_BUSY_MESSAGE, PARSER_BUSY_RETRY_AFTER_S, READ_TOO_COMPLEX_MESSAGE, TOO_COMPLEX_MESSAGE } from "../src/http/parse-errors.js";
import { DOC_MERGE_ATTEMPTS } from "../src/notes/editing/apply.js";
import { EditorSession } from "../src/notes/editing/session.js";
import { ParsePool } from "../src/notes/editing/parse-pool.js";
import type { ParseLimits } from "../src/notes/editing/parse-settings.js";
import { createEditingRuntime, type EditingRuntime } from "../src/notes/editing/runtime.js";
import { transferParseMessage } from "../src/routes/transfer.js";
import { SiteLimits } from "../src/site-limits/store.js";
import { buildCollabTestApp, signTestSession, testConfig, testEditingRuntime, type TestClient } from "./helpers.js";
import { bearer, docText, getContent, seedContent, seedTokenForUser, waitFor } from "./editing-helpers.js";
import { seedNote, seedUser } from "./group-helpers.js";
import { bulkGet, bulkPut, callTool, downloadNote, editBody, issueBulkDirect, liveMarkdown, seedMd } from "./bulk-transfer-helpers.js";
import { idleStall, loopStall, stallLimit } from "./perf-helpers.js";

const PASSWORD = "correct-horse-battery";
const ps = (n: number) => Array.from({ length: n }, (_, k) => `<p>q${k}</p>`).join("");
const SLOW = "<figcaption><blockquote>" + ps(2000) + "</blockquote></figcaption>";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));


/**
 * One runtime shared by the whole file (starting a parse worker loads the editor, taking seconds on a 2-vCPU CI; per-case runtimes took
 * the file to 12 minutes and ate the 30-minute job limit). Each case starts with `ParsePool.configure` to switch to its own settings
 * (unspecified ones revert to the defaults below), then waits for all workers to be ready: workers replaced after a previous timeout
 * must restart, and without waiting this case's timing would include the restart. Cases look only at pool counter deltas.
 *
 * Default is two workers: while the timed-out one is replaced and restarting, the request's later conversion work (e.g. `/edits`'
 * comparison before returning 400) is picked up by the other, so timing excludes the restart (a restart takes seconds on CI and would otherwise push the /edits timing past its bound). Cases needing "the only worker is occupied" set 1 themselves.
 */
let shared: EditingRuntime | undefined;
async function runtimeWith(limits: Partial<Pick<ParseLimits, "workers" | "timeoutMs" | "queueWaitMs">> = {}): Promise<EditingRuntime> {
  if (shared === undefined) {
    const c = loadConfig({ DATABASE_URL: "postgres://u:p@localhost:5432/db", APP_SECRET: testConfig.appSecret, PUBLIC_URL: "http://localhost:3000", PARSE_WORKERS: "2", PARSE_TIMEOUT_MS: "60000" });
    shared = createEditingRuntime(c, SiteLimits.defaults({ limitEnv: c.limitEnv, machine: c.machine }).parseLimits());
  }
  const pool = shared.parser as ParsePool;
  pool.configure({ workers: 2, timeoutMs: 60_000, queueWaitMs: 20_000, ...limits });
  await until("parse worker ready", () => pool.stats().ready >= pool.limits.workers);
  return shared;
}
/** Per-request time limit for the timeout cases (ms): too-complex content takes tens of seconds on the same thread, so the limit only needs to be far below that; smaller makes the case faster. */
const TIMEOUT_MS = 1_000;
async function until(what: string, f: () => boolean, ms = 120_000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error(`等不到：${what}`);
    await sleep(10);
  }
}
afterAll(async () => {
  await shared?.close();
});

async function setup(editing: EditingRuntime) {
  const ctx = await buildCollabTestApp({ editing });
  const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
  const note = await ctx.createNote(u.id);
  const session = await ctx.loginAs("a@example.com", PASSWORD);
  const client = await seedContent(ctx, session, note.id, "# A\n\n原文");
  const { token } = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write", "Claude Code (knotebook)");
  const cookie = `${SESSION_COOKIE}=${await signTestSession({ userId: u.id, tv: 0 })}`;
  return { ctx, u, note, client, token, cookie };
}

describe("#398 parsing in the worker: HTTP", () => {
  it("/edits with too-complex content -> time limit reached, 400 unsupported_block (too complex); main-thread stall < 200 ms; note not written, no record", async () => {
    const rt = await runtimeWith({ timeoutMs: TIMEOUT_MS });
    const { ctx, note, token } = await setup(rt);
    const before = (await getContent(ctx.app, note.id, token)).json();
    const pool = rt.parser as ParsePool;
    const timedOut0 = pool.stats().timedOut;
    const baseline = await idleStall(); // this machine's noise right now
    const meter = loopStall();
    const t = performance.now();
    const res = await ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(token), payload: { op: "replace_all", markdown: SLOW, if_match: before.fingerprint } });
    const ms = performance.now() - t;
    const stall = meter.stop();
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: "unsupported_block", message: TOO_COMPLEX_MESSAGE } });
    expect(pool.stats().timedOut - timedOut0, "是時限到才回的").toBe(1);
    expect(ms).toBeLessThan(TIMEOUT_MS + 5_000); // limit + the rest of this request's work; solving on the same thread takes tens of seconds
    console.log(`[#398] /edits 太複雜 ${Math.round(ms)} ms；主執行緒最大停頓 ${stall} ms`);
    expect(stall).toBeLessThan(stallLimit(baseline, 200));
    expect((await getContent(ctx.app, note.id, token)).json().fingerprint).toBe(before.fingerprint);
    expect(await ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, note.id))).toHaveLength(0);
    // Normal writes work as usual (the worker has been replaced)
    expect((await ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(token), payload: { op: "append", markdown: "追加" } })).statusCode).toBe(201);
    await ctx.destroy();
  }, 240_000);

  it("all workers busy and the queue over its limit -> 503 server_busy + Retry-After; the queued request writes nothing. The POST /api/notes that holds the worker is too complex -> 400, no row created", async () => {
    const rt = await runtimeWith({ workers: 1, timeoutMs: TIMEOUT_MS, queueWaitMs: 300 });
    const { ctx, u, note, token } = await setup(rt);
    // Another user holds the only worker (at most one per user, so a different user is needed to queue behind "someone else")
    const v = await ctx.createUser({ email: "b@example.com", password: PASSWORD });
    const { token: tokenB } = await seedTokenForUser(ctx.db, v.id, "notes:read notes:write");
    const notesOfB = async () => (await ctx.db.select({ id: notes.id }).from(notes).where(eq(notes.ownerId, v.id))).length;
    const nB0 = await notesOfB();
    const before = (await getContent(ctx.app, note.id, token)).json();
    const slow = ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(tokenB), payload: { content: SLOW } });
    await until("慢的那筆進了 worker", () => (rt.parser as ParsePool).stats().busy === 1); // poll, no fixed sleep
    const res = await ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(token), payload: { op: "append", markdown: "排隊的" } });
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe(String(PARSER_BUSY_RETRY_AFTER_S));
    expect(res.json()).toEqual({ error: { code: "server_busy", message: PARSER_BUSY_MESSAGE } });
    const slowRes = await slow;
    expect(slowRes.statusCode).toBe(400);
    expect(slowRes.json()).toEqual({ error: { code: "unsupported_block", message: TOO_COMPLEX_MESSAGE } });
    expect(await notesOfB()).toBe(nB0);
    expect((await getContent(ctx.app, note.id, token)).json().fingerprint).toBe(before.fingerprint);
    expect(await ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, note.id))).toHaveLength(0);
    expect(u.id).not.toBe(v.id);
    await ctx.destroy();
  }, 240_000);
});

async function transferScene(rt: EditingRuntime, md = "Para 0\n\nPara 1") {
  const ctx = await buildCollabTestApp({ editing: rt });
  const u = await seedUser(ctx.db);
  const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
  const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
  const note = await seedNote(ctx.db, { ownerId: u.id }, { title: "Title" });
  await seedMd(ctx.db, note.id, md);
  return { ctx, u, pat, bulk, note };
}

describe("#398 parsing in the worker: batch write-back (PUT /api/transfer/notes)", () => {
  it("an added fence-like line + 256 KiB of `*a ` (whole-file unclosed-fence check, about 64 s on the same thread) -> 400 too complex at the time limit, main-thread stall < 200 ms", async () => {
    // This case only looks at the answer and the stall, and halves the limit again (about 4x limit per request): no other normal work in this request could be killed by such a short limit into a different answer
    const rt = await runtimeWith({ timeoutMs: TIMEOUT_MS / 2 });
    const s = await transferScene(rt);
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const text = editBody(d.text, b => b.replace("Para 1", "*a ".repeat(80_000) + "\n\n```\nx"));
    const baseline = await idleStall(); // this machine's noise right now
    const meter = loopStall();
    const t = performance.now();
    const r = await bulkPut(s.ctx.app, s.bulk.token, text);
    const ms = performance.now() - t;
    const stall = meter.stop();
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toEqual({ code: "unsupported_block", message: transferParseMessage("unsupported_block", "too_complex") });
    console.log(`[#398] 批次寫回 fence 最壞形 ${Math.round(ms)} ms；主執行緒最大停頓 ${stall} ms`);
    expect(stall).toBeLessThan(stallLimit(baseline, 200));
    await s.ctx.destroy();
  }, 240_000);

  it("20 sections stuck under one too-complex block (one boundary parse each) -> the whole file 400 too complex (file-version message), total time within 3x limit, not one full wait per section; note unchanged, no record", async () => {
    const T = TIMEOUT_MS / 2; // about 4x limit per request; the first timeout fails the whole file, and a normal job being killed gives the same answer, not an extra timeout
    const rt = await runtimeWith({ timeoutMs: T });
    const paras = Array.from({ length: 20 }, (_, k) => `Para ${k}`);
    const s = await transferScene(rt, paras.join("\n\n"));
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const before = await liveMarkdown(s.ctx, s.note.id);
    const pool = rt.parser as ParsePool;
    const s0 = pool.stats();
    const t = performance.now();
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, () => SLOW + "\n" + paras.join("\n") + "\n"));
    const ms = performance.now() - t;
    const s1 = pool.stats();
    console.log(`[#398] 20 段 ${Math.round(ms)} ms；逾時 ${s1.timedOut - s0.timedOut} 次`);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("unsupported_block");
    expect(r.json().error.message).toBe(transferParseMessage("unsupported_block", "too_complex"));
    expect(ms).toBeLessThan(3 * T + 4_000);
    expect(s1.timedOut - s0.timedOut).toBeLessThanOrEqual(1);
    expect(await liveMarkdown(s.ctx, s.note.id)).toBe(before);
    expect(await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.note.id))).toHaveLength(0);
    await s.ctx.destroy();
  }, 240_000);

  it("`<!--` x 65 000 (260 KB), newlines x 250 000 followed by a character -> main-thread stall < 200 ms", async () => {
    const rt = await runtimeWith();
    const s = await transferScene(rt);
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    for (const [name, body] of [["comments", "<!--".repeat(65_000)], ["newlines", "x" + "\n".repeat(250_000) + "y"]] as const) {
      const baseline = await idleStall(); // this machine's noise right now
      const meter = loopStall();
      const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, () => body));
      const stall = meter.stop();
      console.log(`[#398] ${name} → ${r.statusCode}；主執行緒最大停頓 ${stall} ms`);
      expect(stall, name).toBeLessThan(stallLimit(baseline, 200));
    }
    await s.ctx.destroy();
  }, 240_000);
});

/**
 * How long the main thread is blocked when heavy content that will be accepted (within the 256 KiB limit) is written. Parsing and the
 * apply conversion (the editor's insert-then-delete, post-merge fingerprint and outline) all run in the worker (`doc-jobs.ts`); what
 * stays on the main thread is linear work on Yjs structures: encoding the live doc to state, comparing to the snapshot before merging,
 * applying the diff to the live doc, and encoding and walking on persist (version fingerprint, search index).
 *
 * The main assertion is structural: the pool's conversion-job count increases (= conversion ran in the worker; if conversion returned
 * to the main thread, e.g. `DOC_INLINE_MAX_BYTES` set to infinity, this goes red). The `x<br>` case (tens of
 * thousands of children interleaving text and newlines in one paragraph; the earlier quadratic, walking children with `get(i)`, came
 * from this shape) writes about 122 KB (half the limit) via `/edits` against a loose ceiling max(`HEAVY_STALL_CEILING_MS`, 3x the idle
 * stall) to keep the quadratic out (at `x<br>` x 49 000 the quadratic stalled for tens of seconds; at half the size it would still stall about twice the
 * ceiling). It doesn't write the full 245 KB: this one's worker conversion is linear but already slow locally and slower on CI.
 * MCP, batch write-back and file creation share the same worker pipeline, each using about 40 KB (still far above
 * `DOC_INLINE_MAX_BYTES`), mainly to confirm conversion went to the worker, under the same loose ceiling. Bold/italic interleaving (tens of thousands of format runs in one
 * XmlText) stalls at the same level as `x<br>`, so it runs once at the smaller size in the MCP case; paragraphs and lists are many
 * small blocks with much smaller stalls and were dropped to keep CI time down.
 */
const HEAVY_STALL_CEILING_MS = 5_000;
const DENSEST_BIG = "x<br>".repeat(24_500);
const DENSEST_SMALL = "x<br>".repeat(8_000);
const BOLD_ITALIC_SMALL = "**b** _i_ ".repeat(4_000);

describe("heavy accepted content: main-thread stall when written", () => {
  it("/edits replace_all: the biggest densest shape (`x<br>` x 24 500, about 122 KB) -> conversion goes to the worker; main-thread stall within the loose ceiling", async () => {
    const rt = await runtimeWith();
    const { ctx, note, token } = await setup(rt);
    const before = (await getContent(ctx.app, note.id, token)).json();
    const baseline = await idleStall(); // this machine's noise right now
    const jobs0 = (rt.parser as ParsePool).stats().docJobs;
    const meter = loopStall();
    const res = await ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(token), payload: { op: "replace_all", markdown: DENSEST_BIG, if_match: before.fingerprint } });
    const stall = meter.stop();
    console.log(`[#398] /edits x<br>×24500 → ${res.statusCode}；主執行緒最大停頓 ${stall} ms`);
    expect(res.statusCode).toBe(201);
    expect((rt.parser as ParsePool).stats().docJobs - jobs0, "轉換送進了 worker").toBeGreaterThan(0);
    expect(stall).toBeLessThan(stallLimit(baseline, HEAVY_STALL_CEILING_MS));
    await ctx.destroy();
  }, 300_000);

  it("MCP edit_note replace_all (interleaved bold/italic, about 40 KB) -> conversion goes to the worker", async () => {
    const rt = await runtimeWith();
    const { ctx, note, token } = await setup(rt);
    const before = (await getContent(ctx.app, note.id, token)).json();
    const baseline = await idleStall();
    const jobs0 = (rt.parser as ParsePool).stats().docJobs;
    const meter = loopStall();
    const r = await callTool(ctx.app, token, "edit_note", { note_id: note.id, op: "replace_all", markdown: BOLD_ITALIC_SMALL, if_match: before.fingerprint });
    const stall = meter.stop();
    console.log(`[#398] edit_note 粗斜體×4000 → ${r.isError ? "error" : "ok"}；主執行緒最大停頓 ${stall} ms`);
    expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
    expect((rt.parser as ParsePool).stats().docJobs - jobs0, "轉換送進了 worker").toBeGreaterThan(0);
    expect(stall).toBeLessThan(stallLimit(baseline, HEAVY_STALL_CEILING_MS));
    await ctx.destroy();
  }, 300_000);

  it("batch write-back (change one section) and file creation (densest shape, about 40 KB) -> both conversions go to the worker", async () => {
    const rt = await runtimeWith();
    const s = await transferScene(rt);
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const baseline = await idleStall();
    const jobs0 = (rt.parser as ParsePool).stats().docJobs;
    const meter = loopStall();
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, () => DENSEST_SMALL));
    const stall = meter.stop();
    console.log(`[#398] 寫回 x<br>×8000 → ${r.statusCode}；主執行緒最大停頓 ${stall} ms`);
    expect(r.statusCode, r.body.slice(0, 200)).toBe(200);
    expect((rt.parser as ParsePool).stats().docJobs - jobs0, "寫回的轉換送進了 worker").toBeGreaterThan(0);
    expect(stall).toBeLessThan(stallLimit(baseline, HEAVY_STALL_CEILING_MS));
    const jobsNew0 = (rt.parser as ParsePool).stats().docJobs;
    const meterNew = loopStall();
    const c = await bulkPut(s.ctx.app, s.bulk.token, `---\nknotebook: 1\ntitle: "densest"\n---\n${DENSEST_SMALL}\n`);
    const stallNew = meterNew.stop();
    console.log(`[#398] 新增檔 x<br>×8000 → ${c.statusCode}；主執行緒最大停頓 ${stallNew} ms`);
    expect(c.statusCode, c.body.slice(0, 200)).toBe(201);
    expect((rt.parser as ParsePool).stats().docJobs - jobsNew0, "新增檔的轉換送進了 worker").toBeGreaterThan(0);
    expect(stallNew).toBeLessThan(stallLimit(baseline, HEAVY_STALL_CEILING_MS));
    await s.ctx.destroy();
  }, 300_000);
});

/**
 * Read and apply conversions run in the worker (`doc-jobs.ts`), diffing against "the document state at that moment". If the live doc
 * was changed by someone else before the merge (`live-watch.ts`): change only to another section -> merge anyway (Yjs CRDT merge: both
 * sides' text appear once each); change to a block this write cares about -> start over (the worker recompares if_match -> 409);
 * changed and changed back (same fingerprint) while always being overtaken -> at most `DOC_MERGE_ATTEMPTS` times, then 503.
 * Browser edits are made with a real collab client.
 */
describe("conversion in the worker: browser edits landing in the live doc during apply", () => {
  async function raceScene(editing: EditingRuntime, hooks: { beforeMerge?: () => Promise<void>; afterOpenDirect?: () => Promise<void> }) {
    const ctx = await buildCollabTestApp({ editing, editingTestHooks: hooks });
    const u = await ctx.createUser({ email: "r@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const session = await ctx.loginAs("r@example.com", PASSWORD);
    const client = await seedContent(ctx, session, note.id, "# A\n\n第一段原文\n\n# B\n\n第二段原文");
    const { token } = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write", "Claude Code (knotebook)");
    return { ctx, note, client, token, session };
  }
  type Ctx = Awaited<ReturnType<typeof buildCollabTestApp>>;
  /** Edits the document with a real collab client (= browser typing) and waits until the server's live doc shows `expectText` (or no longer has `goneText`). */
  async function browserEdit(ctx: Ctx, client: { doc: Y.Doc }, noteId: string, f: (ed: EditorSession["editor"]) => void, until: (text: string) => boolean) {
    const s = await EditorSession.open(testEditingRuntime, client.doc);
    try {
      f(s.editor);
    } finally {
      s.close();
    }
    await waitFor("server 收到瀏覽器的修改", 5_000, () => until(docText(ctx.collab.hocuspocus.documents.get(noteId)!)));
  }
  const appendText = (ctx: Ctx, client: { doc: Y.Doc }, noteId: string, text: string) =>
    browserEdit(ctx, client, noteId, ed => ed.insertBlocks([{ type: "paragraph", content: text }], ed.document.at(-1)!.id, "after"), t => t.includes(text));
  const count = (s: string, sub: string) => s.split(sub).length - 1;
  const sectionOf = async (s: { ctx: Ctx; note: { id: string }; token: string }, heading: string) =>
    ((await getContent(s.ctx.app, s.note.id, s.token)).json().outline as Array<{ sectionId: string; heading: string; fingerprint: string }>).find(o => o.heading === heading)!;

  it("browser typed in another section before the merge -> no retry, merged directly (201); what the AI wrote and what the browser typed each appear once", async () => {
    const rt = await runtimeWith();
    let calls = 0;
    let typed: (() => Promise<void>) | null = null;
    const s = await raceScene(rt, {
      beforeMerge: async () => {
        calls++;
        if (calls === 1) await typed!();
      },
    });
    typed = () => appendText(s.ctx, s.client, s.note.id, "瀏覽器在這時打的字");
    const a = await sectionOf(s, "A");
    // The browser types at the document end (section B); the AI replaces section A (if_match = A's fingerprint)
    const res = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits`, headers: bearer(s.token), payload: { op: "replace_section", section_id: a.sectionId, markdown: "# A\n\nAI 換掉第一段", if_match: a.fingerprint } });
    expect(res.statusCode, res.body).toBe(201);
    expect(calls, "別段的修改不算衝突：只跑一次").toBe(1);
    const after = (await getContent(s.ctx.app, s.note.id, s.token)).json();
    expect(count(after.markdown, "瀏覽器在這時打的字")).toBe(1);
    expect(count(after.markdown, "AI 換掉第一段")).toBe(1);
    expect(count(after.markdown, "第一段原文")).toBe(0);
    expect(count(after.markdown, "第二段原文")).toBe(1);
    expect(after.markdown, "合併後的內容與順序").toBe("# A\n\nAI 換掉第一段\n\n# B\n\n第二段原文\n\n瀏覽器在這時打的字\n");
    expect(await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.note.id))).toHaveLength(1);
    await s.ctx.destroy();
  }, 120_000);

  it("like typing: while the AI replaces section B the browser types in section A character by character (one update per character) -> merged; all typed characters present in order, section B has the AI's content", async () => {
    const rt = await runtimeWith();
    let typed: (() => Promise<void>) | null = null;
    const s = await raceScene(rt, { beforeMerge: async () => await typed!() });
    typed = async () => {
      for (const ch of "打字中") {
        await browserEdit(s.ctx, s.client, s.note.id, ed => {
          const p = ed.document.find(x => x.type === "paragraph")!;
          const text = (p.content as Array<{ text: string }>).map(c => c.text).join("");
          ed.updateBlock(p.id, { content: text + ch });
        }, t => t.includes(ch));
      }
    };
    const b = await sectionOf(s, "B");
    const res = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits`, headers: bearer(s.token), payload: { op: "replace_section", section_id: b.sectionId, markdown: "# B\n\nAI 換掉第二段", if_match: b.fingerprint } });
    expect(res.statusCode, res.body).toBe(201);
    const after = (await getContent(s.ctx.app, s.note.id, s.token)).json();
    expect(after.markdown).toBe("# A\n\n第一段原文打字中\n\n# B\n\nAI 換掉第二段\n");
    await s.ctx.destroy();
  }, 120_000);

  it("revert of a section deletion: while the worker works the browser restores the section (same ids, like Ctrl+Z) -> not merged, no duplicates; on retry it's judged unrevertable -> 409 stale", async () => {
    const rt = await runtimeWith();
    const s = await raceScene(rt, {});
    const b = await sectionOf(s, "B");
    const before = (await getContent(s.ctx.app, s.note.id, s.token)).json();
    const del = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits`, headers: bearer(s.token), payload: { op: "delete_section", section_id: b.sectionId, if_match: b.fingerprint } });
    expect(del.statusCode, del.body).toBe(201);
    void before;
    // ids of the two deleted blocks (from the record's before_blocks)
    const [row] = await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.id, del.json().editId));
    const removed = row!.beforeBlocks as Array<{ id: string; type: string; props: unknown; content: unknown; children: unknown }>;
    const orig = rt.runDoc.bind(rt);
    let hit = 0;
    (rt as { runDoc: unknown }).runDoc = async (owner: string, op: { kind: string }, opts?: object) => {
      const r = await orig(owner, op as never, opts);
      if (op.kind === "revert" && hit++ === 0) {
        // The browser re-inserts the two deleted blocks at the document end with the original ids (the result of Ctrl+Z)
        await browserEdit(s.ctx, s.client, s.note.id, ed => ed.insertBlocks(removed as never, ed.document.at(-1)!.id, "after"), t => t.includes("第二段原文"));
      }
      return r;
    };
    const r = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits/${del.json().editId}/revert`, headers: bearer(s.token) });
    (rt as { runDoc: unknown }).runDoc = orig;
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error.code).toBe("stale");
    const after = (await getContent(s.ctx.app, s.note.id, s.token)).json();
    expect(count(after.markdown, "第二段原文"), "救回來的那段只有一份").toBe(1);
    expect(count(after.markdown, "# B")).toBe(1);
    await s.ctx.destroy();
  }, 120_000);

  it("append without if_match: the browser added a paragraph at the end before the merge -> merged anyway; each paragraph once", async () => {
    const rt = await runtimeWith();
    let calls = 0;
    let typed: (() => Promise<void>) | null = null;
    const s = await raceScene(rt, {
      beforeMerge: async () => {
        calls++;
        await typed!();
      },
    });
    typed = () => appendText(s.ctx, s.client, s.note.id, `瀏覽器第${calls}次`);
    const res = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits`, headers: bearer(s.token), payload: { op: "append", markdown: "AI 追加" } });
    expect(res.statusCode, res.body).toBe(201);
    expect(calls).toBe(1);
    const after = (await getContent(s.ctx.app, s.note.id, s.token)).json();
    expect(count(after.markdown, "AI 追加")).toBe(1);
    expect(count(after.markdown, "瀏覽器第1次")).toBe(1);
    await s.ctx.destroy();
  }, 120_000);

  it("the browser changed the section if_match points at -> on retry the fingerprint mismatches -> 409, nothing written (same semantics as before)", async () => {
    const rt = await runtimeWith();
    let calls = 0;
    let edit: (() => Promise<void>) | null = null;
    const s = await raceScene(rt, {
      beforeMerge: async () => {
        calls++;
        if (calls === 1) await edit!();
      },
    });
    const b = await sectionOf(s, "B");
    edit = () => browserEdit(s.ctx, s.client, s.note.id, ed => ed.updateBlock(ed.document.at(-1)!.id, { content: "第二段被瀏覽器改了" }), t => t.includes("第二段被瀏覽器改了"));
    const res = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits`, headers: bearer(s.token), payload: { op: "replace_section", section_id: b.sectionId, markdown: "# B\n\nAI 換掉第二段", if_match: b.fingerprint } });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("fingerprint_mismatch");
    expect(calls).toBe(1);
    const after = (await getContent(s.ctx.app, s.note.id, s.token)).json();
    expect(after.markdown).toContain("第二段被瀏覽器改了");
    expect(after.markdown).not.toContain("AI 換掉第二段");
    expect(await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.note.id))).toHaveLength(0);
    await s.ctx.destroy();
  }, 120_000);

  it("target section changed and changed back before every merge (fingerprint unchanged but touched) -> DOC_MERGE_ATTEMPTS (3) attempts exhausted -> 503 server_busy + Retry-After; no record", async () => {
    expect(DOC_MERGE_ATTEMPTS).toBe(3);
    const rt = await runtimeWith();
    let calls = 0;
    let wiggle: (() => Promise<void>) | null = null;
    const s = await raceScene(rt, {
      beforeMerge: async () => {
        calls++;
        await wiggle!();
      },
    });
    const a = await sectionOf(s, "A");
    wiggle = async () => {
      const firstPara = (ed: EditorSession["editor"]) => ed.document.find(x => x.type === "paragraph")!.id;
      await browserEdit(s.ctx, s.client, s.note.id, ed => ed.updateBlock(firstPara(ed), { content: "第一段原文!" }), t => t.includes("第一段原文!"));
      await browserEdit(s.ctx, s.client, s.note.id, ed => ed.updateBlock(firstPara(ed), { content: "第一段原文" }), t => !t.includes("第一段原文!"));
    };
    const res = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits`, headers: bearer(s.token), payload: { op: "replace_section", section_id: a.sectionId, markdown: "# A\n\nAI 想換", if_match: a.fingerprint } });
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json().error.code).toBe("server_busy");
    expect(res.headers["retry-after"]).toBe(String(PARSER_BUSY_RETRY_AFTER_S));
    expect(calls).toBe(3);
    const after = (await getContent(s.ctx.app, s.note.id, s.token)).json();
    expect(after.markdown).not.toContain("AI 想換");
    expect(after.markdown).toContain("第一段原文");
    expect(await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.note.id))).toHaveLength(0);
    await s.ctx.destroy();
  }, 120_000);

  it("the check inside transact: after the direct connection opens and before transact the browser changes the target section -> not merged; on retry the fingerprint mismatches -> 409", async () => {
    const rt = await runtimeWith();
    let opened = 0;
    let edit: (() => Promise<void>) | null = null;
    const s = await raceScene(rt, {
      afterOpenDirect: async () => {
        opened++;
        if (opened === 1) await edit!();
      },
    });
    const a = await sectionOf(s, "A");
    edit = () => browserEdit(s.ctx, s.client, s.note.id, ed => ed.updateBlock(ed.document.find(x => x.type === "paragraph")!.id, { content: "開直連後瀏覽器改的" }), t => t.includes("開直連後瀏覽器改的"));
    const res = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits`, headers: bearer(s.token), payload: { op: "replace_section", section_id: a.sectionId, markdown: "# A\n\nAI 換掉第一段", if_match: a.fingerprint } });
    expect(res.statusCode, res.body).toBe(409);
    const after = (await getContent(s.ctx.app, s.note.id, s.token)).json();
    expect(after.markdown).toContain("開直連後瀏覽器改的");
    expect(after.markdown).not.toContain("AI 換掉第一段");
    await s.ctx.destroy();
  }, 120_000);

  it("note not in memory when state is taken (cold): after the direct connection opens a browser connects and changes the target section -> transact's comparison to the snapshot differs -> not merged; on retry the fingerprint mismatches -> 409", async () => {
    const rt = await runtimeWith();
    const hooks: { afterOpenDirect?: () => Promise<void> } = {};
    const ctx = await buildCollabTestApp({ editing: rt, editingTestHooks: hooks });
    const u = await ctx.createUser({ email: "c@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    await seedMd(ctx.db, note.id, "# A\n\n冷的第一段\n\n# B\n\n冷的第二段");
    const { token } = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write", "Claude Code (knotebook)");
    const session = await ctx.loginAs("c@example.com", PASSWORD);
    const a = ((await getContent(ctx.app, note.id, token)).json().outline as Array<{ sectionId: string; heading: string; fingerprint: string }>).find(o => o.heading === "A")!;
    expect(ctx.collab.hocuspocus.documents.has(note.id), "讀出不會把筆記載進記憶體").toBe(false);
    let opened = 0;
    let client: TestClient | null = null;
    hooks.afterOpenDirect = async () => {
      opened++;
      if (opened > 1) return;
      client = await session.connect(note.id);
      await browserEdit(ctx, client, note.id, ed => ed.updateBlock(ed.document.find(x => x.type === "paragraph")!.id, { content: "冷的時候瀏覽器改的" }), t => t.includes("冷的時候瀏覽器改的"));
    };
    const res = await ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(token), payload: { op: "replace_section", section_id: a.sectionId, markdown: "# A\n\nAI 換掉冷的第一段", if_match: a.fingerprint } });
    expect(res.statusCode, res.body).toBe(409);
    expect(opened).toBe(1);
    const after = (await getContent(ctx.app, note.id, token)).json();
    expect(after.markdown).toContain("冷的時候瀏覽器改的");
    expect(after.markdown).not.toContain("AI 換掉冷的第一段");
    (client as TestClient | null)?.disconnect();
    await ctx.destroy();
  }, 120_000);

  it("revert: after the worker finishes and before the merge the browser types elsewhere -> no retry, merged directly; the reverted paragraph is gone, the browser's text remains", async () => {
    const rt = await runtimeWith();
    const s = await raceScene(rt, {});
    const w = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits`, headers: bearer(s.token), payload: { op: "append", markdown: "要被撤回的段落" } });
    expect(w.statusCode, w.body).toBe(201);
    // Revert has no beforeMerge injection point: wrap runDoc and type after the revert's worker job returns and before the merge.
    const orig = rt.runDoc.bind(rt);
    let hit = 0;
    (rt as { runDoc: unknown }).runDoc = async (owner: string, op: { kind: string }, opts?: object) => {
      const r = await orig(owner, op as never, opts);
      if (op.kind === "revert" && hit++ === 0) await browserEdit(s.ctx, s.client, s.note.id, ed => ed.updateBlock(ed.document.find(x => x.type === "paragraph")!.id, { content: "撤回期間瀏覽器打的字" }), t => t.includes("撤回期間瀏覽器打的字"));
      return r;
    };
    const r = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits/${w.json().editId}/revert`, headers: bearer(s.token) });
    (rt as { runDoc: unknown }).runDoc = orig;
    expect(r.statusCode, r.body).toBe(201);
    expect(hit, "改的是別的 block：撤回的轉換只跑一次").toBe(1);
    const after = (await getContent(s.ctx.app, s.note.id, s.token)).json();
    expect(after.markdown).not.toContain("要被撤回的段落");
    expect(count(after.markdown, "撤回期間瀏覽器打的字")).toBe(1);
    await s.ctx.destroy();
  }, 120_000);
});

describe("read conversion timeout", () => {
  it("reading a large note exceeds the time limit -> /content 500 too_complex, read_note_section too_complex, download 500; main thread doesn't stall; works again after relaxing the limit", async () => {
    const rt = await runtimeWith();
    const s = await transferScene(rt);
    const big = await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "Big" });
    // A read takes much longer than the 150 ms limit below (3 x 50 ms). Not made bigger: seedMd builds the note synchronously in the
    // test's thread, and each synchronous chunk must stay within a few seconds or it hogs the vitest worker (onTaskUpdate 60 s timeout);
    // the read itself also pays three times at that scale.
    await seedMd(s.ctx.db, big.id, "x<br>".repeat(8_000));
    s.note = big;
    const pool = rt.parser as ParsePool;
    const timedOut0 = pool.stats().timedOut;
    pool.configure({ timeoutMs: 50 }); // read limit = 3 x 50 ms
    const baseline = await idleStall(); // this machine's noise right now
    const meter = loopStall();
    const c = await s.ctx.app.inject({ method: "GET", url: `/api/notes/${s.note.id}/content`, headers: bearer(s.pat.token) });
    expect(c.statusCode, c.body).toBe(500);
    expect(c.json().error).toEqual({ code: "too_complex", message: READ_TOO_COMPLEX_MESSAGE });
    const t = await callTool(s.ctx.app, s.pat.token, "read_note_section", { note_id: s.note.id, section_id: "_top" });
    expect(t.isError).toBe(true);
    expect(t.structuredContent.code).toBe("too_complex");
    const d = await bulkGet(s.ctx.app, `/api/transfer/notes/${s.note.id}`, s.bulk.token);
    expect(d.statusCode, d.body).toBe(500);
    expect(meter.stop(), "逾時那幾次主執行緒也沒被卡住").toBeLessThan(stallLimit(baseline, 500));
    expect(pool.stats().timedOut - timedOut0).toBeGreaterThanOrEqual(3);
    pool.configure({ timeoutMs: 60_000 });
    const ok = await s.ctx.app.inject({ method: "GET", url: `/api/notes/${s.note.id}/content`, headers: bearer(s.pat.token) });
    expect(ok.statusCode).toBe(200);
    await s.ctx.destroy();
  }, 300_000);
});

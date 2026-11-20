/**
 * #398: real parse worker, run from source (`spawnParseWorker` boots through tsx).
 * The production build (`dist/*.js`, no tsx) is covered in `parse-pool-dist.test.ts`.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadConfig } from "../../src/config.js";
import { parseMarkdownForNote } from "../../src/notes/editing/markdown.js";
import { TOO_COMPLEX, type ParseRequest } from "../../src/notes/editing/parse-core.js";
import { PARSE_WORKER_YOUNG_MB, ParsePool, spawnParseWorker } from "../../src/notes/editing/parse-pool.js";
import { createEditingRuntime, EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { idleStall, loopStall, stallLimit } from "../perf-helpers.js";

const BASE = "http://localhost/";
const ORIGIN = "http://localhost";
const rt = new EditingRuntime({ baseUrl: BASE });
rt.installGlobals();
const stripIds = (x: unknown) => JSON.stringify(x, (k, v) => (k === "id" ? undefined : v));
const req = (markdown: string, owner = "u"): ParseRequest => ({ owner, markdown, candidates: [], siteOrigin: ORIGIN });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function ready(pool: ParsePool, n = pool.limits.workers, ms = 120_000): Promise<void> {
  const until = Date.now() + ms;
  while (pool.stats().ready < n) {
    if (Date.now() > until) throw new Error("worker 沒有在時限內 ready");
    await sleep(20);
  }
}
const pools: ParsePool[] = [];
const mk = (o: Partial<{ workers: number; timeoutMs: number; workerMemoryMb: number }> = {}) => {
  const p = new ParsePool({ baseUrl: BASE, workers: 1, workerMemoryMb: 1024, timeoutMs: 30_000, queueWaitMs: 120_000, ...o });
  pools.push(p);
  return p;
};
afterAll(async () => {
  for (const p of pools) await p.close();
});

/** Shapes known to blow up: a quote inside a premerge-skipped subtree (~25 s on the same thread), depth x content (eats 4 GB on the same thread), thousands of nesting levels. */
const ps = (n: number) => Array.from({ length: n }, (_, k) => `<p>q${k}</p>`).join("");
const SLOW_FIGCAPTION = "<figcaption><blockquote>" + ps(2000) + "</blockquote></figcaption>";
const OOM_QUOTE_BOLD = "> ".repeat(120) + "**x** ".repeat(15000);
const DEEP_QUOTE = "> ".repeat(8000) + "a";

describe("parse worker (real thread)", () => {
  let pool: ParsePool;
  beforeAll(async () => {
    pool = mk({ workers: 1 });
    await ready(pool);
  }, 180_000);

  it("result matches parsing on a mounted editor (all goldens, ids stripped)", async () => {
    const goldens = JSON.parse(readFileSync(new URL("../../../../packages/shared/test-fixtures/note-markdown-goldens.json", import.meta.url), "utf8")) as { cases: Array<{ id: string; markdown: string }> };
    expect(goldens.cases.length).toBeGreaterThan(10);
    for (const c of goldens.cases) {
      const s = await EditorSession.open(rt, new Y.Doc());
      let expected: unknown;
      try {
        expected = parseMarkdownForNote(s.editor, c.markdown, [], ORIGIN);
      } finally {
        s.close();
      }
      expect(stripIds(await pool.parse(req(c.markdown))), c.id).toBe(stripIds(expected));
    }
  }, 120_000);

  it("error codes and causes still come back from the worker (unsupported_color, nested_paragraph, too_deep)", async () => {
    expect(await pool.parse(req('x <span style="color:tomato">o</span>'))).toEqual({ error: "unsupported_color" });
    expect(await pool.parse(req("<p>a<button><p>b</p></button></p>"))).toEqual({ error: "unsupported_block", detail: "nested_paragraph" });
    expect(await pool.parse(req("<blockquote><p>a</p>".repeat(128) + "</blockquote>".repeat(128)))).toEqual({ error: "unsupported_block", detail: "too_deep" });
  }, 60_000);
});

describe("time limit, memory cap, main thread not blocked", () => {
  it("worker young generation is fixed at PARSE_WORKER_YOUNG_MB, independent of host memory", async () => {
    const w = spawnParseWorker({ baseUrl: BASE, workerMemoryMb: 256, stackSizeMb: 4 }) as unknown as import("node:worker_threads").Worker;
    try {
      expect(w.resourceLimits?.maxYoungGenerationSizeMb).toBe(PARSE_WORKER_YOUNG_MB);
      expect(w.resourceLimits?.maxOldGenerationSizeMb).toBe(256);
    } finally {
      await w.terminate();
    }
  });
  it("timeout: 2,000 quote paragraphs inside a figcaption (~25 s on the same thread) -> too_complex at the 1.5 s limit and the worker is replaced; the replacement parses normally", async () => {
    const pool = mk({ workers: 1, timeoutMs: 1_500 });
    await ready(pool);
    const t = performance.now();
    expect(await pool.parse(req(SLOW_FIGCAPTION))).toEqual(TOO_COMPLEX);
    const ms = performance.now() - t;
    expect(ms).toBeGreaterThanOrEqual(1_400);
    expect(ms).toBeLessThan(5_000);
    expect(pool.stats().timedOut).toBe(1);
    await ready(pool);
    expect(await pool.parse(req("# ok"))).toMatchObject({ unbound: 0 });
  }, 180_000);

  it("main thread keeps running during a parse: longest stall < max(200 ms, 3 x idle stall) (the same thread stalls for seconds)", async () => {
    const pool = mk({ workers: 1, timeoutMs: 3_000 });
    await ready(pool);
    const baseline = await idleStall();
    const meter = loopStall();
    let stall = 0;
    try {
      expect(await pool.parse(req(SLOW_FIGCAPTION))).toEqual(TOO_COMPLEX);
    } finally {
      stall = meter.stop();
    }
    console.log(`[perf] parse-pool 主執行緒停頓 ${stall} ms（閒置基準 ${baseline} ms）`);
    expect(stall).toBeLessThan(stallLimit(baseline, 200));
  }, 180_000);

  it("out of memory: 15,000 bold runs inside 120 nested quotes (90 KB; takes the process to 4 GB on the same thread) -> too_complex at the 256 MiB worker cap; main process survives and the replacement parses normally", async () => {
    const pool = mk({ workers: 1, workerMemoryMb: 256, timeoutMs: 60_000 });
    await ready(pool);
    expect(await pool.parse(req(OOM_QUOTE_BOLD))).toEqual(TOO_COMPLEX);
    expect(pool.stats()).toMatchObject({ crashed: 1, timedOut: 0 });
    await ready(pool);
    expect(await pool.parse(req("# ok"))).toMatchObject({ unbound: 0 });
  }, 180_000);

  it("the unclosed-fence check for batch write-back also runs in the worker: a normal file returns the fence line; `*a ` repeated for 256 KiB plus one ``` line (~64 s on the same thread) -> \"too_complex\" at the limit", async () => {
    const pool = mk({ workers: 1, timeoutMs: 2_000 });
    await ready(pool);
    expect(await pool.openFenceLine("u", ["A", "", "```", "", "B"])).toBe(2);
    expect(await pool.openFenceLine("u", ["A", "", "```js", "x", "```"])).toBeNull();
    const heavy = ["*a ".repeat(87_000), "", "```", "x"];
    const t = performance.now();
    expect(await pool.openFenceLine("u", heavy)).toBe("too_complex");
    expect(performance.now() - t).toBeLessThan(6_000);
  }, 180_000);

  it("8,000 levels of `>` (16 KB) -> 400 within the limit (too_complex, or too_deep computed on the DOM), not an exception", async () => {
    const pool = mk({ workers: 1, timeoutMs: 2_000 });
    await ready(pool);
    const r = await pool.parse(req(DEEP_QUOTE));
    expect([TOO_COMPLEX, { error: "unsupported_block", detail: "too_deep" }]).toContainEqual(r);
  }, 180_000);
});

describe("createEditingRuntime", () => {
  it("production and integration runtimes use the worker pool (settings from the given ParseLimits); close shuts it down", async () => {
    const config = loadConfig({ DATABASE_URL: "postgres://u:p@localhost:5432/db", APP_SECRET: "a".repeat(64), PUBLIC_URL: "http://localhost:3000" });
    const runtime = createEditingRuntime(config, { workers: 1, workerMemoryMb: 768, timeoutMs: 7_000, queueWaitMs: 33_000 });
    try {
      expect(runtime.parser).toBeInstanceOf(ParsePool);
      expect((runtime.parser as ParsePool).limits).toEqual({ workers: 1, workerMemoryMb: 768, timeoutMs: 7_000, queueWaitMs: 33_000 });
      expect(await runtime.parser.parse(req("hello"))).toMatchObject({ unbound: 0 });
    } finally {
      await runtime.close();
    }
    await expect(runtime.parser.parse(req("x"))).rejects.toThrow("closed");
  }, 180_000);
  it("a directly constructed runtime (unit tests) parses on the same thread", () => {
    expect(new EditingRuntime({ baseUrl: BASE }).parser).not.toBeInstanceOf(ParsePool);
  });
});

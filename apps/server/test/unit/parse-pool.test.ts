/** #398: `ParsePool` scheduling with fake workers (no threads; vitest fake timers). Real-worker behaviour is in `parse-pool-worker.test.ts`. */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ParserBusyError, TOO_COMPLEX, type ParseRequest } from "../../src/notes/editing/parse-core.js";
import { PARSE_QUEUE_MAX, PER_OWNER_MAX, ParsePool, RECYCLE_AFTER_PARSES, RECYCLE_HEAP_SHARE, type PoolWorker, type WorkerInbound, type WorkerOutbound } from "../../src/notes/editing/parse-pool.js";

class FakeWorker extends EventEmitter implements PoolWorker {
  inbox: WorkerInbound[] = [];
  terminated = false;
  refd = false;
  constructor(readonly memoryMb: number) {
    super();
  }
  postMessage(m: WorkerInbound): void {
    this.inbox.push(m);
  }
  async terminate(): Promise<number> {
    this.terminated = true;
    return 1;
  }
  ref(): void {
    this.refd = true;
  }
  unref(): void {
    this.refd = false;
  }
  send(m: WorkerOutbound): void {
    this.emit("message", m);
  }
  ready(): void {
    this.send({ type: "ready" });
  }
  reply(text: string): void {
    const m = this.inbox[this.inbox.length - 1]!;
    this.send({ type: "result", id: m.id, result: { blocks: [{ type: "paragraph", content: text }], unbound: 0 } as never });
  }
}

let spawned: FakeWorker[] = [];
const spawn = vi.fn(({ workerMemoryMb }: { workerMemoryMb: number }) => {
  const w = new FakeWorker(workerMemoryMb);
  spawned.push(w);
  return w;
});
const req = (owner: string, markdown = "x"): ParseRequest => ({ owner, markdown, candidates: [], siteOrigin: "http://localhost" });
const pools: ParsePool[] = [];
const mk = (o: Partial<{ workers: number; timeoutMs: number; queueWaitMs: number; workerMemoryMb: number }> = {}) => {
  const p = new ParsePool({ baseUrl: "http://localhost/", workers: 2, workerMemoryMb: 512, timeoutMs: 5_000, queueWaitMs: 10_000, spawn, ...o });
  pools.push(p);
  return p;
};
const mdOf = (m: WorkerInbound) => (m.kind === "parse" ? m.markdown : null);
const flush = () => new Promise<void>(r => setImmediate(r));

beforeEach(() => {
  spawned = [];
  spawn.mockClear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
});
afterEach(async () => {
  for (const p of pools.splice(0)) await p.close();
  vi.useRealTimers();
});

describe("ParsePool (fake workers)", () => {
  it("opens `workers` workers at start; queues until ready, then sends; sent messages carry no owner", async () => {
    const pool = mk({ workers: 2 });
    expect(spawned).toHaveLength(2);
    const r = pool.parse(req("u1", "hello"));
    expect(spawned[0]!.inbox).toHaveLength(0);
    spawned[0]!.ready();
    expect(spawned[0]!.inbox).toHaveLength(1);
    expect(spawned[0]!.inbox[0]).toEqual({ id: expect.any(Number), kind: "parse", markdown: "hello", candidates: [], siteOrigin: "http://localhost" });
    expect(spawned[0]!.refd).toBe(true); // ref'd while parsing
    spawned[0]!.reply("hello");
    await expect(r).resolves.toEqual({ blocks: [{ type: "paragraph", content: "hello" }], unbound: 0 });
    expect(spawned[0]!.refd).toBe(false); // unref'd when idle
  });

  it("each user holds at most PER_OWNER_MAX (2) workers at once: the 3rd job queues; a freed worker goes first to someone with no running job (even if queued later)", async () => {
    expect(PER_OWNER_MAX).toBe(2);
    const pool = mk({ workers: 2 });
    for (const w of spawned) w.ready();
    const a1 = pool.parse(req("A", "a1"));
    const a2 = pool.parse(req("A", "a2")); // nobody else queued yet: this is A's 2nd
    const a3 = pool.parse(req("A", "a3"));
    const b1 = pool.parse(req("B", "b1"));
    expect(spawned.map(w => w.inbox.map(mdOf))).toEqual([["a1"], ["a2"]]);
    expect(pool.stats()).toMatchObject({ busy: 2, queued: 2 });
    spawned[1]!.reply("a2");
    await a2;
    // worker 1 freed: a3 is ahead of b1 in the queue, but B has no running job -> b1 goes first
    expect(spawned[1]!.inbox.map(mdOf)).toEqual(["a2", "b1"]);
    spawned[1]!.reply("b1");
    await b1;
    expect(spawned[1]!.inbox.map(mdOf)).toEqual(["a2", "b1", "a3"]);
    spawned[0]!.reply("a1");
    spawned[1]!.reply("a3");
    await expect(Promise.all([a1, a3])).resolves.toHaveLength(2);
  });

  it("when one person already holds 1 worker, others' jobs go before his queued 2nd job (people with no running job are picked first)", async () => {
    const pool = mk({ workers: 3 });
    for (const w of spawned) w.ready();
    for (const [o, m] of [["A", "a1"], ["A", "a2"], ["A", "a3"], ["B", "b1"]] as const) pool.parse(req(o, m)).catch(() => {}); // rejected when afterEach closes the pool
    // worker 0 <- a1; worker 1 <- a2 (nobody else queued then); worker 2 <- b1 (A already holds 2, a3 queues)
    expect(spawned.map(w => w.inbox.map(mdOf))).toEqual([["a1"], ["a2"], ["b1"]]);
    expect(pool.stats()).toMatchObject({ busy: 3, queued: 1 });
  });

  it("timeout: terminates that worker, returns too_complex, opens a replacement; the clock starts at hand-off to the worker (queueing excluded)", async () => {
    const pool = mk({ workers: 1, timeoutMs: 1_000 });
    const r = pool.parse(req("u"));
    vi.advanceTimersByTime(5_000); // not ready yet: still queued, so the parse timeout has not started
    spawned[0]!.ready();
    vi.advanceTimersByTime(999);
    expect(spawned[0]!.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(r).resolves.toEqual(TOO_COMPLEX);
    expect(spawned[0]!.terminated).toBe(true);
    expect(spawned).toHaveLength(2);
    expect(pool.stats()).toMatchObject({ timedOut: 1, workers: 1 });
    const r2 = pool.parse(req("u"));
    spawned[1]!.ready();
    spawned[1]!.reply("ok");
    await expect(r2).resolves.toMatchObject({ unbound: 0 });
  });

  it("a result that arrives from the worker after its timeout is dropped (not returned to the next job)", async () => {
    const pool = mk({ workers: 1, timeoutMs: 1_000 });
    spawned[0]!.ready();
    const r = pool.parse(req("u", "slow"));
    vi.advanceTimersByTime(1_000);
    await expect(r).resolves.toEqual(TOO_COMPLEX);
    spawned[0]!.reply("late"); // late message from the terminated worker
    const r2 = pool.parse(req("u", "next"));
    spawned[1]!.ready();
    spawned[1]!.reply("next");
    await expect(r2).resolves.toEqual({ blocks: [{ type: "paragraph", content: "next" }], unbound: 0 });
  });

  it("worker dies mid-parse (out of memory: error + exit) -> too_complex, replacement opened; queued jobs proceed", async () => {
    const pool = mk({ workers: 1 });
    spawned[0]!.ready();
    const r = pool.parse(req("A"));
    const q = pool.parse(req("B"));
    spawned[0]!.emit("error", Object.assign(new Error("Worker terminated due to reaching memory limit: JS heap out of memory"), { code: "ERR_WORKER_OUT_OF_MEMORY" }));
    spawned[0]!.emit("exit", 1);
    await expect(r).resolves.toEqual(TOO_COMPLEX);
    expect(pool.stats().crashed).toBe(1);
    expect(spawned).toHaveLength(2);
    spawned[1]!.ready();
    spawned[1]!.reply("b");
    await expect(q).resolves.toMatchObject({ unbound: 0 });
  });

  it("queued longer than queueWaitMs -> ParserBusyError (503); removed from the queue and never sent to a worker afterwards", async () => {
    const pool = mk({ workers: 1, queueWaitMs: 2_000 });
    spawned[0]!.ready();
    const busy = pool.parse(req("A"));
    const waiting = pool.parse(req("B"));
    vi.advanceTimersByTime(2_000);
    await expect(waiting).rejects.toBeInstanceOf(ParserBusyError);
    expect(pool.stats().queued).toBe(0);
    spawned[0]!.reply("a");
    await busy;
    expect(spawned[0]!.inbox).toHaveLength(1);
  });

  it("worker replies failed (a bug) -> reject (500), the worker stays in use", async () => {
    const pool = mk({ workers: 1 });
    spawned[0]!.ready();
    const r = pool.parse(req("u"));
    spawned[0]!.send({ type: "failed", id: spawned[0]!.inbox[0]!.id, name: "TypeError", frames: [] });
    await expect(r).rejects.toThrow("parse worker: TypeError");
    expect(spawned[0]!.terminated).toBe(false);
    expect(pool.stats().workers).toBe(1);
  });

  it(`after ${RECYCLE_AFTER_PARSES} parses -> replaced by a new worker (the ${RECYCLE_AFTER_PARSES}th result is still returned)`, async () => {
    const pool = mk({ workers: 1 });
    spawned[0]!.ready();
    for (let i = 1; i <= RECYCLE_AFTER_PARSES; i++) {
      const r = pool.parse(req("u"));
      spawned[0]!.reply("x");
      await expect(r).resolves.toMatchObject({ unbound: 0 });
      expect(spawned[0]!.terminated).toBe(i === RECYCLE_AFTER_PARSES);
    }
    expect(spawned).toHaveLength(2);
    expect(pool.stats().recycled).toBe(1);
  });

  it("dies before ready -> replacement opens after a delay (no immediate respawn loop)", async () => {
    mk({ workers: 1 });
    spawned[0]!.emit("exit", 1);
    expect(spawned).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(spawned).toHaveLength(2);
  });

  it("configure: raising the worker count opens at once, lowering retires idle ones; the timeout applies at once; changed memory replaces all", async () => {
    const pool = mk({ workers: 1 });
    spawned[0]!.ready();
    pool.configure({ workers: 3, workerMemoryMb: 256, timeoutMs: 100 });
    // memory changed: the idle old worker (512) is retired at once, fill() then opens 3 with the new cap
    expect(spawned[0]!.terminated).toBe(true);
    expect(spawned).toHaveLength(4);
    expect(spawned.map(w => w.memoryMb)).toEqual([512, 256, 256, 256]);
    expect(pool.limits).toMatchObject({ workers: 3, workerMemoryMb: 256, timeoutMs: 100 });
    for (const w of spawned.slice(1)) w.ready();
    pool.configure({ workers: 1 });
    // only the worker count changed: keep the first (spawned[1]), retire the other two idle ones
    expect(spawned.map(w => w.terminated)).toEqual([true, false, true, true]);
    expect(pool.stats().workers).toBe(1);
    const r = pool.parse(req("u"));
    expect(spawned[1]!.inbox).toHaveLength(1);
    vi.advanceTimersByTime(100);
    await expect(r).resolves.toEqual(TOO_COMPLEX);
  });

  it("configure changing the memory cap -> all idle workers replaced, new ones use the new cap", () => {
    const pool = mk({ workers: 2, workerMemoryMb: 1024 });
    for (const w of spawned) w.ready();
    pool.configure({ workerMemoryMb: 512 });
    expect(spawned.slice(0, 2).map(w => w.terminated)).toEqual([true, true]);
    expect(spawn).toHaveBeenCalledTimes(4);
    expect(spawned.slice(2).map(w => w.memoryMb)).toEqual([512, 512]);
    expect(pool.stats().workers).toBe(2);
  });

  it("configure changing the memory cap -> a busy worker is retired after its current job; idle ones at once; new ones use the new cap", async () => {
    const pool = mk({ workers: 2, workerMemoryMb: 1024 });
    for (const w of spawned) w.ready();
    const r = pool.parse(req("u", "busy"));
    r.catch(() => {}); // if an earlier assertion fails first, close() in afterEach rejects it
    expect(spawned[0]!.inbox.map(mdOf)).toEqual(["busy"]);
    pool.configure({ workerMemoryMb: 512 });
    expect(spawned[0]!.terminated).toBe(false);
    expect(spawned[1]!.terminated).toBe(true);
    expect(spawned.slice(2).map(w => w.memoryMb)).toEqual([512, 512]);
    spawned[0]!.reply("busy");
    await expect(r).resolves.toMatchObject({ blocks: [{ type: "paragraph", content: "busy" }] });
    expect(spawned[0]!.terminated).toBe(true);
    // the two new workers already fill the pool: retiring the old one must not open another
    expect(spawn).toHaveBeenCalledTimes(4);
    expect(pool.stats()).toMatchObject({ workers: 2, recycled: 0 });
  });

  it("configure with the same memory cap -> workers are not replaced", () => {
    const pool = mk({ workerMemoryMb: 1024 });
    for (const w of spawned) w.ready();
    pool.configure({ workerMemoryMb: 1024 });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawned.some(w => w.terminated)).toBe(false);
  });

  it("memory cap changed during spawn-failure backoff -> live old workers retired at once; workers opened after backoff all use the new cap", () => {
    const pool = mk({ workers: 2, workerMemoryMb: 1024 });
    spawned[0]!.ready();
    spawned[1]!.emit("exit", 1); // dies before ready: backoff timer starts
    pool.configure({ workerMemoryMb: 512 });
    expect(spawned).toHaveLength(2); // fill() opens nothing during backoff
    vi.advanceTimersByTime(1_000);
    // spawnSlot reads the current settings, so workers opened after backoff get the new cap
    expect(spawned.length).toBeGreaterThan(2);
    for (const w of spawned.slice(2)) expect(w.memoryMb).toBe(512);
    // the live old worker (1024) is retired at configure time, not kept until 500 jobs or high heap
    expect(spawned[0]!.terminated).toBe(true);
    expect(spawned).toHaveLength(4);
    expect(pool.stats().workers).toBe(2);
  });

  it("configure changing time limit and queue wait: timeoutMs() is the new value at once; jobs queued afterwards use the new queue-wait timeout", async () => {
    const pool = mk({ workers: 1, timeoutMs: 10_000, queueWaitMs: 45_000 });
    pool.configure({ timeoutMs: 5_000, queueWaitMs: 25_000 });
    expect(pool.timeoutMs()).toBe(5_000);
    let rejected: unknown = null;
    const waiting = pool.parse(req("u")).catch((e: unknown) => {
      rejected = e;
    });
    vi.advanceTimersByTime(24_999);
    await flush();
    expect(rejected).toBeNull();
    vi.advanceTimersByTime(1);
    await waiting;
    expect(rejected).toBeInstanceOf(ParserBusyError);
  });

  it("the unclosed-fence check (openFenceLine) takes the same path: sends kind fence, returns the fence result; shares the per-user cap with the same person's parses; timeout -> \"too_complex\"", async () => {
    const pool = mk({ workers: 2, timeoutMs: 1_000 });
    for (const w of spawned) w.ready();
    const p = pool.parse(req("A", "a1"));
    const f = pool.openFenceLine("A", ["x", "```"]);
    expect(spawned[1]!.inbox).toHaveLength(1); // same owner's 2nd (nobody else queued)
    spawned[0]!.reply("a1");
    await p;
    const w = spawned.find(x => x.inbox.some(m => m.kind === "fence"))!;
    const m = w.inbox.find(x => x.kind === "fence")!;
    expect(m).toEqual({ id: expect.any(Number), kind: "fence", lines: ["x", "```"] });
    w.send({ type: "fence", id: m.id, line: 1 });
    await expect(f).resolves.toBe(1);
    const slow = pool.openFenceLine("B", ["y"]);
    vi.advanceTimersByTime(1_000);
    await expect(slow).resolves.toBe("too_complex");
  });

  it("#398 total file budget: the limit is the smaller of the single-job limit and the remaining budget; elapsed time is deducted; parses after it is used up are not sent to a worker and get too_complex at once", async () => {
    const pool = mk({ workers: 1, timeoutMs: 5_000 });
    spawned[0]!.ready();
    const budget = { remainingMs: 1_200 };
    const a = pool.parse({ ...req("u", "a"), budget });
    vi.advanceTimersByTime(500);
    spawned[0]!.reply("a");
    await a;
    expect(budget.remainingMs).toBeCloseTo(700, -1);
    const b = pool.parse({ ...req("u", "b"), budget }); // only ~700 ms left: times out after 700 ms (not 5 s)
    vi.advanceTimersByTime(699);
    expect(spawned[0]!.terminated).toBe(false);
    vi.advanceTimersByTime(2);
    await expect(b).resolves.toEqual(TOO_COMPLEX);
    expect(budget.remainingMs).toBeLessThanOrEqual(0);
    spawned[1]!.ready();
    const c = pool.parse({ ...req("u", "c"), budget });
    await expect(c).resolves.toEqual(TOO_COMPLEX);
    expect(spawned[1]!.inbox).toHaveLength(0);
    expect(await pool.openFenceLine("u", ["x"], budget)).toBe("too_complex");
    expect(pool.fileBudget()).toEqual({ remainingMs: 15_000 });
  });

  it("#398 queue cap: with PARSE_QUEUE_MAX jobs queued, further ones get ParserBusyError at once (no waiting for a timeout)", async () => {
    const pool = mk({ workers: 1 });
    const queued = Array.from({ length: PARSE_QUEUE_MAX }, (_, i) => pool.parse(req(`u${i}`)));
    await expect(pool.parse(req("late"))).rejects.toBeInstanceOf(ParserBusyError);
    expect(pool.stats().queued).toBe(PARSE_QUEUE_MAX);
    await pool.close();
    await Promise.allSettled(queued);
  });

  it("close: terminates all workers, rejects queued and in-flight jobs, rejects later parses, opens no more", async () => {
    const pool = mk({ workers: 2 });
    spawned[0]!.ready();
    const running = pool.parse(req("A"));
    const queued = pool.parse(req("A"));
    await pool.close();
    await expect(running).rejects.toThrow("closed");
    await expect(queued).rejects.toThrow("closed");
    expect(spawned.every(w => w.terminated)).toBe(true);
    await expect(pool.parse(req("B"))).rejects.toThrow("closed");
    spawned[0]!.emit("exit", 1);
    vi.advanceTimersByTime(60_000);
    await flush();
    expect(spawned).toHaveLength(2);
  });

  it(`after a job whose heap use exceeds the RECYCLE_HEAP_SHARE limit (${RECYCLE_HEAP_SHARE}) -> replaced by a new worker (result still returned); not replaced when under`, async () => {
    const pool = mk({ workers: 1, workerMemoryMb: 1000 });
    spawned[0]!.ready();
    const a = pool.parse(req("u", "a"));
    let m = spawned[0]!.inbox.at(-1)!;
    spawned[0]!.send({ type: "result", id: m.id, result: { blocks: [], unbound: 0 } as never, heapMb: 500 }); // exactly half: not replaced
    await a;
    expect(pool.stats().recycled).toBe(0);
    const b = pool.parse(req("u", "b"));
    m = spawned[0]!.inbox.at(-1)!;
    spawned[0]!.send({ type: "result", id: m.id, result: { blocks: [], unbound: 0 } as never, heapMb: 501 });
    await expect(b).resolves.toMatchObject({ unbound: 0 });
    expect(pool.stats().recycled).toBe(1);
    expect(spawned[0]!.terminated).toBe(true);
    expect(spawned).toHaveLength(2);
  });

  it("transfer job (doc): sends kind doc (state >= 64 KiB and owning the whole buffer -> transfer); the worker's ask is answered by the main thread to the same worker; an ask that throws -> answer ok:false; result returned; timeout -> \"too_complex\"", async () => {
    const pool = mk({ workers: 1 });
    spawned[0]!.ready();
    const asked: unknown[] = [];
    const state = new Uint8Array(64 * 1024);
    const r = pool.runDoc("u", { kind: "outline", state }, async q => {
      asked.push(q);
      return [["x", "標題"]];
    }, 5_000);
    const w = spawned[0]!;
    const m = w.inbox.at(-1)!;
    expect(m).toMatchObject({ kind: "doc", op: { kind: "outline" } });
    w.send({ type: "ask", id: m.id, q: { kind: "titles", ids: ["x"] } });
    await flush();
    expect(asked).toEqual([{ kind: "titles", ids: ["x"] }]);
    expect(w.inbox.at(-1)).toEqual({ id: m.id, kind: "answer", ok: true, value: [["x", "標題"]] });
    w.send({ type: "doc", id: m.id, result: { whole: "w" }, heapMb: 1 });
    await expect(r).resolves.toEqual({ whole: "w" });
    const r2 = pool.runDoc("u", { kind: "outline", state: new Uint8Array(1) }, async () => {
      throw new Error("db down");
    }, 5_000);
    const m2 = w.inbox.at(-1)!;
    w.send({ type: "ask", id: m2.id, q: { kind: "titles", ids: ["y"] } });
    await flush();
    expect(w.inbox.at(-1)).toEqual({ id: m2.id, kind: "answer", ok: false });
    w.send({ type: "failed", id: m2.id, name: "Error", frames: [] });
    await expect(r2).rejects.toThrow(/parse worker/);
    const r3 = pool.runDoc("u", { kind: "outline", state: new Uint8Array(1) }, async () => null, 1_000);
    vi.advanceTimersByTime(1_000);
    await expect(r3).resolves.toBe("too_complex");
  });
});

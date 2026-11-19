// #398: markdown parsing and doc conversions run in workers so one parse can't stall the main thread. Both are pure (workers only return data), so terminating a worker midway leaves no write.
// A user holds at most PER_OWNER_MAX workers, the second only when nobody else is queued.
// Workers are recycled after RECYCLE_AFTER_PARSES parses and when heap exceeds RECYCLE_HEAP_SHARE of the limit after a job: mounted-editor residue plus uncollected garbage from a read followed by an apply can exhaust the limit (ERR_WORKER_OUT_OF_MEMORY). A false positive costs one extra worker (~0.5 s).
// configure(): a changed memory limit replaces all workers (busy ones after their job), otherwise old workers keep the old limit until recycled; time limits apply only to later jobs.
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { ParseLimits } from "./parse-settings.js";
import { DOC_TOO_COMPLEX, type AskFn, type DocAsk, type DocOp } from "./doc-jobs.js";
import { PARSE_FILE_BUDGET_FACTOR, ParserBusyError, TOO_COMPLEX, type MarkdownParser, type ParseBudget, type ParseOutcome, type ParseRequest } from "./parse-core.js";

export type WorkerInbound =
  | { id: number; kind: "parse"; markdown: string; candidates: ParseRequest["candidates"]; siteOrigin: string }
  | { id: number; kind: "fence"; lines: string[] }
  | { id: number; kind: "doc"; op: DocOp }
  | { id: number; kind: "answer"; ok: boolean; value?: unknown };
export type WorkerOutbound =
  | { type: "ready" }
  | { type: "doc"; id: number; result: unknown; heapMb?: number }
  | { type: "ask"; id: number; q: DocAsk }
  | { type: "result"; id: number; result: ParseOutcome; heapMb?: number }
  | { type: "fence"; id: number; line: number | null | "too_complex"; heapMb?: number }
  | { type: "failed"; id: number; name: string; frames: string[] };
export interface WorkerData {
  baseUrl: string;
}

export const PARSE_WORKER_STACK_MB = 4;
/** Unset, Node derives the young generation from host/container memory; a large semi-space lets one scavenge promote tens of MiB past the margin Node keeps near the heap limit, aborting the whole process before the worker can be terminated. 48 fixes the heap at old + 48. */
export const PARSE_WORKER_YOUNG_MB = 48;
export const PARSE_QUEUE_MAX = 100;
export const RECYCLE_AFTER_PARSES = 500;
export const RECYCLE_HEAP_SHARE = 0.5;
export const RESPAWN_DELAY_MS = 1_000;
export const RESPAWN_DELAY_MAX_MS = 30_000;
/** One user's browser download and MCP reads/writes can arrive together, so 1 is too tight; the second worker is only given when nobody else is queued, so others wait at most one job (≤ one time limit, shorter than `queueWaitMs`). */
export const PER_OWNER_MAX = 2;
/** Larger states are transferred, not copied; smaller copies are cheap and the caller can keep using them. */
export const TRANSFER_MIN_BYTES = 64 * 1024;

export interface PoolWorker {
  postMessage(m: WorkerInbound, transfer?: ArrayBuffer[]): void;
  on(event: "message", fn: (m: WorkerOutbound) => void): unknown;
  on(event: "error", fn: (err: Error) => void): unknown;
  on(event: "exit", fn: (code: number) => void): unknown;
  terminate(): Promise<number>;
  ref(): void;
  unref(): void;
}
export type SpawnWorker = (opts: { baseUrl: string; workerMemoryMb: number; stackSizeMb: number }) => PoolWorker;

export interface PoolLog {
  info(o: object, m: string): void;
  warn(o: object, m: string): void;
  error(o: object, m: string): void;
}

export interface ParsePoolOptions extends ParseLimits {
  baseUrl: string;
  log?: PoolLog;
  spawn?: SpawnWorker;
}

/** From source (tsx, vitest) the worker is another Node thread outside vite, so an eval bootstrap registers tsx's loader first. tsx is a devDependency, absent from the production image. */
export const spawnParseWorker: SpawnWorker = ({ baseUrl, workerMemoryMb, stackSizeMb }) => {
  const resourceLimits = { maxOldGenerationSizeMb: workerMemoryMb, maxYoungGenerationSizeMb: PARSE_WORKER_YOUNG_MB, stackSizeMb };
  const workerData: WorkerData = { baseUrl };
  const here = import.meta.url;
  if (!here.endsWith(".ts")) return new Worker(new URL("./parse-worker.js", here), { workerData, resourceLimits });
  const api = pathToFileURL(createRequire(here).resolve("tsx/esm/api")).href;
  const entry = new URL("./parse-worker.ts", here).href;
  const boot = `import(${JSON.stringify(api)}).then(m => { m.register(); return import(${JSON.stringify(entry)}); })`;
  return new Worker(boot, { eval: true, workerData, resourceLimits });
};

type Job = { kind: "parse"; markdown: string; candidates: ParseRequest["candidates"]; siteOrigin: string } | { kind: "fence"; lines: string[] } | { kind: "doc"; op: DocOp };
interface Task {
  id: number;
  owner: string;
  job: Job;
  resolve(r: unknown): void;
  reject(e: Error): void;
  tooComplex: unknown;
  queueTimer: ReturnType<typeof setTimeout> | null;
  budget: ParseBudget | undefined;
  startedAt: number;
  timeoutMs?: number;
  ask?: AskFn;
}
interface Slot {
  worker: PoolWorker;
  state: "starting" | "idle" | "busy" | "gone";
  task: Task | null;
  timer: ReturnType<typeof setTimeout> | null;
  retire: boolean;
  parses: number;
}

export interface ParsePoolStats {
  workers: number;
  ready: number;
  busy: number;
  queued: number;
  spawned: number;
  timedOut: number;
  crashed: number;
  recycled: number;
  docJobs: number;
}

export class ParsePool implements MarkdownParser {
  private limitsNow: ParseLimits;
  private readonly baseUrl: string;
  private readonly spawnFn: SpawnWorker;
  private readonly log: PoolLog | undefined;
  private readonly slots = new Set<Slot>();
  private readonly queue: Task[] = [];
  private readonly running = new Map<string, number>();
  private nextId = 1;
  private closed = false;
  private respawnDelay = RESPAWN_DELAY_MS;
  private respawnTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly counters = { spawned: 0, timedOut: 0, crashed: 0, recycled: 0, docJobs: 0 };

  constructor(opts: ParsePoolOptions) {
    this.baseUrl = opts.baseUrl;
    this.spawnFn = opts.spawn ?? spawnParseWorker;
    this.log = opts.log;
    this.limitsNow = { workers: opts.workers, workerMemoryMb: opts.workerMemoryMb, timeoutMs: opts.timeoutMs, queueWaitMs: opts.queueWaitMs };
    this.fill();
  }

  get limits(): ParseLimits {
    return { ...this.limitsNow };
  }

  stats(): ParsePoolStats {
    const live = [...this.slots].filter(s => s.state !== "gone" && !s.retire);
    return {
      workers: live.length,
      ready: live.filter(s => s.state === "idle" || s.state === "busy").length,
      busy: [...this.slots].filter(s => s.state === "busy").length,
      queued: this.queue.length,
      ...this.counters,
    };
  }

  configure(next: Partial<ParseLimits>): void {
    const memoryChanged = next.workerMemoryMb !== undefined && next.workerMemoryMb !== this.limitsNow.workerMemoryMb;
    this.limitsNow = { ...this.limitsNow, ...next };
    const live = [...this.slots].filter(s => s.state !== "gone" && !s.retire);
    for (const s of memoryChanged ? live : live.slice(this.limitsNow.workers)) this.retireSlot(s);
    this.fill();
  }

  parse(req: ParseRequest): Promise<ParseOutcome> {
    const { owner, markdown, candidates, siteOrigin, budget } = req;
    return this.enqueue<ParseOutcome>(owner, { kind: "parse", markdown, candidates, siteOrigin }, TOO_COMPLEX, budget);
  }

  openFenceLine(owner: string, lines: readonly string[], budget?: ParseBudget): Promise<number | null | "too_complex"> {
    return this.enqueue<number | null | "too_complex">(owner, { kind: "fence", lines: [...lines] }, "too_complex", budget);
  }

  fileBudget(): ParseBudget {
    return { remainingMs: PARSE_FILE_BUDGET_FACTOR * this.limitsNow.timeoutMs };
  }

  timeoutMs(): number {
    return this.limitsNow.timeoutMs;
  }

  runDoc(owner: string, op: DocOp, ask: AskFn, timeoutMs: number, queueWaitMs?: number): Promise<unknown> {
    this.counters.docJobs++;
    return this.enqueue<unknown>(owner, { kind: "doc", op }, DOC_TOO_COMPLEX, undefined, { timeoutMs, ask, ...(queueWaitMs !== undefined ? { queueWaitMs } : {}) });
  }

  private enqueue<R>(owner: string, job: Job, tooComplex: R, budget: ParseBudget | undefined, extra: { timeoutMs?: number; ask?: AskFn; queueWaitMs?: number } = {}): Promise<R> {
    if (this.closed) return Promise.reject(new Error("parse pool is closed"));
    if (budget !== undefined && budget.remainingMs <= 0) return Promise.resolve(tooComplex);
    if (this.queue.length >= PARSE_QUEUE_MAX) return Promise.reject(new ParserBusyError());
    return new Promise<R>((resolve, reject) => {
      const { queueWaitMs, ...taskExtra } = extra;
      const task: Task = { id: this.nextId++, owner, job, resolve: resolve as (r: unknown) => void, reject, tooComplex, queueTimer: null, budget, startedAt: 0, ...taskExtra };
      task.queueTimer = setTimeout(() => {
        const i = this.queue.indexOf(task);
        if (i === -1) return;
        this.queue.splice(i, 1);
        reject(new ParserBusyError());
      }, queueWaitMs ?? this.limitsNow.queueWaitMs);
      this.queue.push(task);
      this.dispatch();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.respawnTimer !== null) clearTimeout(this.respawnTimer);
    for (const t of this.queue.splice(0)) {
      if (t.queueTimer !== null) clearTimeout(t.queueTimer);
      t.reject(new Error("parse pool is closed"));
    }
    const slots = [...this.slots];
    this.slots.clear();
    await Promise.all(
      slots.map(async s => {
        if (s.timer !== null) clearTimeout(s.timer);
        s.state = "gone";
        if (s.task !== null) s.task.reject(new Error("parse pool is closed"));
        s.task = null;
        await s.worker.terminate().catch(() => 0);
      })
    );
  }

  private fill(): void {
    if (this.closed || this.respawnTimer !== null) return;
    let live = [...this.slots].filter(s => s.state !== "gone" && !s.retire).length;
    while (live < this.limitsNow.workers) {
      this.spawnSlot();
      live++;
    }
  }

  private spawnSlot(): void {
    const memoryMb = this.limitsNow.workerMemoryMb;
    let worker: PoolWorker;
    try {
      worker = this.spawnFn({ baseUrl: this.baseUrl, workerMemoryMb: memoryMb, stackSizeMb: PARSE_WORKER_STACK_MB });
    } catch (err) {
      this.log?.error({ err }, "parse worker: spawn failed");
      this.scheduleRespawn();
      return;
    }
    this.counters.spawned++;
    const slot: Slot = { worker, state: "starting", task: null, timer: null, retire: false, parses: 0 };
    this.slots.add(slot);
    worker.unref();
    worker.on("message", m => this.onMessage(slot, m));
    worker.on("error", err => this.onGone(slot, err));
    worker.on("exit", code => this.onGone(slot, null, code));
  }

  private scheduleRespawn(): void {
    if (this.closed || this.respawnTimer !== null) return;
    const delay = this.respawnDelay;
    this.respawnDelay = Math.min(RESPAWN_DELAY_MAX_MS, this.respawnDelay * 2);
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      this.fill();
    }, delay);
    this.respawnTimer.unref();
  }

  private onMessage(slot: Slot, m: WorkerOutbound): void {
    if (slot.state === "gone") return;
    if (m.type === "ready") {
      this.respawnDelay = RESPAWN_DELAY_MS;
      if (slot.retire) return void this.endSlot(slot);
      slot.state = "idle";
      this.dispatch();
      return;
    }
    const task = slot.task;
    if (task === null || task.id !== m.id) return;
    if (m.type === "ask") return void this.answer(slot, task, m.q);
    this.finishTask(slot);
    if (m.type === "failed") {
      this.log?.error({ name: m.name, frames: m.frames }, "parse worker: parse threw");
      task.reject(new Error(`parse worker: ${m.name}`));
    } else {
      task.resolve(m.type === "result" ? m.result : m.type === "doc" ? m.result : m.line);
    }
    const heavy = m.type !== "failed" && m.heapMb !== undefined && m.heapMb > RECYCLE_HEAP_SHARE * this.limitsNow.workerMemoryMb;
    if ((++slot.parses >= RECYCLE_AFTER_PARSES || heavy) && !slot.retire) {
      this.counters.recycled++;
      slot.retire = true;
    }
    if (slot.retire) {
      this.endSlot(slot);
      this.fill();
    } else {
      slot.state = "idle";
      slot.worker.unref();
    }
    this.dispatch();
  }

  /** If the worker timed out and was replaced, or moved to another job, the answer is dropped. */
  private answer(slot: Slot, task: Task, q: DocAsk): void {
    const reply = (ok: boolean, value?: unknown) => {
      if (slot.task !== task || slot.state !== "busy") return;
      slot.worker.postMessage({ id: task.id, kind: "answer", ok, ...(ok ? { value } : {}) });
    };
    if (task.ask === undefined) return reply(false);
    task.ask(q).then(
      v => reply(true, v),
      err => {
        this.log?.error({ err: err instanceof Error ? { name: err.name, message: err.message } : String(err), ask: q.kind }, "parse worker: answering a doc job failed");
        reply(false);
      }
    );
  }

  private onGone(slot: Slot, err: Error | null, code?: number): void {
    if (slot.state === "gone") return;
    const wasStarting = slot.state === "starting";
    const task = slot.task;
    slot.state = "gone";
    this.slots.delete(slot);
    if (task !== null) {
      this.finishTask(slot);
      this.counters.crashed++;
      this.log?.warn({ err: err ? { name: err.name, code: (err as { code?: string }).code } : null, exitCode: code ?? null }, "parse worker: died while parsing; answered too_complex");
      task.resolve(task.tooComplex);
    } else if (!slot.retire) {
      this.log?.error({ err: err ? { name: err.name, message: err.message } : null, exitCode: code ?? null, starting: wasStarting }, "parse worker: exited");
    }
    if (this.closed) return;
    if (wasStarting && !slot.retire) this.scheduleRespawn();
    else this.fill();
    this.dispatch();
  }

  private finishTask(slot: Slot): void {
    const task = slot.task!;
    if (slot.timer !== null) clearTimeout(slot.timer);
    slot.timer = null;
    slot.task = null;
    if (task.budget !== undefined) task.budget.remainingMs -= performance.now() - task.startedAt;
    const n = (this.running.get(task.owner) ?? 1) - 1;
    if (n <= 0) this.running.delete(task.owner);
    else this.running.set(task.owner, n);
  }

  private retireSlot(slot: Slot): void {
    slot.retire = true;
    if (slot.state === "idle" || slot.state === "starting") this.endSlot(slot);
  }

  private endSlot(slot: Slot): void {
    slot.state = "gone";
    this.slots.delete(slot);
    void slot.worker.terminate().catch(() => 0);
  }

  private dispatch(): void {
    if (this.closed) return;
    for (const slot of this.slots) {
      if (slot.state !== "idle") continue;
      let i = this.queue.findIndex(t => !this.running.has(t.owner));
      if (i === -1) i = this.queue.findIndex(t => (this.running.get(t.owner) ?? 0) < PER_OWNER_MAX);
      if (i === -1) return;
      const [task] = this.queue.splice(i, 1) as [Task];
      if (task.queueTimer !== null) clearTimeout(task.queueTimer);
      task.queueTimer = null;
      this.running.set(task.owner, (this.running.get(task.owner) ?? 0) + 1);
      slot.state = "busy";
      slot.task = task;
      slot.worker.ref();
      task.startedAt = performance.now();
      // The budget may have been used up by other parses of the same file while queued: return too-complex without sending.
      const own = task.timeoutMs ?? this.limitsNow.timeoutMs;
      const limit = task.budget === undefined ? own : Math.min(own, task.budget.remainingMs);
      if (limit <= 0) {
        this.finishTask(slot);
        slot.state = "idle";
        slot.worker.unref();
        task.resolve(task.tooComplex);
        // This worker is free again: dispatch once more (this round already passed it).
        queueMicrotask(() => this.dispatch());
        continue;
      }
      slot.timer = setTimeout(() => this.onTimeout(slot, task), limit);
      if (task.job.kind === "doc") {
        const op = task.job.op;
        const st = op.state;
        // A small pg Buffer may be a slice of a shared pool and can't be transferred.
        const own = st.byteLength >= TRANSFER_MIN_BYTES && st.byteOffset === 0 && st.byteLength === st.buffer.byteLength && st.buffer instanceof ArrayBuffer;
        slot.worker.postMessage({ id: task.id, kind: "doc", op: own ? op : { ...op, state: new Uint8Array(st) } }, own ? [st.buffer as ArrayBuffer] : []);
      } else {
        slot.worker.postMessage({ id: task.id, ...task.job });
      }
    }
  }

  private onTimeout(slot: Slot, task: Task): void {
    if (slot.task !== task) return;
    this.finishTask(slot);
    this.counters.timedOut++;
    slot.state = "gone";
    this.slots.delete(slot);
    void slot.worker.terminate().catch(() => 0);
    this.log?.warn({ timeoutMs: this.limitsNow.timeoutMs, kind: task.job.kind }, "parse worker: parse timed out; worker terminated, answered too_complex");
    task.resolve(task.tooComplex);
    this.fill();
    this.dispatch();
  }
}

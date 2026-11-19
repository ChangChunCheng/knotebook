// An unmounted collaborative editor is an empty doc (by-id operations throw), so sessions mount into jsdom; a mounted editor leaves ~0.53 MB that GC can't reclaim even after unmount. So the window is rebuilt every N mounts or at +64 MiB heap, only when in-flight is zero. Fallback if that isn't enough: move the runtime into worker_threads.
// `acquire()` isn't reentrant: acquiring while holding a lease deadlocks once the rebuild flag is set (silent timeout). See `prepareEdit` in `apply.ts`.
// jsdom's url is PUBLIC_URL's origin + "/": the schema's media guard uses it as the base for relative URLs.
// Attaching window/document makes packages that sniff `typeof window` think they're in a browser (@anthropic-ai/sdk; pinned by editing-runtime.test.ts); yjs/hocuspocus are guarded by lib0's `!isNode`.
import { JSDOM } from "jsdom";
import type { AppConfig } from "../../config.js";
import { publicUrlIssuer } from "../../config.js";
import { patchJsdomForLargeTrees } from "./jsdom-perf.js";
import { DOC_INLINE_MAX_BYTES, DOC_TIMEOUT_FACTOR, docWeight, executeDocOp, type AskFn, type DocOp, type DocOpOf, type DocResults, type DocTooComplex } from "./doc-jobs.js";
import { InlineMarkdownParser, type MarkdownParser } from "./parse-core.js";
import { ParsePool, type PoolLog } from "./parse-pool.js";
import type { ParseLimits } from "./parse-settings.js";

export interface EditingRuntimeOptions {
  baseUrl: string;
  rebuildEvery?: number;
  heapGrowthLimit?: number;
  readHeapUsed?: () => number;
  parser?: MarkdownParser;
  inlineMaxBytes?: number;
}
export interface SessionLease {
  release(): void;
}

const DEFAULT_REBUILD_EVERY = 50;
const DEFAULT_HEAP_LIMIT = 64 * 1024 * 1024;
const noAsk: AskFn = async q => {
  throw new Error(`EditingRuntime.runDoc: no answer for ask ${q.kind}`);
};

/** navigator is not attached: a getter-only built-in on Node ≥ 21; overwriting it would make environment sniffing see browser values. */
const GLOBAL_KEYS = [
  "window",
  "document",
  "Node",
  "Element",
  "HTMLElement",
  "Range",
  "DOMRect",
  "MutationObserver",
  "getComputedStyle",
  "DocumentFragment",
  "Text",
  "DOMParser",
  "XMLSerializer",
] as const;

export class EditingRuntime {
  readonly baseUrl: string;
  private readonly rebuildEvery: number;
  private readonly heapGrowthLimit: number;
  private readonly readHeapUsed: () => number;
  private dom: JSDOM | null = null;
  private heapBaseline = 0;
  private mountsSinceRebuild = 0;
  private inFlightCount = 0;
  private pending = false;
  private waiters: Array<() => void> = [];
  private rebuildCount = 0;
  private mountCount = 0;
  readonly parser: MarkdownParser;
  readonly inlineMaxBytes: number;

  constructor(opts: EditingRuntimeOptions) {
    this.baseUrl = opts.baseUrl;
    this.inlineMaxBytes = opts.inlineMaxBytes ?? DOC_INLINE_MAX_BYTES;
    this.parser = opts.parser ?? new InlineMarkdownParser(this);
    this.rebuildEvery = opts.rebuildEvery ?? DEFAULT_REBUILD_EVERY;
    this.heapGrowthLimit = opts.heapGrowthLimit ?? DEFAULT_HEAP_LIMIT;
    this.readHeapUsed = opts.readHeapUsed ?? (() => process.memoryUsage().heapUsed);
  }

  get inFlight(): number {
    return this.inFlightCount;
  }
  get rebuildPending(): boolean {
    return this.pending;
  }
  get rebuilds(): number {
    return this.rebuildCount;
  }
  get mounts(): number {
    return this.mountCount;
  }

  runDoc<K extends DocOp["kind"]>(owner: string, op: DocOpOf<K>, opts: { ask?: AskFn; extraWeight?: number; timeoutMs?: number; queueWaitMs?: number } = {}): Promise<DocResults[K] | DocTooComplex> {
    const ask = opts.ask ?? noAsk;
    const pool = this.parser.runDoc?.bind(this.parser);
    if (pool === undefined || docWeight(op, opts.extraWeight) < this.inlineMaxBytes) return executeDocOp<K>(this, op, ask);
    return pool(owner, op, ask, opts.timeoutMs ?? DOC_TIMEOUT_FACTOR * this.parser.timeoutMs(), opts.queueWaitMs) as Promise<DocResults[K] | DocTooComplex>;
  }

  async close(): Promise<void> {
    await this.parser.close();
  }

  installGlobals(): void {
    if (!patchJsdomForLargeTrees()) console.warn("EditingRuntime: could not patch jsdom for large node lists; exporting large paragraphs may be slow");
    this.dom?.window.close();
    const dom = new JSDOM("", { url: this.baseUrl });
    this.dom = dom;
    const w = dom.window as unknown as Record<string, unknown>;
    for (const key of GLOBAL_KEYS) {
      Object.defineProperty(globalThis, key, { value: w[key], configurable: true, writable: true, enumerable: false });
    }
    // Same rect polyfills as apps/web/src/test/setup.ts: ProseMirror measures geometry.
    const rect = (): DOMRect => new dom.window.DOMRect(0, 0, 0, 0);
    dom.window.Element.prototype.getBoundingClientRect = rect;
    dom.window.Range.prototype.getBoundingClientRect = rect;
    dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    this.heapBaseline = this.readHeapUsed();
    this.mountsSinceRebuild = 0;
  }

  async acquire(): Promise<SessionLease> {
    while (this.pending) await new Promise<void>(resolve => this.waiters.push(resolve));
    this.inFlightCount += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.inFlightCount -= 1;
        this.maybeRebuild();
      },
    };
  }

  /** `noteMount`'s check runs before mount and can't see what the job just left behind: a read followed by an apply stacks two mounted editors in the worker's memory limit (ERR_WORKER_OUT_OF_MEMORY). */
  settleAfterJob(): void {
    if (this.readHeapUsed() - this.heapBaseline > this.heapGrowthLimit) this.pending = true;
    this.maybeRebuild();
  }

  noteMount(): void {
    this.mountCount += 1;
    this.mountsSinceRebuild += 1;
    if (this.mountsSinceRebuild >= this.rebuildEvery || this.readHeapUsed() - this.heapBaseline > this.heapGrowthLimit) this.pending = true;
  }

  private maybeRebuild(): void {
    if (!this.pending || this.inFlightCount > 0) return;
    // pending and waiters must be released in a finally, or every queued and later acquire() never settles. The error isn't swallowed (logged); the next mount surfaces it again.
    const waiters = this.waiters;
    this.waiters = [];
    try {
      this.installGlobals();
      this.rebuildCount += 1;
    } catch (err) {
      console.error("EditingRuntime: installGlobals() failed during rebuild", err);
    } finally {
      this.pending = false;
      for (const w of waiters) w();
    }
  }
}

export function createEditingRuntime(config: AppConfig, limits: ParseLimits, log?: PoolLog): EditingRuntime {
  const baseUrl = `${publicUrlIssuer(config.publicUrl)}/`;
  const { workers, workerMemoryMb, timeoutMs, queueWaitMs } = limits;
  const rt = new EditingRuntime({ baseUrl, parser: new ParsePool({ baseUrl, workers, workerMemoryMb, timeoutMs, queueWaitMs, log }) });
  rt.installGlobals();
  return rt;
}

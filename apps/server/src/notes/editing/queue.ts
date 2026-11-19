export class QueueBusyError extends Error { constructor() { super("note write queue busy"); } }
const settled = (p: Promise<unknown>): Promise<void> => p.then(() => undefined, () => undefined);
/** Per-note serialization: two writes forking the same state and merging separately would defeat the fingerprint check. Process-local. */
export class NoteWriteQueue {
  private readonly chains = new Map<string, Promise<unknown>>();
  get size(): number { return this.chains.size; }
  async run<T>(noteId: string, fn: () => Promise<T>, waitMs = 10_000): Promise<T> {
    const prev = this.chains.get(noteId) ?? Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let entered = false;
    const gate = Promise.race([
      settled(prev).then(() => "ok" as const),
      new Promise<"busy">(r => { timer = setTimeout(() => r("busy"), waitMs); }),
    ]);
    const chain = gate.then(async state => {
      if (timer) clearTimeout(timer);
      if (state === "busy") throw new QueueBusyError();
      entered = true;
      return fn();
    });
    // A request that never reached `fn` must not shorten the chain: on busy the previous request is still running, so the tail must stay `settled(prev)`, not the rejected chain, and eviction must not run on the chain's rejection, or the next request gets a fresh chain in parallel.
    // Serial order matters most for revert: `POST …/revert` has no `if_match` and its idempotency check (`editRevertable`) pre-reads the live doc, so two concurrent reverts both insert `before_blocks` and duplicate top-level ids. Pinned by test/unit/editing-queue.test.ts.
    const tail = gate.then(state => (state === "busy" ? settled(prev) : settled(chain)));
    this.chains.set(noteId, tail);
    const evict = (): void => { if (this.chains.get(noteId) === tail) this.chains.delete(noteId); };
    try {
      return await chain;
    } finally {
      // Not run (busy): evict only after the tail settles, i.e. when the previous request really finished.
      if (entered) evict(); else void tail.then(evict);
    }
  }
}

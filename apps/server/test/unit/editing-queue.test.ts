import { describe, expect, it } from "vitest";
import { NoteWriteQueue, QueueBusyError } from "../../src/notes/editing/queue.js";

describe("NoteWriteQueue", () => {
  it("same noteId runs serially, different noteIds in parallel; an entry is deleted once its chain drains", async () => {
    const q = new NoteWriteQueue();
    const order: string[] = [];
    const slow = (tag: string, ms: number) => async () => { await new Promise(r => setTimeout(r, ms)); order.push(tag); return tag; };
    const results = await Promise.all([q.run("n1", slow("a", 30)), q.run("n1", slow("b", 5)), q.run("n2", slow("c", 5))]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(order).toEqual(["c", "a", "b"]);
    expect(q.size).toBe(0);
  });
  it("waiting longer than waitMs -> QueueBusyError, and the previous job still completes", async () => {
    const q = new NoteWriteQueue();
    const first = q.run("n1", () => new Promise<string>(r => setTimeout(() => r("first"), 80)));
    await expect(q.run("n1", async () => "second", 10)).rejects.toBeInstanceOf(QueueBusyError);
    expect(await first).toBe("first");
  });
  // Guards queue.ts's invariant "a request that never reached fn must not shorten the chain". busy means "timed out waiting for my turn" while
  // the previous request is still running: if the timed-out call removed its own slot from the map (or left a tail that lands at the moment of
  // busy), the next arriving request would get a brand-new chain and run in parallel with the one still running. The undo path has no if_match,
  // so its idempotency guard relies entirely on serialization; breaking it means two concurrent undos each insert before_blocks once -> two top-level blocks with the same id.
  it("serialization is not broken after a busy timeout: a request arriving after the timeout still waits for the previous one to finish (in flight at once <= 1)", async () => {
    const q = new NoteWriteQueue();
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseFirst = (): void => {};
    const firstGate = new Promise<void>(r => { releaseFirst = r; });
    const job = (tag: string, wait: Promise<void>) => async (): Promise<string> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await wait;
      inFlight -= 1;
      return tag;
    };
    const first = q.run("n1", job("first", firstGate));
    // The second call can't get its turn -> busy. It never ran fn, so it must not touch that slot in the map
    await expect(q.run("n1", job("busy", Promise.resolve()), 10)).rejects.toBeInstanceOf(QueueBusyError);
    expect(q.size).toBe(1);
    const third = q.run("n1", job("third", Promise.resolve()), 5_000);
    await new Promise(r => setTimeout(r, 30)); // if serialization were broken, this time is enough for third to run in parallel and finish
    expect(inFlight).toBe(1); // precondition guard (not this case's criterion): first is really still in flight, otherwise the case spins idle
    releaseFirst();
    expect(await first).toBe("first");
    expect(await third).toBe("third");
    expect(maxInFlight).toBe(1);
    expect(q.size).toBe(0);
  });
});

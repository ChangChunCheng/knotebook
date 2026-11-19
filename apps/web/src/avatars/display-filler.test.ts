import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFail } from "@/api/client";
import { syncFillerUser } from "./filler-user";
import {
  clearFillerState,
  configureFiller,
  dropQueuedFill,
  enqueueFill,
  fillKey,
  getQuotaFailed,
  notifyAvatarWritten,
  registerCropOpen,
  resetFiller,
  type EncodeModule,
  type FillerDeps,
} from "./display-filler";

const A = "0f8fad5b-d9cb-469f-a165-70867728950e";
const B = "1a2b3c4d-d9cb-469f-a165-70867728950f";

interface Harness {
  deps: FillerDeps;
  fetchOriginal: ReturnType<typeof vi.fn>;
  putDisplay: ReturnType<typeof vi.fn>;
  invalidate: ReturnType<typeof vi.fn>;
  loadEncode: ReturnType<typeof vi.fn>;
  bitmapClosed: ReturnType<typeof vi.fn>;
}

function harness(over: Partial<FillerDeps> = {}): Harness {
  const bitmapClosed = vi.fn();
  const encode: EncodeModule = {
    decodeImage: async () => ({ width: 600, height: 400, close: bitmapClosed }) as unknown as ImageBitmap,
    renderDisplay: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" }),
  };
  const fetchOriginal = vi.fn(async () => new Blob([new Uint8Array([9])], { type: "image/png" }));
  const putDisplay = vi.fn(async () => ({}));
  const invalidate = vi.fn();
  const loadEncode = vi.fn(async () => encode);
  const deps: FillerDeps = { fetchOriginal, putDisplay, invalidate, loadEncode, backoffMs: 20, ...over };
  configureFiller(deps);
  return { deps, fetchOriginal, putDisplay, invalidate, loadEncode, bitmapClosed };
}

const fail = (status: number, code: string) => new ApiFail(status, code, "x");
const idle = () => new Promise<void>(resolve => setTimeout(resolve, 60));

describe("display-filler", () => {
  beforeEach(() => resetFiller());
  afterEach(() => resetFiller());

  it("centered minimum-scale backfill: reads the original, encodes, sends back with version and crop, closes the bitmap, invalidates the cache", async () => {
    const h = harness();
    enqueueFill({ id: A, v: 3 });
    await vi.waitFor(() => expect(h.putDisplay).toHaveBeenCalledTimes(1));
    const input = h.putDisplay.mock.calls[0]![0] as { id: string; version: number; crop: Record<string, number>; display: Blob };
    expect(input.id).toBe(A);
    expect(input.version).toBe(3);
    expect(input.crop).toEqual({ x: 100, y: 0, size: 400, width: 600, height: 400 });
    expect(input.display.type).toBe("image/webp");
    await vi.waitFor(() => expect(h.invalidate).toHaveBeenCalledTimes(1));
    expect(h.bitmapClosed).toHaveBeenCalledTimes(1);
  });

  it("each (id, v) is processed once; a new version is processed as usual", async () => {
    const h = harness();
    enqueueFill({ id: A, v: 1 });
    enqueueFill({ id: A, v: 1 });
    await vi.waitFor(() => expect(h.putDisplay).toHaveBeenCalledTimes(1));
    enqueueFill({ id: A, v: 1 });
    await idle();
    expect(h.putDisplay).toHaveBeenCalledTimes(1);
    enqueueFill({ id: A, v: 2 });
    await vi.waitFor(() => expect(h.putDisplay).toHaveBeenCalledTimes(2));
  });

  it("a version that already failed (500) isn't retried", async () => {
    const h = harness({ putDisplay: vi.fn(async () => Promise.reject(fail(500, "internal"))) });
    enqueueFill({ id: A, v: 1 });
    await vi.waitFor(() => expect(h.deps.putDisplay).toHaveBeenCalledTimes(1));
    enqueueFill({ id: A, v: 1 });
    await idle();
    expect(h.deps.putDisplay).toHaveBeenCalledTimes(1);
  });

  it.each([
    [404, "not_found"],
    [413, "payload_too_large"],
    [415, "unsupported_media_type"],
    [429, "too_many_requests"],
    [500, "internal"],
  ])("%i %s: no retry, not recorded as quota failure, no invalidation", async (status, code) => {
    const h = harness({ putDisplay: vi.fn(async () => Promise.reject(fail(status, code))) });
    enqueueFill({ id: A, v: 1 });
    await vi.waitFor(() => expect(h.deps.putDisplay).toHaveBeenCalledTimes(1));
    await idle();
    expect(h.deps.putDisplay).toHaveBeenCalledTimes(1);
    expect(getQuotaFailed().size).toBe(0);
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it("decode failure (not an API error) is also recorded as failed, not retried, and later ones are processed as usual", async () => {
    const decodeImage = vi
      .fn()
      .mockRejectedValueOnce(new Error("cannot decode"))
      .mockResolvedValue({ width: 10, height: 10, close: vi.fn() });
    const h = harness({
      loadEncode: async () => ({ decodeImage, renderDisplay: async () => new Blob([new Uint8Array([1])], { type: "image/webp" }) }),
    });
    enqueueFill({ id: A, v: 1 });
    enqueueFill({ id: B, v: 1 });
    await vi.waitFor(() => expect(h.putDisplay).toHaveBeenCalledTimes(1));
    expect((h.putDisplay.mock.calls[0]![0] as { id: string }).id).toBe(B);
  });

  it("one at a time: the second waits for the first to finish", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let active = 0;
    let maxActive = 0;
    const h = harness({
      putDisplay: vi.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gate;
        active -= 1;
        return {};
      }),
    });
    enqueueFill({ id: A, v: 1 });
    enqueueFill({ id: B, v: 1 });
    await vi.waitFor(() => expect(h.deps.putDisplay).toHaveBeenCalledTimes(1));
    await idle();
    expect(h.deps.putDisplay).toHaveBeenCalledTimes(1);
    expect(h.fetchOriginal).toHaveBeenCalledTimes(1);
    release?.();
    await vi.waitFor(() => expect(h.deps.putDisplay).toHaveBeenCalledTimes(2));
    expect(maxActive).toBe(1);
  });

  it("the decode/encode module loads once, on first need", async () => {
    const h = harness();
    expect(h.loadEncode).not.toHaveBeenCalled();
    enqueueFill({ id: A, v: 1 });
    enqueueFill({ id: B, v: 1 });
    await vi.waitFor(() => expect(h.putDisplay).toHaveBeenCalledTimes(2));
    expect(h.loadEncode).toHaveBeenCalledTimes(1);
  });

  describe("crop box mutual exclusion", () => {
    it("a registered candidate is skipped (others proceed as usual) and processed after unregistering", async () => {
      const h = harness();
      const release = registerCropOpen(A);
      enqueueFill({ id: A, v: 1 });
      enqueueFill({ id: B, v: 1 });
      await vi.waitFor(() => expect(h.putDisplay).toHaveBeenCalledTimes(1));
      expect((h.putDisplay.mock.calls[0]![0] as { id: string }).id).toBe(B);
      await idle();
      expect(h.putDisplay).toHaveBeenCalledTimes(1);
      release();
      await vi.waitFor(() => expect(h.putDisplay).toHaveBeenCalledTimes(2));
      expect((h.putDisplay.mock.calls[1]![0] as { id: string }).id).toBe(A);
    });

    it("registering the same one twice needs two unregistrations before release", async () => {
      const h = harness();
      const first = registerCropOpen(A);
      const second = registerCropOpen(A);
      enqueueFill({ id: A, v: 1 });
      first();
      first();
      await idle();
      expect(h.putDisplay).not.toHaveBeenCalled();
      second();
      await vi.waitFor(() => expect(h.putDisplay).toHaveBeenCalledTimes(1));
    });
  });

  describe("server_busy", () => {
    it("retries once after backoff and finishes on success", async () => {
      const put = vi.fn().mockRejectedValueOnce(fail(409, "server_busy")).mockResolvedValue({});
      const h = harness({ putDisplay: put, backoffMs: 200 });
      enqueueFill({ id: A, v: 1 });
      await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
      expect(h.invalidate).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(h.invalidate).toHaveBeenCalledTimes(1));
    });

    it("doesn't block later candidates during backoff", async () => {
      const put = vi.fn(async ({ id }: { id: string }) => {
        if (id === A && put.mock.calls.filter(c => (c[0] as { id: string }).id === A).length === 1) throw fail(409, "server_busy");
        return {};
      });
      harness({ putDisplay: put, backoffMs: 80 });
      enqueueFill({ id: A, v: 1 });
      enqueueFill({ id: B, v: 1 });
      await vi.waitFor(() => expect(put.mock.calls.map(c => (c[0] as { id: string }).id)).toEqual([A, B]));
    });

    it("fails again -> recorded as failed, no more retries", async () => {
      const put = vi.fn(async () => Promise.reject(fail(409, "server_busy")));
      harness({ putDisplay: put });
      enqueueFill({ id: A, v: 1 });
      await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2));
      await idle();
      expect(put).toHaveBeenCalledTimes(2);
      expect(getQuotaFailed().size).toBe(0);
    });

    it("when the crop box is open at retry time, waits for it to close", async () => {
      let open: (() => void) | undefined;
      const gate = new Promise<void>(resolve => {
        open = resolve;
      });
      const put = vi
        .fn()
        .mockImplementationOnce(async () => {
          await gate;
          throw fail(409, "server_busy");
        })
        .mockResolvedValue({});
      harness({ putDisplay: put });
      enqueueFill({ id: A, v: 1 });
      await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
      const release = registerCropOpen(A);
      open?.();
      await idle();
      expect(put).toHaveBeenCalledTimes(1);
      release();
      await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    });
  });

  it("avatar_outdated: invalidates the cache, no quota failure recorded, same version not retried; a new version is processed as usual", async () => {
    const put = vi.fn().mockRejectedValueOnce(fail(409, "avatar_outdated")).mockResolvedValue({});
    const h = harness({ putDisplay: put });
    enqueueFill({ id: A, v: 1 });
    await vi.waitFor(() => expect(h.invalidate).toHaveBeenCalledTimes(1));
    await idle();
    expect(put).toHaveBeenCalledTimes(1);
    expect(getQuotaFailed().size).toBe(0);
    enqueueFill({ id: A, v: 2 });
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2));
  });

  describe("crop box opened during backfill", () => {
    function gate() {
      let open: () => void = () => undefined;
      const promise = new Promise<void>(resolve => {
        open = resolve;
      });
      return { promise, open };
    }

    it("the one already running isn't sent either: put back in the queue, sent once after the crop box closes", async () => {
      const g = gate();
      const h = harness({
        fetchOriginal: vi.fn(async () => {
          await g.promise;
          return new Blob([new Uint8Array([9])], { type: "image/png" });
        }),
      });
      enqueueFill({ id: A, v: 1 });
      await vi.waitFor(() => expect(h.deps.fetchOriginal).toHaveBeenCalledTimes(1));
      const release = registerCropOpen(A);
      g.open();
      await idle();
      expect(h.putDisplay).not.toHaveBeenCalled();
      expect(h.invalidate).not.toHaveBeenCalled();
      release();
      await vi.waitFor(() => expect(h.putDisplay).toHaveBeenCalledTimes(1));
      await idle();
      expect(h.putDisplay).toHaveBeenCalledTimes(1);
    });
  });

  describe("avatar_outdated isn't a write", () => {
    it("doesn't requeue quota-failed items (nothing was written)", async () => {
      const put = vi.fn(async ({ id }: { id: string }) => {
        if (id === A) throw fail(409, "storage_quota_exceeded");
        throw fail(409, "avatar_outdated");
      });
      const h = harness({ putDisplay: put });
      enqueueFill({ id: A, v: 1 });
      await vi.waitFor(() => expect(getQuotaFailed().size).toBe(1));
      enqueueFill({ id: B, v: 1 });
      await vi.waitFor(() => expect(h.invalidate).toHaveBeenCalledTimes(1));
      await idle();
      expect(put).toHaveBeenCalledTimes(2);
      expect(getQuotaFailed().size).toBe(1);
    });
  });

  describe("dropQueuedFill", () => {
    it("queued, waiting-for-retry and quota-failed items are all dropped; other avatars unaffected", async () => {
      const g = gate2();
      const put = vi.fn(async ({ id }: { id: string }) => {
        if (id === "q") throw fail(409, "storage_quota_exceeded");
        if (id === "r") throw fail(409, "server_busy");
        return {};
      });
      const h = harness({
        putDisplay: put,
        backoffMs: 400,
        fetchOriginal: vi.fn(async (id: string) => {
          if (id === A) await g.promise;
          return new Blob([new Uint8Array([9])], { type: "image/png" });
        }),
      });
      enqueueFill({ id: "q", v: 1 });
      await vi.waitFor(() => expect(getQuotaFailed().size).toBe(1));
      enqueueFill({ id: "r", v: 1 });
      await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2));
      enqueueFill({ id: A, v: 1 });
      await vi.waitFor(() => expect(h.deps.fetchOriginal).toHaveBeenCalledTimes(3));
      enqueueFill({ id: B, v: 1 }); // queued behind the in-flight A
      dropQueuedFill("q", 1);
      dropQueuedFill("r", 1);
      dropQueuedFill(B, 1);
      expect(getQuotaFailed().size).toBe(0);
      g.open();
      await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(3));
      await idle();
      await idle();
      expect(put.mock.calls.map(c => (c[0] as { id: string }).id)).toEqual(["q", "r", A]);
    });

    it("only items with version <= v are dropped: newer versions stay", async () => {
      const h = harness();
      const release = registerCropOpen(A); // keeps A's item in the queue
      enqueueFill({ id: A, v: 1 });
      enqueueFill({ id: A, v: 2 });
      enqueueFill({ id: A, v: 3 });
      dropQueuedFill(A, 2);
      release();
      await vi.waitFor(() => expect(h.putDisplay).toHaveBeenCalledTimes(1));
      await idle();
      expect(h.putDisplay.mock.calls.map(c => (c[0] as { version: number }).version)).toEqual([3]);
    });

    function gate2() {
      let open: () => void = () => undefined;
      const promise = new Promise<void>(resolve => {
        open = resolve;
      });
      return { promise, open };
    }
  });

  describe("timeout", () => {
    it("reading the original hangs -> aborted on timeout, recorded as failed with no retry, later ones are processed as usual", async () => {
      const signals: (AbortSignal | undefined)[] = [];
      const h = harness({
        timeoutMs: 30,
        fetchOriginal: vi.fn((id: string, signal?: AbortSignal) => {
          signals.push(signal);
          if (id === B) return Promise.resolve(new Blob([new Uint8Array([9])], { type: "image/png" }));
          return new Promise<Blob>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason));
          });
        }),
      });
      enqueueFill({ id: A, v: 1 });
      enqueueFill({ id: B, v: 1 });
      await vi.waitFor(() => expect(h.putDisplay).toHaveBeenCalledTimes(1));
      expect((h.putDisplay.mock.calls[0]![0] as { id: string }).id).toBe(B);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      await idle();
      expect(h.deps.fetchOriginal).toHaveBeenCalledTimes(2);
      expect(getQuotaFailed().size).toBe(0);
    });

    it("sending the display image back also carries the timeout signal", async () => {
      const h = harness();
      enqueueFill({ id: A, v: 1 });
      await vi.waitFor(() => expect(h.putDisplay).toHaveBeenCalledTimes(1));
      expect((h.putDisplay.mock.calls[0]![0] as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe("clearFillerState (user switch)", () => {
    it("clears the queue and processed memory; the one already running has its result discarded when it finishes", async () => {
      let open: () => void = () => undefined;
      const gateP = new Promise<void>(resolve => {
        open = resolve;
      });
      const h = harness({
        fetchOriginal: vi.fn(async (id: string) => {
          if (id === A) await gateP;
          return new Blob([new Uint8Array([9])], { type: "image/png" });
        }),
      });
      enqueueFill({ id: A, v: 1 });
      await vi.waitFor(() => expect(h.deps.fetchOriginal).toHaveBeenCalledTimes(1));
      enqueueFill({ id: B, v: 1 });
      clearFillerState();
      open();
      await idle();
      expect(h.invalidate).not.toHaveBeenCalled();
      expect(h.putDisplay).not.toHaveBeenCalled(); // A had already fetched the original before the clear, but its result isn't submitted; B was cleared
      enqueueFill({ id: A, v: 1 });
      await vi.waitFor(() => expect(h.putDisplay).toHaveBeenCalledTimes(1));
    });
  });

  describe("PUT in flight at user switch", () => {
    it.each([
      ["storage_quota_exceeded"],
      ["server_busy"],
    ])("PUT returns %s: no quota failure recorded, no retry queued, no invalidation", async code => {
      let reject: (err: unknown) => void = () => undefined;
      const h = harness({
        backoffMs: 20,
        putDisplay: vi.fn(
          () =>
            new Promise<unknown>((_resolve, rej) => {
              reject = rej;
            }),
        ),
      });
      enqueueFill({ id: A, v: 1 });
      await vi.waitFor(() => expect(h.deps.putDisplay).toHaveBeenCalledTimes(1));
      clearFillerState();
      reject(fail(409, code));
      await idle();
      await idle();
      expect(getQuotaFailed().size).toBe(0);
      expect(h.fetchOriginal).toHaveBeenCalledTimes(1);
      expect(h.deps.putDisplay).toHaveBeenCalledTimes(1);
      expect(h.invalidate).not.toHaveBeenCalled();
    });
  });

  describe("syncFillerUser", () => {
    it("clears only when switching to a different user; the same user or not yet loaded (undefined) don't clear", async () => {
      const h = harness();
      const release = registerCropOpen(A);
      enqueueFill({ id: A, v: 1 });
      syncFillerUser(undefined);
      syncFillerUser("u-alice");
      syncFillerUser("u-alice");
      release();
      await vi.waitFor(() => expect(h.putDisplay).toHaveBeenCalledTimes(1));
      const again = registerCropOpen(B);
      enqueueFill({ id: B, v: 1 });
      syncFillerUser("u-bob");
      again();
      await idle();
      expect(h.putDisplay).toHaveBeenCalledTimes(1);
    });
  });

  describe("storage_quota_exceeded", () => {
    it("records the quota failure (keyed by (id, v)); requeues only after any avatar write succeeds", async () => {
      const put = vi.fn().mockRejectedValueOnce(fail(409, "storage_quota_exceeded")).mockResolvedValue({});
      const h = harness({ putDisplay: put });
      enqueueFill({ id: A, v: 1 });
      await vi.waitFor(() => expect(getQuotaFailed().has(fillKey({ id: A, v: 1 }))).toBe(true));
      await idle();
      expect(put).toHaveBeenCalledTimes(1);
      expect(h.invalidate).not.toHaveBeenCalled();
      notifyAvatarWritten();
      await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2));
      expect(getQuotaFailed().size).toBe(0);
    });

    it("subscribers are notified on record and on clear, and the snapshot is a new object", async () => {
      const { subscribeFiller } = await import("./display-filler");
      const put = vi.fn().mockRejectedValueOnce(fail(409, "storage_quota_exceeded")).mockResolvedValue({});
      harness({ putDisplay: put });
      const listener = vi.fn();
      const off = subscribeFiller(listener);
      const before = getQuotaFailed();
      enqueueFill({ id: A, v: 1 });
      await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
      expect(getQuotaFailed()).not.toBe(before);
      notifyAvatarWritten();
      expect(listener).toHaveBeenCalledTimes(2);
      off();
    });

    it("notifyAvatarWritten with no quota failure doesn't notify or queue anything", () => {
      const h = harness();
      notifyAvatarWritten();
      expect(h.fetchOriginal).not.toHaveBeenCalled();
    });

    it("a backfill's own success also counts as a write: clears other avatars' quota failures and requeues", async () => {
      const put = vi
        .fn()
        .mockRejectedValueOnce(fail(409, "storage_quota_exceeded"))
        .mockResolvedValue({});
      harness({ putDisplay: put });
      enqueueFill({ id: A, v: 1 });
      await vi.waitFor(() => expect(getQuotaFailed().size).toBe(1));
      enqueueFill({ id: B, v: 1 });
      await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(3));
      // A's put fails on quota, then B succeeds -> A requeued -> A succeeds: three puts in all.
      expect(put.mock.calls.map(c => (c[0] as { id: string }).id)).toEqual([A, B, A]);
    });
  });
});

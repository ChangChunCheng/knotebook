import { describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";

describe("EditingRuntime", () => {
  it("after installGlobals, window/document and the three rect polyfills exist, document.URL is baseUrl, and navigator is still Node's built-in getter", () => {
    const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
    rt.installGlobals();
    expect(typeof globalThis.document.createElement).toBe("function");
    expect(globalThis.document.URL).toBe("http://localhost/");
    expect(typeof Element.prototype.getBoundingClientRect).toBe("function");
    expect(typeof Range.prototype.getBoundingClientRect).toBe("function");
    expect(typeof Range.prototype.getClientRects).toBe("function");
    const d = Object.getOwnPropertyDescriptor(globalThis, "navigator")!;
    expect(typeof d.get).toBe("function"); // Node >= 21 getter-only built-in, not overridden with jsdom's value
    expect(d.value).toBeUndefined();
  });

  it("after installGlobals, new Anthropic() does not throw (dangerouslyAllowBrowser in upstream.ts blocks the browser sniffing)", () => {
    const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
    rt.installGlobals();
    expect(() => new Anthropic({ apiKey: "x" })).toThrow(/browser-like environment/); // without the flag it throws: pins that the sniffing is really triggered
    expect(() => new Anthropic({ apiKey: "x", dangerouslyAllowBrowser: true })).not.toThrow();
  });

  it("fake counter: the rebuildEvery-th mount marks a rebuild; deferred while there is an in-flight lease, rebuilt once it reaches zero", async () => {
    const rt = new EditingRuntime({ baseUrl: "http://localhost/", rebuildEvery: 2 });
    rt.installGlobals();
    const a = await rt.acquire();
    rt.noteMount();
    rt.noteMount();
    expect(rt.rebuildPending).toBe(true);
    expect(rt.rebuilds).toBe(0);
    a.release();
    expect(rt.rebuilds).toBe(1);
    expect(rt.rebuildPending).toBe(false);
  });

  it("after the flag is set, new sessions are blocked -> drain -> rebuild -> let through", async () => {
    const rt = new EditingRuntime({ baseUrl: "http://localhost/", rebuildEvery: 1 });
    rt.installGlobals();
    const a = await rt.acquire();
    rt.noteMount();
    let admitted = false;
    const pending = rt.acquire().then(l => {
      admitted = true;
      return l;
    });
    await new Promise(r => setImmediate(r));
    expect(admitted).toBe(false);
    a.release();
    const b = await pending;
    expect(admitted).toBe(true);
    expect(rt.rebuilds).toBe(1);
    b.release();
  });

  it("a heap increase over the limit also marks a rebuild (heapUsed reader injected)", async () => {
    let heap = 0;
    const rt = new EditingRuntime({ baseUrl: "http://localhost/", rebuildEvery: 1_000, heapGrowthLimit: 10, readHeapUsed: () => heap });
    rt.installGlobals();
    heap = 11;
    const a = await rt.acquire();
    rt.noteMount();
    a.release();
    expect(rt.rebuilds).toBe(1);
  });

  // When two leases are held, the one released first must not trigger the rebuild: once it leaves it would close the window the other is still
  // using. Rebuild only when in-flight really reaches zero (both released). Removing `|| this.inFlightCount > 0` in runtime.ts would
  // rebuild early at the a.release() step and fail this case.
  it("with two leases held, releasing one doesn't rebuild early; rebuild only after all are released", async () => {
    const rt = new EditingRuntime({ baseUrl: "http://localhost/", rebuildEvery: 1 });
    rt.installGlobals();
    const a = await rt.acquire();
    const b = await rt.acquire();
    rt.noteMount();
    expect(rt.rebuildPending).toBe(true);
    a.release();
    expect(rt.rebuilds).toBe(0);
    expect(rt.rebuildPending).toBe(true);
    b.release();
    expect(rt.rebuilds).toBe(1);
    expect(rt.rebuildPending).toBe(false);
  });

  // A rebuild is not just the counter jumping: the window must really be replaced and the old one really closed, otherwise the memory left
  // behind by mounts is never reclaimed (the point of this module). Removing installGlobals()/window.close() in runtime.ts would fail
  // this case.
  it("a rebuild really swaps the window and really closes the old one (not just the counter)", async () => {
    const rt = new EditingRuntime({ baseUrl: "http://localhost/", rebuildEvery: 1 });
    rt.installGlobals();
    const beforeDoc = globalThis.document;
    const beforeWindow = beforeDoc.defaultView!;
    const a = await rt.acquire();
    rt.noteMount();
    a.release();
    expect(globalThis.document).not.toBe(beforeDoc);
    // jsdom's window.close() doesn't set `closed` but does tear down window.document: that pins "really closed".
    expect(beforeWindow.document).toBeUndefined();
  });

  // If mountsSinceRebuild weren't reset, mounting again right after a rebuild would reach the threshold again from the leftover count and
  // wrongly judge pending. Removing `this.mountsSinceRebuild = 0` in runtime.ts would fail this case.
  it("after a rebuild mountsSinceRebuild is reset: mounting again right away doesn't trigger pending again", async () => {
    const rt = new EditingRuntime({ baseUrl: "http://localhost/", rebuildEvery: 2 });
    rt.installGlobals();
    const a = await rt.acquire();
    rt.noteMount();
    rt.noteMount();
    a.release();
    expect(rt.rebuildPending).toBe(false);
    rt.noteMount();
    expect(rt.rebuildPending).toBe(false);
  });

  // When installGlobals() throws on the rebuild path (simulated here via the readHeapUsed injection point), pending and waiters must still
  // be released, otherwise every later acquire() never settles (AI editing across the whole server stalls silently).
  it("installGlobals() throwing during a rebuild doesn't hang forever: pending is cleared, waiters are let through, the error is logged", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let throwOnRead = false;
      const rt = new EditingRuntime({
        baseUrl: "http://localhost/",
        rebuildEvery: 1,
        readHeapUsed: () => {
          if (throwOnRead) throw new Error("heap read boom");
          return 0;
        },
      });
      rt.installGlobals();
      const a = await rt.acquire();
      rt.noteMount();
      throwOnRead = true;
      a.release();
      expect(rt.rebuildPending).toBe(false);
      expect(rt.rebuilds).toBe(0);
      expect(consoleError).toHaveBeenCalledTimes(1);
      const raced = await Promise.race([
        rt.acquire().then(() => "acquired" as const),
        new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), 200)),
      ]);
      expect(raced).toBe("acquired");
    } finally {
      consoleError.mockRestore(); // restore console.error even if an assertion fails first, otherwise later tests' error output is swallowed
    }
  });
});

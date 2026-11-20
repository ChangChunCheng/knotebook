import { afterEach, describe, expect, it, vi } from "vitest";

// One fake document per case plus re-importing the module: the module attaches fullscreenchange to `document` once at load,
// and sharing the real document would let earlier cases' module instances keep receiving events (leftover state calls exitFullscreen extra times).
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

interface Deferred {
  resolve: () => void;
  reject: (err: unknown) => void;
}

function makeFakeDocument() {
  const listeners = new Set<() => void>();
  let request: Deferred | null = null;
  const exits: Deferred[] = [];
  const documentElement = {
    requestFullscreen: vi.fn(() => new Promise<void>((resolve, reject) => { request = { resolve, reject }; })),
  };
  const doc = {
    fullscreenEnabled: true,
    fullscreenElement: null as unknown,
    documentElement,
    addEventListener: (type: string, fn: () => void) => { if (type === "fullscreenchange") listeners.add(fn); },
    exitFullscreen: vi.fn(() => new Promise<void>((resolve, reject) => { exits.push({ resolve, reject }); })),
  };
  const fire = () => listeners.forEach((fn) => fn());
  return {
    doc,
    // Spec order: fullscreenchange, then resolve.
    async grantEventFirst() { doc.fullscreenElement = documentElement; fire(); request?.resolve(); request = null; await flush(); },
    async grantResolveFirst() { doc.fullscreenElement = documentElement; request?.resolve(); request = null; await flush(); fire(); await flush(); },
    async deny() { request?.reject(new TypeError("denied")); request = null; await flush(); },
    async completeExit() { doc.fullscreenElement = null; fire(); exits.shift()?.resolve(); await flush(); },
    async rejectExit() { exits.shift()?.reject(new TypeError("not in fullscreen")); await flush(); },
    async userExit() { doc.fullscreenElement = null; fire(); await flush(); },
    async otherEnters(el: unknown) { doc.fullscreenElement = el; fire(); await flush(); },
  };
}

async function load(fake: ReturnType<typeof makeFakeDocument>) {
  vi.stubGlobal("document", fake.doc);
  vi.resetModules();
  return import("./fullscreen");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("present/fullscreen", () => {
  it("requestFullscreen is called synchronously within the user event; after success isOwnedFullscreen is true", async () => {
    const fake = makeFakeDocument();
    const fs = await load(fake);
    fs.enterPresentationFullscreen();
    expect(fake.doc.documentElement.requestFullscreen).toHaveBeenCalledTimes(1);
    await fake.grantEventFirst();
    expect(fs.isOwnedFullscreen()).toBe(true);
  });

  it("no request when fullscreenEnabled is false, already fullscreen, or a request is pending", async () => {
    const fake = makeFakeDocument();
    const fs = await load(fake);
    fake.doc.fullscreenEnabled = false;
    fs.enterPresentationFullscreen();
    fake.doc.fullscreenEnabled = true;
    fake.doc.fullscreenElement = {};
    fs.enterPresentationFullscreen();
    fake.doc.fullscreenElement = null;
    fs.enterPresentationFullscreen();
    fs.enterPresentationFullscreen();
    expect(fake.doc.documentElement.requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it("request rejected: owned and exitWanted both reset to false (elements entering fullscreen later aren't exited)", async () => {
    const fake = makeFakeDocument();
    const fs = await load(fake);
    fs.enterPresentationFullscreen();
    fs.exitOwnedFullscreen(); // Exit requested while pending -> exitWanted
    await fake.deny();
    expect(fs.isOwnedFullscreen()).toBe(false);
    await fake.otherEnters(fake.doc.documentElement);
    expect(fake.doc.exitFullscreen).not.toHaveBeenCalled();
  });

  it("exit during pending, and a video enters fullscreen before the request is rejected -> that video isn't exited (only the whole document we asked for is handled)", async () => {
    const fake = makeFakeDocument();
    const fs = await load(fake);
    fs.enterPresentationFullscreen();
    fs.exitOwnedFullscreen(); // Exit requested while pending -> exitWanted
    await fake.otherEnters({ tagName: "VIDEO" });
    await fake.deny();
    expect(fake.doc.exitFullscreen).not.toHaveBeenCalled();
  });

  it("doesn't exit a fullscreen this module didn't request (a video's own fullscreen)", async () => {
    const fake = makeFakeDocument();
    const fs = await load(fake);
    await fake.otherEnters({ tagName: "VIDEO" });
    fs.exitOwnedFullscreen();
    expect(fake.doc.exitFullscreen).not.toHaveBeenCalled();
    expect(fs.isOwnedFullscreen()).toBe(false);
  });

  it("someone else fullscreens the whole document (not requested by this module) -> owned is false, exitOwnedFullscreen doesn't exit", async () => {
    const fake = makeFakeDocument();
    const fs = await load(fake);
    await fake.otherEnters(fake.doc.documentElement);
    expect(fs.isOwnedFullscreen()).toBe(false);
    fs.exitOwnedFullscreen();
    expect(fake.doc.exitFullscreen).not.toHaveBeenCalled();
  });

  it.each(["grantEventFirst", "grantResolveFirst"] as const)("exit during pending, %s -> exitFullscreen exactly once", async (order) => {
    const fake = makeFakeDocument();
    const fs = await load(fake);
    fs.enterPresentationFullscreen();
    fs.exitOwnedFullscreen();
    expect(fake.doc.exitFullscreen).not.toHaveBeenCalled(); // Can't exit while pending (it would reject, and the request takes effect anyway)
    await fake[order]();
    expect(fake.doc.exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it("exit during pending twice -> still exits only once", async () => {
    const fake = makeFakeDocument();
    const fs = await load(fake);
    fs.enterPresentationFullscreen();
    fs.exitOwnedFullscreen();
    fs.exitOwnedFullscreen();
    await fake.grantResolveFirst();
    expect(fake.doc.exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it("exitFullscreen rejecting leaves no unhandled rejection", async () => {
    const fake = makeFakeDocument();
    const fs = await load(fake);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      fs.enterPresentationFullscreen();
      await fake.grantEventFirst();
      fs.exitOwnedFullscreen();
      await fake.rejectExit();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("after a pending exit completes, another element entering fullscreen -> no exit call (regression for a leftover exitWanted)", async () => {
    const fake = makeFakeDocument();
    const fs = await load(fake);
    fs.enterPresentationFullscreen();
    fs.exitOwnedFullscreen();
    await fake.grantResolveFirst();
    await fake.completeExit();
    expect(fake.doc.exitFullscreen).toHaveBeenCalledTimes(1);
    await fake.otherEnters({ tagName: "VIDEO" });
    expect(fake.doc.exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it("msSinceFullscreenExit: Infinity if it never exited; a small finite number after an exit event", async () => {
    const fake = makeFakeDocument();
    const fs = await load(fake);
    expect(fs.msSinceFullscreenExit()).toBe(Infinity);
    fs.enterPresentationFullscreen();
    await fake.grantEventFirst();
    await fake.userExit();
    expect(fs.msSinceFullscreenExit()).toBeLessThan(1000);
  });

  it("subscribeFullscreen: notifies after the state is updated; no notification after unsubscribing", async () => {
    const fake = makeFakeDocument();
    const fs = await load(fake);
    const seen: boolean[] = [];
    const unsubscribe = fs.subscribeFullscreen(() => seen.push(fs.isOwnedFullscreen()));
    fs.enterPresentationFullscreen();
    await fake.grantEventFirst();
    await fake.userExit();
    unsubscribe();
    await fake.otherEnters({});
    expect(seen).toEqual([true, false]);
  });

  it("subscribeFullscreen: when the exit event notifies, msSinceFullscreenExit is already finite (the fake changes fullscreenElement first)", async () => {
    const fake = makeFakeDocument();
    const fs = await load(fake);
    const seen: number[] = [];
    fs.subscribeFullscreen(() => seen.push(fs.msSinceFullscreenExit()));
    fs.enterPresentationFullscreen();
    await fake.grantEventFirst();
    expect(seen).toEqual([Infinity]); // Enter event: hasn't exited yet
    await fake.userExit();
    expect(seen).toHaveLength(2);
    expect(Number.isFinite(seen[1])).toBe(true);
  });
});

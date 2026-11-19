import { afterEach, describe, expect, it, vi } from "vitest";
import { createLinkConversion, type LinkConversionDeps } from "../../src/notes/link-conversion.js";

// stop() never rejects: if a rejection took down the Promise.race in the SIGTERM chain, it would skip collab.destroy() (dropping people's
// pending edits). Here `running` itself rejects (log.info and log.error both throw), and stop() must still resolve.
describe("#269 createLinkConversion().stop()", () => {
  afterEach(() => vi.useRealTimers());

  it("when the in-flight round ends in a rejection, stop() still resolves (never rejects)", async () => {
    vi.useFakeTimers();
    const boom = () => {
      throw new Error("log boom");
    };
    const deps = { db: {}, writes: {}, versions: {}, siteOrigin: "http://kb.test", log: { info: boom, warn: boom, error: boom } } as unknown as LinkConversionDeps;
    const lc = createLinkConversion(deps, { startDelayMs: 0 });
    lc.start();
    vi.advanceTimersByTime(0); // fires the timer: running exists but hasn't settled
    const stopped = lc.stop(); // attach the handler in the same synchronous section: the rejection of running doesn't become unhandled
    await expect(stopped).resolves.toBeUndefined();
  });

  it("stop before starting: resolves, and a timer started afterwards no longer runs", async () => {
    vi.useFakeTimers();
    const info = vi.fn();
    const deps = { db: {}, writes: {}, versions: {}, siteOrigin: "http://kb.test", log: { info, warn: vi.fn(), error: vi.fn() } } as unknown as LinkConversionDeps;
    const lc = createLinkConversion(deps, { startDelayMs: 1_000 });
    lc.start();
    await expect(lc.stop()).resolves.toBeUndefined();
    vi.advanceTimersByTime(5_000);
    expect(info).not.toHaveBeenCalled();
  });
});

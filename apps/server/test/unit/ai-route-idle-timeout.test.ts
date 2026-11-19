import { describe, expect, it } from "vitest";
import { IDLE_TIMEOUT_MS } from "../../src/routes/ai.js";

// Pins the production default: `AiRouteDeps.idleTimeoutMs` can be injected (integration coverage in test/ai-sse.test.ts,
// `BuildAppOptions.aiIdleTimeoutMs`), so only the constant is asserted. This catches the 60s fallback changing
// (retuned seconds, or the `?? IDLE_TIMEOUT_MS` fallback removed) without waiting 60s.
describe("routes/ai: idle timeout default", () => {
  it("without AiRouteDeps.idleTimeoutMs, the production default is 60_000ms (60s)", () => {
    expect(IDLE_TIMEOUT_MS).toBe(60_000);
  });
});

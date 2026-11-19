import { describe, expect, it } from "vitest";
import { COLLAB_RESTART_DELAYS_MS, COLLAB_RESTART_JITTER, COLLAB_TOKEN_RETRY_DELAYS_MS } from "@knotebook/shared";
import { DELETING_GATE_TTL_MS } from "../../src/collab/hooks-impl.js";

/**
 * The deleting gate's TTL and the client's restart backoff form a cross-package coupling contract (#35).
 *
 * The gate is how the server tells someone who could see the note at deletion time that it was deleted: once the transaction commits the row
 * is gone and `resolveRole` returns only 'none', and that path tells the user "you lost access" (the wrong message #35 fixes). So the gate
 * must outlive the time a reconnecting tab takes to knock again.
 *
 * Raising the last `COLLAB_RESTART_DELAYS_MS` entry (or lowering the TTL) would break this silently; the symptom is only users occasionally
 * seeing the wrong message. This test catches that.
 */
describe("deleting gate TTL vs client restart backoff (cross-package invariant)", () => {
  const worstRestartDelay = Math.max(...COLLAB_RESTART_DELAYS_MS) * (1 + COLLAB_RESTART_JITTER);

  it("TTL outlasts the client's longest restart backoff", () => {
    expect(DELETING_GATE_TTL_MS).toBeGreaterThan(worstRestartDelay);
  });

  it("TTL leaves headroom for a whole round of the token backoff table (reconnecting must first obtain a token before knocking)", () => {
    // Computed from the actual retry table in shared rather than a hand-copied number (a copied 7_500 drifts).
    const tokenRetryTail = COLLAB_TOKEN_RETRY_DELAYS_MS.reduce((sum, d) => sum + d, 0);
    expect(DELETING_GATE_TTL_MS).toBeGreaterThan(worstRestartDelay + tokenRetryTail);
  });
});

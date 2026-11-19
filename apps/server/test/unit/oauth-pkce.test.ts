/**
 * #132: PKCE S256 verification (`oauth/pkce.ts`). "Return false first when the lengths differ" is load-bearing:
 * `timingSafeEqual` **throws** on Buffers of different lengths instead of returning false.
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyPkce } from "../../src/oauth/pkce.js";

describe("verifyPkce", () => {
  it("a correct verifier passes", () => {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(verifyPkce(verifier, challenge)).toBe(true);
  });

  it("a wrong verifier doesn't pass", () => {
    const challenge = createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url");
    expect(verifyPkce(randomBytes(32).toString("base64url"), challenge)).toBe(false);
  });

  // Load-bearing case: without the length pre-check this throws instead of returning false.
  it("a challenge of different length returns false instead of throwing", () => {
    const verifier = randomBytes(32).toString("base64url");
    expect(() => verifyPkce(verifier, "short")).not.toThrow();
    expect(verifyPkce(verifier, "short")).toBe(false);
  });

  // The standard base64 form (with +/=) and base64url are different strings: a client sending the wrong encoding must be rejected, not matched loosely.
  it("a challenge encoded with base64 (not url-safe) -> doesn't pass", () => {
    const verifier = randomBytes(32).toString("base64url");
    const std = createHash("sha256").update(verifier).digest("base64");
    const url = createHash("sha256").update(verifier).digest("base64url");
    if (std !== url) expect(verifyPkce(verifier, std)).toBe(false);
  });
});

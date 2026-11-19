import { createHash, timingSafeEqual } from "node:crypto";

/** PKCE S256. A length mismatch must return false first: `timingSafeEqual` throws on different lengths. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  const actual = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const expected = Buffer.from(challenge);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

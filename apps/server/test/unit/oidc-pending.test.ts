import { describe, expect, it } from "vitest";
import { OIDC_PENDING_MAX_COOKIE_BYTES, newPendingId, pendingCookieBytes, sealPendingLink, sealPendingLinkWithinLimit, unsealPendingLink, type PendingLinkPayload } from "../../src/auth/oidc-pending.js";
import { unsealOidcState } from "../../src/auth/oidc-state.js";
import { sealCookieJson } from "../../src/auth/sealed-cookie.js";

const S = "a".repeat(64);
const NOW = 1_790_000_000;
/** Everything else at its limit: issuer 512, sub 255, email 254, three ids of 36, pendingId 22. */
function worst(next?: string): PendingLinkPayload {
  return {
    pendingId: newPendingId(),
    issuer: "https://" + "i".repeat(504),
    sub: "s".repeat(255),
    providerId: "11111111-1111-1111-1111-111111111111",
    userId: "22222222-2222-2222-2222-222222222222",
    email: "e".repeat(242) + "@example.com",
    exp: NOW + 900,
    ...(next !== undefined ? { next } : {}),
  };
}

describe("pending-link cookie (#187)", () => {
  it("round-trips; pendingId is 22-char base64url (128 bit); exp <= now -> null; tampering -> null; a next of the wrong type -> null", () => {
    const p = worst("/n/alice/x");
    expect(p.pendingId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const sealed = sealPendingLink(S, p);
    expect(unsealPendingLink(S, sealed, NOW)).toEqual(p);
    expect(unsealPendingLink(S, sealed, p.exp)).toBeNull();
    // Tamper: deterministically replace the first base64url character of ct (`slice(0,-2)+"AA"` has about a 1/256 chance of being no change).
    const [ivPart, ctPart, tagPart] = sealed.split(".");
    const flipped = (ctPart![0] === "A" ? "B" : "A") + ctPart!.slice(1);
    expect(unsealPendingLink(S, `${ivPart}.${flipped}.${tagPart}`, NOW)).toBeNull();
    expect(unsealPendingLink(S, sealPendingLink(S, { ...p, next: 7 as unknown as string }), NOW)).toBeNull();
    expect(unsealPendingLink(S, sealPendingLink(S, { ...p, userId: undefined as unknown as string }), NOW)).toBeNull();
  });

  it("namespace isolation: ciphertext of the state cookie can't be used as pending, and vice versa", () => {
    // Seal directly with sealCookieJson under the "oidc-state" namespace (byte-for-byte the same shape as sealOidcState): not tied to the type of
    // OidcStatePayload, so this file needn't change when the state payload gains a required field.
    const state = sealCookieJson(S, "oidc-state", { state: "a", nonce: "b", codeVerifier: "c", exp: NOW + 600 });
    expect(unsealPendingLink(S, state, NOW)).toBeNull();
    expect(unsealOidcState(S, sealPendingLink(S, worst()), NOW)).toBeNull();
    // Load-bearing: seal a fully populated pending payload under the "oidc-state" namespace; only the namespace blocks it.
    // The two checks above also return null if pending's NAMESPACE were changed to "oidc-state" (it decrypts but the field check rejects it), so they don't prove isolation.
    expect(unsealPendingLink(S, sealCookieJson(S, "oidc-state", worst()), NOW)).toBeNull();
  });

  it("size guard 1: next 2048 + everything else at its limit -> next is dropped, name=value < 3800", () => {
    const next = "/" + "a".repeat(2047);
    const r = sealPendingLinkWithinLimit(S, worst(next));
    expect(r).not.toBeNull();
    expect(r!.droppedNext).toBe(true);
    expect(unsealPendingLink(S, r!.sealed, NOW)!.next).toBeUndefined();
    expect(pendingCookieBytes(r!.sealed)).toBeLessThan(OIDC_PENDING_MAX_COOKIE_BYTES);
  });

  it("size guard 2: next 1500 (just fits) + everything else at its limit -> next really lands in the cookie, and name=value < 3800", () => {
    const next = "/" + "a".repeat(1499);
    const r = sealPendingLinkWithinLimit(S, worst(next));
    expect(r!.droppedNext).toBe(false);
    // Pin first that it really went in: otherwise if next were dropped the next upper bound would look even greener.
    expect(unsealPendingLink(S, r!.sealed, NOW)!.next).toBe(next);
    expect(pendingCookieBytes(r!.sealed)).toBeLessThan(OIDC_PENDING_MAX_COOKIE_BYTES);
  });

  it("defence in depth: still over after dropping next (e.g. an issuer of 6000 characters, which normally can't happen) -> null (not sealed)", () => {
    expect(sealPendingLinkWithinLimit(S, { ...worst("/x"), issuer: "https://" + "i".repeat(6000) })).toBeNull();
  });
});

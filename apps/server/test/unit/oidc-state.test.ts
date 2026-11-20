import { describe, it, expect } from "vitest";
import {
  OIDC_STATE_TTL_SECONDS,
  OIDC_STATE_COOKIE_PATH,
  sealOidcState,
  unsealOidcState,
  type OidcStateBase,
  type OidcStatePayload,
} from "../../src/auth/oidc-state.js";
import { sealCookieJson } from "../../src/auth/sealed-cookie.js";

const secret = "a".repeat(64);

/** #187: the payload carries new required fields. The override type deliberately accepts only the base fields and next, so it needn't change when intent grows to two forms. */
function payload(overrides: Partial<OidcStateBase> & { next?: string } = {}): OidcStatePayload {
  return {
    state: "state-abc",
    nonce: "nonce-xyz",
    codeVerifier: "verifier-123",
    exp: 1_000_000 + OIDC_STATE_TTL_SECONDS,
    providerId: "p1",
    configVersion: 1,
    intent: "login",
    ...overrides,
  };
}

/** `OidcStatePayload` is a union (the prove form has no next): read next only through this narrowing helper. */
function nextOf(p: OidcStatePayload | null): string | undefined {
  return p !== null && p.intent === "login" ? p.next : undefined;
}

describe("auth/oidc-state: seal/unseal of the OIDC state cookie (AES-256-GCM, exp verified on the server)", () => {
  it("OIDC_STATE_TTL_SECONDS is 600 (10 minutes)", () => {
    expect(OIDC_STATE_TTL_SECONDS).toBe(600);
  });

  it("OIDC_STATE_COOKIE_PATH is /api/auth/oidc", () => {
    expect(OIDC_STATE_COOKIE_PATH).toBe("/api/auth/oidc");
  });

  it("round-trips (seal -> unseal gives the same payload)", () => {
    const p = payload();
    const sealed = sealOidcState(secret, p);
    expect(unsealOidcState(secret, sealed, 1_000_000)).toEqual(p);
  });

  it("exp clearly before now (payload.exp < now) -> null", () => {
    const p = payload({ exp: 1_000_000 });
    const sealed = sealOidcState(secret, p);
    expect(unsealOidcState(secret, sealed, 1_000_601)).toBeNull();
  });

  it("exp exactly equal to now (<= boundary) -> treated as expired, null", () => {
    const p = payload({ exp: 1_000_000 });
    const sealed = sealOidcState(secret, p);
    expect(unsealOidcState(secret, sealed, 1_000_000)).toBeNull();
  });

  it("exp not reached (now below exp) -> the payload is returned normally", () => {
    const p = payload({ exp: 1_000_100 });
    const sealed = sealOidcState(secret, p);
    expect(unsealOidcState(secret, sealed, 1_000_099)).toEqual(p);
  });

  it("tampered ciphertext (flip one bit of ct) -> null", () => {
    const sealed = sealOidcState(secret, payload());
    const [ivPart, ctPart, tagPart] = sealed.split(".");
    const ctBytes = Buffer.from(ctPart ?? "", "base64url");
    ctBytes[0] = (ctBytes[0] ?? 0) ^ 0xff;
    const tampered = `${ivPart}.${ctBytes.toString("base64url")}.${tagPart}`;
    expect(unsealOidcState(secret, tampered, 1_000_000)).toBeNull();
  });

  it("tampered tag (replace the tag) -> null", () => {
    const sealed = sealOidcState(secret, payload());
    const [ivPart, ctPart, tagPart] = sealed.split(".");
    const tagBytes = Buffer.from(tagPart ?? "", "base64url");
    tagBytes[0] = (tagBytes[0] ?? 0) ^ 0xff;
    const tampered = `${ivPart}.${ctPart}.${tagBytes.toString("base64url")}`;
    expect(unsealOidcState(secret, tampered, 1_000_000)).toBeNull();
  });

  it("garbage string (wrong format entirely) -> null, doesn't throw", () => {
    expect(unsealOidcState(secret, "not-a-sealed-value", 1_000_000)).toBeNull();
  });

  it("empty string -> null, doesn't throw", () => {
    expect(unsealOidcState(secret, "", 1_000_000)).toBeNull();
  });

  it("unseal with a different appSecret -> null", () => {
    const sealed = sealOidcState(secret, payload());
    expect(unsealOidcState("b".repeat(64), sealed, 1_000_000)).toBeNull();
  });

  it("iv differs every time (nonce isn't reused)", () => {
    const a = sealOidcState(secret, payload());
    const b = sealOidcState(secret, payload());
    expect(a.split(".")[0]).not.toBe(b.split(".")[0]);
  });
});

// This file already has a module-level `const secret = "a".repeat(64)` and a `payload(overrides)` factory (exp is 1_000_000 + OIDC_STATE_TTL_SECONDS):
// reuse them, don't declare same-named variables. now is always passed as 1_000_000 (copied from the existing cases); passing Date.now() would be
// expired immediately and turn the whole group red.
describe("#131 the next field", () => {
  it("sealed with next -> unsealed verbatim identical", () => {
    const sealed = sealOidcState(secret, payload({ next: "/n/alice/my-note?x=1" }));
    expect(nextOf(unsealOidcState(secret, sealed, 1_000_000))).toBe("/n/alice/my-note?x=1");
  });

  it("without next -> unsealed as undefined (the field is optional, not an empty string)", () => {
    const sealed = sealOidcState(secret, payload());
    const opened = unsealOidcState(secret, sealed, 1_000_000);
    expect(opened).not.toBeNull();
    // Pin first that it is the login form: otherwise nextOf also returns undefined for the prove form and this case would pass vacuously.
    expect(opened?.intent).toBe("login");
    expect(nextOf(opened)).toBeUndefined();
  });

  it("next of the wrong type (a number) -> the whole payload is invalid (type guard, not an as-cast)", () => {
    // Sealing guarantees "we sealed this", not that the field types are right: the unsealed payload is used as an OidcStatePayload,
    // so every field has to be really checked.
    const sealed = sealOidcState(secret, { ...payload(), next: 42 } as unknown as OidcStatePayload);
    expect(unsealOidcState(secret, sealed, 1_000_000)).toBeNull();
  });

  it("next is null -> also invalid (typeof null is object, not an undefined that slipped through)", () => {
    const sealed = sealOidcState(secret, { ...payload(), next: null } as unknown as OidcStatePayload);
    expect(unsealOidcState(secret, sealed, 1_000_000)).toBeNull();
  });
});

describe("#187 new required fields (providerId/configVersion/intent)", () => {
  // Three cases each missing one field with the rest complete, so removing a single check turns the matching case red (the old format missing all three fields is blocked by any one check, so on its own it can't tell the checks apart).
  it("missing providerId -> null; the old format sealed before deployment (all three fields missing) -> null", () => {
    expect(unsealOidcState(secret, sealCookieJson(secret, "oidc-state", { ...payload(), providerId: undefined }), 1_000_000)).toBeNull();
    const old = sealCookieJson(secret, "oidc-state", { state: "s", nonce: "n", codeVerifier: "v", exp: 1_000_600 });
    expect(unsealOidcState(secret, old, 1_000_000)).toBeNull();
  });

  it("configVersion is not an integer (1.5, the string '1') -> null", () => {
    for (const configVersion of [1.5, "1"]) {
      expect(unsealOidcState(secret, sealCookieJson(secret, "oidc-state", { ...payload(), configVersion }), 1_000_000)).toBeNull();
    }
  });

  it("intent link: with linkUserId -> accepted; missing linkUserId or not a string -> null; a next that is passed is dropped", () => {
    const base = { ...payload(), intent: "link" };
    expect(unsealOidcState(secret, sealCookieJson(secret, "oidc-state", base), 1_000_000)).toBeNull();
    expect(unsealOidcState(secret, sealCookieJson(secret, "oidc-state", { ...base, linkUserId: 7 }), 1_000_000)).toBeNull();
    const opened = unsealOidcState(secret, sealCookieJson(secret, "oidc-state", { ...base, linkUserId: "u1", next: "/x" }), 1_000_000);
    expect(opened).toMatchObject({ intent: "link", linkUserId: "u1" });
    expect(opened).not.toHaveProperty("next");
  });

  it("intent link also verifies exp", () => {
    const expired = { ...payload({ exp: 999_999 }), intent: "link", linkUserId: "u1" };
    expect(unsealOidcState(secret, sealCookieJson(secret, "oidc-state", expired), 1_000_000)).toBeNull();
  });
});

describe("#187: prove form", () => {
  /** A prove payload with all fields; overriding with `undefined` means "this field is missing" (JSON.stringify drops it). */
  const prove = (over: Record<string, unknown> = {}) => ({
    state: "s", nonce: "n", codeVerifier: "v", exp: 1_000_600, providerId: "p1", configVersion: 1,
    intent: "prove", pendingId: "pid-1", proveUserId: "u1", ...over,
  });

  it("prove form round-trips: pendingId and proveUserId unchanged", () => {
    const sealed = sealOidcState(secret, {
      state: "s", nonce: "n", codeVerifier: "v", exp: 1_000_600, providerId: "p1", configVersion: 1,
      intent: "prove", pendingId: "pid-1", proveUserId: "u1",
    });
    expect(unsealOidcState(secret, sealed, 1_000_000)).toEqual(prove());
  });

  it("prove missing pendingId -> null; missing proveUserId -> null", () => {
    expect(unsealOidcState(secret, sealCookieJson(secret, "oidc-state", prove({ pendingId: undefined })), 1_000_000)).toBeNull();
    expect(unsealOidcState(secret, sealCookieJson(secret, "oidc-state", prove({ proveUserId: undefined })), 1_000_000)).toBeNull();
  });

  it("prove with next isn't adopted either: the unsealed object has no next key (next stays in the pending cookie)", () => {
    const opened = unsealOidcState(secret, sealCookieJson(secret, "oidc-state", prove({ next: "/n/alice/x" })), 1_000_000);
    expect(opened).not.toBeNull();
    expect(opened!.intent).toBe("prove");
    expect("next" in opened!).toBe(false);
  });
});

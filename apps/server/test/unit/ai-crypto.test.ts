import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  AiKeyDecryptError,
  decryptApiKey,
  encryptApiKey,
  type EncryptedApiKey,
} from "../../src/ai/crypto.js";

const secret = "a".repeat(64);
const PROVIDER_A = "a1b2c3d4-1111-1111-1111-111111111111";
const PROVIDER_B = "b1b2c3d4-2222-2222-2222-222222222222";

describe("ai/crypto: API key encryption at rest", () => {
  it("round-trips", () => {
    const payload = encryptApiKey(secret, "sk-super-secret-key", PROVIDER_A);
    expect(decryptApiKey(secret, payload, PROVIDER_A)).toBe("sk-super-secret-key");
  });

  it("keyId is a hash fingerprint of the derived key, not a fragment of the key itself", () => {
    const payload = encryptApiKey(secret, "sk-x", PROVIDER_A);
    const derivedKeyHex = createHash("sha256").update(`${secret}:ai-key`).digest("hex");
    expect(payload.keyId).not.toBe(derivedKeyHex.slice(0, 8));
  });

  it("iv differs on every call (nonce is never reused)", () => {
    const a = encryptApiKey(secret, "sk-x", PROVIDER_A);
    const b = encryptApiKey(secret, "sk-x", PROVIDER_A);
    expect(a.iv).not.toBe(b.iv);
  });

  it("iv is 12 bytes (after base64 decoding)", () => {
    const payload = encryptApiKey(secret, "sk-x", PROVIDER_A);
    expect(Buffer.from(payload.iv, "base64")).toHaveLength(12);
  });

  it("wrong secret (keyId mismatch) -> rejected early with AiKeyDecryptError", () => {
    const payload = encryptApiKey(secret, "sk-x", PROVIDER_A);
    expect(() => decryptApiKey("b".repeat(64), payload, PROVIDER_A)).toThrow(AiKeyDecryptError);
  });

  it("same secret but tampered ciphertext (GCM tag check fails) -> same AiKeyDecryptError type", () => {
    const payload = encryptApiKey(secret, "sk-x", PROVIDER_A);
    const ctBytes = Buffer.from(payload.ct, "base64");
    ctBytes[0] = (ctBytes[0] ?? 0) ^ 0xff;
    const tampered = { ...payload, ct: ctBytes.toString("base64") };
    expect(() => decryptApiKey(secret, tampered, PROVIDER_A)).toThrow(AiKeyDecryptError);
  });

  it("tampered tag -> AiKeyDecryptError", () => {
    const payload = encryptApiKey(secret, "sk-x", PROVIDER_A);
    const tagBytes = Buffer.from(payload.tag, "base64");
    tagBytes[0] = (tagBytes[0] ?? 0) ^ 0xff;
    const tampered = { ...payload, tag: tagBytes.toString("base64") };
    expect(() => decryptApiKey(secret, tampered, PROVIDER_A)).toThrow(AiKeyDecryptError);
  });

  // The payload comes from a DB jsonb column; ai/runtime.ts casts it from `unknown` with `as EncryptedApiKey`,
  // so the static type can't guarantee the runtime shape. Bad data must throw `AiKeyDecryptError` (not a bare TypeError),
  // otherwise it escapes the type contract and `selfCheckAiKeys` would crash server startup (see the matching note in crypto.ts).
  describe("payload is not an object (must throw AiKeyDecryptError, never a bare TypeError)", () => {
    it.each([
      ["null", null],
      ["string", "not-an-object"],
      ["number", 42],
    ])("payload=%s -> throws AiKeyDecryptError", (_label, badPayload) => {
      expect(() => decryptApiKey(secret, badPayload as unknown as EncryptedApiKey, PROVIDER_A)).toThrow(AiKeyDecryptError);
    });
  });

  // `v` is unauthenticated metadata: GCM ignores it, so `{ ...payload, v: 3 }` would decrypt fine and silently accept ciphertext
  // that claims an unknown future format version. Any `v` other than 1 or 2 must be a decrypt failure.
  it("v is not 1 or 2 (e.g. an unknown future format version) -> AiKeyDecryptError, never decrypts silently", () => {
    const payload = encryptApiKey(secret, "sk-x", PROVIDER_A);
    const badVersion = { ...payload, v: 3 } as unknown as EncryptedApiKey;
    expect(() => decryptApiKey(secret, badVersion, PROVIDER_A)).toThrow(AiKeyDecryptError);
  });
});

describe("ciphertext is bound to providerId (AAD, issue #14)", () => {
  it("writes v2", () => {
    expect(encryptApiKey(secret, "sk-x", PROVIDER_A).v).toBe(2);
  });

  it("ciphertext moved to another provider's row cannot be decrypted", () => {
    const payload = encryptApiKey(secret, "sk-super-secret-key", PROVIDER_A);
    expect(decryptApiKey(secret, payload, PROVIDER_A)).toBe("sk-super-secret-key");
    expect(() => decryptApiKey(secret, payload, PROVIDER_B)).toThrow(AiKeyDecryptError);
  });

  it("a one-character difference in providerId breaks decryption (AAD is verified byte for byte)", () => {
    const payload = encryptApiKey(secret, "sk-x", PROVIDER_A);
    expect(() => decryptApiKey(secret, payload, `${PROVIDER_A} `)).toThrow(AiKeyDecryptError);
    expect(() => decryptApiKey(secret, payload, PROVIDER_A.toUpperCase())).toThrow(AiKeyDecryptError);
  });

  it("changing v from 2 to 1 does not bypass the binding (the GCM tag covers the AAD)", () => {
    // Attack surface: the v1 decrypt path deliberately passes no AAD, so an attacker could flip `v: 2` to `v: 1` to get
    // AAD-bound ciphertext decrypted without AAD. What stops it is GCM itself: the auth tag is computed over the AAD,
    // so decrypting without it fails. This pins that property so nobody loosens the check.
    const payload = encryptApiKey(secret, "sk-secret", PROVIDER_A);
    const downgraded = { ...payload, v: 1 as const };
    expect(() => decryptApiKey(secret, downgraded, PROVIDER_B)).toThrow(AiKeyDecryptError);
    // Even the correct providerId fails: the v1 path never passes AAD.
    expect(() => decryptApiKey(secret, downgraded, PROVIDER_A)).toThrow(AiKeyDecryptError);
  });

  it("v is the string '2' (bad DB data) -> rejected, not coerced to the number 2", () => {
    const payload = encryptApiKey(secret, "sk-x", PROVIDER_A);
    const weird = { ...payload, v: "2" } as unknown as EncryptedApiKey;
    expect(() => decryptApiKey(secret, weird, PROVIDER_A)).toThrow(AiKeyDecryptError);
  });

  it("v1 ciphertext (written before providerId binding) still decrypts, and ignores providerId", () => {
    // Hand-build a v1 ciphertext (no AAD), as `encryptApiKey` did before issue #14.
    const key = createHash("sha256").update(`${secret}:ai-key`).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update("sk-legacy", "utf8"), cipher.final()]);
    const legacy: EncryptedApiKey = {
      v: 1,
      keyId: createHash("sha256").update(key).digest("hex").slice(0, 8),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ct: ct.toString("base64"),
    };

    // The legacy format has no binding, so any id decrypts; that is why `selfCheckAiKeys` upgrades it to v2 in place
    // instead of waiting for the user to re-enter the API key.
    expect(decryptApiKey(secret, legacy, PROVIDER_A)).toBe("sk-legacy");
    expect(decryptApiKey(secret, legacy, PROVIDER_B)).toBe("sk-legacy");
  });
});

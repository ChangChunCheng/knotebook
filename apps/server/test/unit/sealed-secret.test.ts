import { describe, expect, it } from "vitest";
import { SecretDecryptError, openSecret, sealSecret } from "../../src/lib/sealed-secret.js";
import { decryptApiKey, encryptApiKey } from "../../src/ai/crypto.js";

const S = "a".repeat(64);

describe("lib/sealed-secret (#187)", () => {
  it("round trip; format is the five fields of EncryptedApiKey v2 (v=2, keyId 8 hex, iv 12 bytes)", () => {
    const sealed = sealSecret(S, "oidc-client-secret", "s3cret", "oidc-client-secret:v1:p1");
    expect(Object.keys(sealed).sort()).toEqual(["ct", "iv", "keyId", "tag", "v"]);
    expect(sealed.v).toBe(2);
    expect(sealed.keyId).toMatch(/^[0-9a-f]{8}$/);
    expect(Buffer.from(sealed.iv, "base64")).toHaveLength(12);
    expect(openSecret(S, "oidc-client-secret", sealed, "oidc-client-secret:v1:p1")).toBe("s3cret");
  });

  it("AAD mismatch, namespace mismatch, different APP_SECRET, tampered ct, non-object, v != 2 -> SecretDecryptError", () => {
    const sealed = sealSecret(S, "ns", "x", "aad-1");
    expect(() => openSecret(S, "ns", sealed, "aad-2")).toThrow(SecretDecryptError);
    expect(() => openSecret(S, "other", sealed, "aad-1")).toThrow(SecretDecryptError);
    expect(() => openSecret("b".repeat(64), "ns", sealed, "aad-1")).toThrow(SecretDecryptError);
    const ct = Buffer.from(sealed.ct, "base64");
    ct[0] = ct[0]! ^ 1;
    expect(() => openSecret(S, "ns", { ...sealed, ct: ct.toString("base64") }, "aad-1")).toThrow(SecretDecryptError);
    expect(() => openSecret(S, "ns", null, "aad-1")).toThrow(SecretDecryptError);
    expect(() => openSecret(S, "ns", "str", "aad-1")).toThrow(SecretDecryptError);
    expect(() => openSecret(S, "ns", { ...sealed, v: 1 }, "aad-1")).toThrow(SecretDecryptError);
  });

  it("AI ciphertext format unchanged: encryptApiKey output opens with the sealSecret opener and vice versa", () => {
    const fromAi = encryptApiKey(S, "sk-test", "prov-1");
    expect(openSecret(S, "ai-key", fromAi, "ai-key:v2:prov-1")).toBe("sk-test");
    const fromGeneric = sealSecret(S, "ai-key", "sk-test-2", "ai-key:v2:prov-1");
    expect(decryptApiKey(S, fromGeneric, "prov-1")).toBe("sk-test-2");
  });
});

import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import type pino from "pino";
import { checkProviderKeys, createAiRuntime, type AiProviderRow } from "../../src/ai/runtime.js";
import { encryptApiKey, type EncryptedApiKey } from "../../src/ai/crypto.js";

const secret = "a".repeat(64);

/** Builds ciphertext in the pre-issue-#14 format (v1, no AAD). */
function legacyCiphertext(appSecret: string, plaintext: string): EncryptedApiKey {
  const key = createHash("sha256").update(`${appSecret}:ai-key`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    v: 1,
    keyId: createHash("sha256").update(key).digest("hex").slice(0, 8),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  };
}


function fakeLog(): pino.BaseLogger & { warn: ReturnType<typeof vi.fn> } {
  return {
    warn: vi.fn(),
  } as unknown as pino.BaseLogger & { warn: ReturnType<typeof vi.fn> };
}

function provider(overrides: Partial<AiProviderRow> = {}): AiProviderRow {
  return {
    id: "provider-1",
    name: "Test Provider",
    type: "openai_compatible",
    baseUrl: "https://api.example.com",
    apiKeyEncrypted: null,
    enabled: true,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("checkProviderKeys (pure function)", () => {
  it("api_key_encrypted NULL -> skipped, not degraded, not logged", () => {
    const runtime = createAiRuntime();
    const log = fakeLog();
    checkProviderKeys([provider({ apiKeyEncrypted: null })], secret, runtime, log);
    expect(runtime.degraded.size).toBe(0);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("enabled and decrypts fine -> not degraded", () => {
    const runtime = createAiRuntime();
    const log = fakeLog();
    const encrypted = encryptApiKey(secret, "sk-good-key", "provider-1");
    checkProviderKeys([provider({ apiKeyEncrypted: encrypted })], secret, runtime, log);
    expect(runtime.degraded.size).toBe(0);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("enabled but decryption fails (corrupt ciphertext) -> added to degraded; log.warn message carries the admin re-enter-API-key hint", () => {
    const runtime = createAiRuntime();
    const log = fakeLog();
    const encrypted = encryptApiKey(secret, "sk-good-key", "provider-broken");
    const tampered = { ...encrypted, keyId: "deadbeef" };
    checkProviderKeys([provider({ id: "provider-broken", apiKeyEncrypted: tampered })], secret, runtime, log);

    expect(runtime.degraded.has("provider-broken")).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [, msg] = log.warn.mock.calls[0] as [object, string];
    expect(msg).toContain("admin 後台重輸 API key");
  });

  it("disabled provider is not checked even with corrupt ciphertext, and not degraded", () => {
    const runtime = createAiRuntime();
    const log = fakeLog();
    const encrypted = encryptApiKey(secret, "sk-good-key", "provider-disabled");
    const tampered = { ...encrypted, keyId: "deadbeef" };
    checkProviderKeys([provider({ id: "provider-disabled", enabled: false, apiKeyEncrypted: tampered })], secret, runtime, log);

    expect(runtime.degraded.size).toBe(0);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("mixed rows: only the one that fails to decrypt is degraded, the rest are unaffected", () => {
    const runtime = createAiRuntime();
    const log = fakeLog();
    // Ciphertext is bound to providerId (issue #14): it only decrypts if it was encrypted for the row it sits in.
    const good = encryptApiKey(secret, "sk-good-key", "p-good");
    const bad = { ...good, keyId: "deadbeef" };

    checkProviderKeys(
      [
        provider({ id: "p-null", apiKeyEncrypted: null }),
        provider({ id: "p-good", apiKeyEncrypted: good }),
        provider({ id: "p-bad", apiKeyEncrypted: bad }),
        provider({ id: "p-disabled-bad", enabled: false, apiKeyEncrypted: bad }),
      ],
      secret,
      runtime,
      log
    );

    expect(runtime.degraded).toEqual(new Set(["p-bad"]));
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  // `apiKeyEncrypted` is `undefined` (not `null`): a `=== null` check would miss it and fall into `decryptApiKey`, reading
  // `payload.keyId` and throwing a bare TypeError (not AiKeyDecryptError), which the rethrow of non-AiKeyDecryptError errors
  // would then propagate out of the function.
  it("api_key_encrypted undefined (not null) -> same as NULL: skipped, not degraded, no throw", () => {
    const runtime = createAiRuntime();
    const log = fakeLog();
    expect(() => checkProviderKeys([provider({ apiKeyEncrypted: undefined })], secret, runtime, log)).not.toThrow();
    expect(runtime.degraded.size).toBe(0);
    expect(log.warn).not.toHaveBeenCalled();
  });

  // `apiKeyEncrypted` is entirely non-object bad data (hand-corrupted DB, or transitional data while the column format evolves):
  // it must take the degraded path. A bare TypeError from `decryptApiKey` must not escape `checkProviderKeys`, or one bad row would
  // take down the startup flow of its caller `selfCheckAiKeys`/`index.ts` (see the matching note in crypto.ts).
  it("api_key_encrypted is non-object bad data (a string) -> no throw, degraded + log.warn", () => {
    const runtime = createAiRuntime();
    const log = fakeLog();
    expect(() =>
      // schema.ts types apiKeyEncrypted with `.$type<EncryptedApiKey>()` (type only). This deliberately simulates runtime bad data
      // that the type forbids, so `as unknown as EncryptedApiKey` is needed to get past the compiler.
      checkProviderKeys([provider({ id: "provider-corrupt", apiKeyEncrypted: "not-an-object" as unknown as EncryptedApiKey })], secret, runtime, log)
    ).not.toThrow();
    expect(runtime.degraded.has("provider-corrupt")).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  // Ciphertext format version `v` is neither 1 nor 2 (e.g. ciphertext left by a future format, or a tampered version):
  // also takes the degraded path instead of being decrypted under version semantics that may not hold.
  it("api_key_encrypted with v other than 1 or 2 -> no throw, degraded + log.warn", () => {
    const runtime = createAiRuntime();
    const log = fakeLog();
    // The id must match the row's so the AAD matches; otherwise the row degrades because of the AAD mismatch and the test
    // would pass without exercising the version check.
    const encrypted = encryptApiKey(secret, "sk-good-key", "provider-bad-version");
    const badVersion = { ...encrypted, v: 3 };
    expect(() =>
      // `v: 3` is not a valid `EncryptedApiKey["v"]`; the cast simulates ciphertext left by a future format version.
      checkProviderKeys([provider({ id: "provider-bad-version", apiKeyEncrypted: badVersion as unknown as EncryptedApiKey })], secret, runtime, log)
    ).not.toThrow();
    expect(runtime.degraded.has("provider-bad-version")).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

describe("ciphertext upgrade scan (issue #14)", () => {
  it("v1 that decrypts -> goes into upgradableIds", () => {
    const runtime = createAiRuntime();
    const legacy = legacyCiphertext(secret, "sk-legacy");
    const { upgradableIds } = checkProviderKeys([provider({ id: "p-legacy", apiKeyEncrypted: legacy })], secret, runtime, fakeLog());
    expect(upgradableIds).toEqual(["p-legacy"]);
  });

  it("v2 must NOT go into upgradableIds (otherwise every boot rewrites all ciphertext for nothing)", () => {
    const runtime = createAiRuntime();
    const modern = encryptApiKey(secret, "sk-x", "p-modern");
    const { upgradableIds } = checkProviderKeys([provider({ id: "p-modern", apiKeyEncrypted: modern })], secret, runtime, fakeLog());
    expect(upgradableIds).toEqual([]);
  });

  it("undecryptable rows do not go into upgradableIds (bad data is not rewritten into something harder to recover)", () => {
    const runtime = createAiRuntime();
    const broken = { ...legacyCiphertext(secret, "sk-x"), keyId: "deadbeef" };
    const { upgradableIds } = checkProviderKeys([provider({ id: "p-broken", apiKeyEncrypted: broken })], secret, runtime, fakeLog());
    expect(upgradableIds).toEqual([]);
    expect(runtime.degraded.has("p-broken")).toBe(true);
  });

  it("disabled provider is still upgraded, but if it cannot decrypt it is neither degraded nor logged (two separate things)", () => {
    const runtime = createAiRuntime();
    const log = fakeLog();
    const legacy = legacyCiphertext(secret, "sk-legacy");
    const broken = { ...legacyCiphertext(secret, "sk-x"), keyId: "deadbeef" };

    const { upgradableIds } = checkProviderKeys(
      [
        provider({ id: "p-disabled-legacy", enabled: false, apiKeyEncrypted: legacy }),
        provider({ id: "p-disabled-broken", enabled: false, apiKeyEncrypted: broken }),
      ],
      secret,
      runtime,
      log
    );

    // A disabled but decryptable v1 must still be upgraded: leaving an AAD-less ciphertext would leave issue #14 half-fixed.
    expect(upgradableIds).toEqual(["p-disabled-legacy"]);
    expect(runtime.degraded.size).toBe(0);
    expect(log.warn).not.toHaveBeenCalled();
  });
});

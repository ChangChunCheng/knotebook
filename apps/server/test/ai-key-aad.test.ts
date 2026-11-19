import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type pino from "pino";
import { eq } from "drizzle-orm";
import { buildTestApp, testConfig } from "./helpers.js";
import { aiProviders } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { AiKeyDecryptError, decryptApiKey, encryptApiKey, type EncryptedApiKey } from "../src/ai/crypto.js";
import { createAiRuntime, selfCheckAiKeys } from "../src/ai/runtime.js";

/**
 * Covers the part of issue #14 (key ciphertext bound to providerId as AAD, v1 -> v2 migration) that crosses the DB;
 * pure crypto behaviour is in `test/unit/ai-crypto.test.ts`.
 */

/** Hand-built ciphertext in the pre-#14 format (v1, no AAD). */
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

function fakeLog(): pino.BaseLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), silent: vi.fn() } as unknown as pino.BaseLogger;
}

async function insertProviderWith(db: Db, id: string, apiKeyEncrypted: EncryptedApiKey) {
  await db.insert(aiProviders).values({
    id,
    name: `P-${id.slice(0, 8)}`,
    type: "openai_compatible",
    baseUrl: "http://localhost:9",
    apiKeyEncrypted,
  });
}

async function readEncrypted(db: Db, id: string): Promise<EncryptedApiKey> {
  const [row] = await db.select().from(aiProviders).where(eq(aiProviders.id, id));
  return row!.apiKeyEncrypted!;
}

describe("AI key ciphertext bound to providerId (issue #14)", () => {
  it("copying A's ciphertext row onto B's row -> B can't decrypt it (never silently uses A's key)", async () => {
    const { db } = await buildTestApp();
    const idA = randomUUID();
    const idB = randomUUID();

    await insertProviderWith(db, idA, encryptApiKey(testConfig.appSecret, "sk-victim-key", idA));
    // An attacker with DB write access moves A's ciphertext verbatim to B.
    await insertProviderWith(db, idB, await readEncrypted(db, idA));

    expect(decryptApiKey(testConfig.appSecret, await readEncrypted(db, idA), idA)).toBe("sk-victim-key");

    const stolen = await readEncrypted(db, idB);
    expect(() => decryptApiKey(testConfig.appSecret, stolen, idB)).toThrow(AiKeyDecryptError);
  });

  it("startup self-check upgrades a decryptable v1 ciphertext to v2 in place (migration path)", async () => {
    const { db } = await buildTestApp();
    const id = randomUUID();
    await insertProviderWith(db, id, legacyCiphertext(testConfig.appSecret, "sk-legacy-key"));
    expect((await readEncrypted(db, id)).v).toBe(1);

    await selfCheckAiKeys(db, testConfig.appSecret, createAiRuntime(), fakeLog());

    const upgraded = await readEncrypted(db, id);
    expect(upgraded.v).toBe(2);
    // The upgraded ciphertext is tied to this row: content unchanged, but moved to another row it can't be decrypted.
    expect(decryptApiKey(testConfig.appSecret, upgraded, id)).toBe("sk-legacy-key");
    expect(() => decryptApiKey(testConfig.appSecret, upgraded, randomUUID())).toThrow();
  });

  it("undecryptable ciphertext is not upgraded and doesn't block startup (staying degraded is fine)", async () => {
    const { db } = await buildTestApp();
    const id = randomUUID();
    // Old format (v1) + ciphertext encrypted with a different secret: keyId doesn't match, can't be decrypted.
    await insertProviderWith(db, id, legacyCiphertext("f".repeat(64), "sk-x"));

    const runtime = createAiRuntime();
    await selfCheckAiKeys(db, testConfig.appSecret, runtime, fakeLog());

    expect(runtime.degraded.has(id)).toBe(true);
    // Not upgraded: upgrade only applies to ciphertext that decrypts with the current APP_SECRET.
    expect((await readEncrypted(db, id)).v).toBe(1);
  });
});

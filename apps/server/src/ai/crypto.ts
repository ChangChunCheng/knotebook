import { createDecipheriv, createHash } from "node:crypto";
import { sealSecret } from "../lib/sealed-secret.js";

// Namespaced sha256 derivation (like `sessionKey` in `auth/session.ts`), so this key never equals the session JWT key from the same APP_SECRET.

function deriveKey(appSecret: string): Buffer {
  return createHash("sha256").update(`${appSecret}:ai-key`).digest();
}

/** A hash of the derived key, never the key itself: lets a changed APP_SECRET fail early with a clear reason instead of a GCM auth error. */
function deriveKeyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/**
 * v2 (all writes) binds providerId as GCM AAD, so copying one provider's ciphertext into another
 * row fails to decrypt (#14). v1 (no AAD) is read-only; decryptable v1 rows are upgraded in place
 * at startup (`selfCheckAiKeys`), and re-entering a key in admin writes v2.
 */
export type EncryptedApiKeyVersion = 1 | 2;

export interface EncryptedApiKey {
  v: EncryptedApiKeyVersion;
  keyId: string;
  iv: string;
  tag: string;
  ct: string;
}

/** The `ai-key:v2:` prefix keeps AAD namespaced; AAD needs integrity, not secrecy. */
function aadFor(providerId: string): Buffer {
  return Buffer.from(`ai-key:v2:${providerId}`, "utf8");
}

export class AiKeyDecryptError extends Error {}

/** `providerId` is part of the AAD, so a new provider's id must be generated before encrypting (the DB default is too late). */
export function encryptApiKey(appSecret: string, plaintext: string, providerId: string): EncryptedApiKey {
  return sealSecret(appSecret, "ai-key", plaintext, `ai-key:v2:${providerId}`);
}

export function decryptApiKey(appSecret: string, payload: EncryptedApiKey, providerId: string): string {
  // The payload is an unvalidated jsonb value: a non-object must surface as AiKeyDecryptError, not a bare TypeError that would abort startup.
  if (payload === null || typeof payload !== "object") {
    throw new AiKeyDecryptError("AI provider API key 解密失敗（密文格式不是物件，資料可能已損毀）：請至 admin 後台重輸 API key");
  }
  // An unknown version is a failure; never apply one version's semantics to another format.
  if (payload.v !== 1 && payload.v !== 2) {
    throw new AiKeyDecryptError(`AI provider API key 解密失敗（未知的密文格式版本 v=${JSON.stringify(payload.v)}）：請至 admin 後台重輸 API key`);
  }
  const key = deriveKey(appSecret);
  if (payload.keyId !== deriveKeyId(key)) {
    throw new AiKeyDecryptError("AI provider API key 解密失敗（金鑰指紋不符，APP_SECRET 可能已變更）：請至 admin 後台重輸 API key");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
    // v1 has no AAD; v2 always verifies it.
    if (payload.v === 2) decipher.setAAD(aadFor(providerId));
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    const pt = Buffer.concat([decipher.update(Buffer.from(payload.ct, "base64")), decipher.final()]);
    return pt.toString("utf8");
  } catch (err) {
    throw new AiKeyDecryptError(
      `AI provider API key 解密失敗（密文驗證失敗，可能已損毀或被竄改）：請至 admin 後台重輸 API key（原始錯誤：${err instanceof Error ? err.message : String(err)}）`
    );
  }
}

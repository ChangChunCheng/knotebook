import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** Field for field identical to `EncryptedApiKey` v2 (`ai/crypto.ts`); don't change the AI ciphertext format. */
export interface EncryptedSecret {
  v: 2;
  keyId: string;
  iv: string;
  tag: string;
  ct: string;
}

export class SecretDecryptError extends Error {}

function deriveKey(appSecret: string, namespace: string): Buffer {
  return createHash("sha256").update(`${appSecret}:${namespace}`).digest();
}

/** Same algorithm as `deriveKeyId` in `ai/crypto.ts`. */
function keyIdOf(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/** `encryptApiKey` is `sealSecret(appSecret, "ai-key", plaintext, "ai-key:v2:<providerId>")`. `aad` binds the ciphertext to its row: moved to another row it can't be decrypted. */
export function sealSecret(appSecret: string, namespace: string, plaintext: string, aad: string): EncryptedSecret {
  const key = deriveKey(appSecret, namespace);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { v: 2, keyId: keyIdOf(key), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

export function openSecret(appSecret: string, namespace: string, payload: unknown, aad: string): string {
  if (payload === null || typeof payload !== "object") throw new SecretDecryptError("密文格式不是物件");
  const p = payload as Partial<EncryptedSecret>;
  if (p.v !== 2 || typeof p.keyId !== "string" || typeof p.iv !== "string" || typeof p.tag !== "string" || typeof p.ct !== "string") {
    throw new SecretDecryptError("密文格式不認得");
  }
  const key = deriveKey(appSecret, namespace);
  if (p.keyId !== keyIdOf(key)) throw new SecretDecryptError("金鑰指紋不符（APP_SECRET 可能已變更）");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(p.iv, "base64"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(p.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(p.ct, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretDecryptError("密文驗證失敗（已損毀、被竄改，或屬於別的列）");
  }
}

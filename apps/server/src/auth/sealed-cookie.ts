import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Same format as `sealOidcState`: base64url(iv).base64url(ct).base64url(tag). Callers validate the fields (the result is `unknown`).

function deriveKey(appSecret: string, namespace: string): Buffer {
  return createHash("sha256").update(`${appSecret}:${namespace}`).digest();
}

export function sealCookieJson(appSecret: string, namespace: string, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(appSecret, namespace), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${ct.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
}

export function unsealCookieJson(appSecret: string, namespace: string, sealed: string): unknown {
  const parts = sealed.split(".");
  if (parts.length !== 3) return null;
  const [ivPart, ctPart, tagPart] = parts;
  if (!ivPart || !ctPart || !tagPart) return null;
  let plaintext: string;
  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(appSecret, namespace), Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    plaintext = Buffer.concat([decipher.update(Buffer.from(ctPart, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(plaintext) as unknown;
  } catch {
    return null;
  }
}

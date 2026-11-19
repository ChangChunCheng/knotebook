// The IdP's value is untrusted: this only decides whether it is worth downloading (absolute http/https, bounded length,
// no troublesome characters). Whether the connection target is safe is checked per hop by `avatars/oidc-fetch.ts`.

/** Counted in UTF-16 code units (JS `.length`), not bytes: always >= PG `char_length`, so a passing value satisfies the DB length CHECK. */
export const MAX_PICTURE_URL_LENGTH = 2048;

const FORBIDDEN_CHARS = /[\0]|\p{Surrogate}/u;

export function parsePictureClaim(x: unknown): string | null {
  if (typeof x !== "string") return null;
  const value = x.trim();
  if (value.length === 0 || value.length > MAX_PICTURE_URL_LENGTH) return null;
  if (FORBIDDEN_CHARS.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return value;
}

export function pickPicture(
  idTokenClaims: Record<string, unknown>,
  userinfo: Record<string, unknown> | undefined,
): string | null {
  return parsePictureClaim(idTokenClaims.picture) ?? parsePictureClaim(userinfo?.picture);
}

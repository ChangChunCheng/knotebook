// Keys for every one-time-link page (reset and invite), despite the file name. Not in a lazy chunk: main.tsx clears
// stale keys before render, since React cleanup doesn't run when the user leaves by a full page load.
export const RESET_TOKEN_KEY = "knotebook:reset-token";

export const INVITE_TOKEN_KEY = "knotebook:invite-token";

/** Paths must be lowercase without a trailing `/`. */
export const ONE_TIME_TOKEN_PAGES: ReadonlyArray<{ path: string; key: string }> = [
  { path: "/reset-password", key: RESET_TOKEN_KEY },
  { path: "/register", key: INVITE_TOKEN_KEY },
];

/** Normalized because react-router ignores case and trailing slashes: reloading `/reset-password/` must keep the key. */
export function clearStaleOneTimeTokens(pathname: string): void {
  const current = pathname.replace(/\/+$/, "").toLowerCase();
  for (const { path, key } of ONE_TIME_TOKEN_PAGES) {
    if (current !== path) removeSessionToken(key);
  }
}

/** sessionStorage may be unavailable (private mode, blocked): a failed read means no token, a failed write only loses it on reload. */
export function readSessionToken(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeSessionToken(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // See readSessionToken.
  }
}

export function removeSessionToken(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // See readSessionToken.
  }
}

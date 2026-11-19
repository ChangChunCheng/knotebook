import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import type { UserDto } from "@knotebook/shared";
import { readSessionToken, removeSessionToken, writeSessionToken } from "@/auth/resetTokenStorage";

function parseFragmentParam(hash: string, param: string): string | null {
  const value = new URLSearchParams(hash.replace(/^#/, "")).get(param);
  return value === null || value === "" ? null : value;
}

/**
 * The token travels in the fragment so it never reaches the server, logs or Referer. The fragment is cleared with
 * router navigate, not history.replaceState: the router's location wouldn't update, and a null state wipes the
 * router's key/idx. The token is persisted only once the user is known to be logged out.
 */
export function useOneTimeLinkToken(opts: { param: string; storageKey: string; user: UserDto | null | undefined }): { token: string | null; forget: () => void } {
  const { param, storageKey, user } = opts;
  const location = useLocation();
  const navigate = useNavigate();
  const fragmentToken = parseFragmentParam(location.hash, param);
  const [token, setToken] = useState(() => fragmentToken ?? readSessionToken(storageKey));
  if (fragmentToken !== null && fragmentToken !== token) setToken(fragmentToken);
  const forgotten = useRef<string | null>(null);

  const hasFragmentParam = new URLSearchParams(location.hash.replace(/^#/, "")).has(param);
  useEffect(() => {
    if (hasFragmentParam) navigate({ pathname: location.pathname, search: location.search }, { replace: true });
  }, [hasFragmentParam, location.pathname, location.search, navigate]);

  useEffect(() => {
    if (user === null && token !== null && forgotten.current !== token) writeSessionToken(storageKey, token);
    else if (user) removeSessionToken(storageKey);
  }, [user, token, storageKey]);

  useEffect(() => () => removeSessionToken(storageKey), [storageKey]);

  const forget = useCallback(() => {
    forgotten.current = token;
    // A late response for an old token must not delete a newer token.
    if (readSessionToken(storageKey) === token) removeSessionToken(storageKey);
  }, [storageKey, token]);

  return { token, forget };
}

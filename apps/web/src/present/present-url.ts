import { exitOwnedFullscreen } from "./fullscreen";

/**
 * Entry flag: an entry pushed from ⋮ / the public page button carries only this one key (existing state is not spread);
 * leaving with the flag → navigate(-1), otherwise replace to drop present.
 */
export const PRESENT_SEARCH = "?present";
const PRESENT_PARAM = "present";
export const PRESENT_PUSHED_KEY = "knotebookPresentPushed";

export function isPresentingSearch(search: string): boolean {
  return new URLSearchParams(search).has(PRESENT_PARAM);
}

export function searchWithoutPresent(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(PRESENT_PARAM);
  const rest = params.toString();
  return rest === "" ? "" : `?${rest}`;
}

export function presentPushedState(): Record<string, true> {
  return { [PRESENT_PUSHED_KEY]: true };
}

export function wasPresentPushed(state: unknown): boolean {
  return typeof state === "object" && state !== null && (state as Record<string, unknown>)[PRESENT_PUSHED_KEY] === true;
}

export function hashForSlide(id: string): string {
  return `#/${encodeURIComponent(id)}`;
}

export function slideIdFromHash(hash: string): string | null {
  if (!hash.startsWith("#/") || hash.length <= 2) return null;
  try {
    return decodeURIComponent(hash.slice(2));
  } catch {
    return null;
  }
}

/**
 * Unmount-style call sites exit only when really leaving. Reads the browser's real URL, not the router's location: a
 * real leave no longer has present in the URL, while StrictMode's dev-time fake unmount still does.
 */
export function exitFullscreenIfLeftPresentation(): void {
  if (!isPresentingSearch(window.location.search)) exitOwnedFullscreen();
}

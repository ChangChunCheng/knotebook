import { useCallback, useEffect, useState } from "react";

/**
 * One site-wide setting (not per note): `"1"` = pinned, the key is removed on unpin. The pin is only suspended where it
 * can't apply (wide layout, full-width note, tight space); the preference stays and re-pins on a note where it fits.
 * With storage blocked the preference lives only in React state and is lost on reload.
 */
export const OUTLINE_PINNED_STORAGE_KEY = "outline.pinned";

export function readOutlinePinned(): boolean {
  try {
    return window.localStorage.getItem(OUTLINE_PINNED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeOutlinePinned(pinned: boolean): void {
  try {
    if (pinned) window.localStorage.setItem(OUTLINE_PINNED_STORAGE_KEY, "1");
    else window.localStorage.removeItem(OUTLINE_PINNED_STORAGE_KEY);
  } catch {
    // Storage blocked or full: the UI still toggles, it just isn't remembered.
  }
}

/**
 * The column's pin transition turns on only after the outline has been shown for a full frame, and off as soon as it is
 * gone. Opening a note, leaving the version preview or closing the floating versions panel shows the column at pinned width
 * at once instead of sliding from standard width; pin clicks, window/sidebar resizes and toggling the third-column versions
 * panel animate.
 */
export function usePinMotionReady(outlineShown: boolean): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!outlineShown) {
      setReady(false);
      return;
    }
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, [outlineShown]);
  return ready && outlineShown;
}

export function useOutlinePinned(): [boolean, (next: boolean) => void] {
  const [pinned, setPinned] = useState(readOutlinePinned);
  const update = useCallback((next: boolean) => {
    setPinned(next);
    writeOutlinePinned(next);
  }, []);
  return [pinned, update];
}

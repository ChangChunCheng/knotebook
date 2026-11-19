import { useEffect, useState } from "react";

/** A height difference above this counts as the keyboard being open: above the scrollbar width and the transient address-bar difference, below any on-screen keyboard. */
export const KEYBOARD_OPEN_THRESHOLD_PX = 80;

export function readKeyboardInset(): number {
  if (typeof window === "undefined") return 0;
  const viewport = window.visualViewport;
  if (!viewport) return 0;
  // Pinch zoom shrinks the visual viewport, but that is not the keyboard.
  if (Math.abs(viewport.scale - 1) > 0.01) return 0;
  return Math.max(0, window.innerHeight - (viewport.height + viewport.offsetTop));
}

export function isKeyboardOpen(inset: number): boolean {
  return inset > KEYBOARD_OPEN_THRESHOLD_PX;
}

/** Listens to both `resize` and `scroll` (on iOS their order varies as the keyboard rises); same-frame events are merged into one read. */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(readKeyboardInset);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      setInset(readKeyboardInset());
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(update);
    };
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    // Re-read: the viewport may have changed between render and subscribing.
    setInset(readKeyboardInset());
    return () => {
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);

  return inset;
}

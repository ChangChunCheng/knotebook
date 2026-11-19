const FOCUSABLE = '[tabindex]:not([tabindex="-1"]), button, a[href], [contenteditable="true"]';

export function focusReturnTarget(preferred: HTMLElement | null, fallback: Element | null): HTMLElement | null {
  if (preferred?.isConnected) return preferred;
  for (let el = fallback; el !== null; el = el.parentElement) {
    if (el instanceof HTMLElement && el.isConnected && el.matches(FOCUSABLE)) return el;
  }
  return null;
}

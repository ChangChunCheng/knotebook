import { expect } from "vitest";

/**
 * Control-height assertion for card pages (exception two of ui/button.tsx): every
 * `button`, non-checkbox `input` and `a.inline-flex` (a link that looks like a button) inside `root` (default `main`) is 44px (`h-11`), not 32px (`h-8`).
 * Call it once per branch screen (error, retry, signed in, no proof method...) so a branch that misses `size="lg"` under some condition is caught.
 * `ignore`: selectors for exceptions that aren't enlarged (e.g. the "Not you?" link button inside the authorize page text); checkboxes are never checked.
 * Returns the number of elements checked so callers can also assert at least one, avoiding a vacuous pass.
 */
export function expectCardControls44(root: HTMLElement = document.querySelector("main") as HTMLElement, ignore?: string): number {
  expect(root).toBeTruthy();
  const controls = Array.from(
    root.querySelectorAll<HTMLElement>('button:not([role="checkbox"]), input:not([type="checkbox"]), a.inline-flex'),
  ).filter((el) => !ignore || !el.matches(ignore));
  for (const el of controls) {
    expect(el, `${el.tagName} "${el.textContent || el.getAttribute("name") || ""}"`).toHaveClass("h-11");
    expect(el).not.toHaveClass("h-8");
  }
  return controls.length;
}

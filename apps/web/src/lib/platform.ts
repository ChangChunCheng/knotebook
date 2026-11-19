/**
 * `navigator.platform` is deprecated but only drives shortcut badge text; `?? ""` guards
 * environments where it is falsy. iPhone/iPad platforms lack "mac", so they show Ctrl.
 */
export function isMacPlatform(): boolean {
  const p = typeof navigator !== "undefined" ? (navigator.platform ?? "") : "";
  return p.toLowerCase().includes("mac");
}

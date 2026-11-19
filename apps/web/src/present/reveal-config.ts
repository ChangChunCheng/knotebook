import type { RevealConfig } from "reveal.js";

/**
 * reveal merges the URL query string into its config (`Util.getQueryHash()` at `reveal.js:151`, taking priority over our
 * values), hence the `?present` normalization and the post-initialization comparison of all keys here (keyboard /
 * keyboardCondition by identity). reveal ignores the URL otherwise: the hash is written through the router (hash-writer.ts).
 */
export interface RevealKeyHandlers {
  onEsc: (event: KeyboardEvent) => void;
  onF: (event: KeyboardEvent) => void;
  onO: (event: KeyboardEvent) => void;
}

export function buildRevealConfig(handlers: RevealKeyHandlers): RevealConfig {
  return {
    embedded: true,
    disableLayout: true,
    hash: false,
    history: false,
    respondToHashChanges: false,
    postMessage: false,
    postMessageEvents: false,
    previewLinks: false,
    view: null,
    parallaxBackgroundImage: "",
    autoSlide: 0,
    pause: false,
    help: false,
    jumpToSlide: false,
    focusBodyOnPageVisibilityChange: false,
    controls: true,
    progress: true,
    overview: true,
    // #390: reveal adds `hidden` to non-current slides and writes only an inline `display` for the one to show; Tailwind
    // preflight's `[hidden]{display:none !important}` beats a non-important inline value, leaving only the current slide with
    // content in the overview. reveal 6.0.2 applies values containing `!important` with setProperty(..., 'important')
    // (slidecontent.js load()), so an inline important beats the one in @layer base.
    display: "block !important",
    // With the fix nearby slides are block, so reveal's default slide transition would really run (0.8 s); keep the switch instant.
    transition: "none",
    keyboard: { 27: handlers.onEsc, 70: handlers.onF, 79: handlers.onO },
    keyboardCondition: (event: KeyboardEvent) => !(event.altKey || event.ctrlKey || event.metaKey),
  };
}

export const LOCKED_CONFIG_KEYS = [
  "embedded", "disableLayout", "hash", "history", "respondToHashChanges", "postMessage", "postMessageEvents",
  "previewLinks", "view", "parallaxBackgroundImage", "autoSlide", "pause", "help", "jumpToSlide",
  "focusBodyOnPageVisibilityChange", "controls", "progress", "overview", "display", "transition", "keyboard", "keyboardCondition",
] as const;

export function configMatches(actual: object, expected: object): boolean {
  const a = actual as Record<string, unknown>;
  const e = expected as Record<string, unknown>;
  return LOCKED_CONFIG_KEYS.every((key) => Object.is(a[key], e[key]));
}

/** The print view adds these classes only after a rAF and destroy does not remove them; `view === null` is the primary check, this is a fallback. */
export function htmlHasPrintClasses(): boolean {
  const classes = document.documentElement.classList;
  return classes.contains("reveal-print") || classes.contains("print-pdf") || classes.contains("reveal-full-page");
}

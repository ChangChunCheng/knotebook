/**
 * The only importer of `mermaid`. It is a dynamic import so the large dependency stays out of the
 * NotePage chunk (`scripts/check-bundle-size.mjs` guards this). No DOM here: mermaid cannot run
 * in jsdom, so unit tests mock the module.
 *
 * `render()` is one long synchronous task (~500 ms for 150 nodes) that needs a live DOM, so it
 * cannot go to a worker. Renders are serialized in our own queue with a yield before each
 * (mermaid's own queue only yields microtasks, so a page of diagrams would never paint a frame),
 * and results are cached.
 */

export type MermaidRenderResult = { ok: true; svg: string } | { ok: false; message: string };

export type MermaidTheme = "light" | "dark";

/**
 * Not `crypto.randomUUID`: it does not exist in non-secure contexts (plain-http LAN), while
 * jsdom/Node polyfill it so tests would not catch it. The prefix starts with a letter because
 * mermaid builds CSS selectors from it.
 */
let idSeq = 0;
export function nextMermaidId(): string {
  idSeq += 1;
  return `mermaid-${idSeq}`;
}

let initializedTheme: MermaidTheme | null = null;

export function resetMermaidForTests(): void {
  initializedTheme = null;
  svgCache.clear();
  queueTail = Promise.resolve();
}

/** Each SVG is ~80-300 KB; 30 covers leaving and returning to one long note. */
export const MERMAID_CACHE_LIMIT = 30;

/**
 * LRU via Map insertion order. Only successes are cached: a transient failure (e.g. chunk load)
 * would otherwise leave the diagram unrenderable after the network recovers.
 */
const svgCache = new Map<string, { svg: string; id: string }>();

function cacheKey(code: string, theme: MermaidTheme): string {
  return `${theme}\n${code}`;
}

/**
 * mermaid references the id everywhere (root id, `<style>` selectors, marker urls, aria), so
 * identical diagrams on one page need distinct ids. The match must not eat following digits
 * (`mermaid-1` vs `mermaid-12`) and uses a capture group instead of lookbehind: lookbehind needs
 * Safari 16.4, and a pattern inside a `new RegExp` string is not transpiled.
 *
 * Known gaps: label text equal to the id is rewritten too; ids from mermaid's global counters
 * without the `mermaid-N` prefix (sankey `node-N`, sequence `actorN`, architecture `IconifyId…`)
 * are not rewritten, since that needs knowledge of every way each diagram type references them.
 */
export function rewriteMermaidId(svg: string, oldId: string, newId: string): string {
  if (oldId === newId) return svg;
  const escaped = oldId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return svg.replace(new RegExp(`(^|[^A-Za-z0-9])${escaped}(?![0-9])`, "g"), `$1${newId}`);
}

/** Fresh id per call so several copies can be shown at once. */
export function cachedMermaid(code: string, theme: MermaidTheme): string | null {
  if (code.trim().length === 0) return null;
  const key = cacheKey(code, theme);
  const entry = svgCache.get(key);
  if (entry === undefined) return null;
  svgCache.delete(key);
  svgCache.set(key, entry);
  return rewriteMermaidId(entry.svg, entry.id, nextMermaidId());
}

function storeInCache(code: string, theme: MermaidTheme, svg: string, id: string): void {
  const key = cacheKey(code, theme);
  svgCache.delete(key);
  svgCache.set(key, { svg, id });
  while (svgCache.size > MERMAID_CACHE_LIMIT) {
    const oldest = svgCache.keys().next().value as string;
    svgCache.delete(oldest);
  }
}

let queueTail: Promise<void> = Promise.resolve();

function abortError(): DOMException {
  return new DOMException("mermaid render aborted", "AbortError");
}

/**
 * `setTimeout(0)` alone often paints no frame between long tasks, so finished diagrams stay
 * invisible and IntersectionObserver reports (also frame-bound) cannot cancel scrolled-away
 * items. Wait a frame first; without rAF or in a background tab (rAF does not run) use only
 * `setTimeout(0)`; the 100 ms timer covers a tab hidden while waiting for the frame.
 */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== "function" || document.visibilityState === "hidden") {
      setTimeout(resolve, 0);
      return;
    }
    const fallback = setTimeout(resolve, 100);
    requestAnimationFrame(() => {
      clearTimeout(fallback);
      setTimeout(resolve, 0);
    });
  });
}

/**
 * Yields before running, not after, so a finished result returns without another tick.
 * Cancellation during the yield is caught by the check in `renderMermaid`.
 */
function enqueue<T>(task: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  const run = queueTail.then(async () => {
    if (signal?.aborted) throw abortError();
    await yieldToMain();
    return task();
  });
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Failures are swallowed: when a diagram is really drawn, `renderMermaid` imports again and reports the error. */
export function preloadMermaid(): void {
  void import("mermaid").catch(() => undefined);
}

/**
 * Keys in `secure` cannot be overridden by a diagram's `%%{init}%%`. mermaid's built-in list
 * lacks `themeCSS` / `htmlLabels` / `fontFamily`; locking them shrinks the HTML/CSS injection
 * surface (see `mermaidConfig`).
 */
const LOCKED_CONFIG_KEYS = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "suppressErrorRendering",
  "maxEdges",
  "themeCSS", // arbitrary CSS → a network request at render time
  "htmlLabels", // enabling it lets <img srcset> / HTML inside <foreignObject> pull external resources
  // `fontFamily` is a second CSS injection: `addDirective` copies `directive.fontFamily` into
  // `themeVariables.fontFamily` after `sanitizeDirective()`, bypassing its character-set check, and
  // the value lands in `:root{--mermaid-font-family:…}`, so `url(http://…)` issues a request.
  "fontFamily",
  "altFontFamily",
  // Do not also lock `themeVariables` (it would disable the documented
  // `%%{init:{"theme":"base","themeVariables":…}}%%`): `sanitize()` recurses into objects, so
  // locking `fontFamily` already removes the copied value, and mermaid's own character-set check
  // covers the rest. Likewise do not lock all of `flowchart`: nested `flowchart.htmlLabels` is
  // already covered, and locking the object would drop legitimate `flowchart.curve` / `nodeSpacing`.
] as const;

/**
 * Blocks "a diagram making the browser execute code", not "loading external resources": notes
 * already embed arbitrary remote images, so blocking it only for mermaid is meaningless (that is
 * a CSP matter, #101).
 *
 * - `securityLevel: "strict"`: DOMPurify over the whole output SVG; the main defense.
 * - `secure` + `htmlLabels: false`: SVG `<text>` labels shrink the injection surface. Known gap:
 *   a label containing `$$` makes mermaid enable htmlLabels for KaTeX, which the directive lock
 *   cannot reach; DOMPurify still blocks execution.
 *
 * Callers must not call the `bindFunctions` returned by `render()`: it would bind a diagram's
 * `click X callback` to real DOM handlers.
 */
function mermaidConfig(theme: MermaidTheme) {
  return {
    startOnLoad: false,
    securityLevel: "strict" as const,
    secure: [...LOCKED_CONFIG_KEYS],
    theme: theme === "dark" ? ("dark" as const) : ("default" as const),
    htmlLabels: false, // new location in mermaid 11
    flowchart: { htmlLabels: false }, // old location, kept for compatibility
    // A syntax error makes `render()` throw and remove its temporary body container, instead of
    // leaving a "Syntax error in text" diagram in the page.
    suppressErrorRendering: true,
  };
}

/**
 * Empty source returns `ok:false` without loading mermaid. An abort before or while yielding or
 * loading rejects with `AbortError`; a `render()` already started cannot be stopped and its
 * result is still cached. A cache hit at our turn resolves even if aborted. Without a signal it
 * never rejects.
 */
export async function renderMermaid(
  code: string,
  theme: MermaidTheme,
  options: { signal?: AbortSignal } = {},
): Promise<MermaidRenderResult> {
  if (code.trim().length === 0) {
    return { ok: false, message: "" }; // empty block: the caller shows a hint rather than an error
  }

  const cached = cachedMermaid(code, theme);
  if (cached !== null) return { ok: true, svg: cached };

  const { signal } = options;
  return enqueue(async () => {
    // An identical diagram ahead in the queue may have just filled the cache.
    const cachedNow = cachedMermaid(code, theme);
    if (cachedNow !== null) return { ok: true, svg: cachedNow } as const;

    let mermaid: Awaited<typeof import("mermaid")>["default"];
    try {
      ({ default: mermaid } = await import("mermaid"));
    } catch (err) {
      return failure(err); // chunk load failed (offline, new deploy): error state, retry on the next redraw
    }
    // The only cancellation check after starting: the frame yield and first mermaid download can be
    // long, and render cannot be stopped past this point.
    if (signal?.aborted) throw abortError();

    try {
      // The queue runs one item at a time, so no other theme slips in between initialize and render.
      if (initializedTheme !== theme) {
        mermaid.initialize(mermaidConfig(theme));
        initializedTheme = theme;
      }

      // No `parse()` first: with `suppressErrorRendering` mermaid 11.17 removes its temporary body
      // container before throwing (otherwise a "Syntax error" diagram stays in `document.body`), and
      // `render()` parses internally anyway. Unit tests mock mermaid; `e2e/tests/06-mermaid.spec.ts`
      // checks body in a real browser, so rerun it when touching this or upgrading mermaid.
      // `bindFunctions` is deliberately not called; see `mermaidConfig`.
      const id = nextMermaidId();
      const { svg } = await mermaid.render(id, code);
      storeInCache(code, theme, svg, id);
      return { ok: true, svg } as const;
    } catch (err) {
      return failure(err);
    }
  }, signal);
}

function failure(err: unknown): MermaidRenderResult {
  return { ok: false, message: err instanceof Error ? err.message : String(err) };
}

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for `lib/mermaid.ts`.
 *
 * mermaid itself cannot run in jsdom: `mermaid.render()` temporarily inserts a hidden div into `document.body` for text measurement
 * (documented in the mermaid 11 type file), and jsdom has no layout and no `SVGElement.getBBox`. So these tests mock the whole
 * `mermaid` module and verify only OUR behaviour (id generation, initialize arguments, errors not thrown outward, theme mapping).
 * Real rendering is covered by e2e.
 */

const renderMock = vi.hoisted(() => vi.fn());
const initializeMock = vi.hoisted(() => vi.fn());
const parseMock = vi.hoisted(() => vi.fn());

/**
 * `default` is a getter: `renderMermaid` destructures `{ default: mermaid } = await import("mermaid")` inside a try, so reading
 * `default` is the moment loading completes. `onLoad` lets a test intervene at that moment (simulating cancellation during the
 * download), `loadError` makes it throw (simulating a chunk load failure).
 */
const loadHooks = vi.hoisted(() => ({ onLoad: null as (() => void) | null, loadError: null as Error | null }));

vi.mock("mermaid", () => ({
  get default() {
    loadHooks.onLoad?.();
    if (loadHooks.loadError !== null) throw loadHooks.loadError;
    return { render: renderMock, initialize: initializeMock, parse: parseMock };
  },
}));

const { MERMAID_CACHE_LIMIT, cachedMermaid, nextMermaidId, renderMermaid, resetMermaidForTests, rewriteMermaidId } = await import("./mermaid");

beforeEach(() => {
  renderMock.mockReset();
  initializeMock.mockReset();
  parseMock.mockReset();
  parseMock.mockResolvedValue(true);
  loadHooks.onLoad = null;
  // After the network recovers a redraw succeeds (the failure was not cached).
  loadHooks.loadError = null;
  resetMermaidForTests();
});

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Waits until `predicate()` holds (the queue yields a macrotask between items, so wait for macrotasks, not only flush microtasks). */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !predicate(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(predicate()).toBe(true);
}

/** Fake SVG that writes the id everywhere like mermaid does (root id, style selectors, marker and url() references). */
function svgFor(id: string): string {
  return `<svg id="${id}"><style>#${id} .node{fill:red}</style><marker id="${id}_flowchart-v2-pointEnd"/><path marker-end="url(#${id}_flowchart-v2-pointEnd)"/></svg>`;
}

describe("nextMermaidId", () => {
  it("returns a different id each time", () => {
    const ids = new Set([nextMermaidId(), nextMermaidId(), nextMermaidId()]);
    expect(ids.size).toBe(3);
  });

  it("the id is a valid DOM id (starts with a letter, contains only [A-Za-z0-9-])", () => {
    // mermaid uses this id as a DOM element id and as the SVG-internal id prefix; a leading digit or special characters produce invalid selectors.
    expect(nextMermaidId()).toMatch(/^[A-Za-z][A-Za-z0-9-]*$/);
  });

  it("does not use crypto.randomUUID", () => {
    // This repo's legitimate topologies include LAN plain-http (not a secure context), where `crypto.randomUUID` does not exist
    // (`ui/toast.tsx` switched to a module-level counter for the same reason). jsdom/Node have a polyfill, so this assertion is
    // what detects the problem.
    const spy = vi.spyOn(globalThis.crypto, "randomUUID");
    nextMermaidId();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("renderMermaid", () => {
  it("returns the svg on success", async () => {
    renderMock.mockResolvedValue({ svg: "<svg id='x'></svg>" });
    const result = await renderMermaid("graph TD; A-->B;", "light");
    expect(result).toEqual({ ok: true, svg: "<svg id='x'></svg>" });
  });

  it("a syntax error returns ok:false with the message and does not throw", async () => {
    // With suppressErrorRendering: true, render() itself throws on a syntax error.
    renderMock.mockRejectedValue(new Error("Parse error on line 2"));
    const result = await renderMermaid("not a diagram", "light");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("Parse error");
  });

  it("initializes with suppressErrorRendering:true (otherwise a render syntax error leaves the error diagram in document.body)", async () => {
    // By default the throwing path of `render()` leaves a "Syntax error in text" diagram in body, which escapes the component boundary
    // and adds one per redraw. This used to be avoided by calling `parse()` first; #344 switched to this setting (mermaid clears the
    // temporary container on both throwing paths), and that nothing is left in body is checked in a real browser by `e2e/tests/06-mermaid.spec.ts`.
    renderMock.mockResolvedValue({ svg: "<svg></svg>" });
    await renderMermaid("graph TD; A-->B;", "light");
    expect(initializeMock).toHaveBeenCalledWith(expect.objectContaining({ suppressErrorRendering: true }));
  });

  it("does not parse first (render parses internally anyway, so parsing first repeats the work for every diagram)", async () => {
    renderMock.mockResolvedValue({ svg: "<svg></svg>" });
    await renderMermaid("graph TD; A-->B;", "light");
    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(parseMock).not.toHaveBeenCalled();
  });

  it("a non-Error reject is also handled", async () => {
    renderMock.mockRejectedValue("boom");
    const result = await renderMermaid("x", "light");
    expect(result.ok).toBe(false);
  });

  it("initializes with securityLevel:strict and htmlLabels:false", async () => {
    // The diagram is put into the DOM with dangerouslySetInnerHTML, so these two settings are the first line of defense (strict mode is
    // backed by mermaid's built-in dompurify). The second is the caller's assertion on the produced SVG.
    renderMock.mockResolvedValue({ svg: "<svg></svg>" });
    await renderMermaid("graph TD; A-->B;", "light");
    expect(initializeMock).toHaveBeenCalledWith(
      // `htmlLabels` is needed in both places: the global key is the new location in mermaid 11, `flowchart.*` is the legacy-compatible one.
      // Asserting only one of them means deleting the other would not turn the test red.
      expect.objectContaining({
        securityLevel: "strict",
        startOnLoad: false,
        htmlLabels: false,
        flowchart: expect.objectContaining({ htmlLabels: false }),
      }),
    );
  });

  it("theme mapping: light -> default, dark -> dark", async () => {
    renderMock.mockResolvedValue({ svg: "<svg></svg>" });
    await renderMermaid("graph TD; A-->B;", "light");
    expect(initializeMock).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "default" }));

    await renderMermaid("graph TD; A-->B;", "dark");
    expect(initializeMock).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "dark" }));
  });

  it("rendering the same theme repeatedly initializes once", async () => {
    renderMock.mockResolvedValue({ svg: "<svg></svg>" });
    await renderMermaid("a", "light");
    await renderMermaid("b", "light");
    expect(initializeMock).toHaveBeenCalledTimes(1);
  });

  it("re-initializes when the theme changes", async () => {
    renderMock.mockResolvedValue({ svg: "<svg></svg>" });
    await renderMermaid("a", "light");
    await renderMermaid("a", "dark");
    expect(initializeMock).toHaveBeenCalledTimes(2);
  });

  it("does not call bindFunctions (click declarations in a diagram must not become real handlers)", async () => {
    const bindFunctions = vi.fn();
    renderMock.mockResolvedValue({ svg: "<svg></svg>", bindFunctions });
    await renderMermaid("graph TD; A-->B; click A callback", "light");
    expect(bindFunctions).not.toHaveBeenCalled();
  });

  it("blank source returns ok:false directly without calling mermaid", async () => {
    const result = await renderMermaid("   \n  ", "light");
    expect(result.ok).toBe(false);
    expect(renderMock).not.toHaveBeenCalled();
  });
});

describe("serialization queue (#344)", () => {
  it("one at a time: the next does not start until the previous finishes", async () => {
    const first = deferred<{ svg: string }>();
    renderMock.mockImplementationOnce(() => first.promise).mockResolvedValueOnce({ svg: "<svg>b</svg>" });

    const a = renderMermaid("a", "light");
    const b = renderMermaid("b", "light");
    await until(() => renderMock.mock.calls.length === 1);
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(renderMock).toHaveBeenCalledTimes(1);

    first.resolve({ svg: "<svg>a</svg>" });
    await expect(a).resolves.toEqual({ ok: true, svg: "<svg>a</svg>" });
    await expect(b).resolves.toEqual({ ok: true, svg: "<svg>b</svg>" });
    expect(renderMock).toHaveBeenCalledTimes(2);
  });

  it("yields the main thread between diagrams: a macrotask queued when the previous one finishes runs before the next starts", async () => {
    // This is what lets user input slip in between two diagrams: mermaid's own queue goes through only microtasks between them.
    const order: string[] = [];
    renderMock.mockImplementation(async (_id: string, code: string) => {
      order.push(`render:${code}`);
      if (code === "a") setTimeout(() => order.push("macrotask"), 0);
      return { svg: "<svg></svg>" };
    });
    await Promise.all([renderMermaid("a", "light"), renderMermaid("b", "light")]);
    expect(order).toEqual(["render:a", "macrotask", "render:b"]);
  });

  it("waits one frame before each (so the drawn diagram reaches the screen and IntersectionObserver reports first): does not start until the frame arrives", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    try {
      renderMock.mockResolvedValue({ svg: "<svg></svg>" });
      const a = renderMermaid("a", "light");
      const b = renderMermaid("b", "light");
      await until(() => frames.length === 1);
      expect(renderMock).not.toHaveBeenCalled();
      frames.shift()!(0);
      await a;
      expect(renderMock).toHaveBeenCalledTimes(1);

      await until(() => frames.length === 1);
      expect(renderMock).toHaveBeenCalledTimes(1);
      frames.shift()!(0);
      await b;
      expect(renderMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("when the tab is in the background (rAF does not run) it does not wait for a frame, and the queue does not stall", async () => {
    const raf = vi.fn();
    vi.stubGlobal("requestAnimationFrame", raf);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      renderMock.mockResolvedValue({ svg: "<svg></svg>" });
      await expect(renderMermaid("a", "light")).resolves.toEqual({ ok: true, svg: "<svg></svg>" });
      expect(raf).not.toHaveBeenCalled();
    } finally {
      visibility.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("an item cancelled while queued is not drawn when its turn comes, rejects with AbortError, and does not block later items", async () => {
    const first = deferred<{ svg: string }>();
    renderMock.mockImplementationOnce(() => first.promise).mockResolvedValue({ svg: "<svg>c</svg>" });

    const a = renderMermaid("a", "light");
    const controller = new AbortController();
    const b = renderMermaid("b", "light", { signal: controller.signal });
    const c = renderMermaid("c", "light");
    await until(() => renderMock.mock.calls.length === 1);
    controller.abort();
    first.resolve({ svg: "<svg>a</svg>" });

    await expect(b).rejects.toMatchObject({ name: "AbortError" });
    await expect(c).resolves.toEqual({ ok: true, svg: "<svg>c</svg>" });
    await a;
    expect(renderMock.mock.calls.map((call) => call[1])).toEqual(["a", "c"]);
  });

  it("an item already cancelled when its turn comes is skipped without paying the yielded frame", async () => {
    let frames = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames += 1;
      setTimeout(() => cb(0), 0);
      return frames;
    });
    try {
      renderMock.mockResolvedValue({ svg: "<svg></svg>" });
      const controller = new AbortController();
      controller.abort();
      const b = renderMermaid("b", "light", { signal: controller.signal });
      const c = renderMermaid("c", "light");
      await expect(b).rejects.toMatchObject({ name: "AbortError" });
      await c;
      expect(frames).toBe(1); // only c waited for a frame
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rAF never arrives (the tab went to the background while waiting): starts after the 100 ms fallback anyway", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("requestAnimationFrame", () => 0); // never calls back
    try {
      renderMock.mockResolvedValue({ svg: "<svg></svg>" });
      const p = renderMermaid("a", "light");
      await vi.advanceTimersByTimeAsync(99);
      expect(renderMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(p).resolves.toEqual({ ok: true, svg: "<svg></svg>" });
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("cancelled during the yield is not drawn either", async () => {
    const controller = new AbortController();
    // The timer queued first runs first: the abort lands after the first check and before the yield ends.
    setTimeout(() => controller.abort(), 0);
    const p = renderMermaid("a", "light", { signal: controller.signal });
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(renderMock).not.toHaveBeenCalled();
  });

  it("cancelled while mermaid is downloading (scrolled away, unmounted): not drawn after loading, rejects with AbortError", async () => {
    renderMock.mockResolvedValue({ svg: "<svg></svg>" });
    const controller = new AbortController();
    loadHooks.onLoad = () => controller.abort(); // the cancel lands between the start of loading and its completion
    const p = renderMermaid("a", "light", { signal: controller.signal });
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(renderMock).not.toHaveBeenCalled();
    expect(initializeMock).not.toHaveBeenCalled();
  });

  it("mermaid chunk load failure: converted to ok:false (does not reject - presentation mode passes no signal and relies on never rejecting)", async () => {
    loadHooks.loadError = new Error("Failed to fetch dynamically imported module");
    await expect(renderMermaid("a", "light")).resolves.toEqual({ ok: false, message: "Failed to fetch dynamically imported module" });
    expect(renderMock).not.toHaveBeenCalled();

    loadHooks.loadError = null;
    renderMock.mockResolvedValue({ svg: "<svg></svg>" });
    await expect(renderMermaid("a", "light")).resolves.toEqual({ ok: true, svg: "<svg></svg>" });
  });

  it("a call without a signal (presentation mode) resolves normally", async () => {
    renderMock.mockResolvedValue({ svg: "<svg></svg>" });
    await expect(renderMermaid("a", "light")).resolves.toEqual({ ok: true, svg: "<svg></svg>" });
  });
});

describe("result cache (#344)", () => {
  const idOf = (svg: string) => /<svg id="([^"]+)"/.exec(svg)![1]!;

  it("second request for the same theme and source takes the cache without rendering, and the id is replaced with a new one (two on one page do not collide)", async () => {
    renderMock.mockImplementation(async (id: string) => ({ svg: svgFor(id) }));
    const first = await renderMermaid("graph TD; A-->B;", "light");
    const second = await renderMermaid("graph TD; A-->B;", "light");

    expect(renderMock).toHaveBeenCalledTimes(1);
    const firstId = renderMock.mock.calls[0]![0] as string;
    expect(first).toEqual({ ok: true, svg: svgFor(firstId) });
    expect(second.ok).toBe(true);
    const secondSvg = second.ok ? second.svg : "";
    const secondId = idOf(secondSvg);
    expect(secondId).not.toBe(firstId);
    expect(secondSvg).toBe(svgFor(secondId));
  });

  it("a cache hit does not queue: even while another diagram is drawing, a hit returns immediately", async () => {
    renderMock.mockResolvedValueOnce({ svg: "<svg>x</svg>" });
    await renderMermaid("x", "light");

    const slow = deferred<{ svg: string }>();
    renderMock.mockImplementationOnce(() => slow.promise);
    const busy = renderMermaid("y", "light");
    await until(() => renderMock.mock.calls.length === 2);

    await expect(renderMermaid("x", "light")).resolves.toEqual({ ok: true, svg: "<svg>x</svg>" });
    slow.resolve({ svg: "<svg>y</svg>" });
    await busy;
  });

  it("two identical sources requested at once on one page: rendered once, the second gets a copy with a replaced id", async () => {
    renderMock.mockImplementation(async (id: string) => ({ svg: svgFor(id) }));
    const [a, b] = await Promise.all([renderMermaid("same", "light"), renderMermaid("same", "light")]);
    expect(renderMock).toHaveBeenCalledTimes(1);
    const idA = idOf(a.ok ? a.svg : "");
    const idB = idOf(b.ok ? b.svg : "");
    expect(idA).not.toBe(idB);
    expect(b.ok && b.svg).toBe(svgFor(idB));
  });

  it("theme is part of the key: the same source with another theme redraws", async () => {
    renderMock.mockResolvedValue({ svg: "<svg></svg>" });
    await renderMermaid("a", "light");
    await renderMermaid("a", "dark");
    expect(renderMock).toHaveBeenCalledTimes(2);
  });

  it("failures are not cached (a transient error such as a chunk load failure must be retryable)", async () => {
    renderMock.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ svg: "<svg></svg>" });
    expect((await renderMermaid("a", "light")).ok).toBe(false);
    expect(await renderMermaid("a", "light")).toEqual({ ok: true, svg: "<svg></svg>" });
    expect(renderMock).toHaveBeenCalledTimes(2);
  });

  it(`LRU: limit of ${MERMAID_CACHE_LIMIT} entries, the least recently used is dropped first, a hit refreshes the order`, async () => {
    renderMock.mockImplementation(async (id: string) => ({ svg: svgFor(id) }));
    for (let i = 0; i < MERMAID_CACHE_LIMIT; i++) await renderMermaid(`c${i}`, "light");
    await renderMermaid("c0", "light"); // hit: c0 becomes newest, c1 becomes oldest
    await renderMermaid("fresh", "light"); // over the limit: drops c1
    expect(renderMock).toHaveBeenCalledTimes(MERMAID_CACHE_LIMIT + 1);

    expect(cachedMermaid("c0", "light")).not.toBeNull();
    expect(cachedMermaid("c1", "light")).toBeNull();
    expect(cachedMermaid("c2", "light")).not.toBeNull();
    expect(cachedMermaid("fresh", "light")).not.toBeNull();
  });

  it("cachedMermaid: returns null when never drawn, and null for empty source", () => {
    expect(cachedMermaid("never", "light")).toBeNull();
    expect(cachedMermaid("   ", "light")).toBeNull();
  });
});

describe("rewriteMermaidId", () => {
  it("does not consume following digits: replacing mermaid-1 does not touch mermaid-12", () => {
    const svg = `<svg id="mermaid-1"><style>#mermaid-1 .a{}</style><g id="mermaid-12"/><path marker-end="url(#mermaid-1_arrow)"/></svg>`;
    expect(rewriteMermaidId(svg, "mermaid-1", "mermaid-40")).toBe(
      `<svg id="mermaid-40"><style>#mermaid-40 .a{}</style><g id="mermaid-12"/><path marker-end="url(#mermaid-40_arrow)"/></svg>`,
    );
  });

  it("not replaced when immediately preceded by an alphanumeric (not a reference to this id); replaced at string start and for two adjacent occurrences", () => {
    expect(rewriteMermaidId("xmermaid-1 chart-title-mermaid-1", "mermaid-1", "mermaid-2")).toBe("xmermaid-1 chart-title-mermaid-2");
    expect(rewriteMermaidId("mermaid-1 #mermaid-1,#mermaid-1", "mermaid-1", "mermaid-2")).toBe("mermaid-2 #mermaid-2,#mermaid-2");
  });

  it("does not use lookbehind (Safari 16.0-16.3 does not support it, and writing it in a new RegExp string is not transpiled)", () => {
    expect(rewriteMermaidId.toString()).not.toMatch(/\(\?<[!=]/);
  });
});

describe("directive lock", () => {
  it("the secure list locks the keys that open HTML/CSS injection surfaces and keeps mermaid's six built-in ones", async () => {
    // This lock does not promise that diagrams cannot load external resources: that is on a par with embedding an image by URL in a note,
    // so blocking only mermaid is pointless (see the `mermaidConfig` comment). It is locked so labels stay SVG `<text>` and diagrams
    // cannot inject arbitrary CSS.
    renderMock.mockResolvedValue({ svg: "<svg></svg>" });
    await renderMermaid("graph TD; A-->B;", "light");

    const [config] = initializeMock.mock.calls[0] as [{ secure: string[] }];
    expect(config.secure).toEqual(
      expect.arrayContaining([
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "suppressErrorRendering",
        "maxEdges",
        "themeCSS",
        "htmlLabels",
        "fontFamily",
        "altFontFamily",
      ]),
    );
    // Two that should NOT be locked: sanitize recurses so nested keys are already covered, and locking the whole object would
    // silently break `flowchart.curve` and the `theme:"base"` + custom colors that the official docs teach.
    expect(config.secure).not.toContain("flowchart");
    expect(config.secure).not.toContain("themeVariables");
  });
});

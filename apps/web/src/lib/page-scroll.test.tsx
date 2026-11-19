import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { PHONE_QUERY } from "@/lib/layout-tiers";
import { stubLayoutTier } from "@/test/layout-tier";
import {
  PHONE_PAGE_SCROLL_ATTR,
  ROOT_FLAGS,
  STICKY_TOP_VAR,
  captureScrollAnchor,
  mayCrossTiersByDefault,
  restoreScrollAnchor,
  scrollToTopOf,
  scrollsPage,
  stickyTopInset,
  useStickyTopInset,
  useStickyTopVar,
  useRootFlag,
  useTierScrollAnchor,
  visibleHeightOf,
} from "./page-scroll";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  document.documentElement.style.removeProperty(STICKY_TOP_VAR);
});

function makeRoot(framed = true): HTMLDivElement {
  const root = document.createElement("div");
  Object.defineProperty(root, "clientHeight", { value: 5000, configurable: true });
  root.scrollTo = vi.fn() as never;
  if (framed) {
    const frame = document.createElement("div");
    frame.setAttribute(PHONE_PAGE_SCROLL_ATTR, "");
    frame.appendChild(root);
    document.body.appendChild(frame);
  } else {
    document.body.appendChild(root);
  }
  return root;
}

describe("page-scroll: on phone the document scrolls instead of the inner container", () => {
  it("scrollsPage: true only at phone width and inside the frame; false outside the frame (public page) or from 640 up", () => {
    stubLayoutTier("phone");
    expect(scrollsPage(makeRoot())).toBe(true);
    expect(scrollsPage(makeRoot(false))).toBe(false);
    expect(scrollsPage(null)).toBe(false);
    stubLayoutTier("overlay");
    expect(scrollsPage(makeRoot())).toBe(false);
    stubLayoutTier("docked");
    expect(scrollsPage(makeRoot())).toBe(false);
  });

  it("scrollToTopOf: on phone scrolls the document and leaves the container; otherwise scrolls the container", () => {
    const windowScroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    stubLayoutTier("phone");
    const phoneRoot = makeRoot();
    scrollToTopOf(phoneRoot);
    expect(windowScroll).toHaveBeenCalledWith({ top: 0 });
    expect(phoneRoot.scrollTo).not.toHaveBeenCalled();

    windowScroll.mockClear();
    const publicRoot = makeRoot(false);
    scrollToTopOf(publicRoot);
    expect(publicRoot.scrollTo).toHaveBeenCalledWith({ top: 0 });
    expect(windowScroll).not.toHaveBeenCalled();

    stubLayoutTier("overlay");
    const wideRoot = makeRoot();
    scrollToTopOf(wideRoot);
    expect(wideRoot.scrollTo).toHaveBeenCalledWith({ top: 0 });
    expect(windowScroll).not.toHaveBeenCalled();
  });

  it("visibleHeightOf: on phone the window height minus the header; otherwise the container's own visible height", () => {
    stubLayoutTier("phone");
    vi.stubGlobal("innerHeight", 844);
    document.documentElement.style.setProperty(STICKY_TOP_VAR, "120px");
    expect(stickyTopInset()).toBe(120);
    expect(visibleHeightOf(makeRoot())).toBe(724);
    expect(visibleHeightOf(makeRoot(false))).toBe(5000);
    stubLayoutTier("docked");
    expect(visibleHeightOf(makeRoot())).toBe(5000);
  });

  it("stickyTopInset: 0 when not set", () => {
    expect(stickyTopInset()).toBe(0);
  });

  function Header({ enabled, height, framed = true, name = STICKY_TOP_VAR }: { enabled: boolean; height: number; framed?: boolean; name?: string }) {
    const ref = useRef<HTMLDivElement>(null);
    useStickyTopVar(ref, enabled, name);
    const header = <div ref={ref} data-height={height} />;
    return framed ? <div {...{ [PHONE_PAGE_SCROLL_ATTR]: "" }}>{header}</div> : header;
  }

  it("useStickyTopVar: does not write when outside the frame where the document scrolls on its behalf (a list inside a drawer)", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return new DOMRect(0, 0, 390, Number(this.getAttribute("data-height") ?? 0));
    });
    render(<Header enabled height={70} framed={false} />);
    expect(document.documentElement.style.getPropertyValue(STICKY_TOP_VAR)).toBe("");
  });

  it("useStickyTopVar: on unmount removes only the value it wrote; if another instance rewrote the same variable it is left alone", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return new DOMRect(0, 0, 390, Number(this.getAttribute("data-height") ?? 0));
    });
    const first = render(<Header enabled height={88} />);
    const second = render(<Header enabled height={100} />);
    expect(document.documentElement.style.getPropertyValue(STICKY_TOP_VAR)).toBe("100px");
    first.unmount();
    expect(document.documentElement.style.getPropertyValue(STICKY_TOP_VAR)).toBe("100px");
    second.unmount();
    expect(document.documentElement.style.getPropertyValue(STICKY_TOP_VAR)).toBe("");
  });

  it("useStickyTopVar: while enabled writes the header frame's height (rounded) to <html>; removed when disabled or unmounted", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return new DOMRect(0, 0, 390, Number(this.getAttribute("data-height") ?? 0));
    });
    const view = render(<Header enabled height={88.6} />);
    expect(document.documentElement.style.getPropertyValue(STICKY_TOP_VAR)).toBe("89px");
    view.rerender(<Header enabled={false} height={88.6} />);
    expect(document.documentElement.style.getPropertyValue(STICKY_TOP_VAR)).toBe("");
    view.rerender(<Header enabled height={60} />);
    expect(document.documentElement.style.getPropertyValue(STICKY_TOP_VAR)).toBe("60px");
    view.unmount();
    expect(document.documentElement.style.getPropertyValue(STICKY_TOP_VAR)).toBe("");
  });
});

describe("useStickyTopInset: re-renders when the header height changes", () => {
  function Header({ height }: { height: number }) {
    const ref = useRef<HTMLDivElement>(null);
    useStickyTopVar(ref, height > 0);
    return (
      <div {...{ [PHONE_PAGE_SCROLL_ATTR]: "" }}>
        <div ref={ref} data-height={height} />
      </div>
    );
  }
  function Reader() {
    return <p data-testid="inset">{useStickyTopInset()}</p>;
  }

  it("when the header measures a new height, the component reading it re-renders (without waiting for another cause)", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return new DOMRect(0, 0, 390, Number(this.getAttribute("data-height") ?? 0));
    });
    const reader = render(<Reader />);
    expect(reader.getByTestId("inset").textContent).toBe("0");
    const header = render(<Header height={80} />);
    expect(reader.getByTestId("inset").textContent).toBe("80");
    header.rerender(<Header height={0} />);
    expect(reader.getByTestId("inset").textContent).toBe("0");
    header.rerender(<Header height={112} />);
    expect(reader.getByTestId("inset").textContent).toBe("112");
  });
});

describe("captureScrollAnchor / restoreScrollAnchor", () => {
  const ITEMS = { itemSelector: "[data-i]", idAttr: "data-i" };
  function list(tops: number[], height: number): HTMLElement {
    const container = document.createElement("div");
    tops.forEach((_, i) => {
      const item = document.createElement("div");
      item.setAttribute("data-i", String(i));
      container.append(item);
    });
    document.body.append(container);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const i = this.getAttribute("data-i");
      return i === null ? new DOMRect(0, 0, 0, 0) : new DOMRect(0, tops[Number(i)]!, 390, height);
    });
    return container;
  }

  it("takes the first item whose bottom edge is below the line, and records its distance from the line and its height", () => {
    const container = list([-200, -100, -20, 80, 180], 100);
    expect(captureScrollAnchor(container, ITEMS, 50)).toEqual({ id: "2", offset: -70, height: 100 });
  });

  it("restore: the same item returns to the same distance from the line; the part scrolled past the line is rescaled to the new height; not found returns false", () => {
    const container = list([0, 40, 80, 120], 40);
    const scrollBy = vi.fn();
    // Item 2's top is now at 80 and the line at 60: it had scrolled 70/100, new height 40 -> scrolled 28 -> top should be at 32 -> scroll down 48.
    expect(restoreScrollAnchor(container, ITEMS, { id: "2", offset: -70, height: 100 }, 60, scrollBy)).toBe(true);
    expect(scrollBy).toHaveBeenCalledWith(48);
    scrollBy.mockClear();
    expect(restoreScrollAnchor(container, ITEMS, { id: "1", offset: 10, height: 100 }, 20, scrollBy)).toBe(true);
    expect(scrollBy).toHaveBeenCalledWith(10);
    expect(restoreScrollAnchor(container, ITEMS, { id: "9", offset: 0, height: 10 }, 0, scrollBy)).toBe(false);
  });
});

describe("captureScrollAnchor: side-by-side columns", () => {
  type Box = { id: string; top: number; height: number };
  function expectDocumentOrder(boxes: Box[], lines: number[]): void {
    const container = document.createElement("div");
    for (const box of boxes) {
      const item = document.createElement("div");
      item.setAttribute("data-id", box.id);
      container.append(item);
    }
    document.body.append(container);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const box = boxes.find((b) => b.id === this.getAttribute("data-id"));
      return box ? new DOMRect(0, box.top, 180, box.height) : new DOMRect(0, 0, 0, 0);
    });
    const items = { itemSelector: "[data-id]", idAttr: "data-id" };
    for (const line of lines) {
      const expected = boxes.find((b) => b.top + b.height > line)!;
      expect(captureScrollAnchor(container, items, line), `線在 ${line}`).toEqual({ id: expected.id, offset: expected.top - line, height: expected.height });
    }
  }
  const linesUpTo = (end: number, step: number) => Array.from({ length: Math.ceil(end / step) }, (_, i) => i * step);

  it("columns of unequal length (the second column's blocks come after the first column in the document but their positions restart from the top): across the whole range, the first block in document order whose bottom edge is below the line is picked", () => {
    // Document order: first column c1-0..c1-3 (each 100 high, from 0), second column c2-0..c2-3 (each 60 high, from 0), after the columns b0..b29 (each 50 high, from 400).
    expectDocumentOrder(
      [
        ...Array.from({ length: 4 }, (_, i) => ({ id: `c1-${i}`, top: i * 100, height: 100 })),
        ...Array.from({ length: 4 }, (_, i) => ({ id: `c2-${i}`, top: i * 60, height: 60 })),
        ...Array.from({ length: 30 }, (_, i) => ({ id: `b${i}`, top: 400 + i * 50, height: 50 })),
      ],
      linesUpTo(1900, 23),
    );
  });

  it("second column longer: when the line is past the first column's bottom but still inside the second column, the second column's block is picked", () => {
    // First column c1-0, c1-1 (each 100 high, to 200), second column c2-0..c2-5 (each 60 high, to 360), after the columns b0..b9 (each 50 high, from 360).
    const boxes = [
      ...Array.from({ length: 2 }, (_, i) => ({ id: `c1-${i}`, top: i * 100, height: 100 })),
      ...Array.from({ length: 6 }, (_, i) => ({ id: `c2-${i}`, top: i * 60, height: 60 })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, top: 360 + i * 50, height: 50 })),
    ];
    expectDocumentOrder(boxes, linesUpTo(800, 17));
    // Line at 250 (the first column has ended) -> the second column's c2-4 (240-300).
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    expectDocumentOrder(boxes, [250]);
    expect(boxes.find((b) => b.top + b.height > 250)!.id).toBe("c2-4");
  });
});

describe("useTierScrollAnchor: keeps the reading position across 640", () => {
  // Two layouts: phone (the document scrolls, items 100 high, starting at 100 in the document) and 640 and up (the container scrolls, container top at 60, items 40 high).
  let layout: "phone" | "wide" = "phone";
  let pageY = 0;
  let boxTop = 0;
  let hidden = false;
  let frames: FrameRequestCallback[] = [];
  const PHONE_TOP = 50;

  let phoneSized: boolean | "default" = true;
  function Host({ framed = true }: { framed?: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    useTierScrollAnchor({
      containerRef: ref,
      itemSelector: "[data-i]",
      idAttr: "data-i",
      phoneTop: () => PHONE_TOP,
      mayCrossTiers: phoneSized === "default" ? undefined : () => phoneSized === true,
    });
    const list = (
      <div ref={ref} data-container="">
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} data-i={i} />
        ))}
      </div>
    );
    return framed ? <div {...{ [PHONE_PAGE_SCROLL_ATTR]: "" }}>{list}</div> : list;
  }

  function setup(
    framed = true,
    start: { tier: "phone" | "overlay"; phoneSized: boolean | "default"; others?: (query: string) => boolean } = { tier: "phone", phoneSized: true },
  ): { container: HTMLElement; tier: ReturnType<typeof stubLayoutTier>; beforeReact: (fn: () => void) => void } {
    layout = start.tier === "phone" ? "phone" : "wide";
    phoneSized = start.phoneSized;
    pageY = 0;
    boxTop = 0;
    hidden = false;
    const tier = stubLayoutTier(start.tier, start.others);
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(window, "scrollTo").mockImplementation(((x: number, y: number) => {
      pageY = y;
    }) as typeof window.scrollTo);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.hasAttribute("data-container")) return new DOMRect(0, layout === "phone" ? 100 - pageY : 60, 390, 400);
      const i = Number(this.getAttribute("data-i"));
      return layout === "phone" ? new DOMRect(0, 100 + i * 100 - pageY, 390, 100) : new DOMRect(0, 60 + i * 40 - boxTop, 844, 40);
    });
    vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
      return (hidden ? [] : [this.getBoundingClientRect()]) as unknown as DOMRectList;
    });
    // What must happen after the media query flips and before React is notified (layout swaps, the document is clamped back to 0 and fires scroll): registered before React's listener so it runs first.
    const pending: Array<() => void> = [];
    window.matchMedia(PHONE_QUERY).addEventListener("change", () => pending.splice(0).forEach((fn) => fn()));
    const { container } = render(<Host framed={framed} />);
    const box = container.querySelector<HTMLElement>("[data-container]")!;
    Object.defineProperty(box, "scrollTop", {
      configurable: true,
      get: () => boxTop,
      set: (v: number) => {
        boxTop = v;
      },
    });
    return { container: box, tier, beforeReact: (fn) => pending.push(fn) };
  }

  const scrollOn = (target: EventTarget = document) =>
    act(() => {
      target.dispatchEvent(new Event("scroll"));
      frames.splice(0).forEach((cb) => cb(0));
    });

  it("phone -> 640 and up -> phone: the same item stays near the top; the scroll that clamps to 0 during the switch is not recorded", () => {
    const { tier, beforeReact } = setup();
    pageY = 320; // item 2's top is at -20, which is -70 from the line (50)
    scrollOn();
    beforeReact(() => {
      layout = "wide";
      pageY = 0;
      scrollOn();
    });
    act(() => tier.setLayoutTier("overlay"));
    // 640 and up: item 2 scrolled 70/100 -> new height 40 scrolled 28 -> top at 60 - 28 = 32 -> container scrollTop = 60 + 80 - 32 = 108.
    expect(boxTop).toBe(108);
    beforeReact(() => {
      layout = "phone";
    });
    act(() => tier.setLayoutTier("phone"));
    expect(pageY).toBe(320);
  });

  it("turning right after scrolling ends (one frame apart, no pause): restores the last item scrolled to", () => {
    const { tier, beforeReact } = setup();
    pageY = 320;
    scrollOn();
    pageY = 650; // item 5's bottom is at 50 (exactly on the line, does not count) -> item 6's top is at 50
    scrollOn();
    beforeReact(() => {
      layout = "wide";
      pageY = 0;
    });
    act(() => tier.setLayoutTier("overlay"));
    // Item 6 is 0 from the line -> at 640 and up its top is at 60 -> scrollTop = 60 + 240 - 60 = 240.
    expect(boxTop).toBe(240);
  });

  it("scrolling of other elements (tables, menus) is ignored", () => {
    const { tier, beforeReact } = setup();
    const other = document.createElement("div");
    document.body.append(other);
    pageY = 320;
    scrollOn(other);
    beforeReact(() => {
      layout = "wide";
      pageY = 0;
    });
    act(() => tier.setLayoutTier("overlay"));
    expect(boxTop).toBe(0);
  });

  it("container not inside the frame where the document scrolls on its behalf (the list in a drawer): neither records nor restores", () => {
    const { tier, beforeReact } = setup(false);
    pageY = 320;
    scrollOn();
    beforeReact(() => {
      layout = "wide";
      pageY = 0;
    });
    act(() => tier.setLayoutTier("overlay"));
    expect(boxTop).toBe(0);
  });

  it("container not visible (a list hidden on the note page, a collapsed drawer): neither records nor restores; the position is kept for restoring on return", () => {
    const { container, tier, beforeReact } = setup();
    pageY = 520;
    scrollOn();
    // The document's scrolling while the list is hidden (e.g. on the note page) does not change the position it recorded.
    hidden = true;
    pageY = 900;
    scrollOn();
    beforeReact(() => {
      layout = "wide";
      pageY = 0;
    });
    act(() => tier.setLayoutTier("overlay"));
    expect(boxTop).toBe(0);
    scrollOn(container);
    beforeReact(() => {
      layout = "phone";
      hidden = false;
    });
    act(() => tier.setLayoutTier("phone"));
    expect(pageY).toBe(520);
  });
  it("at most one measurement per frame: several scrolls within a frame are queued once", () => {
    setup();
    pageY = 320;
    act(() => {
      for (let i = 0; i < 5; i++) document.dispatchEvent(new Event("scroll"));
    });
    expect(frames).toHaveLength(1);
  });

  it("640 and up with the screen's short side not narrower than 640 (desktop, tablet): does not queue or measure on scroll", () => {
    const { container } = setup(true, { tier: "overlay", phoneSized: false });
    const rects = vi.mocked(Element.prototype.getBoundingClientRect);
    rects.mockClear();
    boxTop = 100;
    scrollOn(container);
    expect(frames).toHaveLength(0);
    expect(rects).not.toHaveBeenCalled();
  });

  it("a desktop window widened from phone width: the position recorded at phone width is discarded on restore, and narrowing back to phone width does not jump there", () => {
    const { tier, beforeReact } = setup(true, { tier: "phone", phoneSized: false });
    pageY = 320;
    scrollOn();
    beforeReact(() => {
      layout = "wide";
      pageY = 0;
    });
    act(() => tier.setLayoutTier("overlay"));
    expect(boxTop).toBe(108);
    beforeReact(() => {
      layout = "phone";
    });
    act(() => tier.setLayoutTier("phone"));
    expect(pageY).toBe(0);
  });

  it("640 and up with the screen's short side narrower than 640 (a phone held landscape): still records, and restores when turned back to portrait", () => {
    const { container, tier, beforeReact } = setup(true, { tier: "overlay", phoneSized: true });
    boxTop = 80; // item 2's top is at 60 + 80 - 80 = 60 = container top, 0 from the line
    scrollOn(container);
    beforeReact(() => {
      layout = "phone";
    });
    act(() => tier.setLayoutTier("phone"));
    // Phone: item 2's top 300 - pageY must be 50 -> pageY = 250.
    expect(pageY).toBe(250);
  });
  it("default decision: 640 and up, short side not narrower than 640, but the primary pointer is a finger (tablet split screen, foldable) -> still records; a desktop window with a mouse does not", () => {
    vi.stubGlobal("screen", { width: 1024, height: 768 });
    const touch = setup(true, { tier: "overlay", phoneSized: "default", others: (query) => query === "(pointer: coarse)" });
    boxTop = 80;
    scrollOn(touch.container);
    expect(mayCrossTiersByDefault()).toBe(true);
    touch.beforeReact(() => {
      layout = "phone";
    });
    act(() => touch.tier.setLayoutTier("phone"));
    expect(pageY).toBe(250);
  });

  it("default decision: a desktop with a mouse (short side >= 640, precise pointer) does not record; a phone-sized screen does", () => {
    stubLayoutTier("overlay");
    vi.stubGlobal("screen", { width: 1440, height: 900 });
    expect(mayCrossTiersByDefault()).toBe(false);
    vi.stubGlobal("screen", { width: 390, height: 844 });
    expect(mayCrossTiersByDefault()).toBe(true);
    stubLayoutTier("overlay", (query) => query === "(pointer: coarse)");
    vi.stubGlobal("screen", { width: 1180, height: 820 });
    expect(mayCrossTiersByDefault()).toBe(true);
  });
});

describe("useRootFlag", () => {
  function Flag({ on = true }: { on?: boolean }) {
    useRootFlag(ROOT_FLAGS.listShown, on);
    return null;
  }

  it("when active sets a flag on <html>, removed when disabled or unmounted", () => {
    const view = render(<Flag />);
    expect(document.documentElement).toHaveAttribute(ROOT_FLAGS.listShown, "");
    view.rerender(<Flag on={false} />);
    expect(document.documentElement).not.toHaveAttribute(ROOT_FLAGS.listShown);
    view.rerender(<Flag />);
    expect(document.documentElement).toHaveAttribute(ROOT_FLAGS.listShown, "");
    view.unmount();
    expect(document.documentElement).not.toHaveAttribute(ROOT_FLAGS.listShown);
  });

  it("two components want the same flag at once: the one leaving first does not remove it, the last one leaving does", () => {
    const first = render(<Flag />);
    const second = render(<Flag />);
    first.unmount();
    expect(document.documentElement).toHaveAttribute(ROOT_FLAGS.listShown, "");
    second.unmount();
    expect(document.documentElement).not.toHaveAttribute(ROOT_FLAGS.listShown);
  });
});

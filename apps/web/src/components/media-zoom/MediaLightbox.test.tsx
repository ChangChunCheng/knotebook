import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import i18n from "@/i18n";
import { MediaLightbox } from "./MediaLightbox";
import type { ZoomSource } from "./context";
import { fitView, wheelFactor, zoomAt, type Size } from "./zoom-math";

// jsdom has no PointerEvent: add a MouseEvent carrying pointerId/pointerType so fields such as clientX/clientY get in.
class FakePointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  constructor(type: string, init: MouseEventInit & { pointerId?: number; pointerType?: string } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
  }
}

const HINT_EN =
  "Scroll or pinch to zoom and drag to move. Press + or - to zoom, 0 to fit, the arrow keys to move, and Esc to close.";

let viewportSize: Size = { width: 1000, height: 800 };
let observerCallbacks: Array<() => void> = [];

class FakeResizeObserver {
  constructor(cb: () => void) {
    observerCallbacks.push(cb);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function isViewport(el: Element): boolean {
  return el.hasAttribute("data-zoom-viewport");
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  viewportSize = { width: 1000, height: 800 };
  observerCallbacks = [];
  vi.stubGlobal("PointerEvent", FakePointerEvent);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
    return isViewport(this) ? viewportSize.width : 0;
  });
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    return isViewport(this) ? viewportSize.height : 0;
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return isViewport(this) ? new DOMRect(0, 0, viewportSize.width, viewportSize.height) : new DOMRect(0, 0, 0, 0);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BIG: Size = { width: 2000, height: 1000 };

function image(over: Partial<Extract<ZoomSource, { kind: "image" }>> = {}): ZoomSource {
  return { kind: "image", src: "/uploads/alice.png", alt: "alice.png", caption: "Cap", naturalWidth: 2000, naturalHeight: 1000, ...over };
}

function setup(source: ZoomSource = image()) {
  const onClose = vi.fn();
  const restoreFocus = vi.fn();
  render(<MediaLightbox source={source} onClose={onClose} restoreFocus={restoreFocus} />);
  const dialog = screen.getByRole("dialog");
  const viewport = dialog.querySelector<HTMLElement>("[data-zoom-viewport]")!;
  return { onClose, restoreFocus, dialog, viewport };
}

function img(): HTMLImageElement {
  return screen.getByRole("dialog").querySelector("img")!;
}

/** Current position and size of the content element (read back from style). */
function geometry(el: HTMLElement) {
  const m = /translate\((-?[\d.e+-]+)px,\s*(-?[\d.e+-]+)px\)/.exec(el.style.transform);
  if (!m) throw new Error(`no translate in "${el.style.transform}"`);
  return { width: parseFloat(el.style.width), height: parseFloat(el.style.height), x: Number(m[1]), y: Number(m[2]) };
}

/** Image coordinate under window coordinate `p`. */
function contentPointUnder(el: HTMLElement, natural: Size, p: { x: number; y: number }) {
  const g = geometry(el);
  const scale = g.width / natural.width;
  return { x: (p.x - g.x) / scale, y: (p.y - g.y) / scale };
}

function tap(target: Element, x: number, y: number, pointerId = 1, pointerType = "mouse") {
  fireEvent.pointerDown(target, { pointerId, pointerType, clientX: x, clientY: y });
  fireEvent.pointerUp(target, { pointerId, pointerType, clientX: x, clientY: y });
}

describe("MediaLightbox", () => {
  it("a large image is scaled proportionally into the window and centered; the name is the caption, the caption shows under the image, the description is the operation hint", () => {
    const { dialog } = setup();
    const g = geometry(img());
    expect(img().style.width).toBe("1000px");
    expect(img().style.height).toBe("500px");
    expect(img().style.transform).toContain("translate(0px, 150px)");
    expect(g.x).toBe(0);
    expect(screen.getByRole("dialog", { name: "Cap" })).toBe(dialog);
    const visible = within(dialog)
      .getAllByText("Cap")
      .filter(el => !el.classList.contains("sr-only"));
    expect(visible).toHaveLength(1);
    expect(dialog).toHaveAccessibleDescription(HINT_EN);
    expect(img().getAttribute("src")).toBe("/uploads/alice.png");
    expect(img().getAttribute("alt")).toBe("alice.png");
    expect(img().getAttribute("draggable")).toBe("false");
  });

  it("a small image is not enlarged and sits centered at its original size; the name falls back to alt, then \"Image\"", () => {
    setup(image({ naturalWidth: 200, naturalHeight: 100, caption: "", alt: "box.png" }));
    expect(img().style.width).toBe("200px");
    expect(img().style.transform).toContain("translate(400px, 350px)");
    expect(screen.getByRole("dialog", { name: "box.png" })).toBeInTheDocument();
    cleanup();
    setup(image({ caption: "", alt: "" }));
    expect(screen.getByRole("dialog", { name: "Image" })).toBeInTheDocument();
  });

  it("svg: put in with its root id replaced, and the selectors in style follow; the name is \"Diagram\"", () => {
    const { dialog, viewport } = setup({
      kind: "svg",
      svg: '<svg id="mermaid-7" viewBox="0 0 300 200"><style>#mermaid-7 .node{}</style></svg>',
      naturalWidth: 300,
      naturalHeight: 200,
    });
    const svgs = viewport.querySelectorAll("svg");
    expect(svgs).toHaveLength(1);
    expect(dialog.querySelector("img")).toBeNull();
    const svg = svgs[0]!;
    const id = svg.getAttribute("id")!;
    expect(id).not.toBe("mermaid-7");
    expect(id).toMatch(/^mermaid-\d+$/);
    expect(svg.querySelector("style")!.textContent).toBe(`#${id} .node{}`);
    expect(screen.getByRole("dialog", { name: "Diagram" })).toBe(dialog);
    const box = svg.parentElement as HTMLElement;
    expect(box.style.width).toBe("300px");
    expect(box.style.height).toBe("200px");
  });

  it("wheel: zooms in around the cursor, the image coordinate under the cursor is unchanged", () => {
    const { viewport } = setup();
    const anchor = { x: 300, y: 400 };
    const before = contentPointUnder(img(), BIG, anchor);
    fireEvent.wheel(viewport, { deltaY: -100, deltaMode: 0, clientX: anchor.x, clientY: anchor.y });
    const fit = fitView(BIG, viewportSize);
    const expected = zoomAt(fit, fit.scale * wheelFactor(-100, 0, false, 800), anchor, BIG, viewportSize);
    const g = geometry(img());
    expect(g.width).toBeGreaterThan(1000);
    expect(g.width).toBeCloseTo(BIG.width * expected.scale, 6);
    expect(g.x).toBeCloseTo(expected.offset.x, 6);
    expect(g.y).toBeCloseTo(expected.offset.y, 6);
    const after = contentPointUnder(img(), BIG, anchor);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("wheel with an invalid delta: no exception, view unchanged", () => {
    const { viewport } = setup();
    // The event constructor does not accept NaN: build it and replace the field afterwards.
    const event = createEvent.wheel(viewport, { deltaY: -100, clientX: 300, clientY: 400 });
    Object.defineProperty(event, "deltaY", { value: Number.NaN });
    expect(() => fireEvent(viewport, event)).not.toThrow();
    expect(img().style.width).toBe("1000px");
  });

  it("keyboard: + zooms in, - zooms back, 0 returns to fit-to-window, arrow keys move toward the direction of looking; with Ctrl they are not intercepted", () => {
    const { dialog } = setup();
    fireEvent.keyDown(dialog, { key: "+" });
    expect(geometry(img()).width).toBeCloseTo(1200, 6);
    fireEvent.keyDown(dialog, { key: "-" });
    expect(geometry(img()).width).toBeCloseTo(1000, 6);
    fireEvent.keyDown(dialog, { key: "=" });
    fireEvent.keyDown(dialog, { key: "=" });
    expect(geometry(img()).width).toBeCloseTo(1440, 6);
    fireEvent.keyDown(dialog, { key: "0" });
    expect(img().style.width).toBe("1000px");
    expect(img().style.transform).toContain("translate(0px, 150px)");
    fireEvent.keyDown(dialog, { key: "+" });
    fireEvent.keyDown(dialog, { key: "+" });
    const zoomed = geometry(img());
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(geometry(img()).x).toBeCloseTo(zoomed.x - 40, 6);
    fireEvent.keyDown(dialog, { key: "ArrowLeft", shiftKey: true });
    expect(geometry(img()).x).toBeCloseTo(Math.min(0, zoomed.x - 40 + 200), 6);
    const now = geometry(img());
    fireEvent.keyDown(dialog, { key: "+", ctrlKey: true });
    fireEvent.keyDown(dialog, { key: "ArrowRight", metaKey: true });
    expect(geometry(img())).toEqual(now);
  });

  it("Esc calls onClose once; the close button also calls onClose", () => {
    const { dialog, onClose } = setup();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("clicking the background (without moving) closes; clicking on the image does not", () => {
    const { viewport, onClose } = setup();
    tap(img(), 500, 400);
    expect(onClose).not.toHaveBeenCalled();
    tap(viewport, 900, 50);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("double-clicking on the image (100ms apart) toggles zoom and fit-to-window; 400ms apart does not toggle", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    setup();
    vi.setSystemTime(10_000);
    tap(img(), 500, 400);
    vi.setSystemTime(10_100);
    tap(img(), 500, 400);
    // Fit-to-window is 0.5x -> switches to max(1, 2 x 0.5) = 1x
    expect(img().style.width).toBe("2000px");
    vi.setSystemTime(11_000);
    tap(img(), 500, 400);
    vi.setSystemTime(11_100);
    tap(img(), 500, 400);
    expect(img().style.width).toBe("1000px");
    vi.setSystemTime(13_000);
    tap(img(), 500, 400);
    vi.setSystemTime(13_400);
    tap(img(), 500, 400);
    expect(img().style.width).toBe("1000px");
  });

  it("two clicks too far apart (> 24px) do not toggle", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    setup();
    vi.setSystemTime(10_000);
    tap(img(), 300, 400);
    vi.setSystemTime(10_100);
    tap(img(), 360, 400);
    expect(img().style.width).toBe("1000px");
  });

  it("pressing on the background, moving 20px and releasing: a drag, not a click, so it does not close", () => {
    const { viewport, onClose } = setup();
    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 900, clientY: 50 });
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 920, clientY: 50 });
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 920, clientY: 50 });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("drag panning: after zooming in it follows the pointer and cannot be dragged past the content bounds", () => {
    const { dialog, viewport } = setup();
    fireEvent.keyDown(dialog, { key: "+" });
    fireEvent.keyDown(dialog, { key: "+" });
    const start = geometry(img());
    fireEvent.pointerDown(img(), { pointerId: 1, clientX: 500, clientY: 400 });
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 470, clientY: 390 });
    const moved = geometry(img());
    expect(moved.x).toBeCloseTo(start.x - 30, 6);
    expect(moved.y).toBeCloseTo(start.y - 10, 6);
    // Dragged far to the lower right: on the axis where the width exceeds the window the left edge stops at the window's left edge (the content always covers the window);
    // on the axis where the height is smaller than the window it stops with the bottom edge flush to the window's bottom (cannot be dragged out of the window)
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 5000, clientY: 5000 });
    expect(geometry(img()).x).toBe(0);
    expect(geometry(img()).y).toBeCloseTo(800 - 720, 6);
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 5000, clientY: 5000 });
  });

  it("a small image cannot be dragged out of the window", () => {
    const { viewport } = setup(image({ naturalWidth: 200, naturalHeight: 100 }));
    fireEvent.pointerDown(img(), { pointerId: 1, clientX: 500, clientY: 400 });
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: -5000, clientY: -5000 });
    expect(geometry(img()).x).toBe(0);
    expect(geometry(img()).y).toBe(0);
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 5000, clientY: 5000 });
    expect(geometry(img()).x).toBe(800);
    expect(geometry(img()).y).toBe(700);
  });

  it("pointer with an invalid coordinate: no exception, view unchanged", () => {
    const { viewport } = setup();
    fireEvent.pointerDown(img(), { pointerId: 1, clientX: 500, clientY: 400 });
    // The event constructor does not accept NaN: build it and replace the field afterwards.
    const event = createEvent.pointerMove(viewport, { pointerId: 1, clientX: 510, clientY: 400 });
    Object.defineProperty(event, "clientX", { value: Number.NaN });
    expect(() => fireEvent(viewport, event)).not.toThrow();
    expect(img().style.transform).toContain("translate(0px, 150px)");
    // a later normal move still pans (the bad event did not corrupt the start point)
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "+" });
    const zoomed = geometry(img());
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 490, clientY: 400 });
    expect(geometry(img()).x).toBeCloseTo(zoomed.x - 10, 6);
  });

  it("window size change after zooming in: returns to fit-to-window of the new size", () => {
    const { dialog } = setup();
    fireEvent.keyDown(dialog, { key: "+" });
    expect(geometry(img()).width).toBeCloseTo(1200, 6);
    viewportSize = { width: 600, height: 400 };
    act(() => observerCallbacks.forEach(cb => cb()));
    expect(img().style.width).toBe("600px");
    expect(img().style.height).toBe("300px");
    expect(img().style.transform).toContain("translate(0px, 50px)");
  });

  it("a report that the window size did not change does not reset the zoom", () => {
    const { dialog } = setup();
    fireEvent.keyDown(dialog, { key: "+" });
    act(() => observerCallbacks.forEach(cb => cb()));
    expect(geometry(img()).width).toBeCloseTo(1200, 6);
  });

  it("does not render content before the window size has been measured", () => {
    viewportSize = { width: 0, height: 0 };
    const { viewport } = setup();
    expect(viewport.querySelector("img")).toBeNull();
    viewportSize = { width: 1000, height: 800 };
    act(() => observerCallbacks.forEach(cb => cb()));
    expect(img().style.width).toBe("1000px");
  });

  it("two fingers: zooms around the midpoint, the image coordinate under the first midpoint follows the fingers to the new midpoint", () => {
    const { viewport, onClose } = setup();
    const oldMid = { x: 450, y: 400 };
    const before = contentPointUnder(img(), BIG, oldMid);
    fireEvent.pointerDown(img(), { pointerId: 1, clientX: 400, clientY: 400 });
    fireEvent.pointerDown(img(), { pointerId: 2, clientX: 500, clientY: 400 });
    fireEvent.pointerMove(viewport, { pointerId: 2, clientX: 600, clientY: 400 });
    // Finger distance 100 -> 200: zoom 2x (0.5 -> 1)
    expect(geometry(img()).width).toBeCloseTo(2000, 6);
    const newMid = { x: 500, y: 400 };
    const after = contentPointUnder(img(), BIG, newMid);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    fireEvent.pointerUp(viewport, { pointerId: 2, clientX: 600, clientY: 400 });
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 400, clientY: 400 });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("the content sits on the note's card surface: both the image and the svg frame carry bg-card", () => {
    setup();
    expect(img()).toHaveClass("bg-card");
    cleanup();
    const { viewport } = setup({ kind: "svg", svg: '<svg id="mermaid-9" viewBox="0 0 30 20"></svg>', naturalWidth: 30, naturalHeight: 20 });
    expect(viewport.querySelector("svg")!.parentElement).toHaveClass("bg-card");
  });

  it("svg: after pressing and dragging, the window still holds the same svg node (not re-parsed and replaced)", () => {
    const { viewport } = setup({ kind: "svg", svg: '<svg id="mermaid-5" viewBox="0 0 300 200"></svg>', naturalWidth: 300, naturalHeight: 200 });
    const before = viewport.querySelector("svg")!;
    fireEvent.pointerDown(before, { pointerId: 1, clientX: 500, clientY: 400 });
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 520, clientY: 410 });
    expect(viewport.querySelector("svg")).toBe(before);
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 520, clientY: 410 });
    expect(viewport.querySelector("svg")).toBe(before);
  });

  it("root svg without an id: the inner svg's id is not replaced", () => {
    const { viewport } = setup({
      kind: "svg",
      // Pick an inner id that nextMermaidId() will not issue during the test
      svg: '<svg viewBox="0 0 30 20"><svg id="mermaid-9999"></svg><style>#mermaid-9999{}</style></svg>',
      naturalWidth: 30,
      naturalHeight: 20,
    });
    expect(viewport.querySelector("svg svg")!.getAttribute("id")).toBe("mermaid-9999");
    expect(viewport.querySelector("style")!.textContent).toBe("#mermaid-9999{}");
  });

  it("touch and pen on the background: release does not close, it waits for the following click (avoids hitting the page underneath)", () => {
    for (const pointerType of ["touch", "pen"]) {
      const { viewport, onClose } = setup();
      tap(viewport, 900, 50, 1, pointerType);
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.click(viewport);
      expect(onClose).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });

  it("after touching the background with no click following (for example a long press), the next press cancels the pending close: a later click on the image does not close", () => {
    const { viewport, onClose } = setup();
    tap(viewport, 900, 50, 1, "touch");
    tap(img(), 500, 400, 1, "touch");
    fireEvent.click(img());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("mouse click on the background: closes on release, and the following click does not close again", () => {
    const { viewport, onClose } = setup();
    tap(viewport, 900, 50, 1, "mouse");
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(viewport);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a click after a touch drag on the background or a tap on the image does not close", () => {
    const { viewport, onClose } = setup();
    fireEvent.pointerDown(viewport, { pointerId: 1, pointerType: "touch", clientX: 900, clientY: 50 });
    fireEvent.pointerMove(viewport, { pointerId: 1, pointerType: "touch", clientX: 920, clientY: 50 });
    fireEvent.pointerUp(viewport, { pointerId: 1, pointerType: "touch", clientX: 920, clientY: 50 });
    fireEvent.click(viewport);
    tap(img(), 500, 400, 1, "touch");
    fireEvent.click(img());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a pointer that lost pointer capture is no longer tracked: a later single-finger drag with another finger pans instead of pinching", () => {
    const { dialog, viewport } = setup();
    fireEvent.keyDown(dialog, { key: "+" });
    fireEvent.keyDown(dialog, { key: "+" });
    fireEvent.pointerDown(img(), { pointerId: 1, clientX: 500, clientY: 400 });
    fireEvent.lostPointerCapture(viewport, { pointerId: 1 });
    const start = geometry(img());
    fireEvent.pointerDown(img(), { pointerId: 2, clientX: 600, clientY: 400 });
    fireEvent.pointerMove(viewport, { pointerId: 2, clientX: 570, clientY: 390 });
    const moved = geometry(img());
    expect(moved.width).toBeCloseTo(start.width, 6);
    expect(moved.x).toBeCloseTo(start.x - 30, 6);
    expect(moved.y).toBeCloseTo(start.y - 10, 6);
  });

  it("closing (unmount) calls restoreFocus", async () => {
    const restoreFocus = vi.fn();
    function Host() {
      const [open, setOpen] = useState(true);
      return open ? <MediaLightbox source={image()} onClose={() => setOpen(false)} restoreFocus={restoreFocus} /> : null;
    }
    render(<Host />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(restoreFocus).toHaveBeenCalledTimes(1));
  });
});

describe("MediaLightbox handling of the page behind", () => {
  function withPage() {
    const page = document.createElement("main");
    page.innerHTML = "<button>behind</button>";
    document.body.appendChild(page);
    return page;
  }

  afterEach(() => {
    cleanup();
    document.querySelectorAll("body > main").forEach(page => page.remove());
  });

  it("while open it touches nothing on body that would make the whole document recompute styles: no inline style change, no attribute added, no stylesheet inserted", () => {
    withPage();
    const bodyAttrs = () => Array.from(document.body.attributes).map(a => `${a.name}=${a.value}`);
    const before = bodyAttrs();
    const styles = document.querySelectorAll("style").length;
    setup();
    expect(bodyAttrs()).toEqual(before);
    expect(document.body.style.length).toBe(0);
    expect(document.querySelectorAll("style").length).toBe(styles);
  });

  it("the page behind is hidden from assistive technology and restored after closing; the view itself is marked aria-modal", async () => {
    const page = withPage();
    function Host() {
      const [open, setOpen] = useState(true);
      return open ? <MediaLightbox source={image()} onClose={() => setOpen(false)} restoreFocus={() => undefined} /> : null;
    }
    render(<Host />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(page).toHaveAttribute("aria-hidden", "true");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(page).not.toHaveAttribute("aria-hidden");
  });

  it("when only the close button is focusable, Tab and Shift+Tab both stay on it", () => {
    withPage();
    const { dialog } = setup();
    const close = within(dialog).getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(close);
    const tab = createEvent.keyDown(close, { key: "Tab" });
    fireEvent(close, tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(close);
  });

  it("links inside the image (mermaid's click ... href): Tab/Shift+Tab cycle between the links and the close button and never reach the page behind", () => {
    withPage();
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><a href="https://example.com/a"><text>A</text></a><a href="https://example.com/b"><text>B</text></a></svg>';
    const { dialog } = setup({ kind: "svg", svg, naturalWidth: 200, naturalHeight: 100 });
    const [first, second] = Array.from(dialog.querySelectorAll("a"));
    const close = within(dialog).getByRole("button", { name: "Close" });
    act(() => close.focus());
    fireEvent.keyDown(close, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(close);
    act(() => first!.focus());
    // between the links, Tab is left to the browser's document order (not intercepted)
    const middle = createEvent.keyDown(first!, { key: "Tab" });
    fireEvent(first!, middle);
    expect(middle.defaultPrevented).toBe(false);
    act(() => second!.focus());
    const back = createEvent.keyDown(second!, { key: "Tab", shiftKey: true });
    fireEvent(second!, back);
    expect(back.defaultPrevented).toBe(false);
  });

  it("with focus on the view itself (after clicking or dragging the image) Shift+Tab does not go to the page behind but moves to the close button", () => {
    withPage();
    const { dialog } = setup();
    act(() => dialog.focus());
    expect(document.activeElement).toBe(dialog);
    const back = createEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    fireEvent(dialog, back);
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" }));
  });

  it("Alt (Option) with up/down does not scroll the page behind; Alt with left/right (browser back/forward) is left to the browser as usual", () => {
    const { dialog } = setup();
    for (const key of ["ArrowUp", "ArrowDown"]) {
      const event = createEvent.keyDown(dialog, { key, altKey: true });
      fireEvent(dialog, event);
      expect(event.defaultPrevented, `Alt+${key}`).toBe(true);
    }
    for (const key of ["ArrowLeft", "ArrowRight"]) {
      const event = createEvent.keyDown(dialog, { key, altKey: true });
      fireEvent(dialog, event);
      expect(event.defaultPrevented, `Alt+${key}`).toBe(false);
    }
  });

  it("pressing on the scrollbar (target is <html>) does not steal focus; after closing it no longer intercepts", async () => {
    function Host() {
      const [open, setOpen] = useState(true);
      return open ? <MediaLightbox source={image()} onClose={() => setOpen(false)} restoreFocus={() => undefined} /> : null;
    }
    render(<Host />);
    const onRoot = createEvent.mouseDown(document.documentElement);
    fireEvent(document.documentElement, onRoot);
    expect(onRoot.defaultPrevented).toBe(true);
    const inside = within(screen.getByRole("dialog")).getByRole("button", { name: "Close" });
    const onButton = createEvent.mouseDown(inside);
    fireEvent(inside, onButton);
    expect(onButton.defaultPrevented).toBe(false);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const after = createEvent.mouseDown(document.documentElement);
    fireEvent(document.documentElement, after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("Ctrl/Cmd with Home, End, up/down does not scroll the page behind; Ctrl with + and similar are left to the browser as usual", () => {
    const { dialog } = setup();
    for (const [key, mod] of [
      ["Home", "ctrlKey"],
      ["End", "ctrlKey"],
      ["ArrowUp", "metaKey"],
      ["ArrowDown", "metaKey"],
    ] as const) {
      const event = createEvent.keyDown(dialog, { key, [mod]: true });
      fireEvent(dialog, event);
      expect(event.defaultPrevented, `${mod}+${key}`).toBe(true);
    }
    const before = img().style.width;
    const plus = createEvent.keyDown(dialog, { key: "+", ctrlKey: true });
    fireEvent(dialog, plus);
    expect(plus.defaultPrevented).toBe(false);
    expect(img().style.width).toBe(before);
  });

  it("pressing on the scrollbar (target is <html>) does not count as an outside click, so it does not close", async () => {
    const { onClose } = setup();
    // Radix starts listening for outside presses only in the next task
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    // Radix decides "outside click" only on the click after the press
    fireEvent.pointerDown(document.documentElement);
    fireEvent.click(document.documentElement);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("focus moved to the page behind: does not close, focus is pulled back to the close button", () => {
    const page = withPage();
    const { dialog, onClose } = setup();
    act(() => page.querySelector("button")!.focus());
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" }));
  });

  it("page keys, Home/End and Space do not scroll the page behind; Space on the close button works as usual", () => {
    const { dialog } = setup();
    for (const key of ["PageUp", "PageDown", "Home", "End", " "]) {
      const event = createEvent.keyDown(dialog, { key });
      fireEvent(dialog, event);
      expect(event.defaultPrevented, key).toBe(true);
    }
    const close = within(dialog).getByRole("button", { name: "Close" });
    const space = createEvent.keyDown(close, { key: " " });
    fireEvent(close, space);
    expect(space.defaultPrevented).toBe(false);
  });

  it("the wheel on the close button is also blocked (does not scroll the page behind); the whole view does not accept touch scrolling", () => {
    const { dialog } = setup();
    const close = within(dialog).getByRole("button", { name: "Close" });
    const wheel = createEvent.wheel(close, { deltaY: 100, cancelable: true });
    fireEvent(close, wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(dialog).toHaveClass("touch-none");
  });
});

describe("MediaLightbox locking scroll of the page behind", () => {
  function pointer(fine: boolean) {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(pointer: fine)" ? fine : false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
  }
  const root = () => document.documentElement;
  function gutter(width: number) {
    const viewportClientWidth = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")!.get!;
    vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
      return this === document.documentElement ? window.innerWidth - width : viewportClientWidth.call(this);
    });
  }
  function Host() {
    const [open, setOpen] = useState(true);
    return open ? <MediaLightbox source={image()} onClose={() => setOpen(false)} restoreFocus={() => undefined} /> : null;
  }
  async function closeIt() {
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  }

  afterEach(() => {
    root().removeAttribute("style");
  });

  it("mouse device: while open <html> is overflow: hidden; with a space-reserving scrollbar scrollbar-gutter: stable is added; restored after closing", async () => {
    pointer(true);
    gutter(15);
    render(<Host />);
    expect(root().style.overflow).toBe("hidden");
    expect(root().style.getPropertyValue("scrollbar-gutter")).toBe("stable");
    await closeIt();
    expect(root().style.overflow).toBe("");
    expect(root().style.getPropertyValue("scrollbar-gutter")).toBe("");
  });

  it("no space-reserving scrollbar (overlay scrollbars, page does not scroll): only scrolling is locked, no scrollbar-gutter (no empty strip appears)", () => {
    pointer(true);
    gutter(0);
    render(<Host />);
    expect(root().style.overflow).toBe("hidden");
    expect(root().style.getPropertyValue("scrollbar-gutter")).toBe("");
  });

  it("after closing it restores the original inline values (including !important)", async () => {
    pointer(true);
    gutter(15);
    root().style.setProperty("overflow", "clip", "important");
    root().style.setProperty("scrollbar-gutter", "auto");
    render(<Host />);
    expect(root().style.overflow).toBe("hidden");
    await closeIt();
    expect(root().style.getPropertyValue("overflow")).toBe("clip");
    expect(root().style.getPropertyPriority("overflow")).toBe("important");
    expect(root().style.getPropertyValue("scrollbar-gutter")).toBe("auto");
  });

  it("touch device without a scrollbar: <html> style is untouched", () => {
    pointer(false);
    gutter(0);
    render(<Host />);
    expect(root().getAttribute("style")).toBeNull();
  });

  it("mostly touch but with a space-reserving scrollbar (e.g. Windows in tablet mode): still locks scrolling and keeps the scrollbar's place", async () => {
    pointer(false);
    gutter(15);
    render(<Host />);
    expect(root().style.overflow).toBe("hidden");
    expect(root().style.getPropertyValue("scrollbar-gutter")).toBe("stable");
    await closeIt();
    expect(root().getAttribute("style")).toBe("");
  });
});

describe("MediaLightbox loading placeholder", () => {
  it("before the image loads a grey block (original aspect ratio) shows and the image itself is invisible; after load the block goes away and the image appears", () => {
    const { viewport } = setup();
    const skeleton = viewport.querySelector<HTMLElement>("[data-zoom-skeleton]");
    expect(skeleton).not.toBeNull();
    expect(skeleton!.style.aspectRatio).toBe("2000 / 1000");
    expect(img().className).toContain("opacity-0");
    fireEvent.load(img());
    expect(viewport.querySelector("[data-zoom-skeleton]")).toBeNull();
    expect(img().className).not.toContain("opacity-0");
  });

  it("an image load failure also removes the grey block so it is not stuck forever", () => {
    const { viewport } = setup();
    fireEvent.error(img());
    expect(viewport.querySelector("[data-zoom-skeleton]")).toBeNull();
  });

  it("with the grey block showing, Esc and the close button both close", () => {
    const { dialog, onClose } = setup();
    expect(dialog.querySelector("[data-zoom-skeleton]")).not.toBeNull();
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("svg does not wait: no grey block", () => {
    const { viewport } = setup({ kind: "svg", svg: '<svg id="m1"></svg>', naturalWidth: 200, naturalHeight: 100 });
    expect(viewport.querySelector("[data-zoom-skeleton]")).toBeNull();
  });
});

describe("MediaLightbox cursor", () => {
  it("fit-to-window keeps the default cursor; zoomed beyond the window it is grab, while dragging grabbing, back to grab on release; zooming back to fit goes back to default", () => {
    const { dialog, viewport } = setup();
    expect(img().style.cursor).toBe("");
    expect(viewport.style.cursor).toBe("");
    fireEvent.keyDown(dialog, { key: "+" });
    expect(img().style.cursor).toBe("grab");
    expect(viewport.style.cursor).toBe("grab");
    fireEvent.pointerDown(viewport, { pointerId: 1, pointerType: "mouse", clientX: 500, clientY: 400 });
    expect(img().style.cursor).toBe("grabbing");
    expect(viewport.style.cursor).toBe("grabbing");
    fireEvent.pointerUp(viewport, { pointerId: 1, pointerType: "mouse", clientX: 480, clientY: 400 });
    expect(img().style.cursor).toBe("grab");
    expect(viewport.style.cursor).toBe("grab");
    fireEvent.keyDown(dialog, { key: "0" });
    expect(img().style.cursor).toBe("");
    expect(viewport.style.cursor).toBe("");
  });

  it("an svg after zooming is also grab", () => {
    const { dialog } = setup({ kind: "svg", svg: '<svg id="m1"></svg>', naturalWidth: 2000, naturalHeight: 1000 });
    const content = dialog.querySelector<HTMLElement>("[data-zoom-viewport] > div")!;
    expect(content.style.cursor).toBe("");
    fireEvent.keyDown(dialog, { key: "+" });
    expect(content.style.cursor).toBe("grab");
  });
});

describe("MediaLightbox cached image", () => {
  it("image already loaded (complete with an original size): no grey block on render and the image is not invisible", () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(2000);
    const { viewport } = setup();
    expect(viewport.querySelector("[data-zoom-skeleton]")).toBeNull();
    expect(img().className).not.toContain("opacity-0");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import type { VersionListDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { VersionsProvider, useVersionsController } from "@/lib/versions-context";
import { VersionsPanel } from "./VersionsPanel";
import { VERSIONS_ERROR_FRAME } from "./VersionsLazyBoundary";
import { useVersionsPanelWidth } from "./versions-panel-width";
import { stubLayoutTier } from "@/test/layout-tier";

const NOTE = "n1";
const KEY = "versions.panelWidth";
const EMPTY: VersionListDto = {
  versions: [],
  current: { baseSeq: null, base: null, dirty: false, nextSeq: 1, autoEnabled: true },
  nextBefore: null,
};

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(EMPTY) } as Response)),
  );
}

/** Wired like NoteEditor: state lives in the common ancestor of the panel and the error frame, and the width is passed down as a CSS variable. */
function Host({ doc }: { doc: Y.Doc }) {
  const value = useVersionsController({ noteId: NOTE, enabled: true });
  const panelWidth = useVersionsPanelWidth();
  return (
    <VersionsProvider value={value}>
      <div data-testid="row" style={panelWidth.style}>
        <button type="button" onClick={value.open}>host-open</button>
        {value.panelOpen && <VersionsPanel doc={doc} width={panelWidth.width} onWidthChange={panelWidth.onChange} />}
        <div data-testid="error-frame" className={VERSIONS_ERROR_FRAME.panel} />
      </div>
    </VersionsProvider>
  );
}

async function renderPanel() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Host doc={new Y.Doc()} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("host-open"));
  const panel = await screen.findByTestId("versions-panel");
  const handle = screen.getByRole("separator", { name: "Resize versions panel" });
  const row = screen.getByTestId("row");
  return { panel, handle, row };
}
const widthVar = (row: HTMLElement) => row.style.getPropertyValue("--versions-panel-width");

describe("versions panel width handle (#274)", () => {
  let setPointerCapture: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubFetch();
    window.localStorage.removeItem(KEY);
    setPointerCapture = vi.fn();
    Element.prototype.setPointerCapture = setPointerCapture;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (Element.prototype as Partial<Element>).setPointerCapture;
    window.localStorage.removeItem(KEY);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });

  it("default: 320px, aria-valuenow/min/max, focusable, the handle reaches into the gap between the body card and the panel (right-full), and the width goes through a CSS variable", async () => {
    const { panel, handle, row } = await renderPanel();
    expect(widthVar(row)).toBe("320px");
    expect(handle).toHaveAttribute("aria-valuenow", "320");
    expect(handle).toHaveAttribute("aria-valuemin", "240");
    expect(handle).toHaveAttribute("aria-valuemax", "560");
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle.tabIndex).toBe(0);
    expect(panel.contains(handle)).toBe(true);
    // Tab order: the handle is the panel's last child (not the first stop).
    expect(panel.lastElementChild).toBe(handle);
    expect(handle).toHaveClass("absolute", "right-full", "w-3", "cursor-col-resize");
    expect(handle).not.toHaveClass("left-0");
    // The panel root must not clip (overflow-hidden is on the inner layer), or the right-full handle would be clipped.
    expect(panel).not.toHaveClass("overflow-hidden");
    expect(panel.querySelector(":scope > .overflow-hidden")).not.toBeNull();
  });

  it("the handle shows in both the floating and the fixed section (class contract); in the fixed section (xl) the panel is relative and takes its width from the CSS variable, and in the floating section the width is clamped to card width - 3rem", async () => {
    const { panel, handle } = await renderPanel();
    expect(handle).not.toHaveClass("max-md:hidden");
    expect(handle).not.toHaveClass("max-xl:hidden");
    expect(panel).toHaveClass("xl:relative", "xl:w-[var(--versions-panel-width)]", "w-[min(var(--versions-panel-width),calc(100%_-_3rem))]");
    expect(panel).not.toHaveClass("md:w-80");
    expect(panel).not.toHaveClass("xl:w-80");
  });

  it("the handle is outside the panel: the list padding is back to p-2 with no pl-3", async () => {
    const { panel } = await renderPanel();
    const list = panel.querySelector("ul");
    expect(list).not.toBeNull();
    expect(list).toHaveClass("p-2");
    expect(list).not.toHaveClass("pl-3");
  });

  it("the error frame and the panel share one width source (the same CSS variable and the same two-section positioning), with no hard-coded md:w-80", async () => {
    const { panel } = await renderPanel();
    const frame = screen.getByTestId("error-frame");
    expect(frame).toHaveClass("xl:w-[var(--versions-panel-width)]", "w-[min(var(--versions-panel-width),calc(100%_-_3rem))]", "absolute", "xl:relative");
    expect(frame).not.toHaveClass("md:w-80");
    expect(frame).not.toHaveClass("xl:w-80");
    for (const cls of ["absolute", "z-20", "shadow-lg", "xl:relative", "xl:z-30", "xl:shadow-none", "top-[var(--note-header-h,0px)]"]) {
      expect(frame).toHaveClass(cls);
      expect(panel).toHaveClass(cls);
    }
  });

  it("drag: dragging left widens it (the handle is on the left edge), clamped to 240 / 560, locks body while dragging, and writes only on release", async () => {
    const { handle, row } = await renderPanel();

    fireEvent.pointerDown(handle, { button: 0, clientX: 500, pointerId: 1 });
    expect(setPointerCapture).toHaveBeenCalledWith(1);
    expect(document.body.style.userSelect).toBe("none");
    expect(document.body.style.cursor).toBe("col-resize");

    fireEvent.pointerMove(handle, { clientX: 450, pointerId: 1 });
    expect(widthVar(row)).toBe("370px");
    expect(handle).toHaveAttribute("aria-valuenow", "370");
    expect(window.localStorage.getItem(KEY)).toBeNull();

    fireEvent.pointerMove(handle, { clientX: 550, pointerId: 1 });
    expect(widthVar(row)).toBe("270px");

    fireEvent.pointerMove(handle, { clientX: -5000, pointerId: 1 });
    expect(widthVar(row)).toBe("560px");
    fireEvent.pointerMove(handle, { clientX: 5000, pointerId: 1 });
    expect(widthVar(row)).toBe("240px");
    expect(window.localStorage.getItem(KEY)).toBeNull();

    fireEvent.pointerUp(handle, { clientX: 5000, pointerId: 1 });
    expect(window.localStorage.getItem(KEY)).toBe("240");
    expect(document.body.style.userSelect).toBe("");
    expect(document.body.style.cursor).toBe("");

    // Dragging has ended: later moves no longer change the width (clientX 450 would compute to 370 if it had not ended).
    fireEvent.pointerMove(handle, { clientX: 450, pointerId: 1 });
    expect(widthVar(row)).toBe("240px");
  });

  it("keyboard: outward (ArrowLeft) widens by 16px, ArrowRight narrows, Home / End, and every press writes", async () => {
    const { handle, row } = await renderPanel();

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(widthVar(row)).toBe("336px");
    expect(window.localStorage.getItem(KEY)).toBe("336");

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(widthVar(row)).toBe("304px");
    expect(window.localStorage.getItem(KEY)).toBe("304");

    fireEvent.keyDown(handle, { key: "Home" });
    expect(widthVar(row)).toBe("240px");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(widthVar(row)).toBe("240px");

    fireEvent.keyDown(handle, { key: "End" });
    expect(widthVar(row)).toBe("560px");
    expect(window.localStorage.getItem(KEY)).toBe("560");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(widthVar(row)).toBe("560px");
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(handle).toHaveAttribute("aria-valuenow", "560");
  });

  it("double-click returns to 320 and clears the stored value", async () => {
    const { handle, row } = await renderPanel();
    fireEvent.keyDown(handle, { key: "End" });
    expect(window.localStorage.getItem(KEY)).toBe("560");
    fireEvent.doubleClick(handle);
    expect(widthVar(row)).toBe("320px");
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("leaves the sidebar's key alone: sidebar.width is untouched", async () => {
    window.localStorage.setItem("sidebar.width", "300");
    const { handle } = await renderPanel();
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(window.localStorage.getItem("sidebar.width")).toBe("300");
    expect(window.localStorage.getItem(KEY)).toBe("336");
  });

  /** Setting 560 with only 300 actually available (the floating section is squeezed by CSS). */
  function stubClamped(tier: "overlay" | "docked") {
    window.localStorage.setItem(KEY, "560");
    stubLayoutTier(tier);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly cb: () => void) {}
        observe() {
          this.cb();
        }
        unobserve() {}
        disconnect() {}
      },
    );
    const original = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return this.getAttribute("data-testid") === "versions-panel" ? ({ width: 300 } as DOMRect) : original.call(this);
    });
  }

  it("when the floating section is squeezed by CSS (setting 560, actual 300): aria-valuenow reports the actual width and widening does not lower the setting", async () => {
    stubClamped("overlay");
    const { handle, row } = await renderPanel();
    expect(widthVar(row)).toBe("560px");
    expect(handle).toHaveAttribute("aria-valuenow", "300");
    // Widening direction, not yet past the setting: nothing is written, so the setting is not lowered.
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(widthVar(row)).toBe("560px");
    expect(window.localStorage.getItem(KEY)).toBe("560");
    // narrowing starts from the actual width (300 - 16), and is written
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(widthVar(row)).toBe("284px");
    expect(window.localStorage.getItem(KEY)).toBe("284");
  });

  it("when the floating section is squeezed: press and release without moving leaves the setting unchanged", async () => {
    stubClamped("overlay");
    const { handle } = await renderPanel();
    fireEvent.pointerDown(handle, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 500, pointerId: 1 });
    expect(window.localStorage.getItem(KEY)).toBe("560");
  });

  it("fixed section (the width is not clamped): the measured width is not used, and aria-valuenow and the keyboard both start from the setting", async () => {
    stubClamped("docked");
    const { handle } = await renderPanel();
    expect(handle).toHaveAttribute("aria-valuenow", "560");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(window.localStorage.getItem(KEY)).toBe("544");
  });

  it.each([
    ["abc", "320"],
    ["9999", "320"],
    ["100", "320"],
    ["300.5", "320"],
    ["", "320"],
    ["400", "400"],
  ])("reading %j -> %spx", async (raw, expected) => {
    window.localStorage.setItem(KEY, raw);
    const { row, handle } = await renderPanel();
    expect(widthVar(row)).toBe(`${expected}px`);
    expect(handle).toHaveAttribute("aria-valuenow", expected);
  });
});

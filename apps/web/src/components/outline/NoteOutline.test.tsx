import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutlineHeading } from "./headings";
import { NoteOutline, type NoteOutlineProps } from "./NoteOutline";
import { jumpToHeading } from "./outline-jump";
import { outlineMaxHeight, outlinePlacement } from "./outline-layout";

const jump = vi.hoisted(() => ({ cancels: [] as Array<ReturnType<typeof vi.fn>> }));
vi.mock("./outline-jump", () => ({
  jumpToHeading: vi.fn(() => {
    const cancel = vi.fn();
    jump.cancels.push(cancel);
    return cancel;
  }),
}));

const HEADINGS: OutlineHeading[] = [
  { id: "h-intro", level: 1, text: "Intro" },
  { id: "h-install", level: 2, text: "Install" },
  { id: "h-linux", level: 3, text: "Linux" },
  { id: "h-usage", level: 2, text: "Usage" },
];
const BOX = { width: 1072, height: 700, columnRight: 991.5 };

let scrollEl: HTMLElement;

beforeEach(() => {
  jump.cancels = [];
  vi.mocked(jumpToHeading).mockClear();
  scrollEl = document.createElement("div");
  for (const h of HEADINGS) {
    const block = document.createElement("div");
    block.className = "bn-block-outer";
    block.dataset.id = h.id;
    scrollEl.appendChild(block);
  }
  document.body.appendChild(scrollEl);
});
afterEach(() => {
  scrollEl.remove();
});

function setup(over: Partial<NoteOutlineProps> = {}) {
  const props: NoteOutlineProps = {
    headings: HEADINGS,
    scrollEl,
    box: BOX,
    bubbleShown: true,
    pinned: false,
    pinAvailable: false,
    onPinnedChange: vi.fn(),
    ...over,
  };
  return { props, view: render(<NoteOutline {...props} />) };
}

const rail = () => screen.getByTestId("outline-rail");
const panel = () => screen.queryByTestId("outline-panel");
const item = (id: string) => document.querySelector<HTMLButtonElement>(`[data-outline-item="${id}"]`);
/** Keyboard-style activation (`detail: 0`) opens the panel at once, without the hover delay. */
const openPanel = () => fireEvent.click(rail(), { detail: 0 });

describe("NoteOutline", () => {
  it("renders nothing without headings", () => {
    const { view } = setup({ headings: [] });
    expect(view.container).toBeEmptyDOMElement();
    expect(document.querySelector("[data-outline-anchor]")).toBeNull();
  });

  it("mounts the rail in a zero-height anchor, placed from the measured box and kept above the version bubble", () => {
    setup();
    const anchor = document.querySelector<HTMLElement>("[data-outline-anchor]")!;
    expect(anchor).toHaveClass("pointer-events-none", "relative", "z-20", "h-0", "shrink-0");
    expect(anchor.contains(rail())).toBe(true);
    const placement = outlinePlacement(BOX.width, BOX.columnRight);
    expect(rail().style.left).toBe(`${placement.railLeft}px`);
    expect(rail().style.maxHeight).toBe(`${outlineMaxHeight(BOX.height, true)}px`);
  });

  it("without the version bubble the rail may reach lower", () => {
    setup({ bubbleShown: false });
    expect(rail().style.maxHeight).toBe(`${outlineMaxHeight(BOX.height, false)}px`);
  });

  it("jumps inside the scroll container, cancels the previous jump on the next one and the last one on unmount", () => {
    const { view } = setup();
    openPanel();
    fireEvent.click(item("h-install")!);
    expect(jumpToHeading).toHaveBeenCalledTimes(1);
    expect(jumpToHeading).toHaveBeenLastCalledWith(scrollEl, "h-install");
    // The floating panel closes after a jump; the clicked heading is the current one.
    expect(panel()).toBeNull();
    expect(rail().querySelectorAll("[data-active]")).toHaveLength(1);
    expect(rail().children[1]).toHaveAttribute("data-active");

    openPanel();
    expect(item("h-install")).toHaveAttribute("aria-current", "location");
    fireEvent.click(item("h-usage")!);
    expect(jumpToHeading).toHaveBeenLastCalledWith(scrollEl, "h-usage");
    expect(jump.cancels).toHaveLength(2);
    expect(jump.cancels[0]).toHaveBeenCalledTimes(1);
    expect(jump.cancels[1]).not.toHaveBeenCalled();

    view.unmount();
    expect(jump.cancels[1]).toHaveBeenCalledTimes(1);
    expect(jump.cancels[0]).toHaveBeenCalledTimes(1);
  });

  it("keeps working when the headings change under an open panel and drop the current one", () => {
    const { view, props } = setup();
    openPanel();
    fireEvent.click(item("h-usage")!);
    openPanel();
    expect(item("h-usage")).toHaveAttribute("aria-current", "location");

    const next = HEADINGS.filter((h) => h.id !== "h-usage");
    view.rerender(<NoteOutline {...props} headings={next} />);
    expect(panel()).not.toBeNull();
    expect(item("h-usage")).toBeNull();
    expect(screen.getByText("Linux")).toBeInTheDocument();
    expect(rail().children).toHaveLength(3);

    fireEvent.click(item("h-linux")!);
    expect(jumpToHeading).toHaveBeenLastCalledWith(scrollEl, "h-linux");
  });
});

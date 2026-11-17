import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutlineHeading } from "./headings";
import { jumpToHeading } from "./outline-jump";
import type { OutlineScrollBubbleProps } from "./OutlineScrollBubble";
import type { OutlineSheetProps } from "./OutlineSheet";
import { PhoneNoteOutline, type PhoneNoteOutlineProps } from "./PhoneNoteOutline";

const stubs = vi.hoisted(() => ({ bubble: [] as OutlineScrollBubbleProps[], sheet: [] as OutlineSheetProps[], cancels: [] as Array<() => void> }));
vi.mock("./outline-jump", () => ({
  jumpToHeading: vi.fn(() => {
    const cancel = vi.fn();
    stubs.cancels.push(cancel);
    return cancel;
  }),
}));
vi.mock("./OutlineScrollBubble", () => ({
  OutlineScrollBubble: (props: OutlineScrollBubbleProps) => {
    stubs.bubble.push(props);
    return <button type="button" data-testid="bubble-stub" />;
  },
}));
vi.mock("./OutlineSheet", () => ({
  OutlineSheet: (props: OutlineSheetProps) => {
    stubs.sheet.push(props);
    return <div data-testid="sheet-stub" />;
  },
}));

const HEADINGS: OutlineHeading[] = [
  { id: "h-intro", level: 1, text: "Intro" },
  { id: "h-usage", level: 2, text: "Usage" },
];

let root: HTMLElement;

beforeEach(() => {
  stubs.bubble = [];
  stubs.sheet = [];
  stubs.cancels = [];
  vi.mocked(jumpToHeading).mockClear();
  root = document.createElement("div");
  document.body.appendChild(root);
  return () => root.remove();
});

function setup(over: Partial<PhoneNoteOutlineProps> = {}) {
  const props: PhoneNoteOutlineProps = {
    headings: HEADINGS,
    root,
    scrollTarget: window,
    topEdge: () => 0,
    placement: "page",
    sheetOpen: false,
    onSheetOpenChange: vi.fn(),
    onOpenSheet: vi.fn(),
    ...over,
  };
  return { props, view: render(<PhoneNoteOutline {...props} />) };
}

const lastBubble = () => stubs.bubble[stubs.bubble.length - 1]!;
const lastSheet = () => stubs.sheet[stubs.sheet.length - 1]!;

describe("PhoneNoteOutline", () => {
  it("renders nothing without headings", () => {
    const { view } = setup({ headings: [] });
    expect(view.container).toBeEmptyDOMElement();
    expect(stubs.bubble).toHaveLength(0);
    expect(stubs.sheet).toHaveLength(0);
  });

  it("passes the scroll target, placement, editor and sheet state through; tapping the bubble is onOpenSheet", () => {
    const inputRoot = document.createElement("div");
    const restoreFocus = vi.fn();
    const { props } = setup({ inputRoot, sheetOpen: true, restoreFocus });
    // While the sheet is up the bubble is held (it may be where focus returns).
    expect(lastBubble()).toMatchObject({ headings: HEADINGS, scrollTarget: window, placement: "page", inputRoot, hold: true, onOpen: props.onOpenSheet });
    expect(lastSheet()).toMatchObject({ open: true, headings: HEADINGS, onOpenChange: props.onSheetOpenChange, restoreFocus });
  });

  it("`page` places the bubble directly; `anchor` puts it in the zero-height outline anchor", () => {
    const page = setup().view;
    expect(screen.getByTestId("bubble-stub").closest("[data-outline-anchor]")).toBeNull();
    page.unmount();
    setup({ placement: "anchor", scrollTarget: root });
    expect(screen.getByTestId("bubble-stub").closest("[data-outline-anchor]")).not.toBeNull();
  });

  it("picking a heading jumps inside the root and makes it current; a second pick cancels the first jump", () => {
    setup();
    act(() => lastSheet().onJump("h-usage"));
    expect(jumpToHeading).toHaveBeenCalledWith(root, "h-usage");
    expect(lastBubble().activeId).toBe("h-usage");
    expect(lastSheet().activeId).toBe("h-usage");
    act(() => lastSheet().onJump("h-intro"));
    expect(stubs.cancels[0]).toHaveBeenCalledTimes(1);
    expect(lastSheet().activeId).toBe("h-intro");
  });

  it("cancels a pending jump on unmount", () => {
    const { view } = setup();
    act(() => lastSheet().onJump("h-usage"));
    view.unmount();
    expect(stubs.cancels[0]).toHaveBeenCalledTimes(1);
  });
});

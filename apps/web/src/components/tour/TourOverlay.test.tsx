import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { cardSurface } from "@/components/ui/card";
import { isOverlayOpen } from "@/lib/versions-context";
import { HOLE_PADDING, HOLE_RADIUS } from "./geometry";
import { TourOverlay, type TourOverlayProps } from "./TourOverlay";

const TARGET = { left: 500, top: 100, width: 80, height: 40 };

function handlers() {
  return {
    onNext: vi.fn(),
    onBack: vi.fn(),
    onSkip: vi.fn(),
    onClose: vi.fn(),
    onKeep: vi.fn(),
    onDelete: vi.fn(),
  };
}

function renderOverlay(overrides: Partial<TourOverlayProps> = {}) {
  const h = handlers();
  const props: TourOverlayProps = { target: TARGET, step: 2, total: 5, title: "Search", body: "Press Ctrl+K to search.", ...h, ...overrides };
  const view = render(<TourOverlay {...props} />);
  return { ...view, h, props, rerenderWith: (next: Partial<TourOverlayProps>) => view.rerender(<TourOverlay {...props} {...next} />) };
}

const card = () => screen.getByRole("dialog");
const hintRegion = () => card().querySelector('[aria-live="polite"]:not([data-tour-step-announcement])');
const stepRegion = () => document.querySelector("[data-tour-step-announcement]");
const buttonNames = () => Array.from(card().querySelectorAll("button")).map((b) => b.getAttribute("aria-label") ?? b.textContent);

/** Document capture listener: BlockNote menus' "click outside to close" (floating-ui `useDismiss`) lives at this layer. */
function documentCaptureSpy(type: string) {
  const spy = vi.fn();
  document.addEventListener(type, spy, true);
  return { spy, remove: () => document.removeEventListener(type, spy, true) };
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("card role and name", () => {
  it("role=dialog, aria-modal=false, name is the title, description is the body, has data-tour-card", () => {
    renderOverlay();
    const dialog = screen.getByRole("dialog", { name: "Search" });
    expect(dialog).toHaveAttribute("aria-modal", "false");
    expect(dialog).toHaveAccessibleDescription("Press Ctrl+K to search.");
    expect(dialog).toHaveAttribute("data-tour-card");
  });

  it("stop count is shown as n / N", () => {
    renderOverlay({ step: 2, total: 5 });
    expect(card()).toHaveTextContent("2 / 5");
  });
});

describe("buttons by stop position", () => {
  it("stop 1: Skip, Next, close; no Back", () => {
    renderOverlay({ step: 1, total: 5 });
    expect(buttonNames()).toEqual(["Skip feature tour", "Next", "Close"]);
  });

  it("middle stop: Back, Next, close; no Skip", () => {
    renderOverlay({ step: 3, total: 5 });
    expect(buttonNames()).toEqual(["Back", "Next", "Close"]);
  });

  it("last stop: Back, Keep, Delete, close; no Next", () => {
    renderOverlay({ step: 5, total: 5 });
    expect(buttonNames()).toEqual(["Back", "Keep sample note", "Delete sample note", "Close"]);
  });

  it("with a single stop: stop 1 is also the last, with only Keep, Delete, close (no Skip)", () => {
    renderOverlay({ step: 1, total: 1 });
    expect(buttonNames()).toEqual(["Keep sample note", "Delete sample note", "Close"]);
  });

  it("each button calls its own action", () => {
    const first = renderOverlay({ step: 1, total: 5 });
    fireEvent.click(screen.getByRole("button", { name: "Skip feature tour" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(first.h.onSkip).toHaveBeenCalledTimes(1);
    expect(first.h.onNext).toHaveBeenCalledTimes(1);
    expect(first.h.onClose).toHaveBeenCalledTimes(1);
    first.unmount();

    const last = renderOverlay({ step: 5, total: 5 });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep sample note" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete sample note" }));
    expect(last.h.onBack).toHaveBeenCalledTimes(1);
    expect(last.h.onKeep).toHaveBeenCalledTimes(1);
    expect(last.h.onDelete).toHaveBeenCalledTimes(1);
    expect(last.h.onNext).not.toHaveBeenCalled();
  });

  it("zh-TW button labels", async () => {
    await i18n.changeLanguage("zh-TW");
    const { unmount } = renderOverlay({ step: 1, total: 5 });
    expect(buttonNames()).toEqual(["跳過功能導覽", "下一步", "關閉"]);
    unmount();
    renderOverlay({ step: 5, total: 5 });
    expect(buttonNames()).toEqual(["上一步", "保留示範筆記", "刪除示範筆記", "關閉"]);
    expect(screen.getByRole("button", { name: "刪除示範筆記" })).toHaveTextContent("刪除");
  });
});

describe("site-wide shortcuts yield while the tour is open", () => {
  it("isOverlayOpen() is true while mounted and false after unmounting", () => {
    expect(isOverlayOpen()).toBe(false);
    const { unmount } = renderOverlay();
    expect(isOverlayOpen()).toBe(true);
    unmount();
    expect(isOverlayOpen()).toBe(false);
  });
});

describe("card surface", () => {
  it("uses cardSurface", () => {
    renderOverlay();
    for (const cls of cardSurface.split(" ")) expect(card()).toHaveClass(cls);
  });

  it("no default browser outline when the card container itself is focused", () => {
    renderOverlay();
    expect(card()).toHaveClass("outline-none");
  });
});

describe("live stop mode", () => {
  it("has an aria-live=polite hint for changing stops with the arrow keys and ending with Esc", () => {
    renderOverlay({ live: true });
    const region = hintRegion();
    expect(region).not.toBeNull();
    expect(region).toHaveTextContent("← → to change stops, Esc to end");
  });

  it("a regular stop has no hint text, but the live region is mounted ahead of time (so it is announced when switching to a live stop)", () => {
    const view = renderOverlay();
    const region = hintRegion();
    expect(region).not.toBeNull();
    expect(region).toHaveTextContent("");
    view.rerenderWith({ live: true });
    expect(hintRegion()).toBe(region);
    expect(region).toHaveTextContent("← → to change stops, Esc to end");
  });
});

describe("screen readers announce the new stop on a stop change", () => {
  it("no announcement on mount (the dialog itself is read when focus enters the card); after a stop change it announces n / N, title, body", () => {
    const view = renderOverlay({ step: 2, total: 5 });
    const region = stepRegion();
    expect(region).not.toBeNull();
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveClass("sr-only");
    expect(region).toHaveTextContent(/^$/);
    view.rerenderWith({ step: 3, title: "Folders", body: "Create folders here." });
    expect(stepRegion()).toBe(region);
    expect(region).toHaveTextContent("3 / 5: Folders. Create folders here.");
  });

  it("stop change is judged by stopKey: the same stop with only a new number and body (crossing a layout) is not announced again; a stop change with the same number is still announced", () => {
    const view = renderOverlay({ step: 7, stopKey: 6, total: 10, title: "Link", body: "Type [[." });
    const region = stepRegion();
    view.rerenderWith({ step: 7, stopKey: 7, total: 9, title: "Slash", body: "Type /." });
    expect(region).toHaveTextContent("7 / 9: Slash. Type /.");
    view.rerenderWith({ step: 8, stopKey: 7, total: 10, title: "Slash", body: "Type / anywhere." });
    expect(region).toHaveTextContent("7 / 9: Slash. Type /.");
  });

  it("going back is announced too; the live region stays the same element (no remount)", () => {
    const view = renderOverlay({ step: 3, total: 5, title: "Folders", body: "Create folders here." });
    const region = stepRegion();
    view.rerenderWith({ step: 2, title: "New note", body: "Click here to create a note." });
    expect(region).toHaveTextContent("2 / 5: New note. Click here to create a note.");
    view.rerenderWith({ step: 5, title: "Forgot how something works?", body: "Press Ctrl+/." });
    expect(stepRegion()).toBe(region);
    expect(region).toHaveTextContent("5 / 5: Forgot how something works? Press Ctrl+/.");
    expect(region).not.toHaveTextContent("?.");
  });

  it("a title ending in punctuation gets no extra period (English and Chinese endings); one without punctuation gets one", async () => {
    const view = renderOverlay({ step: 1, total: 5 });
    let step = 1;
    const read = (title: string) => {
      view.rerenderWith({ step: ++step, title, body: "Body." });
      return stepRegion()!.textContent;
    };
    expect(read("Done.")).toMatch(/: Done\. Body\.$/);
    expect(read("Why!")).toMatch(/: Why! Body\.$/);
    expect(read("Wait…")).toMatch(/: Wait… Body\.$/);
    expect(read("Wait⋯")).toMatch(/: Wait⋯ Body\.$/);
    expect(read('Say "Done."')).toMatch(/: Say "Done\." Body\.$/);
    expect(read("Is it done?)")).toMatch(/: Is it done\?\) Body\.$/);
    expect(read("Say “Done.”")).toMatch(/: Say “Done\.” Body\.$/);
    expect(read('Say "Done"')).toMatch(/: Say "Done"\. Body\.$/);
    expect(read("Plain")).toMatch(/: Plain\. Body\.$/);
    await i18n.changeLanguage("zh-TW");
    expect(read("忘了怎麼用？")).toMatch(/：忘了怎麼用？Body\.$/);
    expect(read("好了。")).toMatch(/：好了。Body\.$/);
    expect(read("好了⋯⋯")).toMatch(/：好了⋯⋯Body\.$/);
    expect(read("好了．")).toMatch(/：好了．Body\.$/);
    expect(read("他說「好了。」")).toMatch(/：他說「好了。」Body\.$/);
    expect(read("他說『好了？』")).toMatch(/：他說『好了？』Body\.$/);
    expect(read("好了（真的。）")).toMatch(/：好了（真的。）Body\.$/);
    expect(read("他說「好了」")).toMatch(/：他說「好了」。Body\.$/);
    expect(read("忘了")).toMatch(/：忘了。Body\.$/);
  });

  it("zh-TW format", async () => {
    await i18n.changeLanguage("zh-TW");
    const view = renderOverlay({ step: 1, total: 4, title: "側欄分類", body: "側欄有五個分類。" });
    view.rerenderWith({ step: 2, title: "新增筆記", body: "按這裡新增一篇筆記。" });
    expect(stepRegion()).toHaveTextContent("2 / 4：新增筆記。按這裡新增一篇筆記。");
  });
});

describe("window-capture pointerdown interception", () => {
  it("card button, card text, overlay: defaultPrevented, and the document capture listener does not receive it", () => {
    renderOverlay();
    const targets = [
      screen.getByRole("button", { name: "Next" }),
      screen.getByText("Press Ctrl+K to search."),
      document.querySelector("[data-tour-overlay] svg")!,
      document.querySelector("[data-tour-overlay]")!,
    ];
    for (const el of targets) {
      const doc = documentCaptureSpy("pointerdown");
      const notCancelled = fireEvent.pointerDown(el);
      doc.remove();
      expect(notCancelled, el.tagName).toBe(false);
      expect(doc.spy, el.tagName).not.toHaveBeenCalled();
    }
  });

  it("anything other than the overlay and card (e.g. a toast) is not intercepted", () => {
    renderOverlay();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    const doc = documentCaptureSpy("pointerdown");
    const notCancelled = fireEvent.pointerDown(outside);
    doc.remove();
    outside.remove();
    expect(notCancelled).toBe(true);
    expect(doc.spy).toHaveBeenCalledTimes(1);
  });

  it("after pointerdown is intercepted, the button's click still fires its action", () => {
    const first = renderOverlay({ step: 1, total: 5 });
    for (const name of ["Skip feature tour", "Next", "Close"]) {
      const btn = screen.getByRole("button", { name });
      fireEvent.pointerDown(btn);
      fireEvent.click(btn);
    }
    expect(first.h.onSkip).toHaveBeenCalledTimes(1);
    expect(first.h.onNext).toHaveBeenCalledTimes(1);
    expect(first.h.onClose).toHaveBeenCalledTimes(1);
    first.unmount();

    const last = renderOverlay({ step: 5, total: 5 });
    for (const name of ["Back", "Keep sample note", "Delete sample note"]) {
      const btn = screen.getByRole("button", { name });
      fireEvent.pointerDown(btn);
      fireEvent.click(btn);
    }
    expect(last.h.onBack).toHaveBeenCalledTimes(1);
    expect(last.h.onKeep).toHaveBeenCalledTimes(1);
    expect(last.h.onDelete).toHaveBeenCalledTimes(1);
  });

  it("listener is removed on unmount (same function, same capture flag)", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderOverlay();
    const added = add.mock.calls.filter(([type]) => type === "pointerdown");
    expect(added).toHaveLength(1);
    expect(added[0]![2]).toBe(true);
    unmount();
    const removed = remove.mock.calls.filter(([type]) => type === "pointerdown");
    expect(removed).toEqual([["pointerdown", added[0]![1], true]]);
  });
});

describe("no 'show on every login' option", () => {
  it("no checkbox in the card", () => {
    renderOverlay({ step: 1, total: 5 });
    expect(card().querySelector('input[type="checkbox"], [role="checkbox"], [role="switch"]')).toBeNull();
  });
});

describe("last stop", () => {
  it("both buttons' aria-describedby point at the question; the body text has its own element", () => {
    renderOverlay({ step: 5, total: 5, body: "Press Ctrl+/ or open Help from here." });
    const question = screen.getByText("Keep the sample note, or move it to the trash?");
    expect(question.id).not.toBe("");
    for (const name of ["Keep sample note", "Delete sample note"]) {
      const btn = screen.getByRole("button", { name });
      expect(btn.getAttribute("aria-describedby")).toBe(question.id);
      expect(btn).toHaveAccessibleDescription("Keep the sample note, or move it to the trash?");
    }
    expect(card()).toHaveAccessibleDescription("Press Ctrl+/ or open Help from here.");
  });

  it("Delete's accessible name contains its visible text and it looks destructive; Keep does not", () => {
    renderOverlay({ step: 5, total: 5 });
    const del = screen.getByRole("button", { name: "Delete sample note" });
    expect(del).toHaveTextContent("Delete");
    expect(del).toHaveClass("text-destructive");
    expect(screen.getByRole("button", { name: "Keep sample note" })).not.toHaveClass("text-destructive");
  });

  it("other stops do not have the question", () => {
    renderOverlay({ step: 4, total: 5 });
    expect(screen.queryByText("Keep the sample note, or move it to the trash?")).toBeNull();
  });

  it("default focus is on Keep sample note; Tab goes to Delete, then close", () => {
    renderOverlay({ step: 5, total: 5 });
    expect(screen.getByRole("button", { name: "Keep sample note" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Delete sample note" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });
});

describe("focus and Tab loop", () => {
  it("a regular stop focuses Next by default; focus returns to Next after a stop change", () => {
    const view = renderOverlay({ step: 2, total: 5 });
    const next = screen.getByRole("button", { name: "Next" });
    expect(next).toHaveFocus();
    screen.getByRole("button", { name: "Back" }).focus();
    view.rerenderWith({ step: 3 });
    expect(screen.getByRole("button", { name: "Next" })).toHaveFocus();
  });

  it("on reaching the last stop focus moves to Keep sample note", () => {
    const view = renderOverlay({ step: 4, total: 5 });
    view.rerenderWith({ step: 5 });
    expect(screen.getByRole("button", { name: "Keep sample note" })).toHaveFocus();
  });

  it("a live stop does not take focus (it stays in the editor)", () => {
    const editor = document.createElement("div");
    editor.tabIndex = 0;
    document.body.appendChild(editor);
    editor.focus();
    const view = renderOverlay({ live: true });
    expect(editor).toHaveFocus();
    view.rerenderWith({ step: 3 });
    expect(editor).toHaveFocus();
    view.unmount();
    editor.remove();
  });

  it("Tab after the last button returns to the first and Shift+Tab on the first returns to the last; the event does not propagate further", () => {
    renderOverlay({ step: 2, total: 5 });
    const back = screen.getByRole("button", { name: "Back" });
    const next = screen.getByRole("button", { name: "Next" });
    const close = screen.getByRole("button", { name: "Close" });
    const doc = documentCaptureSpy("keydown");
    fireEvent.keyDown(next, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab" });
    expect(back).toHaveFocus();
    fireEvent.keyDown(back, { key: "Tab", shiftKey: true });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(next).toHaveFocus();
    doc.remove();
    expect(doc.spy).not.toHaveBeenCalled();
  });

  it("a live stop does not intercept Tab (focus stays in the editor and the live stop handles it; pulling focus into the card would close the menu)", () => {
    renderOverlay({ live: true });
    const editor = document.createElement("div");
    editor.tabIndex = 0;
    document.body.appendChild(editor);
    editor.focus();
    for (const shiftKey of [false, true]) {
      const doc = documentCaptureSpy("keydown");
      const notCancelled = fireEvent.keyDown(editor, { key: "Tab", shiftKey });
      doc.remove();
      expect(notCancelled).toBe(true);
      expect(doc.spy).toHaveBeenCalledTimes(1);
      expect(editor).toHaveFocus();
    }
    editor.remove();
  });

  it("when focus is outside the card, Tab brings it back into the card", () => {
    renderOverlay({ step: 2, total: 5 });
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    fireEvent.keyDown(outside, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Back" })).toHaveFocus();
    outside.focus();
    fireEvent.keyDown(outside, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    outside.remove();
  });
});

describe("Esc", () => {
  it("taken at window capture: Esc closes even when focus is outside the card (e.g. in the editor), and the document listener does not receive it", () => {
    const { h } = renderOverlay({ live: true });
    const editor = document.createElement("div");
    editor.tabIndex = 0;
    document.body.appendChild(editor);
    editor.focus();
    const doc = documentCaptureSpy("keydown");
    const notCancelled = fireEvent.keyDown(editor, { key: "Escape" });
    doc.remove();
    editor.remove();
    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(notCancelled).toBe(false);
    expect(doc.spy).not.toHaveBeenCalled();
  });

  it.each([
    ["isComposing", { isComposing: true }],
    ["keyCode 229", { keyCode: 229 }],
  ])("Esc during IME composition is left to the IME (%s): does not close or intercept", (_name, init) => {
    const { h } = renderOverlay({ live: true });
    const editor = document.createElement("div");
    editor.tabIndex = 0;
    document.body.appendChild(editor);
    editor.focus();
    const doc = documentCaptureSpy("keydown");
    const notCancelled = fireEvent.keyDown(editor, { key: "Escape", ...init });
    doc.remove();
    editor.remove();
    expect(h.onClose).not.toHaveBeenCalled();
    expect(notCancelled).toBe(true);
    expect(doc.spy).toHaveBeenCalledTimes(1);
  });

  it("with focus inside the card it still closes once", () => {
    const { h } = renderOverlay();
    fireEvent.keyDown(screen.getByRole("button", { name: "Next" }), { key: "Escape" });
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it("other keys are not intercepted (live-stop keyboard is handled separately)", () => {
    const { h } = renderOverlay({ live: true });
    const doc = documentCaptureSpy("keydown");
    const notCancelled = fireEvent.keyDown(document.body, { key: "a" });
    doc.remove();
    expect(notCancelled).toBe(true);
    expect(doc.spy).toHaveBeenCalledTimes(1);
    expect(h.onClose).not.toHaveBeenCalled();
  });

  it("Esc no longer calls after unmount", () => {
    const { h, unmount } = renderOverlay();
    unmount();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(h.onClose).not.toHaveBeenCalled();
  });

  it("always uses the latest onClose (a new function passed in after a stop change)", () => {
    const view = renderOverlay();
    const latest = vi.fn();
    view.rerenderWith({ onClose: latest });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(view.h.onClose).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
  });
});

describe("overlay: hole, outline, arrow", () => {
  const hole = () => document.querySelector("[data-tour-hole]");
  const ring = () => document.querySelector("[data-tour-ring]");

  it("hole and outline extend 6px beyond the target with an 8px corner radius", () => {
    renderOverlay();
    for (const el of [hole(), ring()]) {
      expect(el).not.toBeNull();
      expect(el).toHaveAttribute("x", String(TARGET.left - HOLE_PADDING));
      expect(el).toHaveAttribute("y", String(TARGET.top - HOLE_PADDING));
      expect(el).toHaveAttribute("width", String(TARGET.width + HOLE_PADDING * 2));
      expect(el).toHaveAttribute("height", String(TARGET.height + HOLE_PADDING * 2));
      expect(el).toHaveAttribute("rx", String(HOLE_RADIUS));
    }
    expect(ring()).toHaveAttribute("stroke-width", "2");
    expect(ring()).toHaveClass("stroke-brand");
  });

  it("when the target moves the hole follows", () => {
    const view = renderOverlay();
    view.rerenderWith({ target: { left: 40, top: 300, width: 10, height: 10 } });
    expect(hole()).toHaveAttribute("x", String(40 - HOLE_PADDING));
    expect(hole()).toHaveAttribute("y", String(300 - HOLE_PADDING));
  });

  it("draws an arrow when there is a target; with no target there is no hole or arrow and the card is still shown", () => {
    const view = renderOverlay();
    expect(document.querySelector("[data-tour-arrow]")).not.toBeNull();
    view.rerenderWith({ target: null });
    expect(hole()).toBeNull();
    expect(ring()).toBeNull();
    expect(document.querySelector("[data-tour-arrow]")).toBeNull();
    expect(card()).toBeInTheDocument();
  });

  it("the overlay is fixed full-screen with z-[95], rendered under body (unaffected by the page's stacking contexts)", () => {
    renderOverlay();
    const root = document.querySelector("[data-tour-overlay]")!;
    expect(root.parentElement).toBe(document.body);
    expect(root).toHaveClass("fixed", "inset-0", "z-[95]");
    expect(root.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("forced-colors: the outline uses Highlight, and an extra CanvasText outline appears only in high contrast", () => {
    renderOverlay();
    expect(ring()).toHaveClass("forced-colors:stroke-[Highlight]");
    const outline = document.querySelector("[data-tour-ring-contrast]");
    expect(outline).not.toBeNull();
    expect(outline).toHaveClass("hidden", "forced-colors:inline", "forced-colors:stroke-[CanvasText]");
  });

  it("hole, outline, arrow and card have no transitions and jump together to the new position on a stop change (so there is no animation to disable for prefers-reduced-motion)", () => {
    renderOverlay();
    const parts = [hole()!, ring()!, document.querySelector("[data-tour-ring-contrast]")!, document.querySelector("[data-tour-arrow]")!, card()];
    for (const el of parts) {
      expect(el).not.toBeNull();
      const classes = (el.getAttribute("class") ?? "").split(/\s+/);
      expect(classes.filter((c) => /(^|:)(transition|duration|animate)/.test(c)), el.tagName).toEqual([]);
      expect((el as HTMLElement | SVGElement).style.transition, el.tagName).toBe("");
    }
  });
});

describe("card position", () => {
  it("placed below the target when it fits below (using the card's actual size)", () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(320);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(160);
    renderOverlay();
    const style = card().style;
    expect(style.left).toBe(`${TARGET.left + TARGET.width / 2 - 160}px`);
    expect(Number.parseFloat(style.top)).toBeGreaterThan(TARGET.top + TARGET.height);
  });

  it("repositions when the card size changes (a longer body after a stop change); stops observing on unmount", () => {
    const observers: { cb: ResizeObserverCallback; observed: Element[]; disconnected: boolean }[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        entry: (typeof observers)[number];
        constructor(cb: ResizeObserverCallback) {
          this.entry = { cb, observed: [], disconnected: false };
          observers.push(this.entry);
        }
        observe(el: Element) {
          this.entry.observed.push(el);
        }
        unobserve() {}
        disconnect() {
          this.entry.disconnected = true;
        }
      },
    );
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(160);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(320);
    const { unmount } = renderOverlay({ target: null });
    expect(card().style.top).toBe(`${(window.innerHeight - 160) / 2}px`);
    const mine = observers.find((o) => o.observed.includes(card()));
    expect(mine).toBeDefined();
    height.mockReturnValue(300);
    act(() => mine!.cb([], {} as ResizeObserver));
    expect(card().style.top).toBe(`${(window.innerHeight - 300) / 2}px`);
    unmount();
    expect(mine!.disconnected).toBe(true);
  });

  it("recomputes the position when the window is resized", () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(320);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(160);
    renderOverlay({ target: null });
    const before = card().style.left;
    const original = window.innerWidth;
    act(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 600 });
      window.dispatchEvent(new Event("resize"));
    });
    expect(card().style.left).toBe(`${(600 - 320) / 2}px`);
    expect(card().style.left).not.toBe(before);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: original });
  });
});

describe("the card avoids the safe area and the bands given by the caller", () => {
  function sized() {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(320);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(160);
  }

  it("keepOut: with no hole the card is centered between the bands and the max height subtracts them", () => {
    sized();
    renderOverlay({ target: null, keepOut: { top: 100, right: 0, bottom: 200, left: 0 } });
    const top = 100 + 8;
    const bottom = window.innerHeight - 200 - 8;
    expect(card().style.top).toBe(`${(top + bottom - 160) / 2}px`);
    expect(card().style.maxHeight).toBe(`${bottom - top}px`);
  });

  it("safe area (a measuring element reading env()): the card stays out of the notch and the home indicator", () => {
    sized();
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element, pseudo?: string | null) => {
      const style = real(el, pseudo);
      if (!(el instanceof HTMLElement) || !el.className.includes("safe-area-inset-top")) return style;
      return { ...style, paddingTop: "47px", paddingRight: "0px", paddingBottom: "34px", paddingLeft: "0px" } as CSSStyleDeclaration;
    });
    // The hole hugs the viewport top: without the safe area the card would sit right below the hole.
    renderOverlay({ target: { left: 20, top: 0, width: 40, height: 10 } });
    expect(Number.parseFloat(card().style.top)).toBeGreaterThanOrEqual(47 + 8);
    expect(card().style.maxHeight).toBe(`${window.innerHeight - 47 - 34 - 16}px`);
  });

  it("per side the larger of safe area and keepOut", () => {
    sized();
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element, pseudo?: string | null) => {
      const style = real(el, pseudo);
      if (!(el instanceof HTMLElement) || !el.className.includes("safe-area-inset-top")) return style;
      return { ...style, paddingTop: "47px", paddingRight: "0px", paddingBottom: "34px", paddingLeft: "0px" } as CSSStyleDeclaration;
    });
    renderOverlay({ target: null, keepOut: { top: 20, right: 0, bottom: 90, left: 0 } });
    expect(card().style.maxHeight).toBe(`${window.innerHeight - 47 - 90 - 16}px`);
  });
});

describe("card is hidden while the screen changes", () => {
  it("hidden: the card is invisible while the overlay stays; once shown, focus returns to the primary action", () => {
    const view = renderOverlay({ hidden: true, target: null });
    expect(card()).toHaveClass("invisible");
    expect(document.querySelector("[data-tour-overlay]")).not.toBeNull();
    (document.activeElement as HTMLElement | null)?.blur();
    view.rerenderWith({ hidden: false, target: null });
    expect(card()).not.toHaveClass("invisible");
    expect(screen.getByRole("button", { name: "Next" })).toHaveFocus();
  });
});

describe("covered area (on-screen keyboard)", () => {
  it("blocked: the card always avoids it, even when the screen is small enough that keepOut is dropped", () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(320);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(160);
    const keepOut = { top: window.innerHeight / 2, right: 0, bottom: window.innerHeight / 2, left: 0 };
    renderOverlay({ target: null, keepOut, blocked: { top: 0, right: 0, bottom: 300, left: 0 } });
    expect(card().style.maxHeight).toBe(`${window.innerHeight - 300 - 16}px`);
    expect(Number.parseFloat(card().style.top) + 160).toBeLessThanOrEqual(window.innerHeight - 300 - 8);
  });
});

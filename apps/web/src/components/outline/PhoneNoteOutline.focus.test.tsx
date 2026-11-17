import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { OutlineHeading } from "./headings";
import { OUTLINE_BUBBLE_HIDE_MS } from "./OutlineScrollBubble";
import { focusBackTo } from "./OutlineSheet";
import { PhoneNoteOutline } from "./PhoneNoteOutline";

// Real bubble and real sheet: where focus lands when the sheet opened from the bubble closes.

const HEADINGS: OutlineHeading[] = [
  { id: "h-intro", level: 1, text: "Intro" },
  { id: "h-usage", level: 2, text: "Usage" },
];

/** Wires the sheet like the pages do: the bubble's hand-over becomes the sheet's focus return. */
function Host({ scroller }: { scroller: HTMLElement }) {
  const [open, setOpen] = useState(false);
  const [returnTo, setReturnTo] = useState<HTMLElement | null>(null);
  return (
    <PhoneNoteOutline
      headings={HEADINGS}
      root={scroller}
      scrollTarget={scroller}
      topEdge={() => 0}
      placement="anchor"
      sheetOpen={open}
      onSheetOpenChange={setOpen}
      onOpenSheet={(el) => {
        setReturnTo(el);
        setOpen(true);
      }}
      restoreFocus={focusBackTo(returnTo)}
    />
  );
}

let scroller: HTMLDivElement;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.useFakeTimers();
  scroller = document.createElement("div");
  document.body.appendChild(scroller);
});
afterEach(() => {
  vi.useRealTimers();
  scroller.remove();
});

const bubble = () => screen.queryByRole("button", { name: /^Open heading outline: / });
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const scroll = () => act(() => void scroller.dispatchEvent(new Event("scroll")));
const dialog = () => screen.queryByRole("dialog", { name: "Heading outline" });
const pressEscape = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

describe("PhoneNoteOutline: focus around the bubble and the sheet", () => {
  it("keyboard: focus the bubble, open, wait past the countdown, close → focus is back on the bubble", () => {
    render(<Host scroller={scroller} />);
    scroll();
    const chip = bubble()!;
    act(() => chip.focus());
    fireEvent.click(chip);
    expect(dialog()).not.toBeNull();
    // Focus moved into the sheet; the bubble lost it but is held while the sheet is up.
    expect(chip.contains(document.activeElement)).toBe(false);
    advance(OUTLINE_BUBBLE_HIDE_MS + 500);
    // (The modal sheet hides the rest of the page from the accessibility tree, so check the node itself.)
    expect(chip.isConnected).toBe(true);
    pressEscape();
    advance(50);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(chip);
    // Focused, it stays.
    advance(OUTLINE_BUBBLE_HIDE_MS + 500);
    expect(bubble()).toBe(chip);
  });

  it("touch: tap the bubble (it never takes focus), open, close → focus is not put on the bubble, which then counts down", () => {
    render(<Host scroller={scroller} />);
    scroll();
    const chip = bubble()!;
    fireEvent.pointerDown(chip);
    fireEvent.click(chip);
    expect(dialog()).not.toBeNull();
    advance(OUTLINE_BUBBLE_HIDE_MS + 500);
    expect(chip.isConnected).toBe(true);
    pressEscape();
    advance(50);
    expect(dialog()).toBeNull();
    expect(document.activeElement).not.toBe(chip);
    advance(OUTLINE_BUBBLE_HIDE_MS);
    expect(bubble()).toBeNull();
  });
});

import { createRef, useRef, useState, type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubLayoutTier } from "@/test/layout-tier";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "@/i18n";
import { ShortcutsDialog } from "./ShortcutsDialog";

/**
 * The shortcut guide's dialog shell: lazy boundary, name and description (sr-only DialogTitle/Description), focus (opening focuses the content area,
 * Tab cycles between the content area and the close button, closing returns focus). The content component is replaced by a stand-in - its own behaviour is in
 * ShortcutsLazy.test.tsx, and together with the shell in ShortcutsDialog.panel.test.tsx.
 *
 * The open=false case must be the first `it` in this file: a `vi.mock` factory runs once per file and the `React.lazy` result is cached for good
 * (same technique as App.lazyPages.test.tsx). `mockState.loaded` is set by the factory - the factory running is lazy's first dynamic import -
 * so that case asserts it is still false when open=false, and a static import would turn it red.
 */

const mockState = vi.hoisted(() => ({ loaded: false }));

vi.mock("@/components/shortcuts/ShortcutsLazy", () => {
  mockState.loaded = true;
  // The stand-in reproduces only the contract the shell depends on: a focusable `[data-shortcuts-content]` content area; it must not contain other focusable elements
  // (otherwise it is no longer the last tabbable). On phones the shell passes `listBack` (the category list's back arrow) and the stand-in draws that one too.
  // The real content component's layout, category switching and focus are in ShortcutsLazy.test.tsx and ShortcutsDialog.panel.test.tsx.
  return {
    ShortcutsContent: ({ listBack }: { listBack?: { label: string; onBack: () => void } }) => (
      <>
        {listBack && (
          <button type="button" data-shortcuts-focus="" onClick={listBack.onBack}>
            {listBack.label}
          </button>
        )}
        <div data-shortcuts-content="" data-shortcuts-focus={listBack ? undefined : ""} role="region" aria-label="stub region" tabIndex={0}>
          stub shortcuts content
        </div>
      </>
    ),
  };
});

/** Each case builds its own ref: when a timer leaks into the next case (after Radix unmounts, setTimeout(0) fires onCloseAutoFocus) it does not touch another case's ref. */
function newRef(): RefObject<HTMLElement | null> {
  return createRef<HTMLElement>();
}

function ui(open: boolean, onOpenChange: (open: boolean) => void, returnFocusRef: RefObject<HTMLElement | null> = newRef()) {
  return (
    <>
      <button type="button">opener</button>
      <button type="button">target</button>
      <ShortcutsDialog open={open} onOpenChange={onOpenChange} returnFocusRef={returnFocusRef} />
    </>
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

describe("ShortcutsDialog", () => {
  it("open=false: no dialog, the content chunk is not loaded yet", () => {
    render(ui(false, () => {}));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mockState.loaded).toBe(false);
  });

  it("open=true: the dialog has a name and description, the content appears, the close button is named Close", async () => {
    render(ui(true, () => {}));
    const dialog = await screen.findByRole("dialog", { name: "Help" });
    expect(dialog).toHaveAccessibleDescription("Feature tour, what is new in this version, and common keyboard shortcuts and typing triggers");
    expect(await screen.findByText("stub shortcuts content")).toBeInTheDocument();
    expect(mockState.loaded).toBe(true);
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("Esc and clicking the close button both call onOpenChange(false)", async () => {
    const onOpenChange = vi.fn();
    render(ui(true, onOpenChange));
    await screen.findByRole("dialog", { name: "Help" });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    onOpenChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("after closing, focus returns to the element returnFocusRef points at (not whatever happened to have focus before opening)", async () => {
    const onOpenChange = vi.fn();
    const ref = newRef();
    const view = render(ui(false, onOpenChange, ref));
    const opener = screen.getByRole("button", { name: "opener" });
    const target = screen.getByRole("button", { name: "target" });
    opener.focus();
    ref.current = target;
    view.rerender(ui(true, onOpenChange, ref));
    await screen.findByRole("dialog", { name: "Help" });
    view.rerender(ui(false, onOpenChange, ref));
    await waitFor(() => expect(target).toHaveFocus());
  });

  it("returnFocusRef pointing at a removed element: closing does not throw", async () => {
    const onOpenChange = vi.fn();
    const ref = newRef();
    const view = render(ui(false, onOpenChange, ref));
    const gone = document.createElement("button");
    ref.current = gone; // never attached to the document: isConnected is false
    view.rerender(ui(true, onOpenChange, ref));
    await screen.findByRole("dialog", { name: "Help" });
    expect(() => view.rerender(ui(false, onOpenChange, ref))).not.toThrow();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(ref.current).toBeNull();
  });

  it("when the content chunk was already loaded, opening again lands focus directly in the content area", async () => {
    const onOpenChange = vi.fn();
    const ref = newRef();
    const view = render(ui(true, onOpenChange, ref));
    await screen.findByRole("region", { name: "stub region" });
    view.rerender(ui(false, onOpenChange, ref));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    view.rerender(ui(true, onOpenChange, ref));
    const region = await screen.findByRole("region", { name: "stub region" });
    await waitFor(() => expect(region).toHaveFocus());
  });

  describe("phone (< 640): no close button, the category list's back arrow", () => {
    afterEach(() => vi.unstubAllGlobals());

    function Controlled({ reopen, returnFocusRef }: { reopen: (() => void) | null; returnFocusRef: RefObject<HTMLElement | null> }) {
      const reopenRef = useRef<(() => void) | null>(reopen);
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button">target</button>
          <ShortcutsDialog open={open} onOpenChange={setOpen} returnFocusRef={returnFocusRef} reopenMenuRef={reopenRef} />
        </>
      );
    }

    it("opening lands focus on the list's back arrow (inside the dialog, the visible layer), not on the hidden content area", async () => {
      stubLayoutTier("phone");
      render(<Controlled reopen={vi.fn()} returnFocusRef={newRef()} />);
      const dialog = await screen.findByRole("dialog", { name: "Help" });
      const back = await screen.findByRole("button", { name: "Back to menu" });
      await waitFor(() => expect(back).toHaveFocus());
      expect(dialog.contains(document.activeElement)).toBe(true);
    });

    it("opened at 640 or wider and then shrunk to phone width: the list's back arrow is named Close, pressing it only closes and does not reopen the menu", async () => {
      const tier = stubLayoutTier("overlay");
      const reopen = vi.fn();
      render(<Controlled reopen={reopen} returnFocusRef={newRef()} />);
      await screen.findByRole("dialog", { name: "Help" });
      act(() => tier.setLayoutTier("phone"));
      expect(screen.queryByRole("button", { name: "Back to menu" })).toBeNull();
      fireEvent.click(await screen.findByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await new Promise((r) => setTimeout(r, 20));
      expect(reopen).not.toHaveBeenCalled();
    });

    it("opened from the menu: \"Back to menu\" closes, then reopens the menu once the close finishes (no focus return)", async () => {
      stubLayoutTier("phone");
      const reopen = vi.fn();
      const returnFocusRef = newRef();
      render(<Controlled reopen={reopen} returnFocusRef={returnFocusRef} />);
      returnFocusRef.current = screen.getByRole("button", { name: "target", hidden: true });
      await screen.findByRole("dialog", { name: "Help" });
      expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
      fireEvent.click(await screen.findByRole("button", { name: "Back to menu" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(reopen).toHaveBeenCalledTimes(1));
      expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "target" }));
    });

    it("not opened from the menu: the back arrow is named Close, only closes, focus is returned as usual; Esc also closes and does not reopen the menu", async () => {
      stubLayoutTier("phone");
      const returnFocusRef = newRef();
      render(<Controlled reopen={null} returnFocusRef={returnFocusRef} />);
      returnFocusRef.current = screen.getByRole("button", { name: "target", hidden: true });
      fireEvent.click(await screen.findByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "target" })));
      cleanup();

      const reopen = vi.fn();
      const ref2 = newRef();
      render(<Controlled reopen={reopen} returnFocusRef={ref2} />);
      fireEvent.keyDown(await screen.findByRole("dialog", { name: "Help" }), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await new Promise((r) => setTimeout(r, 20));
      expect(reopen).not.toHaveBeenCalled();
    });
  });

  it("Tab cycles between the content area and the close button (FocusScope loop; the close button is first in the DOM)", async () => {
    render(ui(true, () => {}));
    const region = await screen.findByRole("region", { name: "stub region" });
    region.focus();
    const close = screen.getByRole("button", { name: "Close" });
    fireEvent.keyDown(region, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(region).toHaveFocus();
  });

  it("the dialog itself is outline-none: on first open focus first lands on Content (chunk not arrived) and the browser's default focus-visible outline (a white flash) must not be drawn", async () => {
    render(ui(true, () => {}));
    const dialog = await screen.findByRole("dialog", { name: "Help" });
    expect(dialog).toHaveAttribute("data-shortcuts-dialog");
    expect(dialog).toHaveClass("outline-none");
  });
});

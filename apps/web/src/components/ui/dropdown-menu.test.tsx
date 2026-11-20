import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PHONE_QUERY } from "@/lib/layout-tiers";
import { stubLayoutTier } from "@/test/layout-tier";
import { clickOutside } from "@/test/outside-click";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuMainLevel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu";

function renderOpenMenu() {
  render(
    <DropdownMenu open>
      <DropdownMenuTrigger>open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>plain item</DropdownMenuItem>
        <DropdownMenuCheckboxItem checked>checkbox item</DropdownMenuCheckboxItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>sub trigger</DropdownMenuSubTrigger>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
}

describe("menu items grow to at least 40px on coarse pointers", () => {
  it.each([
    ["menuitem", "plain item"],
    ["menuitemcheckbox", "checkbox item"],
    ["menuitem", "sub trigger"],
  ] as const)("%s '%s': pointer-coarse:py-2.5 on top of py-1.5", (role, name) => {
    renderOpenMenu();
    const item = screen.getByRole(role, { name });
    expect(item).toHaveClass("py-1.5");
    expect(item).toHaveClass("pointer-coarse:py-2.5");
  });
});

describe("phoneSheet: on phones (< 640) it is a bottom sheet and other widths are unchanged", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function Harness({ phoneSheet = true, onSelect }: { phoneSheet?: boolean; onSelect?: () => void }) {
    return (
      <DropdownMenu phoneSheet={phoneSheet}>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent sheetTitle="Row title" className="max-w-72 min-w-56">
          <DropdownMenuItem onSelect={onSelect}>first</DropdownMenuItem>
          <DropdownMenuSeparator data-testid="sep" />
          <DropdownMenuItem>second</DropdownMenuItem>
          <DropdownMenuRadioGroup value="a">
            <DropdownMenuRadioItem value="a" sheetRow>
              row radio
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="b">dot radio</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  /** One browser click: pointerdown then click (Radix originally opens on pointerdown; the sheet form opens on click). */
  function open(): HTMLElement {
    const trigger = screen.getByRole("button", { name: "open" });
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);
    return screen.getByRole("menu");
  }

  const SHEET_CLASSES = [
    "kb-menu-sheet",
    "kb-sheet",
    "w-full",
    "max-w-none",
    "min-w-0",
    "rounded-t-xl",
    "rounded-b-none",
    "pb-[max(0.5rem,env(safe-area-inset-bottom))]",
    "mb-(--kb-inset,0px)",
    "max-h-[calc(var(--kb-visible-h,100dvh)*0.85)]",
    "overflow-y-auto",
  ];

  it("phone: the content is a sheet (full width, rounded top, bottom safe area, follows the keyboard, kb-sheet enter/exit) and the caller's width limit is overridden; the small heading is at the top followed by a separator", () => {
    stubLayoutTier("phone");
    render(<Harness />);
    const menu = open();
    expect(menu).toHaveAttribute("data-menu-sheet");
    expect(menu).toHaveClass(...SHEET_CLASSES);
    expect(menu).not.toHaveClass("max-w-72");
    expect(menu).not.toHaveClass("min-w-56");
    const title = within(menu).getByText("Row title");
    expect(title).toHaveClass("truncate");
    expect(menu.firstElementChild).toBe(title);
    expect(title.nextElementSibling).toHaveAttribute("role", "separator");
  });

  it("phone: rows are at least 48px tall with 16px text (replacing the coarse-pointer py-2.5); the separator extends to both sides (-mx-2); a sheetRow RadioItem is a row too, a color-dot one is not", () => {
    stubLayoutTier("phone");
    render(<Harness />);
    const menu = open();
    for (const name of ["first", "second"]) {
      const item = within(menu).getByRole("menuitem", { name });
      expect(item).toHaveClass("min-h-12", "text-base", "pointer-coarse:py-2");
      expect(item).not.toHaveClass("text-sm");
      expect(item).not.toHaveClass("pointer-coarse:py-2.5");
    }
    expect(screen.getByTestId("sep")).toHaveClass("-mx-2");
    expect(within(menu).getByRole("menuitemradio", { name: "row radio" })).toHaveClass("min-h-12", "text-base");
    expect(within(menu).getByRole("menuitemradio", { name: "dot radio" })).not.toHaveClass("min-h-12");
  });

  it.each([["floating (640-1279)", "overlay"], ["docked (>= 1280)", "docked"]] as const)("%s: same as without phoneSheet (no sheet classes, no small heading, rows and separator unchanged)", (_label, tier) => {
    stubLayoutTier(tier);
    render(<Harness />);
    const menu = open();
    expect(menu).not.toHaveAttribute("data-menu-sheet");
    expect(menu.className).not.toMatch(/kb-menu-sheet|kb-sheet|rounded-t-xl|--kb-inset/);
    expect(menu).toHaveClass("max-w-72", "min-w-56", "rounded-md", "p-1");
    expect(within(menu).queryByText("Row title")).toBeNull();
    const item = within(menu).getByRole("menuitem", { name: "first" });
    expect(item).toHaveClass("py-1.5", "pointer-coarse:py-2.5", "text-sm");
    expect(item).not.toHaveClass("min-h-12");
    expect(screen.getByTestId("sep")).toHaveClass("-mx-1");
    expect(screen.getByTestId("sep")).not.toHaveClass("-mx-2");
  });

  it("phone without phoneSheet: still a small menu", () => {
    stubLayoutTier("phone");
    render(<Harness phoneSheet={false} />);
    const menu = open();
    expect(menu).not.toHaveAttribute("data-menu-sheet");
    expect(menu.className).not.toMatch(/kb-menu-sheet/);
    expect(within(menu).queryByText("Row title")).toBeNull();
  });

  it("phone: still a Radix menu - role menu/menuitem, arrow keys move focus, choosing an item closes it, Esc closes it and focus returns to the trigger button", async () => {
    stubLayoutTier("phone");
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    let menu = open();
    const first = within(menu).getByRole("menuitem", { name: "first" });
    act(() => first.focus());
    await waitFor(() => expect(document.activeElement).toBe(first));
    fireEvent.keyDown(first, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "second" })));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "open" }));
    menu = open();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "first" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("phone: clicking outside the sheet (the backdrop) closes it", async () => {
    stubLayoutTier("phone");
    render(<Harness />);
    open();
    await clickOutside();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("the phone check subscribes only while the menu is open (each sidebar row's kebab menu does not hold its own subscription normally)", async () => {
    const handle = stubLayoutTier("phone");
    render(<Harness />);
    expect(handle.listenerCount(PHONE_QUERY)).toBe(0);
    open();
    expect(handle.listenerCount(PHONE_QUERY)).toBe(1);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(handle.listenerCount(PHONE_QUERY)).toBe(0);
  });

  it("phone: while open, writes the keyboard height (--kb-inset) and the visible height (--kb-visible-h) onto the content; other widths do not", () => {
    const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
    const viewport = Object.assign(new EventTarget(), { height: 500, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true, writable: true });
    vi.stubGlobal("innerHeight", 844);
    try {
      stubLayoutTier("phone");
      render(<Harness />);
      const style = open().style;
      expect(style.getPropertyValue("--kb-inset")).toBe("344px");
      expect(style.getPropertyValue("--kb-visible-h")).toBe("500px");
      cleanup();
      stubLayoutTier("docked");
      render(<Harness />);
      expect(open().style.getPropertyValue("--kb-inset")).toBe("");
    } finally {
      if (original) Object.defineProperty(window, "visualViewport", original);
      else delete (window as { visualViewport?: unknown }).visualViewport;
    }
  });
});

describe("DropdownMenuMainLevel: in a phone sheet the main level is not rendered while a submenu is expanded", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function renderLevel(drilled: boolean) {
    render(
      <DropdownMenu open phoneSheet>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuMainLevel drilled={drilled}>
            <DropdownMenuItem>main item</DropdownMenuItem>
          </DropdownMenuMainLevel>
          <DropdownMenuItem>submenu row</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
  }

  it("phone sheet: drilled -> main-level items are absent; not drilled -> present", () => {
    stubLayoutTier("phone");
    renderLevel(true);
    expect(screen.queryByRole("menuitem", { name: "main item" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "submenu row" })).toBeInTheDocument();
    cleanup();
    renderLevel(false);
    expect(screen.getByRole("menuitem", { name: "main item" })).toBeInTheDocument();
  });

  it("not a sheet (640 and up): drilled still renders normally (the in-place expansion does not replace the content)", () => {
    stubLayoutTier("overlay");
    renderLevel(true);
    expect(screen.getByRole("menuitem", { name: "main item" })).toBeInTheDocument();
  });
});

describe("when phoneSheet opens: the sheet form does not open on pointerdown (so the same tap's click does not land on the just-raised menu item)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function Harness({ phoneSheet = true, onSelect, onOpenChange, open }: { phoneSheet?: boolean; onSelect?: () => void; onOpenChange?: (open: boolean) => void; open?: boolean }) {
    return (
      <DropdownMenu phoneSheet={phoneSheet} open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={onSelect}>first</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  // While a menu is open Radix marks everything outside it as aria-hidden: grab the trigger before opening.
  const trigger = () => screen.getByRole("button", { name: "open", hidden: true });

  it("phone: pointerdown is blocked and does not open; the click of the same tap opens it and selects no item", () => {
    stubLayoutTier("phone");
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    expect(fireEvent.pointerDown(trigger(), { button: 0 })).toBe(false);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(trigger());
    expect(screen.getByRole("menu")).toHaveAttribute("data-menu-sheet");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("phone: a click whose pointerdown did not occur on this button (e.g. pressing on the backdrop to close the menu and releasing on the button) does not open it; an assistive-technology click (detail 0) still opens it", () => {
    stubLayoutTier("phone");
    render(<Harness />);
    fireEvent.click(trigger(), { detail: 1 });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(trigger(), { detail: 0 });
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("phone: when scrolling takes over after pressing (pointercancel) or capture is lost before release (dragged away), the later click does not open it; a normal touch release (lostpointercapture after pointerup) still opens it", () => {
    stubLayoutTier("phone");
    render(<Harness />);
    fireEvent.pointerDown(trigger(), { button: 0 });
    fireEvent.pointerCancel(trigger());
    fireEvent.click(trigger(), { detail: 1 });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.pointerDown(trigger(), { button: 0 });
    fireEvent.lostPointerCapture(trigger());
    fireEvent.click(trigger(), { detail: 1 });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.pointerDown(trigger(), { button: 0 });
    fireEvent.pointerUp(trigger());
    fireEvent.lostPointerCapture(trigger());
    fireEvent.click(trigger(), { detail: 1 });
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("phone: keyboard Enter / ArrowDown still opens it (keydown) and the later click does not close it", () => {
    stubLayoutTier("phone");
    render(<Harness />);
    fireEvent.keyDown(trigger(), { key: "Enter" });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(trigger());
    expect(screen.getByRole("menu")).toBeInTheDocument();
    cleanup();
    render(<Harness />);
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("controlled: opening by click goes through onOpenChange(true)", () => {
    stubLayoutTier("phone");
    const onOpenChange = vi.fn();
    render(<Harness open={false} onOpenChange={onOpenChange} />);
    fireEvent.pointerDown(trigger(), { button: 0 });
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.click(trigger());
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it.each([["640 and up with phoneSheet", "overlay", true], ["phone without phoneSheet", "phone", false]] as const)("%s: opens on pointerdown as Radix does by default", (_label, tier, phoneSheet) => {
    stubLayoutTier(tier);
    render(<Harness phoneSheet={phoneSheet} />);
    fireEvent.pointerDown(trigger(), { button: 0 });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(trigger());
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("crossing 640 while the sheet is open -> the whole menu closes (a controlled one receives onOpenChange(false)); one without phoneSheet stays open as before", () => {
    const handle = stubLayoutTier("phone");
    const onOpenChange = vi.fn();
    render(<Harness open onOpenChange={onOpenChange} />);
    act(() => handle.setLayoutTier("overlay"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    cleanup();

    const again = stubLayoutTier("phone");
    render(<Harness />);
    fireEvent.click(trigger());
    expect(screen.getByRole("menu")).toBeInTheDocument();
    act(() => again.setLayoutTier("docked"));
    expect(screen.queryByRole("menu")).toBeNull();
    cleanup();

    const plain = stubLayoutTier("phone");
    render(<Harness phoneSheet={false} />);
    fireEvent.pointerDown(trigger(), { button: 0 });
    act(() => plain.setLayoutTier("overlay"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });
});

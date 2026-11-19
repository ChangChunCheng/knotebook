import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, type Location } from "react-router";
import i18n from "@/i18n";
import { clickOutside, settle } from "@/test/outside-click";
import { ManagementShell, type ManagementNavItemSpec } from "./ManagementShell";
import { rememberPanelReturn, type PanelLocationState } from "@/lib/panel-return";
import { stubLayoutTier } from "@/test/layout-tier";

// #247. jsdom does not apply Tailwind: `hidden`/`flex` can only be asserted via classes, real display is verified by e2e screenshots.
// matchMedia: the global stub in `src/test/setup.ts` always returns matches:false (= narrow viewport); wide-viewport cases stub it themselves.

const ITEMS: ManagementNavItemSpec[] = [
  { to: "/settings/account", label: "Account info" },
  { to: "/settings/login", label: "Sign-in" },
  { to: "/settings/storage", label: "Storage", count: 7 },
];

const BG = { pathname: "/n/tester/my-note", search: "", hash: "", state: null, key: "bg" } as Location;

function LocationProbe() {
  const location = useLocation();
  const bg = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation;
  return (
    <div data-testid="location" data-bg={bg?.pathname ?? ""} data-state-keys={Object.keys((location.state as object | null) ?? {}).sort().join(",")}>
      {location.pathname}
    </div>
  );
}

function renderShell(opts: { path?: string; state?: unknown; items?: ManagementNavItemSpec[]; subtitle?: string } = {}) {
  const onOpenChange = vi.fn();
  render(
    <MemoryRouter initialEntries={[{ pathname: opts.path ?? "/settings/login", state: opts.state ?? null }]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <ManagementShell
                title="Settings"
                subtitle={opts.subtitle}
                description="Panel description"
                items={opts.items ?? ITEMS}
                onOpenChange={onOpenChange}
              >
                <p>slot content</p>
              </ManagementShell>
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return { onOpenChange };
}

const itemsCard = () => document.querySelector<HTMLElement>('[data-management-card="items"]')!;
const contentCard = () => document.querySelector<HTMLElement>('[data-management-card="content"]')!;
const contentBox = () => document.querySelector<HTMLElement>("[data-management-content]")!;

function stubWideViewport() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })),
  );
}

describe("ManagementShell (#247)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("slots: the title is the DialogTitle, with subtext, description and count; children land in [data-management-content]", async () => {
    renderShell({ subtitle: "Admin" });
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    const headings = within(dialog).getAllByRole("heading");
    expect(headings).toHaveLength(1);
    expect(headings[0]!.id).toBe(dialog.getAttribute("aria-labelledby"));
    expect(dialog).toHaveAccessibleDescription("Panel description");
    expect(within(dialog).getByText("Admin")).toBeInTheDocument();
    expect(within(dialog).getByText("7")).toHaveAttribute("aria-hidden", "true");
    expect(within(dialog).getByRole("link", { name: "Storage" })).toBeInTheDocument(); // the count does not enter the accessible name
    expect(within(dialog).getByRole("navigation", { name: "Settings" })).toBeInTheDocument();
    expect(contentBox()).toContainElement(screen.getByText("slot content"));
    expect(contentBox()).toHaveAttribute("tabindex", "-1");
  });

  it("items forward backgroundLocation", async () => {
    renderShell({ state: { backgroundLocation: BG } });
    fireEvent.click(await screen.findByRole("link", { name: "Account info" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/settings/account"));
    expect(screen.getByTestId("location")).toHaveAttribute("data-bg", "/n/tester/my-note");
  });

  it("no state is passed without backgroundLocation (deep link)", async () => {
    renderShell();
    fireEvent.click(await screen.findByRole("link", { name: "Account info" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/settings/account"));
    expect(screen.getByTestId("location")).toHaveAttribute("data-bg", "");
  });

  it("end takes effect: at /groups/g1/roles \"Members\" (with end) has no aria-current", async () => {
    renderShell({
      path: "/groups/g1/roles",
      items: [
        { to: "/groups/g1", label: "Members", end: true },
        { to: "/groups/g1/roles", label: "Roles" },
      ],
    });
    expect(await screen.findByRole("link", { name: "Roles" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Members" })).not.toHaveAttribute("aria-current");
  });

  it("the close button calls onOpenChange(false)", async () => {
    const { onOpenChange } = renderShell();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("narrow width stays on the items layer: the left card also has a Close button (md:hidden) that closes when clicked; the content layer has the right card's Close", async () => {
    const { onOpenChange } = renderShell();
    await settle();
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Back to sections" }));
    const closes = screen.getAllByRole("button", { name: "Close" });
    expect(closes).toHaveLength(2);
    const itemsCard = document.querySelector<HTMLElement>('[data-management-card="items"]')!;
    const left = within(itemsCard).getByRole("button", { name: "Close" });
    expect(left).toHaveClass("md:hidden");
    fireEvent.click(left);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("the two close buttons and the back button all extend a 44px hit area on touch devices", async () => {
    renderShell();
    await settle();
    const right = screen.getByRole("button", { name: "Close" });
    const back = screen.getByRole("button", { name: "Back to sections" });
    for (const button of [right, back]) expect(button).toHaveClass("pointer-coarse:after:-inset-2", "pointer-coarse:after:absolute");
    fireEvent.click(back);
    const itemsCard = document.querySelector<HTMLElement>('[data-management-card="items"]')!;
    // Same position as the right card's close button (the card's top right, right-2 top-2), so switching layers does not make it jump.
    expect(within(itemsCard).getByRole("button", { name: "Close" })).toHaveClass("pointer-coarse:after:-inset-2", "absolute", "right-2", "top-2");
  });

  it("Esc calls onOpenChange(false)", async () => {
    const { onOpenChange } = renderShell();
    await settle();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("the panel has a single Close button (relies on the size==='panel' check in dialog.tsx)", async () => {
    renderShell();
    await settle();
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
  });

  it("right card DOM order: back button -> close button -> content container", async () => {
    renderShell();
    await screen.findByRole("dialog");
    const kids = Array.from(contentCard().children);
    expect(kids[0]).toBe(screen.getByRole("button", { name: "Back to sections" }));
    expect(kids[1]).toBe(screen.getByRole("button", { name: "Close" }));
    expect(kids[2]).toBe(contentBox());
  });

  it("after opening, focus is on the back button, not on any item (Radix removeLinks; an onOpenAutoFocus that focuses an item would break it)", async () => {
    renderShell();
    const back = await screen.findByRole("button", { name: "Back to sections" });
    await waitFor(() => expect(document.activeElement).toBe(back));
    expect(back).toHaveClass("md:hidden", "bg-card");
    for (const link of screen.getAllByRole("link")) expect(document.activeElement).not.toBe(link);
  });

  it("two layers start on the content layer: left card hidden + md:flex (no bare flex), right card flex", async () => {
    renderShell();
    await screen.findByRole("dialog");
    expect(itemsCard().classList).toContain("hidden");
    expect(itemsCard().classList).toContain("md:flex");
    expect(itemsCard().classList).not.toContain("flex");
    expect(contentCard().classList).toContain("flex");
    expect(contentCard().classList).not.toContain("hidden");
  });

  it("pressing back: left card shows, right card hides (no bare flex), the URL is unchanged, focus is on the aria-current item", async () => {
    renderShell();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Back to sections" }));
    await waitFor(() => expect(itemsCard().classList).toContain("flex"));
    expect(itemsCard().classList).not.toContain("hidden");
    expect(contentCard().classList).toContain("hidden");
    expect(contentCard().classList).toContain("md:flex");
    expect(contentCard().classList).not.toContain("flex");
    expect(screen.getByTestId("location")).toHaveTextContent("/settings/login");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("link", { name: "Sign-in" })));
  });

  it("after back, clicking the current item: returns to the content layer even though pathname is unchanged, focus on [data-management-content]", async () => {
    renderShell();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Back to sections" }));
    await waitFor(() => expect(contentCard().classList).toContain("hidden"));
    fireEvent.click(screen.getByRole("link", { name: "Sign-in" }));
    await waitFor(() => expect(contentCard().classList).toContain("flex"));
    expect(itemsCard().classList).toContain("hidden");
    await waitFor(() => expect(document.activeElement).toBe(contentBox()));
    expect(screen.getByTestId("location")).toHaveTextContent("/settings/login");
  });

  it("two consecutive \"back -> click the same item\" both send focus to the content container (seq increments, it does not fire once)", async () => {
    renderShell();
    await settle();
    for (let i = 0; i < 2; i += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Back to sections" }));
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("link", { name: "Sign-in" })));
      fireEvent.click(screen.getByRole("link", { name: "Sign-in" }));
      await waitFor(() => expect(document.activeElement).toBe(contentBox()));
    }
  });

  it("wide viewport (matchMedia matches:true): clicking an item does not move focus", async () => {
    stubWideViewport();
    renderShell();
    await settle();
    fireEvent.click(screen.getByRole("link", { name: "Account info" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/settings/account"));
    await settle();
    expect(document.activeElement).not.toBe(contentBox());
    expect(window.matchMedia).toHaveBeenCalledWith("(min-width: 768px)");
  });
});

describe("ManagementShell on phones (< 640): back stack of the bottom sheet", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opened from the menu (panelStart + panelReturn): stays on the item list; top-left \"Back to menu\", no close button; clicking it calls onOpenChange(false) after the sheet finishes closing, then reopens the menu", async () => {
    stubLayoutTier("phone");
    const reopen = vi.fn();
    const state: PanelLocationState = { backgroundLocation: BG, panelStart: "list", panelReturn: rememberPanelReturn(reopen) };
    const { onOpenChange } = renderShell({ state });
    await settle();
    expect(itemsCard().classList).toContain("flex");
    expect(contentCard().classList).toContain("hidden");
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    const back = within(itemsCard()).getByRole("button", { name: "Back to menu" });
    expect(back).toHaveClass("absolute", "left-2", "top-2", "max-sm:after:-inset-2", "max-sm:after:absolute");
    expect(document.activeElement).toBe(back);
    fireEvent.click(back);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    await waitFor(() => expect(reopen).toHaveBeenCalledTimes(1));
    expect(onOpenChange.mock.invocationCallOrder[0]!).toBeLessThan(reopen.mock.invocationCallOrder[0]!);
  });

  it("choosing an item -> content layer: the same top-left position shows \"Back to sections\", still no close button; pressing it returns to the item list", async () => {
    stubLayoutTier("phone");
    renderShell({ state: { backgroundLocation: BG, panelStart: "list" } satisfies PanelLocationState });
    await settle();
    fireEvent.click(screen.getByRole("link", { name: "Sign-in" }));
    expect(contentCard().classList).toContain("flex");
    expect(itemsCard().classList).toContain("hidden");
    const back = within(contentCard()).getByRole("button", { name: "Back to sections" });
    expect(back).toHaveClass("absolute", "left-2", "top-2", "max-sm:after:-inset-2");
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    fireEvent.click(back);
    expect(itemsCard().classList).toContain("flex");
    expect(within(itemsCard()).getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("deep link (no panelStart): stays on that page; after backing out to the item list the back arrow is named Close and only closes without reopening", async () => {
    stubLayoutTier("phone");
    const reopen = vi.fn();
    rememberPanelReturn(reopen);
    const { onOpenChange } = renderShell({ state: { backgroundLocation: BG } });
    await settle();
    expect(contentCard().classList).toContain("flex");
    fireEvent.click(screen.getByRole("button", { name: "Back to sections" }));
    fireEvent.click(within(itemsCard()).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    await settle();
    expect(reopen).not.toHaveBeenCalled();
  });

  it("Esc on the content layer: closes everything and does not reopen the menu", async () => {
    stubLayoutTier("phone");
    const reopen = vi.fn();
    const { onOpenChange } = renderShell({ state: { backgroundLocation: BG, panelStart: "list", panelReturn: rememberPanelReturn(reopen) } });
    await settle();
    fireEvent.click(screen.getByRole("link", { name: "Sign-in" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    await settle();
    expect(reopen).not.toHaveBeenCalled();
  });

  it("clicking outside the sheet (the gap above): closes everything on phones and does not reopen the menu; at 640 and above clicking outside does not close (forms may have unsaved input)", async () => {
    stubLayoutTier("phone");
    const reopen = vi.fn();
    const { onOpenChange } = renderShell({ state: { backgroundLocation: BG, panelStart: "list", panelReturn: rememberPanelReturn(reopen) } });
    await settle();
    await clickOutside();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    await settle();
    expect(reopen).not.toHaveBeenCalled();
    cleanup();
    vi.unstubAllGlobals();

    stubLayoutTier("overlay");
    const wide = renderShell({ state: { backgroundLocation: BG } });
    await settle();
    await clickOutside();
    expect(wide.onOpenChange).not.toHaveBeenCalled();
  });

  it("640 and above: panelStart has no effect (stays on the content layer), there is a close button and no \"Back to menu\"", async () => {
    stubLayoutTier("overlay");
    renderShell({ state: { backgroundLocation: BG, panelStart: "list", panelReturn: rememberPanelReturn(() => {}) } });
    await settle();
    expect(contentCard().classList).toContain("flex");
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back to menu" })).toBeNull();
  });
});

describe("ManagementShell on phones: \"Back to menu\" only for the open that really came from the menu", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("after opening, panelStart/panelReturn are removed from this history entry (only backgroundLocation stays); a reload or back/forward to this entry = deep link: stays on that page, the list's back arrow is Close and does not reopen the menu", async () => {
    stubLayoutTier("phone");
    const reopen = vi.fn();
    renderShell({ state: { backgroundLocation: BG, panelStart: "list", panelReturn: rememberPanelReturn(reopen) } satisfies PanelLocationState });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveAttribute("data-state-keys", "backgroundLocation"));
    // This entry is still the one opened from the menu: the list's back arrow is still Back to menu
    expect(within(itemsCard()).getByRole("button", { name: "Back to menu" })).toBeInTheDocument();
    cleanup();

    // Mounting the same history entry again (reload, back/forward): state keeps only backgroundLocation
    const { onOpenChange } = renderShell({ state: { backgroundLocation: BG } });
    await settle();
    expect(contentCard().classList).toContain("flex");
    fireEvent.click(screen.getByRole("button", { name: "Back to sections" }));
    expect(within(itemsCard()).queryByRole("button", { name: "Back to menu" })).toBeNull();
    fireEvent.click(within(itemsCard()).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    await settle();
    expect(reopen).not.toHaveBeenCalled();
  });

  it("opened from the menu at 640 or wider and then shrunk to phone width: the list's back arrow is Close, it only closes and does not reopen the menu", async () => {
    const tier = stubLayoutTier("overlay");
    const reopen = vi.fn();
    const { onOpenChange } = renderShell({ state: { backgroundLocation: BG, panelStart: "list", panelReturn: rememberPanelReturn(reopen) } });
    await settle();
    act(() => tier.setLayoutTier("phone"));
    fireEvent.click(screen.getByRole("button", { name: "Back to sections" }));
    expect(within(itemsCard()).queryByRole("button", { name: "Back to menu" })).toBeNull();
    fireEvent.click(within(itemsCard()).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    await settle();
    expect(reopen).not.toHaveBeenCalled();
  });

  it("on phones the card is flush with the sheet: the tray has no padding, the card has only top rounded corners and no border on the sides and bottom, the safe area is the card's padding", async () => {
    stubLayoutTier("phone");
    renderShell({ state: { backgroundLocation: BG, panelStart: "list" } });
    await settle();
    const tray = itemsCard().parentElement!;
    expect(tray).toHaveClass("max-sm:p-0", "max-sm:gap-0");
    expect(tray.className).not.toMatch(/max-sm:p[lrb]-\[/);
    for (const card of [itemsCard(), contentCard()]) expect(card).toHaveClass("max-sm:rounded-t-xl", "max-sm:rounded-b-none", "max-sm:border-x-0", "max-sm:border-b-0");
    expect(itemsCard()).toHaveClass("max-sm:pb-[max(1rem,env(safe-area-inset-bottom))]", "max-sm:pl-[max(1rem,env(safe-area-inset-left))]");
    expect(contentCard()).toHaveClass("max-sm:pb-[env(safe-area-inset-bottom)]", "max-sm:pl-[env(safe-area-inset-left)]");
    // The card is flush with the sheet's left edge: the back arrows of both layers step aside by the left safe area themselves
    expect(within(itemsCard()).getByRole("button", { name: "Close" })).toHaveClass("max-sm:left-[max(0.5rem,env(safe-area-inset-left))]");
    expect(within(contentCard()).getByRole("button", { name: "Back to sections", hidden: true })).toHaveClass("max-sm:left-[max(0.5rem,env(safe-area-inset-left))]");
  });

  it("on phones the panel and the menu sheet share one surface: the card uses the popover background with 12px top corners, and the tray no longer has frosted glass or the brand background", async () => {
    stubLayoutTier("phone");
    renderShell({ state: { backgroundLocation: BG, panelStart: "list" } });
    await settle();
    const tray = itemsCard().parentElement!;
    for (const card of [itemsCard(), contentCard()]) {
      expect(card).toHaveClass("max-sm:bg-popover", "max-sm:rounded-t-xl");
      expect(card.className).not.toMatch(/max-sm:rounded-t-2xl/);
    }
    expect(tray).toHaveClass("max-sm:rounded-t-xl", "max-sm:bg-transparent", "max-sm:backdrop-blur-none");
    expect(tray.className).not.toMatch(/max-sm:rounded-t-2xl/);
  });

  it("on phones the item list rows look like menu rows: 48px high, 16px regular weight, adjacent, 4px corners, grey press/focus background, the current item has no persistent brand color; each row ends with a chevron", async () => {
    stubLayoutTier("phone");
    renderShell({ state: { backgroundLocation: BG, panelStart: "list" } });
    await settle();
    const rows = within(itemsCard()).getAllByRole("link");
    expect(rows).toHaveLength(ITEMS.length);
    for (const row of rows) {
      expect(row).toHaveClass(
        "max-sm:min-h-12",
        "max-sm:h-auto",
        "max-sm:text-base",
        "max-sm:font-normal",
        "max-sm:rounded-sm",
        "max-sm:-mx-2",
        "max-sm:px-2",
        "max-sm:hover:bg-accent",
        "max-sm:active:bg-accent",
        "max-sm:focus-visible:bg-accent",
      );
    }
    // The list area scrolls itself (rows that do not fit a short screen must be reachable); the row header sits outside it
    const nav = within(itemsCard()).getByRole("navigation");
    expect(nav).toHaveClass("max-sm:gap-0", "max-sm:min-h-0", "max-sm:flex-1", "max-sm:overflow-y-auto", "max-sm:-mx-2", "max-sm:px-2");
    expect(nav.contains(within(itemsCard()).getByText("Settings"))).toBe(false);
    // The current item (/settings/login): on phones the brand background and bold are overridden
    const current = within(itemsCard()).getByRole("link", { name: "Sign-in" });
    expect(current).toHaveClass("max-sm:bg-transparent", "max-sm:font-normal", "max-sm:text-foreground");
    expect(rows.filter((row) => row !== current).some((row) => /max-sm:bg-transparent/.test(row.className))).toBe(false);
    // The chevron shows only on phones and is not part of the accessible name; in a row with a count (Storage) the count comes before the chevron
    for (const row of rows) {
      const chevron = row.querySelector("svg");
      expect(chevron).not.toBeNull();
      expect(chevron).toHaveAttribute("aria-hidden", "true");
      expect(chevron).toHaveClass("h-4", "w-4", "shrink-0", "sm:hidden");
    }
    expect(within(itemsCard()).getByRole("link", { name: "Account info" }).querySelector("svg")).toHaveClass("ml-auto");
    expect(within(itemsCard()).getByRole("link", { name: "Storage" }).querySelector("svg")).not.toHaveClass("ml-auto");
  });

  it("on phones the title is 18px and the row header has a hairline; the back arrows of both layers sit in the same position with a transparent background", async () => {
    stubLayoutTier("phone");
    renderShell({ state: { backgroundLocation: BG, panelStart: "list" } });
    await settle();
    const title = within(itemsCard()).getByText("Settings");
    expect(title).toHaveClass("max-sm:text-lg", "font-semibold");
    const header = title.parentElement!.parentElement!;
    expect(header).toHaveClass("max-sm:h-12", "max-sm:border-b", "max-sm:border-border");
    const listBack = within(itemsCard()).getByRole("button", { name: "Close" });
    const contentBack = within(contentCard()).getByRole("button", { name: "Back to sections", hidden: true });
    // The back arrow's background is the sheet's surface (looks transparent but hides content scrolling past); the content area's top leaves room for the arrow
    for (const back of [listBack, contentBack]) expect(back).toHaveClass("max-sm:top-[26px]", "max-sm:bg-popover");
    expect(contentBox()).toHaveClass("pt-12", "max-sm:pt-16");
    // The header's hairline spans the card's full width (extending past the card's padding on both sides), the title's left edge does not move
    expect(header).toHaveClass("max-sm:-ml-[max(1rem,env(safe-area-inset-left))]", "max-sm:-mr-[max(1rem,env(safe-area-inset-right))]", "max-sm:pl-[calc(max(1rem,env(safe-area-inset-left))+2.5rem)]");
  });

  it("at 640 and above the rows, title and card stay as before: 36px high, 14px, brand-colored current item, no phone-specific background", async () => {
    stubWideViewport();
    renderShell();
    await settle();
    const current = within(itemsCard()).getByRole("link", { name: "Sign-in" });
    expect(current).toHaveClass("h-9", "text-sm", "rounded-lg", "bg-brand-soft", "text-brand-on-soft");
    expect(itemsCard().parentElement).toHaveClass("backdrop-blur-md", "bg-background/45");
    expect(itemsCard()).toHaveClass("bg-card");
  });
});

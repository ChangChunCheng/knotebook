import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { useShortcutsDialog } from "@/lib/shortcuts-dialog";
import { TourContext, type TourApi } from "@/lib/tour-context";
import { OVERLAY_QUERY } from "@/lib/layout-tiers";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts } from "@/components/ui/toast";
import { AppShell, SidebarDrawerButton } from "./AppShell";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

/**
 * Dialog content is a stand-in (its own behaviour: ShortcutsLazy.test.tsx; lazy load failure: AppShell.shortcuts-lazy-error.test.tsx).
 */

// The stand-in prints the start page it receives on data-start-page: that attribute shows whether the shell passes down which page to open this time.
vi.mock("@/components/shortcuts/ShortcutsLazy", () => ({
  ShortcutsContent: ({ startPage }: { startPage?: string }) => <p data-start-page={startPage}>stub shortcuts content</p>,
}));

function fakeResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

const USER: UserDto = {
  id: "u1",
  email: "a@example.com",
  handle: "tester",
  displayName: "Ann",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
  avatar: null,
};

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse([]));
      if (url === "/api/auth/me") return Promise.resolve(fakeResponse(USER));
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse([]));
      if (url === "/api/ai/actions") return Promise.resolve(fakeResponse({ actions: [] }));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

function OpenViaContext() {
  const shortcuts = useShortcutsDialog();
  return (
    <button type="button" onClick={() => shortcuts!.open()}>
      open via context
    </button>
  );
}

function renderShell(children: ReactNode = <button type="button">probe</button>, tour: TourApi | null = null) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/"]}>
          <TourContext.Provider value={tour}>
            <ActiveNoteProvider>
              <AppShell>{children}</AppShell>
            </ActiveNoteProvider>
          </TourContext.Provider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

const startPage = () => document.querySelector("[data-start-page]")?.getAttribute("data-start-page");

const dialog = () => screen.queryByRole("dialog", { name: "Help" });
const press = (init: KeyboardEventInit & { key: string }) => fireEvent.keyDown(window, init);

async function ready(): Promise<void> {
  await screen.findByRole("button", { name: "probe" });
}

const extras: HTMLElement[] = [];
function addToBody(html: string): void {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  extras.push(host);
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  dismissAllToasts();
  stubFetch();
});

afterEach(() => {
  for (const el of extras.splice(0)) el.remove();
  vi.unstubAllGlobals();
});

describe("AppShell - Ctrl/Cmd+/ help dialog", () => {
  it("Ctrl+/ is preventDefault-ed and opens the dialog", async () => {
    renderShell();
    await ready();
    const notCanceled = press({ key: "/", ctrlKey: true });
    expect(notCanceled).toBe(false);
    expect(await screen.findByRole("dialog", { name: "Help" })).toBeInTheDocument();
  });

  it("Cmd+/ (metaKey) also opens", async () => {
    renderShell();
    await ready();
    press({ key: "/", metaKey: true });
    expect(await screen.findByRole("dialog", { name: "Help" })).toBeInTheDocument();
  });

  it("Ctrl+Alt+/ doesn't open and isn't preventDefault-ed", async () => {
    renderShell();
    await ready();
    const notCanceled = press({ key: "/", ctrlKey: true, altKey: true });
    expect(notCanceled).toBe(true);
    expect(dialog()).toBeNull();
  });

  it("Ctrl+Shift+? (key is ?) doesn't open; Ctrl+Shift+/ (key is /, shift is ignored) opens", async () => {
    renderShell();
    await ready();
    press({ key: "?", ctrlKey: true, shiftKey: true });
    expect(dialog()).toBeNull();
    press({ key: "/", ctrlKey: true, shiftKey: true });
    expect(await screen.findByRole("dialog", { name: "Help" })).toBeInTheDocument();
  });

  it("event already preventDefault-ed by someone else (e.g. an editor key) -> yields, doesn't open", async () => {
    renderShell();
    await ready();
    const event = new KeyboardEvent("keydown", { key: "/", ctrlKey: true, bubbles: true, cancelable: true });
    event.preventDefault();
    act(() => {
      window.dispatchEvent(event);
    });
    expect(dialog()).toBeNull();
  });

  it("another role=dialog on the page -> doesn't open, no preventDefault", async () => {
    renderShell();
    await ready();
    addToBody('<div role="dialog" aria-label="other"></div>');
    const notCanceled = press({ key: "/", ctrlKey: true });
    expect(notCanceled).toBe(true);
    expect(dialog()).toBeNull();
  });

  // Yields to an open menu too (same as Ctrl+S; a Radix menu and Dialog share FocusScope and fight over focus). Deliberately differs from Ctrl+K, where the menu still triggers.
  it("role=menu on the page -> doesn't open, no preventDefault", async () => {
    renderShell();
    await ready();
    addToBody('<div role="menu"></div>');
    const notCanceled = press({ key: "/", ctrlKey: true });
    expect(notCanceled).toBe(true);
    expect(dialog()).toBeNull();
  });

  it("only the sidebar drawer (role=dialog with data-sidebar-drawer) -> still opens", async () => {
    renderShell();
    await ready();
    addToBody('<div role="dialog" data-sidebar-drawer="" aria-label="drawer"></div>');
    press({ key: "/", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "Help" })).toBeInTheDocument();
  });

  it("pressing again while open closes it (toggle) and is preventDefault-ed", async () => {
    renderShell();
    await ready();
    press({ key: "/", ctrlKey: true });
    await screen.findByRole("dialog", { name: "Help" });
    const notCanceled = press({ key: "/", ctrlKey: true });
    expect(notCanceled).toBe(false);
    await waitFor(() => expect(dialog()).toBeNull());
  });

  it("auto-repeat events from a held key don't open", async () => {
    renderShell();
    await ready();
    press({ key: "/", ctrlKey: true, repeat: true });
    expect(dialog()).toBeNull();
  });

  // Covers the keyboard path and ShortcutsDialog's onCloseAutoFocus: a controlled Dialog without a Trigger doesn't return focus on close in Radix, so it would land on body.
  it("after closing, focus returns to the element focused before opening", async () => {
    renderShell();
    const probe = await screen.findByRole("button", { name: "probe" });
    probe.focus();
    press({ key: "/", ctrlKey: true });
    await screen.findByRole("dialog", { name: "Help" });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(dialog()).toBeNull());
    await waitFor(() => expect(probe).toHaveFocus());
  });

  it("Ctrl+K while the shortcuts dialog is open: the search box doesn't get focus (the existing dialog yields, the two listeners don't interfere)", async () => {
    renderShell();
    await ready();
    press({ key: "/", ctrlKey: true });
    await screen.findByRole("dialog", { name: "Help" });
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search notes"]')!;
    expect(search).not.toBeNull();
    press({ key: "k", ctrlKey: true });
    expect(search).not.toHaveFocus();
  });

  it("context: consumer calls open() -> opens", async () => {
    renderShell(<OpenViaContext />);
    fireEvent.click(await screen.findByRole("button", { name: "open via context" }));
    expect(await screen.findByRole("dialog", { name: "Help" })).toBeInTheDocument();
  });
});

/** Radix's DropdownMenuTrigger only listens to onPointerDown, so a plain click can't open it. */
async function openUserMenu(scope?: HTMLElement): Promise<void> {
  const trigger = await (scope ? within(scope) : screen).findByRole("button", { name: "Ann" });
  fireEvent.pointerDown(trigger, { button: 0 });
  await screen.findByRole("menu");
}

describe("AppShell - which page the help dialog opens on", () => {
  it("Ctrl+/ opens on global", async () => {
    renderShell(undefined, { start: vi.fn() });
    await ready();
    press({ key: "/", ctrlKey: true });
    await screen.findByRole("dialog", { name: "Help" });
    expect(startPage()).toBe("global");
  });

  it("user menu (with the tour context) opens on tour; after closing, Ctrl+/ goes back to global instead of reusing the previous page", async () => {
    renderShell(undefined, { start: vi.fn() });
    await ready();
    await openUserMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Help" }));
    await screen.findByRole("dialog", { name: "Help" });
    expect(startPage()).toBe("tour");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(dialog()).toBeNull());
    press({ key: "/", ctrlKey: true });
    await screen.findByRole("dialog", { name: "Help" });
    expect(startPage()).toBe("global");
  });

  it("user menu (without the tour context) opens on global", async () => {
    renderShell();
    await ready();
    await openUserMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Help" }));
    await screen.findByRole("dialog", { name: "Help" });
    expect(startPage()).toBe("global");
  });
});

describe("AppShell - opening the help dialog from the user menu", () => {
  it("opening from the menu shows the dialog; Esc closes it and focus returns to the UserMenu trigger", async () => {
    renderShell();
    await ready();
    const trigger = await screen.findByRole("button", { name: "Ann" });
    await openUserMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Help" }));
    await screen.findByRole("dialog", { name: "Help" });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(dialog()).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  // With the drawer open the shortcuts dialog stacks on top and the drawer stays. While it is open Radix marks the drawer aria-hidden (expected), so that part finds the drawer via [data-sidebar-drawer] instead of getByRole; getByRole confirms the drawer is accessible again only after Esc closes the dialog.
  it("narrow viewport: UserMenu in the drawer opens the shortcuts dialog and the drawer stays; Esc closes only the dialog and focus returns to the trigger in the drawer", async () => {
    const mql = {
      matches: true,
      media: OVERLAY_QUERY,
      addEventListener: () => {},
      removeEventListener: () => {},
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    };
    vi.stubGlobal("matchMedia", vi.fn((query: string) => (query === OVERLAY_QUERY ? mql : { ...mql, matches: false })));
    renderShell(
      <>
        <SidebarDrawerButton />
        <button type="button">probe</button>
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open sidebar" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    const drawerTrigger = await within(drawer).findByRole("button", { name: "Ann" });
    await openUserMenu(drawer);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Help" }));
    await screen.findByRole("dialog", { name: "Help" });
    expect(document.querySelector("[data-sidebar-drawer]")).not.toBeNull();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(dialog()).toBeNull());
    expect(await screen.findByRole("dialog", { name: "Navigation" })).toBeInTheDocument();
    await waitFor(() => expect(drawerTrigger).toHaveFocus());
  });
});

/** Ctrl/Cmd+, opens settings through `lib/open-settings.ts` (same path as the user menu's settings item). */
function LocationProbe() {
  const location = useLocation();
  const bg = (location.state as { backgroundLocation?: { pathname: string } } | null)?.backgroundLocation;
  return (
    <div data-testid="location" data-bg={bg?.pathname ?? ""}>
      {location.pathname}
    </div>
  );
}

describe("AppShell - Ctrl/Cmd+, opens settings", () => {
  const where = () => screen.getByTestId("location");

  it("Ctrl+, is preventDefault-ed and navigates to /settings/account with backgroundLocation (the page it was on)", async () => {
    renderShell(<LocationProbe />);
    await screen.findByTestId("location");
    const notCanceled = press({ key: ",", ctrlKey: true });
    expect(notCanceled).toBe(false);
    await waitFor(() => expect(where()).toHaveTextContent("/settings/account"));
    expect(where().getAttribute("data-bg")).toBe("/");
  });

  it("Cmd+, (metaKey) also opens", async () => {
    renderShell(<LocationProbe />);
    await screen.findByTestId("location");
    press({ key: ",", metaKey: true });
    await waitFor(() => expect(where()).toHaveTextContent("/settings/account"));
  });

  it.each([
    ["Alt", { altKey: true }],
    ["Shift", { shiftKey: true }],
    ["repeat", { repeat: true }],
  ])("Ctrl+, with %s -> no action, no preventDefault", async (_name, extra) => {
    renderShell(<LocationProbe />);
    await screen.findByTestId("location");
    const notCanceled = press({ key: ",", ctrlKey: true, ...extra });
    expect(notCanceled).toBe(true);
    expect(where()).toHaveTextContent("/");
    expect(where().getAttribute("data-bg")).toBe("");
  });

  it("event already preventDefault-ed by someone else -> yields", async () => {
    renderShell(<LocationProbe />);
    await screen.findByTestId("location");
    const event = new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true, cancelable: true });
    event.preventDefault();
    act(() => {
      window.dispatchEvent(event);
    });
    expect(where().getAttribute("data-bg")).toBe("");
  });

  it("another dialog open (including settings itself) -> no action, no preventDefault", async () => {
    renderShell(<LocationProbe />);
    await screen.findByTestId("location");
    addToBody('<div role="dialog" aria-label="settings-like"></div>');
    const notCanceled = press({ key: ",", ctrlKey: true });
    expect(notCanceled).toBe(true);
    expect(where().getAttribute("data-bg")).toBe("");
  });

  it("menu open -> no action, no preventDefault", async () => {
    renderShell(<LocationProbe />);
    await screen.findByTestId("location");
    addToBody('<div role="menu"></div>');
    const notCanceled = press({ key: ",", ctrlKey: true });
    expect(notCanceled).toBe(true);
    expect(where().getAttribute("data-bg")).toBe("");
  });

  it("only the sidebar drawer (role=dialog with data-sidebar-drawer) -> still opens", async () => {
    renderShell(<LocationProbe />);
    await screen.findByTestId("location");
    addToBody('<div role="dialog" data-sidebar-drawer="" aria-label="drawer"></div>');
    press({ key: ",", ctrlKey: true });
    await waitFor(() => expect(where()).toHaveTextContent("/settings/account"));
  });

  it("switching to another page, then Ctrl+,: backgroundLocation is the current page (the handler reads the latest location, not the one at mount)", async () => {
    function GoElsewhere() {
      const navigate = useNavigate();
      return (
        <button type="button" onClick={() => navigate("/other")}>
          go elsewhere
        </button>
      );
    }
    renderShell(
      <>
        <LocationProbe />
        <GoElsewhere />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "go elsewhere" }));
    await waitFor(() => expect(where()).toHaveTextContent("/other"));
    press({ key: ",", ctrlKey: true });
    await waitFor(() => expect(where()).toHaveTextContent("/settings/account"));
    expect(where().getAttribute("data-bg")).toBe("/other");
  });

  it("Ctrl+, with the shortcuts dialog open does nothing (it is a role=dialog)", async () => {
    renderShell(<LocationProbe />);
    await screen.findByTestId("location");
    press({ key: "/", ctrlKey: true });
    await screen.findByRole("dialog", { name: "Help" });
    const notCanceled = press({ key: ",", ctrlKey: true });
    expect(notCanceled).toBe(true);
    expect(where().getAttribute("data-bg")).toBe("");
  });
});

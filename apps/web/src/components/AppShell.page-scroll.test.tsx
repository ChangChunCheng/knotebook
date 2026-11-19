import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import type { NoteDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { PHONE_PAGE_SCROLL_ATTR } from "@/lib/page-scroll";
import { useSidebarTabActions } from "@/lib/sidebar-tab";
import { stubLayoutTier, type LayoutTier } from "@/test/layout-tier";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts } from "@/components/ui/toast";
import { OWNER_PERMS } from "@/test/fixtures";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { trashList } from "@/test/trash-fixtures";
import { AppShell } from "./AppShell";
import { NoteBrowseBar } from "./NoteBrowseBar";

// Phone (< 640): list and note scroll the document, so the outer frame doesn't lock height and AppShell restores or zeroes the scroll position itself on screen change. Unchanged from 640 up.

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

const NOTE: NoteDto = {
  id: "88888888-8888-8888-8888-888888888888",
  title: "Alpha Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "alpha-note",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
  group: null,
  groupId: null,
  folderId: null,
  permissions: OWNER_PERMS,
};

function stubFetch(notes: NoteDto[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/auth/me") return Promise.resolve(fakeResponse(USER));
      if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse([]));
      if (url === "/api/folders") return Promise.resolve(fakeResponse(FOLDER_LIST_EMPTY));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse(notes));
      if (url === "/api/trash") return Promise.resolve(fakeResponse(trashList([], { retentionDays: 7 })));
      if (url === "/api/favorites") return Promise.resolve(fakeResponse([]));
      if (url.startsWith("/api/search?")) return Promise.resolve(fakeResponse({ hits: [], nextCursor: null }));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function Back() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      history-back
    </button>
  );
}

function renderAt(path: string | string[], children: ReactNode) {
  const entries = Array.isArray(path) ? path : [path];
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
          <ActiveNoteProvider>
            <Routes>
              <Route path="*" element={<AppShell>{children}</AppShell>} />
            </Routes>
          </ActiveNoteProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

/** The user scrolls the document to `y`: sets `scrollY` and dispatches scroll (AppShell records the position from the event). */
function scrollPage(y: number): void {
  vi.stubGlobal("scrollY", y);
  act(() => {
    window.dispatchEvent(new Event("scroll"));
  });
}

let scrollTo: ReturnType<typeof vi.spyOn>;
function lastScrollY(): number | null {
  const calls = scrollTo.mock.calls;
  if (calls.length === 0) return null;
  const last = calls[calls.length - 1] as unknown[];
  return typeof last[0] === "object" ? ((last[0] as ScrollToOptions).top ?? null) : (last[1] as number);
}

function useTier(tier: LayoutTier) {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    stubLayoutTier(tier);
    scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  });
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
}

const frameOf = (container: HTMLElement) => container.querySelector<HTMLElement>(`[${PHONE_PAGE_SCROLL_ATTR}]`)!;
const asideOf = (container: HTMLElement) => container.querySelector<HTMLElement>("aside[data-sidebar-instance]")!;

describe("AppShell - document scrolls on phone", () => {
  useTier("phone");

  it("frame carries data-phone-page-scroll: from 640 up it locks viewport height and clips (h-dvh, overflow-hidden); on phone it doesn't lock height, no vertical clip, horizontal clip, card background color", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/", <LocationProbe />);
    await screen.findByRole("tablist");
    const frame = frameOf(container);
    expect(frame).not.toBeNull();
    expect(frame).toHaveClass("h-dvh", "overflow-hidden", "max-sm:h-auto", "max-sm:overflow-y-visible", "max-sm:overflow-x-clip", "max-sm:bg-card");
    // hidden would also make vertical a scroll container, so the top bar's sticky couldn't stick.
    expect(frame.className).not.toMatch(/max-sm:overflow-(x-)?hidden/);
    expect(frame).toContainElement(asideOf(container));
  });

  it("list -> note: document returns to top; system back to the list: returns to the position left at", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt(
      "/",
      <>
        <LocationProbe />
        <Back />
      </>,
    );
    const link = await within(asideOf(container)).findByRole("link", { name: /^Alpha Note/ });
    scrollPage(420);
    expect(scrollTo).not.toHaveBeenCalled();
    fireEvent.click(link);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/n/tester/alpha-note"));
    expect(lastScrollY()).toBe(0);
    scrollPage(2000);
    fireEvent.click(screen.getByRole("button", { name: "history-back", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/));
    expect(lastScrollY()).toBe(420);
  });

  it("switching tab on the list: new tab starts at top; a position scrolled to in the new tab is recorded as usual and restored when returning from a note", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt(
      "/",
      <>
        <LocationProbe />
        <Back />
      </>,
    );
    const tablist = await screen.findByRole("tablist");
    scrollPage(300);
    fireEvent.click(within(tablist).getByRole("tab", { name: "Recent" }));
    expect(lastScrollY()).toBe(0);
    scrollPage(0);
    scrollTo.mockClear();
    fireEvent.click(within(tablist).getByRole("tab", { name: "My notes" }));
    expect(lastScrollY()).toBe(0);
    scrollPage(250);
    const link = await within(asideOf(container)).findByRole("link", { name: /^Alpha Note/ });
    fireEvent.click(link);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/n/tester/alpha-note"));
    fireEvent.click(screen.getByRole("button", { name: "history-back", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/));
    expect(lastScrollY()).toBe(250);
  });

  it("switching tab on a note (e.g. tapping the location in the header) back to the list: new tab starts at top, doesn't reuse the old tab's position", async () => {
    stubFetch([NOTE]);
    function ShowRecent() {
      const { showTab } = useSidebarTabActions();
      return (
        <button type="button" onClick={() => showTab("recent")}>
          show-recent
        </button>
      );
    }
    const { container } = renderAt(
      "/",
      <>
        <LocationProbe />
        <ShowRecent />
      </>,
    );
    const link = await within(asideOf(container)).findByRole("link", { name: /^Alpha Note/ });
    scrollPage(420);
    fireEvent.click(link);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/n/tester/alpha-note"));
    fireEvent.click(screen.getByRole("button", { name: "show-recent", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/));
    expect(lastScrollY()).toBe(0);
  });

  it("opening the search layer on a note: main content hidden, document back to top; Cancel returns to the same note's original position", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt(
      "/n/tester/alpha-note",
      <>
        <LocationProbe />
        <NoteBrowseBar note={NOTE} />
      </>,
    );
    const main = container.querySelector("main")!;
    expect(main).not.toHaveClass("max-sm:hidden");
    expect(scrollTo).not.toHaveBeenCalled();
    scrollPage(900);
    fireEvent.click(within(screen.getByTestId("note-browse-bar")).getByRole("button", { name: "Search notes" }));
    expect(lastScrollY()).toBe(0);
    expect(main).toHaveClass("max-sm:hidden");
    scrollPage(150);
    fireEvent.click(within(asideOf(container)).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(main).not.toHaveClass("max-sm:hidden"));
    expect(lastScrollY()).toBe(900);
  });

  it("opening the search layer on the list, then Cancel: returns to the list's original position", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/", <LocationProbe />);
    await screen.findByRole("tablist");
    scrollPage(510);
    fireEvent.click(within(asideOf(container)).getByRole("button", { name: "Search notes" }));
    await screen.findByRole("textbox", { name: "Search notes" });
    expect(lastScrollY()).toBe(0);
    fireEvent.click(within(asideOf(container)).getByRole("button", { name: "Cancel" }));
    await screen.findByRole("tablist");
    expect(lastScrollY()).toBe(510);
  });

  it("while the list or search layer is on screen the aside has data-phone-list-shown and <html> has data-has-phone-list-shown (index.css uses it to block pull-to-refresh); neither on a note", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt(
      "/n/tester/alpha-note",
      <>
        <LocationProbe />
        <NoteBrowseBar note={NOTE} />
      </>,
    );
    expect(asideOf(container)).not.toHaveAttribute("data-phone-list-shown");
    expect(document.documentElement).not.toHaveAttribute("data-has-phone-list-shown");
    expect(document.documentElement).toHaveAttribute("data-has-phone-page-scroll");
    fireEvent.click(within(screen.getByTestId("note-browse-bar")).getByRole("button", { name: "Search notes" }));
    expect(asideOf(container)).toHaveAttribute("data-phone-list-shown");
    expect(document.documentElement).toHaveAttribute("data-has-phone-list-shown");
  });

  it("top bar is sticky at the top and opaque; list header is sticky under the top bar; list container doesn't scroll itself on phone; same for trash", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/", <LocationProbe />);
    const tablist = await screen.findByRole("tablist");
    const top = container.querySelector("[data-phone-top-bar]");
    expect(top).toHaveClass("max-sm:sticky", "max-sm:top-0", "max-sm:bg-card");
    const header = container.querySelector("[data-sidebar-header]");
    expect(header).toHaveClass("max-sm:sticky", "max-sm:top-[calc(3rem+env(safe-area-inset-top))]", "max-sm:bg-card");
    expect(container.querySelector("[data-sidebar-list]")).toHaveClass("overflow-y-auto", "max-sm:overflow-y-visible");
    fireEvent.click(within(tablist).getByRole("tab", { name: "Trash" }));
    await waitFor(() => expect(container.querySelector("[data-sidebar-header]")).toHaveClass("max-sm:sticky"));
    await waitFor(() => expect(container.querySelector("[data-sidebar-list]")).toHaveClass("max-sm:overflow-y-visible"));
  });

  it("while mounted the browser's own scroll restoration is off (manual), restored on unmount", async () => {
    stubFetch([NOTE]);
    window.history.scrollRestoration = "auto";
    const view = renderAt("/", <LocationProbe />);
    await screen.findByRole("tablist");
    expect(window.history.scrollRestoration).toBe("manual");
    view.unmount();
    expect(window.history.scrollRestoration).toBe("auto");
  });

  it("a scroll clamped to 0 right after the width crosses 640, before React switches tier, isn't recorded as the list position", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt(
      "/",
      <>
        <LocationProbe />
        <Back />
      </>,
    );
    const link = await within(asideOf(container)).findByRole("link", { name: /^Alpha Note/ });
    scrollPage(420);
    // The media query is already non-phone but React hasn't been notified: a scroll now (clamped to 0) isn't the user's position.
    vi.stubGlobal("matchMedia", () => ({ matches: false, media: "", addEventListener: () => {}, removeEventListener: () => {} }));
    scrollPage(0);
    stubLayoutTier("phone");
    fireEvent.click(link);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/n/tester/alpha-note"));
    fireEvent.click(screen.getByRole("button", { name: "history-back", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/));
    expect(lastScrollY()).toBe(420);
  });

  it("note-page floating buttons are mounted outside the main content area (it translates when sliding in; fixed buttons must not be carried along)", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt(
      "/n/tester/alpha-note",
      <>
        <LocationProbe />
        <NoteBrowseBar note={NOTE} />
      </>,
    );
    const bar = screen.getByTestId("note-browse-bar");
    const main = container.querySelector("main")!;
    const slot = container.querySelector("[data-phone-fab-slot]")!;
    expect(main).not.toContainElement(bar);
    expect(slot).toContainElement(bar);
    expect(main.contains(slot)).toBe(false);
    // Not inside the frame (a flex row): if the buttons' wrapper became a flex item, the frame's gap would narrow the main content area.
    expect(frameOf(container).contains(slot)).toBe(false);
  });
});

describe.each(["overlay", "docked"] as const)("AppShell - %s: the page itself does not scroll", (tier) => {
  useTier(tier);

  it("list -> note -> back never calls window.scrollTo", async () => {
    stubFetch([NOTE]);
    renderAt(
      "/",
      <>
        <LocationProbe />
        <Back />
      </>,
    );
    await screen.findByRole("tablist");
    scrollPage(0);
    const link = await screen.findByRole("link", { name: /^Alpha Note/ });
    fireEvent.click(link);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/n/tester/alpha-note"));
    fireEvent.click(screen.getByRole("button", { name: "history-back" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/));
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

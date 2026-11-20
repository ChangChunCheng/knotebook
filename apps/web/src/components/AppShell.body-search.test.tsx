import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { canonicalNotePath, type NoteDto, type NoteSearchResultDto, type UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { BlockAnchorContext } from "@/hooks/block-anchor-context";
import { onSearchMarkClear } from "@/hooks/search-mark";
import { ActiveNoteProvider } from "@/lib/active-note";
import { OVERLAY_QUERY } from "@/lib/layout-tiers";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts } from "@/components/ui/toast";
import { AppShell, SidebarDrawerButton } from "./AppShell";
import { OWNER_PERMS } from "@/test/fixtures";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

/**
 * #93: clicking a snippet in the content area inside the narrow-viewport drawer always closes it (another note closes via pathname; the same note keeps its pathname, so the click must close it).
 * Debounce (300 ms) and lazy chunks are real; global asyncUtilTimeout is 10 s (test/setup.ts).
 */
const USER = { id: "u1", email: "a@example.com", handle: "tester", displayName: "Ann", isAdmin: false, mustChangePassword: false, hasPassword: true, autoVersions: true, avatar: null } satisfies UserDto;
const NOTE: NoteDto = {
  id: "44444444-4444-4444-8444-444444444444", title: "Drawer Note", ownerId: "u1", role: "owner", createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z", slug: "drawer-note", slugIsCustom: false, prevSlug: null, ownerHandle: "tester", lastEdited: null,
  group: null, groupId: null, folderId: null, permissions: OWNER_PERMS,
};
const SEARCH: NoteSearchResultDto = { hits: [{ note: NOTE, matchedOn: "body", matches: [{ sectionId: "h1", heading: "Gamma", snippet: "the needle is here" }] }], nextCursor: null };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/groups") return Promise.resolve(json([]));
      if (url === "/api/auth/me") return Promise.resolve(json(USER));
      if (url === "/api/folders") return Promise.resolve(json(FOLDER_LIST_EMPTY));
      if (url === "/api/notes") return Promise.resolve(json([NOTE]));
      if (url.startsWith("/api/search?")) return Promise.resolve(json(SEARCH));
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

function stubNarrow() {
  const mql = { matches: true, media: OVERLAY_QUERY, addEventListener: () => {}, removeEventListener: () => {}, onchange: null, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false };
  vi.stubGlobal("matchMedia", vi.fn((query: string) => (query === OVERLAY_QUERY ? mql : { ...mql, matches: false })));
}

function renderShell(wrap: (shell: ReactNode) => ReactNode = (s) => s, initialEntry = "/") {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <ActiveNoteProvider>{wrap(<AppShell><SidebarDrawerButton /></AppShell>)}</ActiveNoteProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

async function openDrawerAndSearch() {
  fireEvent.click(await screen.findByRole("button", { name: "Open sidebar" }));
  const drawer = await screen.findByRole("dialog", { name: "Navigation" });
  fireEvent.change(within(drawer).getByRole("textbox", { name: "Search notes" }), { target: { value: "needle" } });
  return within(drawer).findByTestId("body-match");
}
const drawerGone = () => waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument());

describe("narrow-viewport drawer: clicking a content snippet closes the drawer", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    stubNarrow();
    stubFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("snippet of another note -> drawer closes", async () => {
    renderShell();
    fireEvent.click(await openDrawerAndSearch());
    await drawerGone();
  });

  it("snippet of the current note (pathname unchanged) -> drawer also closes, requestAnchor is called", async () => {
    const requestAnchor = vi.fn();
    renderShell((shell) => (
      <BlockAnchorContext.Provider value={{ currentNoteId: NOTE.id, requestAnchor, scrollToTop: vi.fn() }}>{shell}</BlockAnchorContext.Provider>
    ));
    fireEvent.click(await openDrawerAndSearch());
    await drawerGone();
    expect(requestAnchor).toHaveBeenCalledWith("h1", "needle");
  });

  it("hit on the current note (URL has #b-) -> drawer also closes (pathname unchanged, only the click handler closes it; one hit per match, each whole hit is a link)", async () => {
    renderShell((s) => s, `${canonicalNotePath(NOTE)}#b-h1`);
    const match = await openDrawerAndSearch();
    expect(within(match.closest('[data-testid="search-hit"]') as HTMLElement).getAllByRole("link")).toHaveLength(1);
    expect(match).toHaveAttribute("href", `${canonicalNotePath(NOTE)}#b-h1`);
    fireEvent.click(match);
    await drawerGone();
  });
});

describe("persistent search-jump marker: only closing the search clears it", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    stubNarrow();
    stubFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("narrow screen: clicking a result closes the drawer without clearing the marker (query stays in AppShell); reopening and pressing the search box clear button clears it, once", async () => {
    const cleared = vi.fn();
    const off = onSearchMarkClear(cleared);
    try {
      renderShell();
      fireEvent.click(await openDrawerAndSearch());
      await drawerGone();
      expect(cleared).not.toHaveBeenCalled();
      fireEvent.click(await screen.findByRole("button", { name: "Open sidebar" }));
      const drawer = await screen.findByRole("dialog", { name: "Navigation" });
      expect(within(drawer).getByRole("textbox", { name: "Search notes" })).toHaveValue("needle");
      fireEvent.click(within(drawer).getByRole("button", { name: "Clear search" }));
      expect(cleared).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it("manually deleting all search text clears it; editing text (non-empty -> non-empty) or starting empty does not", async () => {
    const cleared = vi.fn();
    const off = onSearchMarkClear(cleared);
    try {
      renderShell();
      expect(cleared).not.toHaveBeenCalled();
      fireEvent.click(await screen.findByRole("button", { name: "Open sidebar" }));
      const box = within(await screen.findByRole("dialog", { name: "Navigation" })).getByRole("textbox", { name: "Search notes" });
      fireEvent.change(box, { target: { value: "ne" } });
      fireEvent.change(box, { target: { value: "nee" } });
      expect(cleared).not.toHaveBeenCalled();
      fireEvent.change(box, { target: { value: "" } });
      expect(cleared).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });
});

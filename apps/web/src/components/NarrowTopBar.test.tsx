import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ReactNode } from "react";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import HomePage from "@/pages/HomePage";
import { NotePageFallback } from "./NotePageFallback";
import { AppShellLayout } from "./AppShellLayout";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { stubLayoutTier } from "@/test/layout-tier";

/**
 * #115: consumer guard for NarrowTopBar (the `xl:hidden` sidebar button + K logo row).
 * The explicit list is HomePage, NotePageFallback and NoteRouteErrorFallback (the third's assertion lives in `ErrorBoundary.test.tsx`, which has the error-screen harness; the reverse assertion that AppErrorFallback is deliberately excluded is there too). Without this guard these pages are dead ends on a narrow window (sidebar hidden, nothing can open the drawer), which jsdom (no CSS) can't reveal.
 */

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

function fakeResponse(json: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(json) } as unknown as Response;
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/me") return Promise.resolve(fakeResponse(USER));
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes") return Promise.resolve(fakeResponse([]));
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

function renderWithProviders(children: ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route element={<AppShellLayout />}>
              <Route path="*" element={children} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe("NarrowTopBar consumers (#115)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("HomePage content card top has the xl:hidden sidebar button row (entry to open the drawer)", async () => {
    renderWithProviders(<HomePage />);
    // The static sidebar has no drawer-opening button, so the "Open sidebar" found here is NarrowTopBar's; it must be inside main (the content card).
    const hamburger = await screen.findByRole("button", { name: "Open sidebar" });
    expect(hamburger.closest("main")).not.toBeNull();
    // Assert xl:hidden on the wrapper and on the button **separately**: `closest('[class*="xl:hidden"]')` includes the element itself and the button carries the class,
    // so that form is always true (it stays green with xl:hidden removed from the wrapper). Losing the wrapper's class would leave a "K Knotebook" row
    // at the top of every content card on wide windows.
    expect(hamburger.parentElement).toHaveClass("xl:hidden");
    expect(hamburger).toHaveClass("xl:hidden");
  });

  it("NotePageFallback (transition screen while the chunk loads) also has the sidebar button row", async () => {
    renderWithProviders(<NotePageFallback />);
    const hamburger = await screen.findByRole("button", { name: "Open sidebar" });
    expect(hamburger.closest("main")).not.toBeNull();
  });

  it("phone: the top bar starts with 'Back to notes', no 'Open sidebar'", async () => {
    stubLayoutTier("phone");
    renderWithProviders(<NotePageFallback />);
    const back = await screen.findByRole("button", { name: "Back to notes" });
    expect(back.closest("main")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Open sidebar" })).toBeNull();
  });

  it("phone: top bar hugs the screen top edge, top padding plus safe area; py-2 unchanged for non-phone", async () => {
    stubLayoutTier("phone");
    renderWithProviders(<NotePageFallback />);
    const back = await screen.findByRole("button", { name: "Back to notes" });
    const bar = back.parentElement;
    expect(bar).toHaveClass("py-2", "max-sm:pt-[calc(0.5rem+env(safe-area-inset-top))]");
    // On phone the content card itself hugs the edges: no rounded corners or border.
    expect(back.closest("main")?.firstElementChild).toHaveClass("max-sm:rounded-none", "max-sm:border-0", "max-sm:pb-[env(safe-area-inset-bottom)]");
  });

  it("floating tier: top bar is 'Open sidebar', no 'Back to notes'", async () => {
    stubLayoutTier("overlay");
    renderWithProviders(<NotePageFallback />);
    expect(await screen.findByRole("button", { name: "Open sidebar" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back to notes" })).toBeNull();
  });
});

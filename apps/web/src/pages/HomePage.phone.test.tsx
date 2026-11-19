import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import i18n from "@/i18n";
import { SidebarDrawerContext } from "@/lib/sidebar-drawer";
import { stubLayoutTier } from "@/test/layout-tier";
import HomePage from "./HomePage";

function renderHome() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) } as unknown as Response)),
  );
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <SidebarDrawerContext.Provider value={{ setOpen: () => {} }}>
          <HomePage />
        </SidebarDrawerContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("HomePage phone", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("phone: renders no empty-state card and no top bar (the list fills the screen)", async () => {
    stubLayoutTier("phone");
    const { container } = renderHome();
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it.each(["overlay", "docked"] as const)("%s: empty state shown as before", async (tier) => {
    stubLayoutTier(tier);
    const { container } = renderHome();
    expect(await screen.findByText("No notes yet.")).toBeInTheDocument();
    // The content card has rounded corners and a border from 640 up; on phone (this tier is not rendered) it is flush.
    expect(container.firstElementChild).toHaveClass("rounded-xl", "border", "max-sm:rounded-none", "max-sm:border-0", "max-sm:pb-[env(safe-area-inset-bottom)]");
  });
});

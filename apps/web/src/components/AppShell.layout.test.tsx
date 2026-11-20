import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { AppShell } from "./AppShell";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { SIDEBAR_WIDTH_DEFAULT } from "@/components/sidebar-width";

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === "/api/auth/me") {
        return Promise.resolve(fakeResponse({ ok: false, status: 401 }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

/**
 * Asserts the class strings themselves: these combinations look fine in jsdom snapshots and ordinary interaction tests and only break with real scrolling content and flex squeeze.
 * Sidebar width is an inline style (draggable); root `gap-3` stays because the drag handle (an `absolute left-full w-3` child of `<aside>`) overlaps that gap. The handle itself: `AppShell.resize.test.tsx`.
 */
describe("AppShell layout smoke", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.removeItem("sidebar.width");
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("root = flex h-dvh overflow-hidden gap-3 bg-background + safe-area padding on all four sides; main = flex min-h-0 min-w-0 flex-1 flex-col", async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <AppShell>content</AppShell>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );

    const main = await screen.findByText("content");
    const root = main.closest("main")?.parentElement;

    expect(main.closest("main")).toHaveClass("flex", "min-h-0", "min-w-0", "flex-1", "flex-col");
    // Height follows the browser toolbar (dvh), not a fixed 100vh.
    expect(root).toHaveClass("flex", "h-dvh", "overflow-hidden", "gap-3", "bg-background");
    expect(root).not.toHaveClass("h-screen");
    // Each side is max(12px, safe area): no edge contact under notches/rounded corners, still 12px without insets.
    expect(root).not.toHaveClass("p-3");
    for (const [prefix, side] of [["pt", "top"], ["pr", "right"], ["pb", "bottom"], ["pl", "left"]]) {
      expect(root).toHaveClass(`${prefix}-[max(0.75rem,env(safe-area-inset-${side}))]`);
    }
    // Phone (< 640): content hugs the screen edge, so the outer padding is zero (the non-phone classes remain; unchanged from 640 up).
    expect(root).toHaveClass("max-sm:p-0");
    // On phone the left/right safe area (landscape notch) is handled by the main content area itself.
    expect(main.closest("main")).toHaveClass("max-sm:pl-[env(safe-area-inset-left)]", "max-sm:pr-[env(safe-area-inset-right)]");

    // The static sidebar card is hidden below xl (the floating drawer takes over) and shown from xl up; `hidden` needs both `xl:flex` (else it vanishes on wide screens) and `xl:flex-col` (else the inner stack loses its direction).
    const aside = root?.querySelector("aside");
    expect(aside).not.toBeNull();
    expect(aside).toHaveClass("relative", "hidden", "shrink-0", "xl:flex", "xl:flex-col");
    // Width is an inline style (draggable), not `w-64`; no saved width = default width.
    expect(aside).not.toHaveClass("w-64");
    expect(aside?.style.width).toBe(`${SIDEBAR_WIDTH_DEFAULT}px`);
  });

  // getByText is not filtered by the accessibility tree, so it can reach the aria-hidden K <span>. ThemeProvider always sets data-accent on <html> on mount (theme.tsx), so clean up in finally to avoid polluting later cases (same as UserMenu.test.tsx).
  it("K logo uses text-brand; new-note button uses the brand tint variant", async () => {
    try {
      render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <ThemeProvider>
            <MemoryRouter initialEntries={["/"]}>
              <AppShell>content</AppShell>
            </MemoryRouter>
          </ThemeProvider>
        </QueryClientProvider>,
      );

      await screen.findByText("content");

      expect(screen.getByText("K")).toHaveClass("text-brand");
      expect(screen.getByRole("button", { name: "New note" })).toHaveClass(
        "bg-brand-soft",
        "text-brand-on-soft",
        "hover:bg-brand-soft-strong",
      );
    } finally {
      document.documentElement.removeAttribute("data-accent");
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { ThemeProvider } from "@/theme";
import { AppErrorBoundary } from "./ErrorBoundary";
import { AppShell } from "./AppShell";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

// TrashLazy chunk fails to load: only the trash part errors, the rest of the sidebar and page stay, nothing bubbles to AppErrorBoundary.
// The message mimics Chromium's bare dynamic-import failure (CHUNK_ERROR_PATTERNS in ErrorBoundary.tsx); vitest wraps the factory's reject as "error when mocking a module" with the original in `cause`,
// and `isChunkLoadError` already checks one level of cause, so it is still classed as a chunk error.

vi.mock("@/components/sidebar/TrashLazy", () =>
  Promise.reject(new TypeError("Failed to fetch dynamically imported module: http://localhost/assets/TrashLazy-abc.js")),
);

const TRASH_FLAG = "knotebook:chunk-reload:trash";
const NOTEPAGE_FLAG = "knotebook:chunk-reload:notepage";

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
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

function renderApp() {
  const appReload = vi.fn();
  render(
    <AppErrorBoundary reload={appReload}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <ActiveNoteProvider>
              <Routes>
                <Route path="/" element={<AppShell>{<div data-testid="page-body">body</div>}</AppShell>} />
              </Routes>
            </ActiveNoteProvider>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>
    </AppErrorBoundary>,
  );
}

const aside = () => document.querySelector("aside") as HTMLElement;

describe("AppShell - trash chunk fails to load", () => {
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    sessionStorage.clear();
    reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
    localStorage.clear();
  });

  it("auto-reload already used once this session: the trash panel shows the chunk error plus retry in place, tab row, UserMenu and page content work as usual", async () => {
    sessionStorage.setItem(TRASH_FLAG, "1");
    stubFetch();
    renderApp();
    fireEvent.click(await within(aside()).findByRole("tab", { name: "Trash" }));

    const panel = within(aside()).getByRole("tabpanel");
    const alert = await within(panel).findByRole("alert");
    expect(alert).toHaveTextContent(i18n.t("app.chunkLoadError"));
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    // The footer copy of the alert is hidden: the panel copy already shows the error.
    const footerAlerts = within(aside()).getAllByRole("alert").filter((el) => !panel.contains(el));
    expect(footerAlerts).toHaveLength(1);
    // Match the whole className: without errorClassName the alert hangs directly under the aside, and the desktop aside carries its own `hidden md:flex` (toHaveClass would pass vacuously).
    expect(footerAlerts[0]!.parentElement?.className).toBe("hidden");

    expect(screen.queryByText("Something went wrong")).toBeNull();
    expect(within(aside()).getByRole("tablist", { name: "Sidebar sections" })).toBeInTheDocument();
    expect(within(aside()).getByRole("button", { name: /Ann/ })).toBeInTheDocument();
    expect(screen.getByTestId("page-body")).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();

    fireEvent.click(within(aside()).getByRole("tab", { name: "My notes" }));
    expect(within(aside()).getByRole("button", { name: "New note" })).toBeInTheDocument();
    expect(within(aside()).queryByRole("alert")).toBeNull();
  });

  it("first failure: auto-reloads once using trash's own allowance (two mount points reload once), NotePage allowance untouched, app doesn't crash", async () => {
    stubFetch();
    renderApp();
    fireEvent.click(await within(aside()).findByRole("tab", { name: "Trash" }));

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem(TRASH_FLAG)).not.toBeNull();
    expect(sessionStorage.getItem(NOTEPAGE_FLAG)).toBeNull();
    expect(screen.queryByText("Something went wrong")).toBeNull();
    expect(within(aside()).getByRole("tablist", { name: "Sidebar sections" })).toBeInTheDocument();
    expect(screen.getByTestId("page-body")).toBeInTheDocument();
  });
});

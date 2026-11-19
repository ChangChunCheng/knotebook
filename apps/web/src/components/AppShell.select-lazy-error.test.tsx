import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { ThemeProvider } from "@/theme";
import { __resetCollapseForTests } from "@/components/sidebar/collapse";
import { adminRole, groupDto } from "@/test/fixtures";
import { groupNote, personalNote } from "@/test/select-fixtures";
import { AppErrorBoundary } from "./ErrorBoundary";
import { AppShell } from "./AppShell";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

// SelectLazy chunk (normal-tab selection mode) fails to load (#181; same structure as AppShell.trash-lazy-error.test.tsx): only the selection parts error, the rest of the sidebar and page stay, nothing bubbles to AppErrorBoundary.
// The message mimics Chromium's bare dynamic-import failure; vitest wraps the factory's reject as "error when mocking a module" with the original in `cause` (`isChunkLoadError` checks one level of cause).
// Mocking only SelectLazy isn't enough: NoteList issues two `import()`s of SelectLazy in one render (title row, list) and in vitest 3.2.7 one of two concurrent imports from the same importer bypasses the factory and loads the real module (`requestWithMock` in execute.js shares one callstack; its comment: "will not work if user does Promise.all(import(), import())"). So the real SelectLazy's first import is made to fail too, and the bypassing import then fails with the same chunk error (in a real browser the three mount points fetch the same chunk and fail together anyway).
vi.mock("@/components/sidebar/SelectLazy", () =>
  Promise.reject(new TypeError("Failed to fetch dynamically imported module: http://localhost/assets/SelectLazy-abc.js")),
);
vi.mock("@/i18n/select-strings", () =>
  Promise.reject(new TypeError("Failed to fetch dynamically imported module: http://localhost/assets/SelectLazy-abc.js")),
);

const SELECT_FLAG = "knotebook:chunk-reload:select";
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

const GROUP = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "R&D" }, adminRole());
const NOTES = [
  personalNote({ id: "p1", title: "p1" }),
  personalNote({ id: "p2", title: "p2" }),
  groupNote({ id: "w1", title: "w1", group: GROUP }),
];

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse([GROUP]));
      if (url === "/api/auth/me") return Promise.resolve(fakeResponse(USER));
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse(NOTES));
      // #93: with search text of 2+ characters the sidebar content area calls /api/search (returns empty).
      if (url.startsWith("/api/search?")) return Promise.resolve(new Response(JSON.stringify({ hits: [], nextCursor: null }), { status: 200, headers: { "Content-Type": "application/json" } }));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

function renderApp() {
  render(
    <AppErrorBoundary reload={vi.fn()}>
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
const header = () => aside().querySelector("[data-sidebar-header]") as HTMLElement;
const list = () => aside().querySelector("[data-sidebar-list]") as HTMLElement;

async function startSelecting() {
  await within(aside()).findByRole("link", { name: "p1" });
  fireEvent.click(within(header()).getByRole("button", { name: "Select" }));
}

describe("AppShell - normal-tab selection chunk fails to load", () => {
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
    __resetCollapseForTests();
  });

  it("auto-reload already used once this session: the list position shows the chunk error plus retry in place, error content of the title row and bottom is hidden, the rest of the sidebar works", async () => {
    sessionStorage.setItem(SELECT_FLAG, "1");
    stubFetch();
    renderApp();
    await startSelecting();

    const listAlert = await within(list()).findByRole("alert");
    expect(listAlert).toHaveTextContent(i18n.t("app.chunkLoadError"));
    expect(within(listAlert).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    // Match the whole className: the frame has only `p-2`.
    expect(listAlert.parentElement?.className).toBe("p-2");
    // The header and footer copies are hidden: the list copy already shows the error.
    const headerAlerts = within(header()).getAllByRole("alert");
    expect(headerAlerts).toHaveLength(1);
    expect(headerAlerts[0]!.parentElement?.className).toBe("hidden");
    // What remains after excluding the list and header copies is the footer's.
    const footerAlerts = within(aside())
      .getAllByRole("alert")
      .filter((el) => !list().contains(el) && !header().contains(el));
    expect(footerAlerts).toHaveLength(1);
    expect(footerAlerts[0]!.parentElement?.className).toBe("hidden");
    expect(within(aside()).queryByRole("button", { name: "New note" })).toBeNull();

    expect(screen.queryByText("Something went wrong")).toBeNull();
    expect(within(aside()).getByRole("tablist", { name: "Sidebar sections" })).toBeInTheDocument();
    expect(within(aside()).getByRole("textbox", { name: "Search notes" })).toBeInTheDocument();
    expect(within(aside()).getByRole("button", { name: /Ann/ })).toBeInTheDocument();
    expect(screen.getByTestId("page-body")).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it("first failure: auto-reloads once using select's own allowance (three mount points reload once), NotePage and trash allowances untouched, app doesn't crash", async () => {
    stubFetch();
    renderApp();
    await startSelecting();

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem(SELECT_FLAG)).not.toBeNull();
    expect(sessionStorage.getItem(NOTEPAGE_FLAG)).toBeNull();
    expect(sessionStorage.getItem(TRASH_FLAG)).toBeNull();
    expect(screen.queryByText("Something went wrong")).toBeNull();
    expect(within(aside()).getByRole("tablist", { name: "Sidebar sections" })).toBeInTheDocument();
    expect(screen.getByTestId("page-body")).toBeInTheDocument();
  });

  it("error state has no Esc or Done: clicking Groups leaves selection, groups are ordinary rows", async () => {
    sessionStorage.setItem(SELECT_FLAG, "1");
    stubFetch();
    renderApp();
    await startSelecting();
    await within(list()).findByRole("alert");

    fireEvent.click(within(aside()).getByRole("tab", { name: "Groups" }));
    expect(await within(list()).findByRole("link", { name: "w1" })).toBeInTheDocument();
    expect(within(list()).getByRole("button", { name: "R&D" })).toHaveAttribute("aria-expanded", "true");
    expect(within(header()).getByRole("button", { name: "Select" })).toBeEnabled();
    expect(within(aside()).queryAllByRole("checkbox")).toHaveLength(0);
    expect(within(aside()).queryByRole("alert")).toBeNull();
    expect(within(aside()).queryByRole("button", { name: "New note" })).toBeNull(); // the Groups tab has no personal new-note button
  });
});

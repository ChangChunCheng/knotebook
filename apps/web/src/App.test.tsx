import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { AppRoutes } from "./App";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return {
    ok,
    status,
    json: json ?? (() => Promise.reject(new Error("no body"))),
  } as unknown as Response;
}

const ADMIN_USER: UserDto = {
  id: "u1",
  email: "admin@example.com",
  handle: "tester",
  displayName: "Admin",
  isAdmin: true,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
  avatar: null,
};

// Site admin (a modal in the second tree since #247): `/settings/users` (old bookmark) redirects to `/admin/users`; `/admin/*` isn't in the main tree, which renders HomePage (matching `/*`) as the background. Guard chaining, redirects and navigation are covered in `components/admin/AdminModal.test.tsx`.
describe("App route tree - /settings/users -> /admin/users (site admin modal, #247)", () => {
  function mockFetchForRedirect() {
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === "/api/auth/me") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ADMIN_USER) }));
      }
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === "/api/admin/users" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === "/api/admin/invites" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === "/api/auth/config" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: true } }) }));
      }
      if (url === "/api/admin/storage-plans" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ plans: [], defaults: { userPlanId: "", groupPlanId: "" } }) }));
      }
      if (url === "/api/admin/trash/settings" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ retentionDays: 7 }) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
  }

  function LocationProbe() {
    const location = useLocation();
    return <div data-testid="redirect-location">{location.pathname}</div>;
  }

  function renderAt(path: string) {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ThemeProvider>
          <MemoryRouter initialEntries={[path]}>
            <AppRoutes />
            <LocationProbe />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("admin deep link /settings/users redirects to /admin/users (site admin modal, not the settings modal)", async () => {
    vi.stubGlobal("fetch", mockFetchForRedirect());
    renderAt("/settings/users");

    await waitFor(() => expect(screen.getByTestId("redirect-location")).toHaveTextContent("/admin/users"));
    const dialog = await screen.findByRole("dialog", { name: "Site admin" });
    await waitFor(() => expect(within(dialog).getByRole("heading", { name: "User management" })).toBeInTheDocument());
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("admin deep link /admin/users opens the site modal directly; the main tree has no /admin/* (background is HomePage via /*: New note present)", async () => {
    vi.stubGlobal("fetch", mockFetchForRedirect());
    renderAt("/admin/users");

    const dialog = await screen.findByRole("dialog", { name: "Site admin" });
    await waitFor(() => expect(within(dialog).getByRole("heading", { name: "User management" })).toBeInTheDocument());
    expect(screen.getByTestId("redirect-location")).toHaveTextContent("/admin/users");
    expect(screen.getByRole("button", { name: "New note", hidden: true })).toBeInTheDocument();
  });
});

// Regression pin for #19: NotePage's module is replaced by a stub that resolves only when the test releases it (no AppShell inside).
// vi.mock is hoisted and applies to the whole file's NotePage import, but the factory is lazy: the lazy App only triggers import() when /notes/:ref really renders, by which time the test has set up the gate; the factory stalls on the gate, the fallback stays up, and assertions don't race any timer. If NotePage were switched back to a static import (the regression), the factory would run while ./App is imported at the top of the file, before the gate exists (null), resolve immediately, and the stub would be in place from the start with no fallback ever, so the "New note" (AppShell landmark) assertion below never finds it on the stub's empty shell and fails.
// A gate instead of a timed resolve avoids flakes under full-suite parallel load; it is created only inside the test, so a static-import regression can't hang collection.
const notePageGate = vi.hoisted(() => ({ pending: null as Promise<void> | null, release: () => {} }));
vi.mock("./pages/NotePage", async () => {
  if (notePageGate.pending) await notePageGate.pending;
  return { default: () => <p>notepage-stub-without-appshell</p> };
});

/**
 * Regression pin for #19: with NotePage lazy, the sidebar (the layout route's AppShell) is still present while the chunk loads, not a blank page. This case guards "NotePage is lazy" and "shell present while the chunk loads"; the fallback's shape and "sidebar is the same node" are covered by `App.appShellLayout.test.tsx`.
 *
 * ⚠ Don't use "doMock + await import("./App")": the static import at the top already caches ./App with the real NotePage, so a dynamic import in the test returns the same cache and the mock never applies (a fake guard). The current form fails at the "New note" wait if NotePage reverts to a static import.
 */
describe("App route tree - NotePage lazy: shell present while the chunk loads (#19)", () => {
  afterEach(() => {
    // Release the gate even if the test fails midway, so the factory isn't left hanging (a later describe rendering /notes/... would stall).
    notePageGate.release();
    vi.unstubAllGlobals();
  });

  it("while the chunk loads: sidebar shell present (New note button), not a blank page", async () => {
    notePageGate.pending = new Promise<void>(resolve => {
      notePageGate.release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/groups") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
        }
        if (url === "/api/auth/me") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ADMIN_USER) }));
        }
        if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
        if (url === "/api/notes") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
        }
        return Promise.resolve(fakeResponse({ ok: false, status: 404 }));
      }),
    );
    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/notes/11111111-1111-1111-1111-111111111111"]}>
            <AppRoutes />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );

    // While the fallback is up (gate not released) the AppShell landmark must be present; the unbounded wait can't outlast the fallback period.
    await waitFor(() => expect(screen.getByText("New note")).toBeInTheDocument());
    // "Loading…" may appear in both the fallback and NoteList's loading state: at least one (AppShell present + loading text = the fallback's full shape).
    expect(screen.getAllByText("Loading…").length).toBeGreaterThanOrEqual(1);
    // Still in the fallback: the stub must not be up before release (if it were, NotePage isn't lazy).
    expect(screen.queryByText("notepage-stub-without-appshell")).not.toBeInTheDocument();

    // After release the stub must take over: proves this mock's gate is what held the fallback (if the mock didn't apply and the real NotePage loaded, the stub is never found and this fails).
    notePageGate.release();
    expect(await screen.findByText("notepage-stub-without-appshell")).toBeInTheDocument();
  });
});

// #131: once `useSessionGate` reads `useLocation()`, App.tsx's two `<Routes>` trees diverge observably: the main tree uses the overridden **background** location, the second tree (only `/settings/*`) uses the **real** URL; signed out, each renders a `<Navigate>` with a different target. Both replace, and the second tree's effect runs later and overwrites the first, so the user ends up at the real URL's target.
//
// This case guards that "later-mounted wins": moving the second tree's `/settings/*` routes into the main tree (or swapping the trees' order) would silently degrade `next` to the background page (`/notes/...`) and fail here. ⚠ It does not guard the other direction: if guards were changed to read the real location directly, this case would only get greener. The reasoning chain is in the JSDoc on the two trees in `App.tsx`.
describe("App route tree - #131: signed out with a modal over a background, next is the real URL, not the background page", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function LocationProbe() {
    const location = useLocation();
    return <div data-testid="app-location">{`${location.pathname}${location.search}`}</div>;
  }

  it("background /notes/..., URL bar /settings/account -> /login?next=%2Fsettings%2Faccount", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/auth/me") {
          return Promise.resolve(
            fakeResponse({
              ok: false,
              status: 401,
              json: () => Promise.resolve({ error: { code: "unauthorized", message: "no" } }),
            }),
          );
        }
        if (url === "/api/auth/config") {
          return Promise.resolve(
            fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: true } }) }),
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter
            initialEntries={[
              {
                pathname: "/settings/account",
                state: { backgroundLocation: { pathname: "/notes/note-1", search: "", hash: "", state: null, key: "bg" } },
              },
            ]}
          >
            <AppRoutes />
            <LocationProbe />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("app-location").textContent).toBe("/login?next=%2Fsettings%2Faccount");
    });
  });
});

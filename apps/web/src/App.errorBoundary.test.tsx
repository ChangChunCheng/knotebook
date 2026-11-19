import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { AppRoutes } from "./App";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

/**
 * Pins that App.tsx really wraps /notes/:ref in NoteRouteErrorBoundary and puts ChunkLoadBeacon inside Suspense. The boundary's own behaviour is in ErrorBoundary.test.tsx, where a hand-assembled shape says nothing about App.tsx's. The app-level wiring is in App.appBoundary.test.tsx (its HomePage mock is hoisted file-wide and would couple with this file).
 *
 * ⚠⚠ The chunk-error case must stay declared before the "renders normally" case, and no new case that successfully renders /notes/:ref may precede it: App.tsx's NotePage lazy is a module-level singleton, so only the first case to trigger it passes through a suspend period. The guard "beacon misplaced outside Suspense -> chunk-error case fails" relies on that pending period (the worst failure here is an infinite reload loop): a misplaced beacon commits during it and clears the seeded flag, so componentDidCatch wrongly treats the error as the first one and reloads into the loading screen, turning the chunk-error-screen assertion red. If the normal case ran first and resolved the lazy, the chunk-error case would be a plain synchronous throw, the beacon would never commit, and the guard would silently stop working.
 */

// vi.mock is hoisted, so the factory can't reference top-level consts (TDZ): shared state goes through vi.hoisted. Read the flag inside the mock component's function body: React.lazy caches the import result forever and the factory runs once, so choosing the export in the factory would give the second case the first case's behaviour.
const mockNotePage = vi.hoisted(() => ({
  mode: "throw" as "throw" | "ok",
  chunkMessage: "Failed to fetch dynamically imported module: https://x/assets/NotePage-abc.js",
}));

vi.mock("./pages/NotePage", () => ({
  default: function NotePageMock() {
    if (mockNotePage.mode === "throw") throw new Error(mockNotePage.chunkMessage);
    return <p>notepage-mock-ok</p>;
  },
}));

const FLAG_KEY = "knotebook:chunk-reload:notepage";
const CHUNK_ERROR_TEXT = "Couldn't load this page — check your connection, or a new version may have been deployed.";

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

function stubFetch() {
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
}

function renderNoteRoute() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/notes/11111111-1111-1111-1111-111111111111"]}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  sessionStorage.clear();
  // Reset so a new case that forgets to set the mode doesn't inherit the previous case's.
  mockNotePage.mode = "throw";
  await i18n.changeLanguage("en");
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App route tree - ErrorBoundary wiring for /notes/:ref (#66)", () => {
  // Runs first (see header). The seeded flag short-circuits the auto-reload path into the chunk-error screen, giving a stable end state to assert and a flag a misplaced beacon could clear.
  it("NotePage render throws a chunk error (flag set) -> chunk-error screen, not a blank page", async () => {
    sessionStorage.setItem(FLAG_KEY, "1");
    mockNotePage.mode = "throw";
    vi.stubGlobal("location", { ...window.location, reload: vi.fn() });

    renderNoteRoute();

    // Precondition: the chunk-error screen must not already be showing. If it appears synchronously, an earlier case already resolved the NotePage lazy and this case skipped the suspend period, which would silently disable the misplaced-beacon guard (see header). This turns that ordering assumption into a failing assertion.
    expect(screen.queryByText(CHUNK_ERROR_TEXT)).not.toBeInTheDocument();

    // Chunk-error-specific elements (chunk-branch text + retry button). Don't assert the AppShell landmark ("New note") instead: the sidebar is in the layout route, independent of the boundary, so it would pass without the boundary.
    // Waiting for an end state: the assertion content guards, not the wait length; headroom for the whole chain (fetch -> react-query -> lazy -> classification -> setState) on a loaded cold start comes from the global asyncUtilTimeout in test/setup.ts.
    await waitFor(() => expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("NotePage renders normally (flag set) -> beacon clears the flag (clear-on-success wiring)", async () => {
    sessionStorage.setItem(FLAG_KEY, "1"); // Seeded: starting empty would pass even if the beacon were deleted
    mockNotePage.mode = "ok";

    renderNoteRoute();

    await waitFor(() => expect(screen.getByText("notepage-mock-ok")).toBeInTheDocument());
    expect(sessionStorage.getItem(FLAG_KEY)).toBeNull();
  });
});

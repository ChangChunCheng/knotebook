import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NoteDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import App from "./App";
import { OWNER_PERMS } from "@/test/fixtures";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

/**
 * Pins that the default-exported App() really wraps AppRoutes in ActiveNoteProvider. Other tests supply their own provider and render AppRoutes, so the real tree's wiring never runs there. useActiveNote fails loudly: a missing provider sends every signed-in page (each sidebar row consumes the context) into the app-level ErrorBoundary fallback, a blank site.
 *
 * Same premise as App.appBoundary.test: the default-export App contains BrowserRouter and reads the real window.location (jsdom default `/` -> HomePage, whose sidebar NoteList renders the stubbed notes).
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

const NOTE: NoteDto = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "Wired Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "wired-note",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
  group: null,
  groupId: null,
  folderId: null,
  permissions: OWNER_PERMS,
};

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

describe("App - ActiveNoteProvider wiring (#122)", () => {
  beforeEach(async () => {
    sessionStorage.clear();
    await i18n.changeLanguage("en");
    window.history.replaceState(null, "", "/");
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/groups") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
        }
        if (url === "/api/auth/me") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
        }
        if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
        if (url === "/api/notes") {
          // The list must be non-empty: only then does NoteRow render and call useActiveNote; with an empty list the test passes with or without the provider.
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([NOTE]) }));
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("real tree renders sidebar note rows (consuming the context) without the app-level fallback; fails if the provider is missing", async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <App />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getAllByRole("link", { name: "Wired Note" }).length).toBeGreaterThan(0));
    // The app-level fallback text is app.crashTitle (as APP_CRASH_TITLE in App.appBoundary.test), not the errors.internal text, which would make the assertion vacuous.
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
  });
});

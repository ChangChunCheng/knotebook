import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import App from "./App";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

/**
 * Pins that the default-exported App() really wraps its outermost layer in AppErrorBoundary. Other tests render only AppRoutes, so that layer never runs there.
 *
 * Kept in its own file: vi.mock("./pages/HomePage") is hoisted file-wide, so in a shared file any case reaching `/` would get the app-level fallback.
 *
 * The default-export App contains BrowserRouter and reads the real window.location: do not stub location (the router would get a fake Location and crash). jsdom's default URL makes pathname `/` hit the catch-all -> HomePage (mocked to throw a non-chunk error). QueryClientProvider comes from the test (App doesn't include it; main.tsx provides it).
 */

vi.mock("./pages/HomePage", () => ({
  default: function HomePageMock(): never {
    throw new Error("render crash from homepage");
  },
}));

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

beforeEach(async () => {
  sessionStorage.clear();
  await i18n.changeLanguage("en");
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App - app-level ErrorBoundary wiring (#66)", () => {
  it("non-chunk render error in the tree -> app-level fallback text, no blank screen", async () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>,
    );

    // Waits for a final state; the assertion content is what guards. Cold-start headroom comes from the global asyncUtilTimeout in test/setup.ts, so no per-test limit.
    await waitFor(() => expect(screen.getByText("Something went wrong")).toBeInTheDocument());
  });
});

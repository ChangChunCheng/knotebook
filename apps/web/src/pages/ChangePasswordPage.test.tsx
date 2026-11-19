import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";
import { expectCardControls44 } from "@/test/card-controls";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

// Same convention as SettingsUsersSection.test.tsx: mock global fetch and go through the real `AppRoutes` (the single tree in App.tsx),
// without mocking ChangePasswordPage itself - what is verified is the wiring (route under <RequireAuth>; after success the ['me']
// refetch gets mustChangePassword:false and lands on /; the sign-out button can really leave this page), not just the component rendered alone.

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const USER_MUST_CHANGE: UserDto = {
  id: "u1",
  email: "alice@example.com",
  handle: "tester",
  displayName: "Alice",
  isAdmin: false,
  mustChangePassword: true,
  hasPassword: true,
  autoVersions: true,
  avatar: null,
};

const CHANGE_PASSWORD_URL = "/api/auth/password";

/** Base fetch mock: `/api/auth/me` returns `loggedInAs`, which may change on later calls - a getter rather than a fixed value, so
 * "the next me query after a password change / sign-out returns something different" can be tested, instead of pinning one
 * response for the whole file. */
function baseFetchHandlers(getLoggedInAs: () => UserDto | null) {
  return (url: string, method: string): Response | null => {
    if (url === "/api/groups" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url === "/api/auth/me" && method === "GET") {
      const user = getLoggedInAs();
      if (user) {
        return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(user) });
      }
      return fakeResponse({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: { code: "unauthorized", message: "nope" } }),
      });
    }
    if (url === "/api/folders") return new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url === "/api/notes" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    return null;
  };
}

function renderAt(initialPath: string, fetchMock: ReturnType<typeof vi.fn>, queryClient: QueryClient = new QueryClient()) {
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
      <Toaster />
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("ChangePasswordPage", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a mustChangePassword:true user visiting /change-password -> renders the form (the gate does not redirect away)", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers(() => USER_MUST_CHANGE)(url, method);
      if (base) return Promise.resolve(base);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAt("/change-password", fetchMock);

    await waitFor(
      () => expect(screen.getByRole("heading", { name: "Change your password" })).toBeInTheDocument(),
    );
  });

  it("card page exception: sign-out, the three password fields and the submit button are 44px (h-11)", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers(() => USER_MUST_CHANGE)(url, method);
      if (base) return Promise.resolve(base);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    renderAt("/change-password", fetchMock);
    await screen.findByRole("heading", { name: "Change your password" });
    expect(expectCardControls44()).toBe(5);
  });

  it("new password < 12 characters -> blocked on the client, no API call", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers(() => USER_MUST_CHANGE)(url, method);
      if (base) return Promise.resolve(base);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAt("/change-password", fetchMock);

    await waitFor(() => expect(screen.getByLabelText("Current password")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "correct-horse-battery" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "short" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    await waitFor(() => expect(screen.getByText("Password is too short.")).toBeInTheDocument());
    const postCalls = fetchMock.mock.calls.filter(
      ([reqUrl, reqInit]) => String(reqUrl) === CHANGE_PASSWORD_URL && (reqInit as RequestInit | undefined)?.method === "POST",
    );
    expect(postCalls).toHaveLength(0);
  });

  it("new password and confirmation differ -> blocked on the client, no API call", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers(() => USER_MUST_CHANGE)(url, method);
      if (base) return Promise.resolve(base);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAt("/change-password", fetchMock);

    await waitFor(() => expect(screen.getByLabelText("Current password")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "correct-horse-battery" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new-correct-horse-battery" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "different-password-here" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    await waitFor(() => expect(screen.getByText("The new password and confirmation don't match.")).toBeInTheDocument());
    const postCalls = fetchMock.mock.calls.filter(
      ([reqUrl, reqInit]) => String(reqUrl) === CHANGE_PASSWORD_URL && (reqInit as RequestInit | undefined)?.method === "POST",
    );
    expect(postCalls).toHaveLength(0);
  });

  it("success flow (simulating real server behaviour: 204 re-signs a new cookie, still signed in) -> me refetch returns mustChangePassword:false -> navigates to / (the gate lets through naturally, not landing on change-password or login)", async () => {
    // `routes/auth.ts` POST /api/auth/password re-signs a new session cookie for this request on success (see that file) - the user is
    // not signed out. The following GET /api/auth/me (the refetch triggered by this page's `invalidateQueries`) should return 200, with
    // mustChangePassword already cleared to false by the server. A closure flag simulates this transition, instead of mocking
    // "401 after changing the password" outright - that would test the opposite of production behaviour.
    let mustChange = true;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers(() => ({ ...USER_MUST_CHANGE, mustChangePassword: mustChange }))(url, method);
      if (base) return Promise.resolve(base);
      if (url === CHANGE_PASSWORD_URL && method === "POST") {
        mustChange = false; // the server cleared the flag; the cookie is still valid (re-signed), not a sign-out
        return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const queryClient = renderAt("/change-password", fetchMock);

    await waitFor(() => expect(screen.getByLabelText("Current password")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "correct-horse-battery" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new-correct-horse-battery" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "new-correct-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Change your password" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sign in" })).not.toBeInTheDocument();

    const call = fetchMock.mock.calls.find(
      ([reqUrl, reqInit]) => String(reqUrl) === CHANGE_PASSWORD_URL && (reqInit as RequestInit | undefined)?.method === "POST",
    );
    expect(call).toBeDefined();
    const [, init] = call as [RequestInfo, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      currentPassword: "correct-horse-battery",
      newPassword: "new-correct-horse-battery",
    });

    // The ['me'] cache reflects the refetched new state: still the same user, mustChangePassword cleared to false - this change is what
    // drives ChangePasswordGate to let through, not the page hard-navigating around the gate.
    expect(queryClient.getQueryData(["me"])).toMatchObject({ id: USER_MUST_CHANGE.id, mustChangePassword: false });

    expect(screen.getByText("Password updated.")).toBeInTheDocument();
  });

  it("forgot the current password: the sign-out button on the change-password page signs out and goes to /login (so the user is not stuck on this page for good)", async () => {
    let loggedInAs: UserDto | null = USER_MUST_CHANGE;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers(() => loggedInAs)(url, method);
      if (base) return Promise.resolve(base);
      if (url === "/api/auth/logout" && method === "POST") {
        loggedInAs = null;
        return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const queryClient = renderAt("/change-password", fetchMock);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Change your password" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Change your password" })).not.toBeInTheDocument();

    const logoutCall = fetchMock.mock.calls.find(
      ([reqUrl, reqInit]) => String(reqUrl) === "/api/auth/logout" && (reqInit as RequestInit | undefined)?.method === "POST",
    );
    expect(logoutCall).toBeDefined();
    expect(queryClient.getQueryData(["me"])).toBeNull();
  });
});

describe("ChangePasswordPage - #187 explanatory sentence", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); dismissAllToasts(); });
  afterEach(() => vi.unstubAllGlobals());

  const B23 = "This site only allows signing in through a sign-in service right now. This password won't be used to sign in for now, but you still need to replace the temporary password the site administrator set.";
  const fetchWithConfig = (config: Response) =>
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/auth/config" && method === "GET") return Promise.resolve(config);
      const base = baseFetchHandlers(() => USER_MUST_CHANGE)(url, method);
      if (base) return Promise.resolve(base);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

  it("password login effective value off -> shows the explanatory sentence", async () => {
    renderAt("/change-password", fetchWithConfig(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: false } }) })));
    expect(await screen.findByText(B23)).toBeInTheDocument();
  });

  it("effective value on -> no such sentence", async () => {
    const queryClient = renderAt("/change-password", fetchWithConfig(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: true } }) })));
    await screen.findByRole("heading", { name: "Change your password" });
    // Wait point for the "absent" assertion: the config has landed in the query cache (otherwise the sentence simply has not appeared yet and the assertion is vacuous).
    await waitFor(() => expect(queryClient.getQueryData(["auth-config"])).toBeDefined());
    expect(screen.queryByText(B23)).not.toBeInTheDocument();
  });
});

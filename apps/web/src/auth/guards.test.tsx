import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import "@/i18n";
import { RequireAuth, ChangePasswordGate } from "./guards";

// Fetch-mocked tests for `ChangePasswordGate`: no real server; checks only which placeholder page the route lands on for different `/api/auth/me` responses.

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

function mockFetchMustChangePassword(mustChangePassword: boolean) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/groups") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
    }
    if (url === "/api/auth/me") {
      return Promise.resolve(
        fakeResponse({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              id: "u1",
              email: "a@example.com",
              displayName: "Alice",
              isAdmin: false,
              mustChangePassword,
              hasPassword: true,
            }),
        }),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

/** Mounts an extra `/change-password` route and wraps the `/*` catch-all in `<ChangePasswordGate>`, matching App.tsx's real nesting (`/change-password` itself is outside the gate, other routes inside). */
function renderChangePasswordGateAt(initialPath: string) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/login" element={<div>login-page</div>} />
          <Route element={<RequireAuth />}>
            <Route path="/change-password" element={<div>change-password-page</div>} />
            <Route element={<ChangePasswordGate />}>
              <Route path="/*" element={<div>home-page</div>} />
            </Route>
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** `/api/auth/me` returns 500 - the session query enters its error branch (only 401 means signed out). */
function mockFetchServerError(): ReturnType<typeof vi.fn> {
  return vi.fn(() =>
    Promise.resolve(
      fakeResponse({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }),
      }),
    ),
  );
}

function renderRequireAuth(existingClient?: QueryClient) {
  const queryClient = existingClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/login" element={<div>login-page</div>} />
          <Route element={<RequireAuth />}>
            <Route path="/*" element={<div>home-page</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { queryClient, unmount: view.unmount };
}

const SESSION_USER = {
  id: "u1",
  email: "a@example.com",
  displayName: "Alice",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  avatar: null,
};

function okSession(): Response {
  return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(SESSION_USER) });
}

function serverError(): Response {
  return fakeResponse({
    ok: false,
    status: 500,
    json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }),
  });
}

describe("session query errors (non-401)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("RequireAuth: 500 -> shows the error with a retry exit, doesn't stay on loading, doesn't misredirect to /login", async () => {
    vi.stubGlobal("fetch", mockFetchServerError());

    renderRequireAuth();

    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument());
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(screen.queryByText("login-page")).not.toBeInTheDocument();
    expect(screen.queryByText("home-page")).not.toBeInTheDocument();
  });

  /**
   * The error screen is for when there is no session at all. After sign-in the session query keeps refetching (`main.tsx` uses a bare `new QueryClient()`, i.e. `refetchOnWindowFocus: true` + `staleTime: 0`), so a server restart or a network blip can put `["me"]` into error while the cached user is still there.
   *
   * Two semantics of the query library (v5.101); this test pins the second:
   * - At the moment a refetch fails, existing observers still report `status:"success"` with the old data;
   * - but any **remount** at that point (route change, opening the settings modal - both route trees in `App.tsx` mount `RequireAuth`) creates a new observer, which sees `status:"error"` with data still present.
   *
   * Replacing the whole tree with the error screen then unmounts NotePage, `useCollab` runs `provider.destroy(); doc.destroy();`, and the project has no y-indexeddb, so edits not yet synced are lost for good. When a session is usable it must be kept.
   */
  it("session in error state but cache still has the user -> after remount lets through as usual, no error screen", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okSession()));
    vi.stubGlobal("fetch", fetchMock);

    const first = renderRequireAuth();
    await waitFor(() => expect(screen.getByText("home-page")).toBeInTheDocument());

    fetchMock.mockImplementation(() => Promise.resolve(serverError()));
    await act(async () => {
      await first.queryClient.refetchQueries({ queryKey: ["me"] });
    });
    expect(first.queryClient.getQueryState(["me"])?.status).toBe("error");
    first.unmount();

    // Remounting with the same QueryClient = a new observer, which sees error + existing data.
    renderRequireAuth(first.queryClient);

    expect(screen.getByText("home-page")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("pressing retry -> queries the session again, and succeeding lets through as usual", async () => {
    let failNext = true;
    const fetchMock = vi.fn(() => {
      if (failNext) {
        failNext = false;
        return Promise.resolve(
          fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) }),
        );
      }
      return Promise.resolve(
        fakeResponse({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              id: "u1",
              email: "a@example.com",
              displayName: "Alice",
              isAdmin: false,
              mustChangePassword: false,
              hasPassword: true,
              avatar: null,
            }),
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    renderRequireAuth();

    const retry = await screen.findByRole("button", { name: "Try again" });
    fireEvent.click(retry);

    await waitFor(() => expect(screen.getByText("home-page")).toBeInTheDocument());
  });
});

describe("ChangePasswordGate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mustChangePassword:true visiting / -> redirects to /change-password", async () => {
    vi.stubGlobal("fetch", mockFetchMustChangePassword(true));

    renderChangePasswordGateAt("/");

    await waitFor(() => expect(screen.getByText("change-password-page")).toBeInTheDocument());
    expect(screen.queryByText("home-page")).not.toBeInTheDocument();
  });

  it("mustChangePassword:false visiting / -> no redirect, lets through", async () => {
    vi.stubGlobal("fetch", mockFetchMustChangePassword(false));

    renderChangePasswordGateAt("/");

    await waitFor(() => expect(screen.getByText("home-page")).toBeInTheDocument());
    expect(screen.queryByText("change-password-page")).not.toBeInTheDocument();
  });

  it("mustChangePassword:true visiting /change-password directly -> stays put, not redirected elsewhere (the gate is outside it)", async () => {
    vi.stubGlobal("fetch", mockFetchMustChangePassword(true));

    renderChangePasswordGateAt("/change-password");

    await waitFor(() => expect(screen.getByText("change-password-page")).toBeInTheDocument());
    expect(screen.queryByText("home-page")).not.toBeInTheDocument();
  });
});

// This family guards whether "the page the user meant to open" is handed to the login page. Asserting the whole query verbatim is the point: pathname+search must be encoded exactly once, so the embedded ?, & and % aren't taken as /login's own parameters (LoginPage decodes once with searchParams.get("next") to get the original string).

function LoginProbe() {
  const location = useLocation();
  return <div data-testid="login-location">{`${location.pathname}${location.search}`}</div>;
}

/** `/api/auth/me` returns 401 = signed out (useSession turns 401 into a resolved null, not the error branch). */
function mockFetchUnauthenticated(): ReturnType<typeof vi.fn> {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/groups") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
    }
    if (url === "/api/auth/me") {
      return Promise.resolve(
        fakeResponse({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: "unauthorized", message: "no" } }),
        }),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

function BackButton() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => void navigate(-1)}>
      back
    </button>
  );
}

function renderRequireAuthAt(entries: string[]) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        <Routes>
          <Route path="/login" element={<LoginProbe />} />
          <Route element={<RequireAuth />}>
            <Route path="/*" element={<div>protected-page</div>} />
          </Route>
        </Routes>
        <BackButton />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function expectLoginLocation(expected: string) {
  await waitFor(() => {
    expect(screen.getByTestId("login-location").textContent).toBe(expected);
  });
}

describe("#131 signed-out redirect carries next", () => {
  // The two existing `afterEach(() => vi.unstubAllGlobals())` live inside other describes, and this describe is their sibling and can't reach them: carry its own, otherwise the fetch stub leaks.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("signed-out visit to a protected path -> /login?next=<current path> (query included, whole string encoded once)", async () => {
    vi.stubGlobal("fetch", mockFetchUnauthenticated());

    renderRequireAuthAt(["/n/alice/my-note?a=1&b=2"]);

    await expectLoginLocation("/login?next=%2Fn%2Falice%2Fmy-note%3Fa%3D1%26b%3D2");
    expect(screen.queryByText("protected-page")).not.toBeInTheDocument();
  });

  it("pathname that is already percent-encoded (the real shape of non-ASCII titles) -> % is encoded again as %25", async () => {
    // A real browser's location.pathname for a non-ASCII slug is percent-encoded, so this is what "/n/alice/<CJK title>" looks like on web. A **missing** encoding makes the server's searchParams.get("next") decode to bare CJK once, failing safeNextPath's visible-ASCII check; **double** encoding makes next start with %252F..., decoding to a first character that isn't /, also rejected. Both mistakes are caught by the verbatim assertion below; this case is the web-side counterpart of that character check.
    // Don't test with a bare CJK path: MemoryRouter doesn't encode for you and a real browser can't produce that state, so the conclusion would mislead.
    vi.stubGlobal("fetch", mockFetchUnauthenticated());

    renderRequireAuthAt(["/n/alice/%E7%AD%86%E8%A8%98"]);

    await expectLoginLocation("/login?next=%2Fn%2Falice%2F%25E7%25AD%2586%25E8%25A8%2598");
  });

  it("next is written to the URL even when it is just / (no special case - one fewer branch, one fewer failure point)", async () => {
    // The cost is a content-free ?next=%2F in the address bar when a signed-out user visits home. This is a deliberate trade-off; don't tidy it up.
    vi.stubGlobal("fetch", mockFetchUnauthenticated());

    renderRequireAuthAt(["/"]);

    await expectLoginLocation("/login?next=%2F");
  });

  it("hash isn't carried (search is)", async () => {
    // A behaviour contract, not a mechanism explanation: see the comment in guards.tsx (safeNextPath does accept paths with a fragment; this side just doesn't produce one).
    vi.stubGlobal("fetch", mockFetchUnauthenticated());

    renderRequireAuthAt(["/n/alice/my-note?a=1#frag"]);

    await expectLoginLocation("/login?next=%2Fn%2Falice%2Fmy-note%3Fa%3D1");
  });

  it("the redirect is replace, not push: going back from the login page doesn't return to the inaccessible protected page", async () => {
    // Push would leave a dead end: after signing in, going back returns to /login?next=... (already signed in).
    vi.stubGlobal("fetch", mockFetchUnauthenticated());

    renderRequireAuthAt(["/somewhere-else", "/n/alice/my-note"]);

    await expectLoginLocation("/login?next=%2Fn%2Falice%2Fmy-note");
    fireEvent.click(screen.getByRole("button", { name: "back" }));

    // replace: the protected page's entry was replaced by the login page, so back goes to /somewhere-else, which is also signed out and redirects to login again with next changed to /somewhere-else.
    // With push: back would be /n/alice/my-note, and next would still be %2Fn%2Falice%2Fmy-note.
    await expectLoginLocation("/login?next=%2Fsomewhere-else");
  });

  it("ChangePasswordGate mounted alone + signed out -> also carries next (the gates share useSessionGate)", async () => {
    vi.stubGlobal("fetch", mockFetchUnauthenticated());

    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/settings/account"]}>
          <Routes>
            <Route path="/login" element={<LoginProbe />} />
            <Route element={<ChangePasswordGate />}>
              <Route path="/*" element={<div>protected-page</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await expectLoginLocation("/login?next=%2Fsettings%2Faccount");
  });
});

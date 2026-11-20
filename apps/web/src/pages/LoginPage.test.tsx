import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import type { AuthConfigDto, AuthProviderPublicDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";
import LoginPage from "./LoginPage";

// LoginPage (multi-provider since #187): react-query `['auth-config']` reads `GET /api/auth/config`, and each entry in `providers`
// renders one SSO entry (a plain `<a href="/api/auth/oidc/login/<id>">`, a full-page navigation, not through `api()` - see client.ts;
// the 302 chain must be carried by the browser's top-level navigation). `?error=` uses the existing
// `t(`errors.${code}`, {defaultValue: t("errors.fallback")})` mechanism, rendered in the existing `role="alert"` area. fetch stubs
// follow `SettingsUsersSection.test.tsx` (`vi.stubGlobal("fetch", ...)` + `afterEach` `vi.unstubAllGlobals()`); msw is not used.

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const AUTH_CONFIG_URL = "/api/auth/config";

const NO_PROVIDERS: AuthConfigDto = { providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: true }, autoVersionsEnabled: true };
const TWO: AuthConfigDto = {
  providers: [
    { id: "11111111-1111-1111-1111-111111111111", displayName: "GitLab", icon: { type: "builtin", name: "generic" } },
    { id: "22222222-2222-2222-2222-222222222222", displayName: "Google", icon: { type: "builtin", name: "generic" } },
  ],
  registration: { enabled: true, providerIds: ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"] },
  passwordLogin: { enabled: true },
  autoVersionsEnabled: true,
};

/** The `/login` route is not mounted under `<RequireAuth>`, so this file needs no `/api/auth/me` stub; this file only
 * covers the SSO entries and the `?error=` mapping. */
function fetchMockWithAuthConfig(config: AuthConfigDto): ReturnType<typeof vi.fn> {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/groups" && method === "GET") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
    }
    if (url === AUTH_CONFIG_URL && method === "GET") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(config) }));
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
}

function renderAt(
  initialPath: string,
  fetchMock: ReturnType<typeof vi.fn>,
  queryClient: QueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
): QueryClient {
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

describe("LoginPage (SSO entries + ?error= mapping)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("no provider -> no SSO button is rendered", async () => {
    const queryClient = renderAt("/login", fetchMockWithAuthConfig(NO_PROVIDERS));
    await waitFor(() => expect(queryClient.getQueryData(["auth-config"])).toEqual(NO_PROVIDERS));
    expect(screen.queryByRole("link", { name: /^Sign in with/ })).not.toBeInTheDocument();
  });

  it("two providers -> two <a> in response order, href pointing to each /api/auth/oidc/login/<id>", async () => {
    renderAt("/login", fetchMockWithAuthConfig(TWO));
    const links = await screen.findAllByRole("link", { name: /^Sign in with/ });
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Sign in with GitLab", "/api/auth/oidc/login/11111111-1111-1111-1111-111111111111"],
      ["Sign in with Google", "/api/auth/oidc/login/22222222-2222-2222-2222-222222222222"],
    ]);
  });

  it("an HTML-shaped display name is rendered literally (even with escapeValue:false it only enters a text node)", async () => {
    const evil = '<img src=x onerror="alert(1)">';
    renderAt(
      "/login",
      fetchMockWithAuthConfig({
        providers: [{ id: "33333333-3333-3333-3333-333333333333", displayName: evil, icon: null }],
        registration: { enabled: true, providerIds: ["33333333-3333-3333-3333-333333333333"] },
        passwordLogin: { enabled: true },
        autoVersionsEnabled: true,
      }),
    );
    const link = await screen.findByRole("link", { name: `Sign in with ${evil}` });
    expect(link.textContent).toBe(`Sign in with ${evil}`);
    expect(document.querySelector("img[src='x']")).toBeNull();
  });

  it("?error=oidc_email_missing -> the alert area shows the matching text", async () => {
    const fetchMock = fetchMockWithAuthConfig(NO_PROVIDERS);
    renderAt("/login?error=oidc_email_missing", fetchMock);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Your identity provider didn't share an email address, which is required to sign in.",
      ),
    );
  });

  it("?error=not_a_real_code -> an unknown code falls back to the errors.fallback text", async () => {
    const fetchMock = fetchMockWithAuthConfig(NO_PROVIDERS);
    renderAt("/login?error=not_a_real_code", fetchMock);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("An unexpected error occurred."));
  });

  // `?error=` is an arbitrary query string; feeding it straight into `t()` produced two problems: `__proto__` hits an inherited
  // `Object.prototype` property, and `constructor` makes `t()` resolve the `errors` object's `constructor` (a function) as the translation,
  // which as a JSX child is the runtime error "Functions are not valid as a React child" (`render()` itself throws, so no extra
  // "does not throw" assertion is needed: reaching the `waitFor` line without an exception is itself the regression evidence).
  // Fix: pass through the shared `ERROR_CODES` allow list first; anything outside the set is treated as `fallback`.
  it("?error=__proto__ -> does not blow up (inherited Object.prototype property), falls back to the errors.fallback text", async () => {
    const fetchMock = fetchMockWithAuthConfig(NO_PROVIDERS);
    renderAt("/login?error=__proto__", fetchMock);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("An unexpected error occurred."));
  });

  it("?error=constructor -> does not blow up (Functions are not valid as a React child), falls back to the errors.fallback text", async () => {
    const fetchMock = fetchMockWithAuthConfig(NO_PROVIDERS);
    renderAt("/login?error=constructor", fetchMock);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("An unexpected error occurred."));
  });

  // The `?error=` message is now fed straight into the initial value of the `errorMessage` state, so the `setErrorMessage(null)` at the
  // start of `handleSubmit` naturally overwrites it: when the form is resubmitted, the old OIDC error unrelated to this submit must not
  // flash back during the wait for the response. A login endpoint whose resolve the test controls checks that the old message is already
  // gone at the moment of submit (response not back yet), instead of only after the new result arrives (which would not catch the flash).
  it("resubmitting the form: the old ?error= OIDC error message does not flash during the wait for the response", async () => {
    let resolveLogin: (() => void) | undefined;
    const loginPending = new Promise<void>((resolve) => {
      resolveLogin = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === AUTH_CONFIG_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(NO_PROVIDERS) }));
      }
      if (url === "/api/auth/login" && method === "POST") {
        return loginPending.then(() =>
          fakeResponse({
            ok: false,
            status: 401,
            json: () => Promise.resolve({ error: { code: "invalid_credentials", message: "nope" } }),
          }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAt("/login?error=oidc_email_missing", fetchMock);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Your identity provider didn't share an email address, which is required to sign in.",
      ),
    );

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "alice@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());

    resolveLogin?.();

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Incorrect email or password."));
  });
});

// #131: after a successful login return to ?next=, and the SSO link hands next to the server.
//
// This group uses an isolated harness (only LoginPage + a catch-all probe), not AppRoutes: next may land on any path, and the real
// route tree would pull in NotePage's whole data path.
//
// Cost: this group cannot prove that the route renders in the real tree after navigation - navigate goes through RequireAuth /
// ChangePasswordGate, which this group bypasses entirely (the catch-all probe accepts any path). In particular, a mustChangePassword:true
// user logging in with next is stopped by the gate and sent to /change-password, landing on `/` after the change, and next is silently
// lost - an accepted limitation, not a gap of this group.
//
// `queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })` does not call /api/auth/me in this harness: TanStack v5's
// refetchType defaults to "active", and no component subscribes to ['me'] here (useSession is not mounted) -> no refetch, so the
// fetch stub needs no such route. (The whole login flow sends only GET /api/auth/config and POST /api/auth/login.)

const LOGIN_URL = "/api/auth/login";
/** #187: this group's SSO entry is always the first of `TWO` (GitLab). The literal is deliberately written separately: what is asserted
 * is this page's output contract for `GET /api/auth/oidc/login/:providerId`, not its own constant. */
const OIDC_LOGIN_URL = "/api/auth/oidc/login/11111111-1111-1111-1111-111111111111";

/** Landing probe: prints the location verbatim as a single text node. Mounted under both /login and the catch-all, so both
 * "still on the login page but the URL was rewritten" and "already navigated away" can be observed. */
function LocationProbe({ testId }: { testId: string }) {
  const location = useLocation();
  return <div data-testid={testId}>{`${location.pathname}${location.search}`}</div>;
}

function fetchMockLoginOk(providers: AuthProviderPublicDto[] = []): ReturnType<typeof vi.fn> {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/groups" && method === "GET") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
    }
    if (url === AUTH_CONFIG_URL && method === "GET") {
      const config: AuthConfigDto = { providers, registration: { enabled: true, providerIds: providers.map(p => p.id) }, passwordLogin: { enabled: true }, autoVersionsEnabled: true };
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(config) }));
    }
    if (url === LOGIN_URL && method === "POST") {
      return Promise.resolve(
        fakeResponse({
          ok: true,
          status: 200,
          json: () =>
            // Fields line up one-to-one with UserDto (including #122's handle, and "alice" matches the /n/alice/... used by the cases) -
            // do not trim them: one field more or fewer makes the stub drift from the real response.
            Promise.resolve({
              id: "u1",
              email: "a@example.com",
              handle: "alice",
              displayName: "Alice",
              isAdmin: false,
              mustChangePassword: false,
              hasPassword: true,
              avatar: null,
            }),
        }),
      );
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
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

function renderLoginWithProbe(initialPath: string, fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route
            path="/login"
            element={
              <>
                <LoginPage />
                <LocationProbe testId="login-location" />
              </>
            }
          />
          <Route path="*" element={<LocationProbe testId="location" />} />
        </Routes>
        <BackButton />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// The three fireEvents are synchronous; the real waiting is in the caller (expectLandedOn).
function submitLogin() {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

async function expectLandedOn(expected: string) {
  await waitFor(() => {
    expect(screen.getByTestId("location").textContent).toBe(expected);
  });
}

describe("#131 return to next after login", () => {
  beforeEach(async () => {
    // The existing beforeEach/afterEach live in another describe and this new one cannot reach them, so bring a copy. Without
    // changeLanguage the new cases would get English only by accident (a global side effect of the previous describe): a false green
    // that depends on execution order.
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("valid next -> after a successful login lands on that path (query included, verbatim)", async () => {
    renderLoginWithProbe("/login?next=%2Fn%2Falice%2Fmy-note%3Fx%3D1", fetchMockLoginOk());

    submitLogin();

    await expectLandedOn("/n/alice/my-note?x=1");
  });

  it("next containing percent-encoding -> decoded only once, navigated verbatim (decoding once more yields mojibake)", async () => {
    // This is the seam with the producer: guards feed location.pathname, which is itself percent-encoded (since #122 the slug in
    // /n/<handle>/<slug> is often like %E7%AD%86...), so the `%` in the next value the guards send is already encoded as %25. If
    // decodeURIComponent were applied once more here, the seven pure-ASCII cases would not notice; only this one goes red.
    renderLoginWithProbe("/login?next=%2Fn%2Falice%2F%25E7%25AD%2586", fetchMockLoginOk(TWO.providers));

    const link = await screen.findByRole("link", { name: "Sign in with GitLab" });
    expect(link).toHaveAttribute("href", `${OIDC_LOGIN_URL}?next=%2Fn%2Falice%2F%25E7%25AD%2586`);

    submitLogin();

    await expectLandedOn("/n/alice/%E7%AD%86");
  });

  it("cross-site next -> lands on / (safeNextPath blocks it, it must not be fed straight into navigate)", async () => {
    renderLoginWithProbe("/login?next=%2F%2Fevil.example", fetchMockLoginOk());

    submitLogin();

    await expectLandedOn("/");
  });

  it("next for a non-SPA path (/api/notes) -> lands on / (the web side also applies isExcludedPath)", async () => {
    renderLoginWithProbe("/login?next=%2Fapi%2Fnotes", fetchMockLoginOk());

    submitLogin();

    await expectLandedOn("/");
  });

  it("no next -> lands on / (existing behaviour unchanged)", async () => {
    renderLoginWithProbe("/login", fetchMockLoginOk());

    submitLogin();

    await expectLandedOn("/");
  });

  it("navigation is replace, not push: pressing back after login does not return to the login page in the signed-in state", async () => {
    renderLoginWithProbe("/login?next=%2Fn%2Falice%2Fmy-note", fetchMockLoginOk());

    submitLogin();
    await expectLandedOn("/n/alice/my-note");
    fireEvent.click(screen.getByRole("button", { name: "back" }));

    // replace: the login page entry has been replaced, so there is nothing to go back to in history -> stays put.
    // With push it would return to /login?next=... (already signed in) = a dead end.
    await expectLandedOn("/n/alice/my-note");
    expect(screen.queryByTestId("login-location")).not.toBeInTheDocument();
  });

  it("the SSO link hands a valid next to the server (encoded once)", async () => {
    renderLoginWithProbe("/login?next=%2Fn%2Falice%2Fmy-note%3Fx%3D1", fetchMockLoginOk(TWO.providers));

    const link = await screen.findByRole("link", { name: "Sign in with GitLab" });
    expect(link).toHaveAttribute("href", `${OIDC_LOGIN_URL}?next=%2Fn%2Falice%2Fmy-note%3Fx%3D1`);
  });

  it("an invalid next is not passed through to the server as is - validation does not rest entirely on the server", async () => {
    renderLoginWithProbe("/login?next=%2F%2Fevil.example", fetchMockLoginOk(TWO.providers));

    const link = await screen.findByRole("link", { name: "Sign in with GitLab" });
    expect(link).toHaveAttribute("href", OIDC_LOGIN_URL);
  });

  it("clearing the one-shot ?error= removes only that key: error gone, next kept", async () => {
    // The mount effect removes ?error= from the URL (existing behaviour, so a refresh does not bring the old error back). Both halves must be
    // asserted: checking only that next is still there stays green even if the whole effect is deleted; checking only that error is gone stays green even if searchParams is replaced wholesale.
    renderLoginWithProbe("/login?error=oidc_email_missing&next=%2Fn%2Falice%2Fmy-note", fetchMockLoginOk(TWO.providers));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("login-location").textContent).toBe("/login?next=%2Fn%2Falice%2Fmy-note");
    });
    const link = await screen.findByRole("link", { name: "Sign in with GitLab" });
    expect(link).toHaveAttribute("href", `${OIDC_LOGIN_URL}?next=%2Fn%2Falice%2Fmy-note`);

    fireEvent.click(screen.getByRole("button", { name: "back" }));
    await waitFor(() => {
      expect(screen.getByTestId("login-location").textContent).toBe("/login?next=%2Fn%2Falice%2Fmy-note");
    });

    submitLogin();

    await expectLandedOn("/n/alice/my-note");
  });
});

const PROVIDERS: AuthProviderPublicDto[] = [{ id: "11111111-1111-1111-1111-111111111111", displayName: "GitLab", icon: { type: "builtin", name: "generic" } }];
const NO_METHODS_TEXT = "There's no way to sign in right now. Please contact the site administrator.";

describe("LoginPage - #187: password toggle, register button, zero methods", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("passwordLogin.enabled=false -> no email / password fields or Sign in button; SSO buttons as usual", async () => {
    renderAt("/login", fetchMockWithAuthConfig({ providers: PROVIDERS, registration: { enabled: true, providerIds: PROVIDERS.map(p => p.id) }, passwordLogin: { enabled: false }, autoVersionsEnabled: true }));
    await screen.findByRole("link", { name: "Sign in with GitLab" });
    expect(document.querySelector("#login-email")).toBeNull();
    expect(document.querySelector("#login-password")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
  });

  it("zero providers + password off -> explanatory text", async () => {
    renderAt("/login", fetchMockWithAuthConfig({ providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: false }, autoVersionsEnabled: true }));
    expect(await screen.findByText(NO_METHODS_TEXT)).toBeInTheDocument();
  });

  it("providers + password off -> no explanatory text", async () => {
    renderAt("/login", fetchMockWithAuthConfig({ providers: PROVIDERS, registration: { enabled: true, providerIds: PROVIDERS.map(p => p.id) }, passwordLogin: { enabled: false }, autoVersionsEnabled: true }));
    await screen.findByRole("link", { name: "Sign in with GitLab" });
    expect(screen.queryByText(NO_METHODS_TEXT)).not.toBeInTheDocument();
  });

  it("password self-registration available -> an outline-button-shaped \"Create an account\" (<a>, accessible role link) linking to /register; a valid next is handed along; not a solid button", async () => {
    renderAt("/login?next=%2Fn%2Falice%2Fx", fetchMockWithAuthConfig({ providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: true }, autoVersionsEnabled: true }));
    const link = await screen.findByRole("link", { name: "Create an account" });
    expect(link.getAttribute("href")).toBe("/register?next=%2Fn%2Falice%2Fx");
    expect(link.className).not.toMatch(/(^|\s)bg-(primary|destructive|brand|brand-deep)(\s|$)/);
  });

  it("card page exception: Sign in, every SSO button and the register button are lg (h-11), and both inputs are also h-11 (all fields equal height)", async () => {
    renderAt("/login", fetchMockWithAuthConfig(TWO));
    const ssoLinks = await screen.findAllByRole("link", { name: /^Sign in with / });
    expect(ssoLinks).toHaveLength(TWO.providers.length);
    const targets = [
      screen.getByRole("button", { name: "Sign in" }),
      ...ssoLinks,
      screen.getByRole("link", { name: "Create an account" }),
      document.querySelector("#login-email")!,
      document.querySelector("#login-password")!,
    ];
    for (const el of targets) {
      expect(el).toHaveClass("h-11");
      expect(el).not.toHaveClass("h-8");
    }
  });

  it("without next -> the register button links to a bare /register", async () => {
    renderAt("/login", fetchMockWithAuthConfig({ providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: true }, autoVersionsEnabled: true }));
    const link = await screen.findByRole("link", { name: "Create an account" });
    expect(link.getAttribute("href")).toBe("/register");
  });

  it("registration off -> no register button (wait for config to land in the cache before asserting; the password form shows while loading, so it cannot be the wait point)", async () => {
    const config: AuthConfigDto = { providers: [], registration: { enabled: false, providerIds: [] }, passwordLogin: { enabled: true }, autoVersionsEnabled: true };
    const queryClient = renderAt("/login", fetchMockWithAuthConfig(config));
    await waitFor(() => expect(queryClient.getQueryData(["auth-config"])).toEqual(config));
    expect(screen.queryByRole("link", { name: "Create an account" })).not.toBeInTheDocument();
  });

  it("/api/auth/config fails (500) -> the password form still shows", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/auth/config") {
        return Promise.resolve(fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "x" } }) }));
      }
      throw new Error(`unexpected fetch: ${String(input)}`);
    });
    renderAt("/login", fetchMock);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(document.querySelector("#login-email")).not.toBeNull();
  });

  it("disabled while the page is open: submit gets 403 password_login_disabled -> shows the matching text", async () => {
    const config: AuthConfigDto = { providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: true }, autoVersionsEnabled: true };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/auth/config") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(config) }));
      if (url === "/api/auth/login" && init?.method === "POST") {
        return Promise.resolve(fakeResponse({ ok: false, status: 403, json: () => Promise.resolve({ error: { code: "password_login_disabled", message: "x" } }) }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    renderAt("/login", fetchMock);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("This site only allows signing in through a sign-in service."));
  });

  it("with password off, ?error= is still shown (e.g. an SSO first login blocked because the service's auto account creation is off)", async () => {
    renderAt("/login?error=registration_disabled", fetchMockWithAuthConfig({ providers: PROVIDERS, registration: { enabled: false, providerIds: [] }, passwordLogin: { enabled: false }, autoVersionsEnabled: true }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("New accounts can't be created this way right now."));
  });
  describe("registration entry", () => {
    const [A] = TWO.providers;
    const cfg = (registrationEnabled: boolean, passwordEnabled: boolean, providerIds: string[]): AuthConfigDto => ({
      providers: TWO.providers,
      registration: { enabled: registrationEnabled, providerIds },
      passwordLogin: { enabled: passwordEnabled },
      autoVersionsEnabled: true,
    });
    async function settled(config: AuthConfigDto): Promise<void> {
      const queryClient = renderAt("/login", fetchMockWithAuthConfig(config));
      await waitFor(() => expect(queryClient.getQueryData(["auth-config"])).toEqual(config));
    }
    const REGISTER = { name: "Create an account" };

    it("password self-service on, no service that creates accounts -> has the register button", async () => {
      await settled(cfg(true, true, []));
      expect(await screen.findByRole("link", REGISTER)).toBeInTheDocument();
    });
    it("password self-service on, a service that creates accounts -> has the register button", async () => {
      await settled(cfg(true, true, [A!.id]));
      expect(await screen.findByRole("link", REGISTER)).toBeInTheDocument();
    });
    it("password self-service off, a service that creates accounts -> no register button (SSO first login creates accounts only through the SSO button)", async () => {
      await settled(cfg(false, true, [A!.id]));
      await screen.findByRole("link", { name: "Sign in with GitLab" });
      expect(screen.queryByRole("link", REGISTER)).not.toBeInTheDocument();
    });
    it("password login off, self-registration on, no service that creates accounts -> no register button", async () => {
      await settled(cfg(true, false, []));
      await screen.findByRole("link", { name: "Sign in with GitLab" });
      expect(screen.queryByRole("link", REGISTER)).not.toBeInTheDocument();
    });
    it("password self-service off, no service that creates accounts -> no register button", async () => {
      await settled(cfg(false, true, []));
      await screen.findByRole("link", { name: "Sign in with GitLab" });
      expect(screen.queryByRole("link", REGISTER)).not.toBeInTheDocument();
    });
    it("password login off, self-registration on, a service that creates accounts -> no register button", async () => {
      await settled(cfg(true, false, [A!.id]));
      await screen.findByRole("link", { name: "Sign in with GitLab" });
      expect(screen.queryByRole("link", REGISTER)).not.toBeInTheDocument();
    });
    it("no providerIds key -> treated as []: password self-service on has the register button and does not throw; off has none", async () => {
      const noKey = (enabled: boolean) => ({ providers: TWO.providers, registration: { enabled }, passwordLogin: { enabled: true }, autoVersionsEnabled: true }) as unknown as AuthConfigDto;
      await settled(noKey(true));
      expect(await screen.findByRole("link", REGISTER)).toBeInTheDocument();
      cleanup();
      await settled(noKey(false));
      expect(screen.queryByRole("link", REGISTER)).not.toBeInTheDocument();
    });
    it("config request returns 500 (not loaded) -> no register button", async () => {
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        if (String(input) === AUTH_CONFIG_URL) {
          return Promise.resolve(fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "x" } }) }));
        }
        throw new Error(`unexpected fetch: ${String(input)}`);
      });
      const queryClient = renderAt("/login", fetchMock);
      // Do not use the Sign in button as the wait point: it appears while loading.
      await waitFor(() => expect(queryClient.getQueryState(["auth-config"])?.status).toBe("error"));
      expect(screen.queryByRole("link", REGISTER)).not.toBeInTheDocument();
    });
  });

  it("provider-icon: every SSO button has an icon before the text (built-in / uploaded), a null icon is not rendered; accessible name and text unchanged", async () => {
    const corpUrl = "/api/auth/providers/22222222-2222-2222-2222-222222222222/icon?v=4";
    renderAt(
      "/login",
      fetchMockWithAuthConfig({
        providers: [
          { id: "11111111-1111-1111-1111-111111111111", displayName: "GitLab", icon: { type: "builtin", name: "generic" } },
          { id: "22222222-2222-2222-2222-222222222222", displayName: "Corp", icon: { type: "upload", url: corpUrl } },
          { id: "33333333-3333-3333-3333-333333333333", displayName: "Plain", icon: null },
        ],
        registration: {
          enabled: true,
          providerIds: ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", "33333333-3333-3333-3333-333333333333"],
        },
        passwordLogin: { enabled: true },
        autoVersionsEnabled: true,
      }),
    );
    // Wait point: that provider's link appears only after the config lands.
    const gitlab = await screen.findByRole("link", { name: "Sign in with GitLab" });
    expect(gitlab.firstChild).toBe(gitlab.querySelector('[data-provider-icon="generic"]'));
    expect(gitlab.textContent).toBe("Sign in with GitLab");
    const corp = screen.getByRole("link", { name: "Sign in with Corp" });
    expect(corp.firstChild).toBe(corp.querySelector('img[data-provider-icon="upload"]'));
    expect(corp.querySelector("img")).toHaveAttribute("src", corpUrl);
    expect(screen.getByRole("link", { name: "Sign in with Plain" }).querySelector("[data-provider-icon]")).toBeNull();
  });
});

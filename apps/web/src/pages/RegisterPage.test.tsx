import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import type { AuthConfigDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { AUTH_CONFIG_QUERY_KEY } from "@/api/authConfig";
import { SESSION_QUERY_KEY } from "@/auth/useSession";
import RegisterPage from "./RegisterPage";
import { expectCardControls44 } from "@/test/card-controls";

function fakeResponse(status: number, body?: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: body === undefined ? () => Promise.reject(new Error("no body")) : () => Promise.resolve(body) } as unknown as Response;
}
/** Same solid-button class as `SOLID_BG` in `LinkAccountPage.test.tsx`. */
const SOLID_BG = /(^|\s)bg-(primary|destructive|brand|brand-deep)(\s|$)/;
const USER: UserDto = { id: "u1", email: "new@example.com", handle: "new", displayName: "New", isAdmin: false, mustChangePassword: false, hasPassword: true, autoVersions: true, avatar: null };
const OPEN: AuthConfigDto = {
  providers: [{ id: "11111111-1111-4111-8111-111111111111", displayName: '<b>Corp</b> & "Co"', icon: null }],
  registration: { enabled: true, providerIds: ["11111111-1111-4111-8111-111111111111"] },
  passwordLogin: { enabled: true },
  autoVersionsEnabled: true,
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function setup(path: string, config: AuthConfigDto, opts: { me?: UserDto | null; register?: () => Response } = {}) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (url === "/api/auth/me") return opts.me ? fakeResponse(200, opts.me) : fakeResponse(401, { error: { code: "unauthorized", message: "x" } });
    if (url === "/api/auth/config") return fakeResponse(200, config);
    if (url === "/api/auth/register" && method === "POST") return (opts.register ?? (() => fakeResponse(201, USER)))();
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/register" element={<RegisterPage />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { calls, queryClient };
}
async function fillAndSubmit(values: { email: string; displayName?: string; password: string; confirm: string }) {
  fireEvent.change(await screen.findByLabelText("Email"), { target: { value: values.email } });
  if (values.displayName !== undefined) fireEvent.change(screen.getByLabelText("Display name (optional)"), { target: { value: values.displayName } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: values.password } });
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: values.confirm } });
  fireEvent.click(screen.getByRole("button", { name: "Create account" }));
}

describe("RegisterPage (#187)", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); });
  afterEach(() => vi.unstubAllGlobals());

  it("password form; no SSO sign-up button or divider even when a provider can create accounts; exactly one solid button", async () => {
    const { queryClient } = setup("/register", OPEN);
    // The form renders while config is loading, so it can't be the wait point; wait for config to land before asserting there is no SSO button.
    await waitFor(() => expect(queryClient.getQueryData(AUTH_CONFIG_QUERY_KEY)).toBeDefined());
    expect(await screen.findByRole("button", { name: "Create account" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Sign up with/ })).not.toBeInTheDocument();
    expect(document.querySelector('[aria-hidden="true"].border-t')).toBeNull();
    expect(screen.getByRole("link", { name: "Already have an account? Sign in" }).getAttribute("href")).toBe("/login");
    const solid = [...screen.getAllByRole("button"), ...screen.getAllByRole("link")].filter(el => SOLID_BG.test(el.className));
    expect(solid.map(el => el.textContent)).toEqual(["Create account"]);
  });

  it("card-page exception: Create account button is lg (h-11) and the four inputs are also h-11 (equal height per column)", async () => {
    setup("/register", OPEN);
    const submit = await screen.findByRole("button", { name: "Create account" });
    const targets = [submit, ...["#register-email", "#register-display-name", "#register-password", "#register-confirm"].map((sel) => document.querySelector(sel)!)];
    for (const el of targets) {
      expect(el).toHaveClass("h-11");
      expect(el).not.toHaveClass("h-8");
    }
  });

  it("submit success -> POST {email, password, displayName}, navigates to /", async () => {
    const { calls } = setup("/register", OPEN);
    await fillAndSubmit({ email: "new@example.com", displayName: "New", password: "correct-horse-battery", confirm: "correct-horse-battery" });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/));
    expect(calls.find(c => c.url === "/api/auth/register")!.body).toEqual({ email: "new@example.com", password: "correct-horse-battery", displayName: "New" });
  });

  it("blank display name -> body has no displayName key (the server derives it from the email local part)", async () => {
    const { calls } = setup("/register", OPEN);
    await fillAndSubmit({ email: "new@example.com", displayName: "   ", password: "correct-horse-battery", confirm: "correct-horse-battery" });
    await waitFor(() => expect(calls.some(c => c.url === "/api/auth/register")).toBe(true));
    expect(calls.find(c => c.url === "/api/auth/register")!.body).toEqual({ email: "new@example.com", password: "correct-horse-battery" });
  });

  it("valid next -> navigates there after success; the Sign in link forwards next", async () => {
    setup("/register?next=%2Fn%2Falice%2Fx", OPEN);
    const link = await screen.findByRole("link", { name: "Already have an account? Sign in" });
    expect(link.getAttribute("href")).toBe("/login?next=%2Fn%2Falice%2Fx");
    await fillAndSubmit({ email: "new@example.com", password: "correct-horse-battery", confirm: "correct-horse-battery" });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/n/alice/x"));
  });

  it("limits: email over 254 chars or display name over 100 code points -> inline error, not submitted; exactly 100 code points -> submitted", async () => {
    const { calls } = setup("/register", OPEN);
    await fillAndSubmit({ email: `${"a".repeat(243)}@example.com`, password: "correct-horse-battery", confirm: "correct-horse-battery" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Email can be at most 254 characters.");
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ok@example.com" } });
    fireEvent.change(screen.getByLabelText("Display name (optional)"), { target: { value: "😀".repeat(101) } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Display name can be at most 100 characters.");
    expect(calls.some(c => c.url === "/api/auth/register")).toBe(false);
    // Exactly 100 code points (200 UTF-16 units) must submit; counting UTF-16 units would wrongly reject 51-100 emoji.
    fireEvent.change(screen.getByLabelText("Display name (optional)"), { target: { value: "😀".repeat(100) } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(calls.some(c => c.url === "/api/auth/register")).toBe(true));
    expect((calls.find(c => c.url === "/api/auth/register")!.body as { displayName: string }).displayName).toBe("😀".repeat(100));
  });

  it("mismatched or too-short passwords -> inline error, not submitted", async () => {
    const { calls } = setup("/register", OPEN);
    await fillAndSubmit({ email: "a@example.com", password: "correct-horse-battery", confirm: "different-horse-battery" });
    expect(await screen.findByText("The passwords don't match.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "short" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Password is too short.");
    expect(calls.some(c => c.url === "/api/auth/register")).toBe(false);
  });

  it("409 email_taken -> errors.email_taken message", async () => {
    setup("/register", OPEN, { register: () => fakeResponse(409, { error: { code: "email_taken", message: "x" } }) });
    await fillAndSubmit({ email: "taken@example.com", password: "correct-horse-battery", confirm: "correct-horse-battery" });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("That email is already in use."));
  });

  it("password self-registration off -> redirects to /login; no form", async () => {
    setup("/register", { ...OPEN, registration: { enabled: false, providerIds: [] } });
    // Wait on the LocationProbe after the redirect (the form shows while loading, so it can't be the wait point).
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/login"));
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
  });

  it("/register with a valid next while password self-registration is unavailable -> redirects to /login?next=...", async () => {
    setup("/register?next=%2Fn%2Falice%2Fx", { ...OPEN, registration: { enabled: false, providerIds: [] } });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/login?next=%2Fn%2Falice%2Fx"));
  });

  it("self-registration unavailable + invalid next -> /login without next", async () => {
    setup("/register?next=%2F%2Fevil.example", { ...OPEN, registration: { enabled: false, providerIds: [] } });
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/login"));
  });

  it("self-registration unavailable, config returns first and a signed-in session later -> no redirect to /login, lands on /", async () => {
    let resolveMe: (r: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/me") return new Promise<Response>((resolve) => (resolveMe = resolve));
      if (url === "/api/auth/config") return fakeResponse(200, { ...OPEN, registration: { enabled: false, providerIds: [] } });
      throw new Error(`unexpected fetch: ${url}`);
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/register"]}>
          <Routes>
            <Route path="/register" element={<RegisterPage />} />
            <Route path="*" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(queryClient.getQueryData(AUTH_CONFIG_QUERY_KEY)).toBeDefined());
    expect(screen.queryByTestId("location")).not.toBeInTheDocument();
    await act(async () => resolveMe(fakeResponse(200, USER)));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/"));
  });

  it("config load failure (500) -> no redirect, form shows as usual (the server is the final authority)", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/me") return fakeResponse(401, { error: { code: "unauthorized", message: "x" } });
      if (url === "/api/auth/config") return fakeResponse(500, { error: { code: "internal", message: "x" } });
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/register"]}>
          <Routes>
            <Route path="/register" element={<RegisterPage />} />
            <Route path="*" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(queryClient.getQueryState(AUTH_CONFIG_QUERY_KEY)?.status).toBe("error"));
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.queryByTestId("location")).not.toBeInTheDocument();
  });

  it("password sign-in effectively off, service can create accounts -> redirects to /login; no password form, no SSO sign-up button", async () => {
    setup("/register", { ...OPEN, passwordLogin: { enabled: false } });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/login"));
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Sign up with/ })).not.toBeInTheDocument();
  });

  it("invalid next (/login) -> lands on / after registration (web-layer safeNextPath)", async () => {
    setup("/register?next=%2Flogin", OPEN);
    await fillAndSubmit({ email: "new@example.com", password: "correct-horse-battery", confirm: "correct-horse-battery" });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/));
  });

  it("signed in + invalid next (//evil.example) -> navigates to /", async () => {
    setup("/register?next=%2F%2Fevil.example", OPEN, { me: USER });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/));
  });

  it("signed in + valid next -> navigates to next", async () => {
    setup("/register?next=%2Fn%2Falice%2Fx", OPEN, { me: USER });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/n\/alice\/x$/));
  });

  it("signed-in user opening /register -> navigates to /", async () => {
    setup("/register", OPEN, { me: USER });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/));
  });
  describe("registration entry", () => {
    const A = "11111111-1111-4111-8111-111111111111";
    const B = "22222222-2222-4222-8222-222222222222";
    const TWO_P: AuthConfigDto["providers"] = [
      { id: A, displayName: "A", icon: null },
      { id: B, displayName: "B", icon: null },
    ];
    const cfg = (enabled: boolean, passwordEnabled: boolean, providerIds: string[]): AuthConfigDto => ({
      providers: TWO_P,
      registration: { enabled, providerIds },
      passwordLogin: { enabled: passwordEnabled },
      autoVersionsEnabled: true,
    });
    const divider = () => document.querySelector('[aria-hidden="true"].border-t');

    it("password self-registration available, providerIds [A] -> form; no Sign up with; no divider", async () => {
      const { queryClient } = setup("/register", cfg(true, true, [A]));
      await waitFor(() => expect(queryClient.getQueryData(AUTH_CONFIG_QUERY_KEY)).toBeDefined());
      expect(await screen.findByLabelText("Email")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /^Sign up with/ })).not.toBeInTheDocument();
      expect(divider()).toBeNull();
    });
    it("self-registration off, password sign-in on, providerIds [A] -> redirects to /login; no form, no Sign up with, no divider", async () => {
      setup("/register", cfg(false, true, [A]));
      await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/login"));
      expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /^Sign up with/ })).not.toBeInTheDocument();
      expect(divider()).toBeNull();
    });
    it("self-registration available, providerIds [] -> form; no Sign up with; no divider", async () => {
      const { queryClient } = setup("/register", cfg(true, true, []));
      await waitFor(() => expect(queryClient.getQueryData(AUTH_CONFIG_QUERY_KEY)).toBeDefined());
      expect(await screen.findByLabelText("Email")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /^Sign up with/ })).not.toBeInTheDocument();
      expect(divider()).toBeNull();
    });
    it("config never responds (not loaded) -> form present (no redirect); no Sign up with", async () => {
      vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
        if (String(input) === "/api/auth/me") return Promise.resolve(fakeResponse(401, { error: { code: "unauthorized", message: "x" } }));
        return new Promise<Response>(() => {});
      }));
      render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter initialEntries={["/register"]}>
            <Routes><Route path="/register" element={<RegisterPage />} /></Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
      expect(await screen.findByLabelText("Email")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /^Sign up with/ })).not.toBeInTheDocument();
    });
    it("no providerIds key -> treated as []: form, no Sign up with, no throw", async () => {
      const noKey = { providers: TWO_P, registration: { enabled: true }, passwordLogin: { enabled: true }, autoVersionsEnabled: true } as unknown as AuthConfigDto;
      const { queryClient } = setup("/register", noKey);
      await waitFor(() => expect(queryClient.getQueryData(AUTH_CONFIG_QUERY_KEY)).toEqual(noKey));
      expect(await screen.findByLabelText("Email")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /^Sign up with/ })).not.toBeInTheDocument();
    });
  });
});

describe("invite mode (#285)", () => {
  const KEY = "knotebook:invite-token";
  const TOKEN = "knbi_X";
  const EXPIRES_AT = "2026-10-30T08:00:00.000Z";
  const RG4: AuthConfigDto = { ...OPEN, registration: { enabled: false, providerIds: [] } };
  const RG3: AuthConfigDto = { ...OPEN, registration: { enabled: false, providerIds: [OPEN.providers[0]!.id] } };
  const fail = (status: number, code: string) => fakeResponse(status, { error: { code, message: "x" } });
  const PASSWORD = "correct-horse-battery";

  function FullProbe() {
    const location = useLocation();
    return <div data-testid="full">{`${location.pathname}${location.search}${location.hash}`}</div>;
  }
  let navigateFn: ((to: string) => void) | null = null;
  function NavCapture() {
    const navigate = useNavigate();
    navigateFn = (to) => navigate(to);
    return null;
  }

  interface Handlers {
    me?: () => Response;
    inspect?: () => Response;
    accept?: () => Response | Promise<Response>;
  }
  function setupInvite(path: string, handlers: Handlers = {}, opts: { cfg?: AuthConfigDto; queryClient?: QueryClient } = {}) {
    const cfg = opts.cfg ?? RG4;
    const state = { me: handlers.me ?? (() => fail(401, "unauthorized")) };
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        calls.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
        if (url === "/api/auth/me") return state.me();
        if (url === "/api/auth/config") return fakeResponse(200, cfg);
        if (url === "/api/auth/invite/inspect" && method === "POST") return (handlers.inspect ?? (() => fakeResponse(200, { expiresAt: EXPIRES_AT })))();
        if (url === "/api/auth/invite/accept" && method === "POST") return (handlers.accept ?? (() => fakeResponse(201, USER)))();
        if (url === "/api/auth/logout" && method === "POST") return fakeResponse(204);
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
    const queryClient = opts.queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(AUTH_CONFIG_QUERY_KEY, cfg);
    const tree = (p: string) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[p]}>
          <FullProbe />
          <NavCapture />
          <Routes>
            <Route path="/register" element={<RegisterPage />} />
            <Route path="*" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    const view = render(tree(path));
    return { calls, queryClient, state, view, tree };
  }
  type Call = { url: string; method: string; body: unknown };
  const inspectCalls = (calls: Call[]) => calls.filter((c) => c.url === "/api/auth/invite/inspect");
  const acceptCalls = (calls: Call[]) => calls.filter((c) => c.url === "/api/auth/invite/accept");
  const fullPath = () => screen.getByTestId("full").textContent;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    sessionStorage.clear();
    navigateFn = null;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it.each([
    ["registration off, no providers", RG4],
    ["OPEN", OPEN],
    ["registration off, one provider", RG3],
  ])("mount (config = %s): fragment cleared, key stored, inspect body, invite form; no SSO button", async (_name, cfg) => {
    const { calls } = setupInvite(`/register#invite=${TOKEN}`, {}, { cfg });
    expect(await screen.findByRole("heading", { name: "Create an account" })).toBeInTheDocument();
    expect(await screen.findByLabelText("Email")).toBeInTheDocument();
    await waitFor(() => expect(fullPath()).toBe("/register"));
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);
    expect(inspectCalls(calls)[0]!.body).toEqual({ token: TOKEN });
    expect(screen.getByText(/^This invitation works once and expires .+\.$/)).toBeInTheDocument();
    expect(screen.getByLabelText("Display name (optional)")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByLabelText("Confirm password")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Sign up with/ })).not.toBeInTheDocument();
    expect(expectCardControls44()).toBeGreaterThan(0);
  });

  it("reload: key exists and URL is just /register -> inspect uses the stored token, form appears", async () => {
    sessionStorage.setItem(KEY, TOKEN);
    const { calls } = setupInvite("/register");
    expect(await screen.findByLabelText("Email")).toBeInTheDocument();
    expect(inspectCalls(calls)[0]!.body).toEqual({ token: TOKEN });
  });

  it("signed in: only the sign-out-first notice, inspect not called, key absent; after sign-out the form appears and the key is stored", async () => {
    sessionStorage.setItem(KEY, "stale");
    const { calls, state } = setupInvite(`/register#invite=${TOKEN}`, { me: () => fakeResponse(200, USER) });
    const signOut = await screen.findByRole("button", { name: "Sign out" });
    expect(screen.getByText("You're signed in as new@example.com. Sign out to use this invitation.")).toBeInTheDocument();
    expect(expectCardControls44()).toBeGreaterThan(0);
    expect(inspectCalls(calls)).toHaveLength(0);
    expect(sessionStorage.getItem(KEY)).toBeNull();
    await waitFor(() => expect(fullPath()).toBe("/register"));

    state.me = () => fail(401, "unauthorized");
    fireEvent.click(signOut);
    expect(await screen.findByLabelText("Email")).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/api/auth/logout" && c.method === "POST")).toBe(true);
    expect(inspectCalls(calls)[0]!.body).toEqual({ token: TOKEN });
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);
  });

  it("reload after sign-out: re-rendering at /register still shows the invite form, not the normal register page", async () => {
    const first = setupInvite(`/register#invite=${TOKEN}`, { me: () => fakeResponse(200, USER) });
    const signOut = await screen.findByRole("button", { name: "Sign out" });
    first.state.me = () => fail(401, "unauthorized");
    fireEvent.click(signOut);
    await screen.findByLabelText("Email");
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);
    first.view.unmount();
    vi.unstubAllGlobals();
    // Unmount cleanup deletes the key; a full page reload doesn't run cleanup, so restore the 'key survives reload' precondition here.
    sessionStorage.setItem(KEY, TOKEN);
    setupInvite("/register");
    expect(await screen.findByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByText(/^This invitation works once and expires .+\.$/)).toBeInTheDocument();
  });

  it("SPA navigation away: navigating to /login after the form appears removes the key", async () => {
    setupInvite(`/register#invite=${TOKEN}`);
    await screen.findByLabelText("Email");
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);
    act(() => navigateFn!("/login"));
    await waitFor(() => expect(fullPath()).toBe("/login"));
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("inspect 410: full invite_invalid text plus back-to-login, key removed", async () => {
    setupInvite(`/register#invite=${TOKEN}`, { inspect: () => fail(410, "invite_invalid") });
    expect(await screen.findByText("This invitation is invalid, already used, revoked, or expired. Ask the site administrator for a new one.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to sign in" }).getAttribute("href")).toBe("/login");
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("inspect 403: full passwordLoginOff text, no form, key kept", async () => {
    setupInvite(`/register#invite=${TOKEN}`, { inspect: () => fail(403, "password_login_disabled") });
    expect(await screen.findByText("Password sign-in is turned off on this site right now, so this invitation can't be used. Ask the site administrator.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);
  });

  it("inspect 403 with a code other than password_login_disabled (e.g. forbidden from an Origin failure) -> generic error text, not the password-off message, key kept", async () => {
    setupInvite(`/register#invite=${TOKEN}`, { inspect: () => fail(403, "forbidden") });
    expect(await screen.findByText("You don't have permission to do that.")).toBeInTheDocument();
    expect(screen.queryByText(/Password sign-in is turned off/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);
  });

  it("A submitting -> same page switches to B -> A's late 410: B's form remains and the storage key is still B (the old token's forget doesn't delete the new key)", async () => {
    let resolveAccept: (r: Response) => void = () => {};
    setupInvite(`/register#invite=${TOKEN}`, { accept: () => new Promise<Response>((resolve) => (resolveAccept = resolve)) });
    await fillAndSubmit({ email: "a@example.com", password: PASSWORD, confirm: PASSWORD });
    await waitFor(() => expect(screen.getByRole("button", { name: "Creating account…" })).toBeInTheDocument());
    act(() => navigateFn!("/register#invite=knbi_B"));
    await waitFor(() => expect(sessionStorage.getItem(KEY)).toBe("knbi_B"));
    expect(await screen.findByRole("button", { name: "Create account" })).toBeInTheDocument();
    await act(async () => {
      resolveAccept(fail(410, "invite_invalid"));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.queryByText(/^This invitation is invalid/)).not.toBeInTheDocument();
    expect(sessionStorage.getItem(KEY)).toBe("knbi_B");
  });

  it("inspect 429: full too_many_requests text, no invite_invalid text, key kept", async () => {
    setupInvite(`/register#invite=${TOKEN}`, { inspect: () => fail(429, "too_many_requests") });
    expect(await screen.findByText("Too many requests. Please slow down.")).toBeInTheDocument();
    expect(screen.queryByText(/This invitation is invalid/)).not.toBeInTheDocument();
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);
  });

  it("/me returns 500: error text plus Try again, no checking state; retry after it returns 401 -> form appears", async () => {
    const { state } = setupInvite(`/register#invite=${TOKEN}`, { me: () => fail(500, "internal") });
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(screen.queryByText("Checking the invitation…")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong. Please try again.");
    expect(expectCardControls44()).toBeGreaterThan(0);
    expect(screen.queryByText("Couldn't load your session.")).not.toBeInTheDocument();
    state.me = () => fail(401, "unauthorized");
    fireEvent.click(retry);
    expect(await screen.findByLabelText("Email")).toBeInTheDocument();
  });

  it("/me fails with a non-ApiFail error (network) -> full errors.fallback text plus Try again", async () => {
    setupInvite(`/register#invite=${TOKEN}`, {
      me: () => {
        throw new TypeError("network");
      },
    });
    await screen.findByRole("button", { name: "Try again" });
    expect(screen.getByRole("alert")).toHaveTextContent("An unexpected error occurred.");
    expect(screen.queryByText("Couldn't load your session.")).not.toBeInTheDocument();
  });

  it("non-form screens (load error, signed in, invalid, password sign-in off) all have the h1 \"Create an account\"", async () => {
    const heading = () => screen.getByRole("heading", { level: 1, name: "Create an account" });
    const first = setupInvite(`/register#invite=${TOKEN}`, { me: () => fail(500, "internal") });
    await screen.findByRole("button", { name: "Try again" });
    heading();
    first.view.unmount();
    const second = setupInvite(`/register#invite=${TOKEN}`, { me: () => fakeResponse(200, USER) });
    await screen.findByRole("button", { name: "Sign out" });
    heading();
    second.view.unmount();
    const third = setupInvite(`/register#invite=${TOKEN}`, { inspect: () => fail(410, "invite_invalid") });
    await screen.findByText(/^This invitation is invalid/);
    heading();
    third.view.unmount();
    setupInvite(`/register#invite=${TOKEN}`, { inspect: () => fail(403, "password_login_disabled") });
    await screen.findByText(/^Password sign-in is turned off/);
    heading();
  });

  it("normal register page (self-registration on) -> same page switches to #invite= (new link pasted): enters invite mode, inspect uses the new token, key is the new token, hash cleared", async () => {
    const { calls } = setupInvite("/register", {}, { cfg: OPEN });
    // Only normal mode has the "Already have an account?" link; the invite form doesn't.
    expect(await screen.findByRole("link", { name: "Already have an account? Sign in" })).toBeInTheDocument();
    expect(inspectCalls(calls)).toHaveLength(0);
    act(() => navigateFn!(`/register#invite=${TOKEN}`));
    expect(await screen.findByText(/^This invitation works once and expires .+\.$/)).toBeInTheDocument();
    expect(inspectCalls(calls).map((c) => c.body)).toEqual([{ token: TOKEN }]);
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);
    await waitFor(() => expect(fullPath()).toBe("/register"));
    expect(screen.queryByRole("link", { name: "Already have an account? Sign in" })).not.toBeInTheDocument();
  });

  it("self-registration off: normal register page redirects to /login, then opening an #invite= link enters invite mode and isn't redirected", async () => {
    const { calls } = setupInvite("/register");
    await waitFor(() => expect(fullPath()).toBe("/login"));
    act(() => navigateFn!(`/register#invite=${TOKEN}`));
    expect(await screen.findByText(/^This invitation works once and expires .+\.$/)).toBeInTheDocument();
    expect(inspectCalls(calls).map((c) => c.body)).toEqual([{ token: TOKEN }]);
    await waitFor(() => expect(fullPath()).toBe("/register"));
  });

  // "Self-registration unavailable -> redirect to /login" applies only to normal mode (OpenRegistration). Placed in the outer RegisterPage,
  // an invite link would be redirected once config has loaded (e2e 03-share-revoke uses an invite link while self-registration is off).
  it.each([
    ["self-registration off", RG4, () => fakeResponse(200, { expiresAt: EXPIRES_AT }), /^This invitation works once and expires .+\.$/],
    ["password sign-in off", { ...OPEN, passwordLogin: { enabled: false } }, () => fail(403, "password_login_disabled"), /^Password sign-in is turned off on this site right now/],
  ] as const)("invite mode ignores normal-mode redirects (%s): stays on /register, shows the invite screen", async (_name, cfg, inspect, expected) => {
    const { calls } = setupInvite(`/register#invite=${TOKEN}`, { inspect }, { cfg });
    expect(await screen.findByText(expected)).toBeInTheDocument();
    await waitFor(() => expect(fullPath()).toBe("/register"));
    expect(inspectCalls(calls)).toHaveLength(1);
    expect(screen.queryByTestId("location")).not.toBeInTheDocument();
  });

  it("invite A returns 410 -> same page switches to #invite=B: B is inspected, form appears, A's invalid state is gone, key is B", async () => {
    let n = 0;
    const { calls } = setupInvite(`/register#invite=${TOKEN}`, {
      inspect: () => (++n === 1 ? fail(410, "invite_invalid") : fakeResponse(200, { expiresAt: EXPIRES_AT })),
    });
    expect(await screen.findByText(/^This invitation is invalid/)).toBeInTheDocument();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    act(() => navigateFn!("/register#invite=knbi_B"));
    expect(await screen.findByLabelText("Email")).toBeInTheDocument();
    expect(inspectCalls(calls).map((c) => c.body)).toEqual([{ token: TOKEN }, { token: "knbi_B" }]);
    expect(screen.queryByText(/^This invitation is invalid/)).not.toBeInTheDocument();
    expect(sessionStorage.getItem(KEY)).toBe("knbi_B");
    await waitFor(() => expect(fullPath()).toBe("/register"));
  });

  it("switching token resets form state: A's form has an error -> after switching to B the fields are empty and the old error is gone", async () => {
    setupInvite(`/register#invite=${TOKEN}`, { accept: () => fail(409, "email_taken") });
    await fillAndSubmit({ email: "taken@example.com", password: PASSWORD, confirm: PASSWORD });
    expect(await screen.findByRole("alert")).toHaveTextContent("That email is already in use.");
    act(() => navigateFn!("/register#invite=knbi_B"));
    await waitFor(() => expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe(""));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("success: ignores ?next, navigates to /, session cache = response, key removed, and the signed-in notice never flashes in between", async () => {
    const seen: string[] = [];
    // Collect text of added nodes plus new characterData text: a flash that is added and removed within one task is no longer in body.textContent by callback time,
    // and React updating the text of a <p> in place only produces characterData, not addedNodes.
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) seen.push(node.textContent ?? "");
        if (record.type === "characterData") seen.push(record.target.textContent ?? "");
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    try {
      const { calls, queryClient } = setupInvite(`/register?next=%2Fn%2Fabc#invite=${TOKEN}`);
      await fillAndSubmit({ email: "new@example.com", password: PASSWORD, confirm: PASSWORD });
      await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/));
      expect(acceptCalls(calls)[0]!.body).toEqual({ token: TOKEN, email: "new@example.com", password: PASSWORD });
      expect(queryClient.getQueryData(SESSION_QUERY_KEY)).toEqual(USER);
      expect(sessionStorage.getItem(KEY)).toBeNull();
      expect(seen.some((text) => text.includes("You're signed in as"))).toBe(false);
    } finally {
      observer.disconnect();
    }
  });

  it("display name filled -> accept body has displayName", async () => {
    const { calls } = setupInvite(`/register#invite=${TOKEN}`);
    await fillAndSubmit({ email: "new@example.com", displayName: "New", password: PASSWORD, confirm: PASSWORD });
    await waitFor(() => expect(acceptCalls(calls)).toHaveLength(1));
    expect(acceptCalls(calls)[0]!.body).toEqual({ token: TOKEN, email: "new@example.com", password: PASSWORD, displayName: "New" });
  });

  it("accept 410: invalid state, key removed", async () => {
    setupInvite(`/register#invite=${TOKEN}`, { accept: () => fail(410, "invite_invalid") });
    await fillAndSubmit({ email: "new@example.com", password: PASSWORD, confirm: PASSWORD });
    expect(await screen.findByText(/^This invitation is invalid/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("accept 409 email_taken: alert above the form, form and key remain", async () => {
    setupInvite(`/register#invite=${TOKEN}`, { accept: () => fail(409, "email_taken") });
    await fillAndSubmit({ email: "taken@example.com", password: PASSWORD, confirm: PASSWORD });
    expect(await screen.findByRole("alert")).toHaveTextContent("That email is already in use.");
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);
  });

  it("client-side checks: short or mismatched password -> inline error, no accept", async () => {
    const { calls } = setupInvite(`/register#invite=${TOKEN}`);
    await fillAndSubmit({ email: "a@example.com", password: "short", confirm: "short" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Password is too short.");
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: PASSWORD } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "different-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("The passwords don't match.")).toBeInTheDocument();
    expect(acceptCalls(calls)).toHaveLength(0);
  });

  it("synchronous read: session cache already signed in -> first render shows the signed-in notice, no redirect to /", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(SESSION_QUERY_KEY, USER);
    setupInvite(`/register#invite=${TOKEN}`, { me: () => fakeResponse(200, USER) }, { queryClient });
    const SIGNED_IN = "You're signed in as new@example.com. Sign out to use this invitation.";
    expect(screen.getByText(SIGNED_IN)).toBeInTheDocument();
    expect(fullPath()).not.toBe("/");
    // This case guards "signed-in navigates first": the router update runs in a transition, so a late redirect only shows once it settles.
    // "Token arrives late" can't be caught here (the fragment-clearing navigate rewrites the path); the next case (storage source) covers it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(screen.getByText(SIGNED_IN)).toBeInTheDocument();
    expect(fullPath()).toBe("/register");
  });

  it("synchronous read (storage source): no fragment, key exists, session cache already signed in -> not redirected to /", async () => {
    // Guards "token arrives late, first render is null and navigates to '/' first": in the fragment-source case the fragment-clearing navigate
    // overwrites a late wrong redirect; with no fragment here, nothing overwrites it. ("Signed-in navigates first" is covered by the previous case.)
    sessionStorage.setItem(KEY, TOKEN);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(SESSION_QUERY_KEY, USER);
    setupInvite("/register", { me: () => fakeResponse(200, USER) }, { queryClient });
    const SIGNED_IN = "You're signed in as new@example.com. Sign out to use this invitation.";
    expect(screen.getByText(SIGNED_IN)).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(screen.getByText(SIGNED_IN)).toBeInTheDocument();
    expect(fullPath()).toBe("/register");
  });

  it("no token (registration off, no providers): normal mode redirects to /login, no inspect request", async () => {
    const { calls } = setupInvite("/register");
    await waitFor(() => expect(fullPath()).toBe("/login"));
    expect(inspectCalls(calls)).toHaveLength(0);
  });

  it("invite form page has exactly one solid button (Create account)", async () => {
    setupInvite(`/register#invite=${TOKEN}`);
    await screen.findByLabelText("Email");
    const solid = [...screen.getAllByRole("button"), ...screen.queryAllByRole("link")].filter((el) => SOLID_BG.test(el.className));
    expect(solid.map((el) => el.textContent)).toEqual(["Create account"]);
  });
});

describe("password length hint number comes from the shared constant", () => {
  // The register page and the change-password form share this string; a hard-coded number would go stale when the constant changes.
  it.each(["en", "zh-TW"])("%s: changePassword.passwordHint interpolates {{min}}", (language) => {
    expect(i18n.getResource(language, "translation", "changePassword.passwordHint")).toContain("{{min}}");
  });
});

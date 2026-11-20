import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import type { PendingLinkDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";
import { expectCardControls44 } from "@/test/card-controls";

interface Call { method: string; url: string; body: unknown }

function fakeResponse(status: number, body?: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)) } as unknown as Response;
}
const err = (status: number, code: string, extra: Record<string, unknown> = {}) => fakeResponse(status, { error: { code, message: "x" }, ...extra });

const PENDING: PendingLinkDto = {
  pendingId: "pid-1",
  email: "u@example.com",
  providerDisplayName: "Corp IdP",
  methods: { password: true, providers: [{ id: "11111111-1111-1111-1111-111111111111", displayName: "GitLab", icon: { type: "builtin", name: "generic" } }] },
};
const USER = { id: "u1", email: "u@example.com", handle: "u", displayName: "U", isAdmin: false, mustChangePassword: false, hasPassword: true, autoVersions: true, avatar: null } satisfies UserDto;

/** Responds by `METHOD url`; an unlisted route returns a 404 JSON instead of throwing, because the page after a navigation may call other APIs. */
function mockFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const url = String(input);
    calls.push({ method, url, body: init?.body !== undefined ? JSON.parse(String(init.body)) : undefined });
    const handler = routes[`${method} ${url}`];
    return Promise.resolve(handler ? handler() : err(404, "not_found"));
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{`${location.pathname}${location.search}`}</div>;
}

/** The default harness turns retry off; a case that guards the page's own `retry: false` passes `new QueryClient()` (retry not disabled). */
function renderAt(path: string, queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })): QueryClient {
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
          <LocationProbe />
        </MemoryRouter>
      </ThemeProvider>
      <Toaster />
    </QueryClientProvider>,
  );
  return queryClient;
}
const loc = () => screen.getByTestId("loc").textContent;
/** Background classes of the `button.tsx` solid variants (default / destructive / brandSolid / brandDeep); same check as in `SettingsGroupRolesSection.test.tsx`. */
const SOLID_BG = /(^|\s)bg-(primary|destructive|brand|brand-deep)(\s|$)/;
/** English text of errors.oidc_link_expired. LoginPage clears ?error= from the URL with replace on mount, so "navigated to /login?error=..."
 * can only be asserted as "the login page shows this text and the final URL is /login". */
const LINK_EXPIRED_TEXT = "This linking request has expired or was replaced. Please sign in again.";

describe("LinkAccountPage (#187 /link-account)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows the email and provider name; methods decide the password field and SSO button; one solid button (password confirm)", async () => {
    mockFetch({ "GET /api/auth/oidc/pending": () => fakeResponse(200, PENDING) });
    renderAt("/link-account");
    expect(
      await screen.findByText(/This email \(u@example\.com\) already has an account/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Corp IdP/)).toBeInTheDocument();
    expect(screen.getByLabelText("Password for this account")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm with password and link" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm by signing in with GitLab" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    // At most one solid button per screen (rule in the header of button.tsx): only the password confirm is solid; SSO and cancel are outline.
    const solid = screen.getAllByRole("button").filter(b => SOLID_BG.test(b.className));
    expect(solid.map(b => b.textContent)).toEqual(["Confirm with password and link"]);
  });

  it("card page exception: password confirm, SSO proof and cancel are all lg (h-11), and the password field is also h-11 (all fields equal height)", async () => {
    mockFetch({ "GET /api/auth/oidc/pending": () => fakeResponse(200, PENDING) });
    renderAt("/link-account");
    const targets = [
      await screen.findByRole("button", { name: "Confirm with password and link" }),
      screen.getByRole("button", { name: "Confirm by signing in with GitLab" }),
      screen.getByRole("button", { name: "Cancel" }),
      screen.getByLabelText("Password for this account"),
    ];
    for (const el of targets) {
      expect(el).toHaveClass("h-11");
      expect(el).not.toHaveClass("h-8");
    }
  });

  it("methods.password=false -> no password field, only the SSO button", async () => {
    mockFetch({ "GET /api/auth/oidc/pending": () => fakeResponse(200, { ...PENDING, methods: { password: false, providers: PENDING.methods.providers } }) });
    renderAt("/link-account");
    await screen.findByRole("button", { name: "Confirm by signing in with GitLab" });
    expect(screen.queryByLabelText("Password for this account")).not.toBeInTheDocument();
  });

  it("password submit: body carries password and pendingId; on success writes ['me'] and navigates to the `next` from the response (not from the URL parameter)", async () => {
    const calls = mockFetch({
      "GET /api/auth/oidc/pending": () => fakeResponse(200, PENDING),
      "POST /api/auth/oidc/pending/confirm": () => fakeResponse(200, { user: USER, next: "/change-password" }),
      "GET /api/auth/me": () => fakeResponse(200, USER),
    });
    const qc = renderAt("/link-account?next=%2Fevil");
    fireEvent.change(await screen.findByLabelText("Password for this account"), { target: { value: "pw-123456789012" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm with password and link" }));
    await waitFor(() => expect(loc()).toBe("/change-password"));
    expect(calls.find(c => c.url === "/api/auth/oidc/pending/confirm")!.body).toEqual({ password: "pw-123456789012", pendingId: "pid-1" });
    expect(qc.getQueryData(["me"])).toEqual(USER);
  });

  it("wrong password -> alert shows the invalid_credentials text and stays on this page; 429 too_many_attempts -> adds the wait seconds", async () => {
    let n = 0;
    mockFetch({
      "GET /api/auth/oidc/pending": () => fakeResponse(200, PENDING),
      "POST /api/auth/oidc/pending/confirm": () => (++n === 1 ? err(401, "invalid_credentials") : err(429, "too_many_attempts", { retryAfterMs: 4200 })),
    });
    renderAt("/link-account");
    fireEvent.change(await screen.findByLabelText("Password for this account"), { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm with password and link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect email or password.");
    expect(loc()).toBe("/link-account");
    fireEvent.click(screen.getByRole("button", { name: "Confirm with password and link" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Try again in 5s."));
  });

  it("confirm returns 409 oidc_link_expired -> goes to /login?error=oidc_link_expired (the login page shows that text, and the URL's error is cleared afterwards)", async () => {
    mockFetch({
      "GET /api/auth/oidc/pending": () => fakeResponse(200, PENDING),
      "POST /api/auth/oidc/pending/confirm": () => err(409, "oidc_link_expired"),
      "GET /api/auth/config": () => fakeResponse(200, { providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: true } }),
    });
    renderAt("/link-account");
    fireEvent.change(await screen.findByLabelText("Password for this account"), { target: { value: "pw-123456789012" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm with password and link" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(LINK_EXPIRED_TEXT);
    await waitFor(() => expect(loc()).toBe("/login"));
  });

  it("SSO button -> POST prove/<id> with pendingId; after {url} comes back, a full-page navigation to it", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const calls = mockFetch({
      "GET /api/auth/oidc/pending": () => fakeResponse(200, PENDING),
      "POST /api/auth/oidc/pending/prove/11111111-1111-1111-1111-111111111111": () => fakeResponse(200, { url: "https://gitlab.example/authorize?x=1" }),
    });
    renderAt("/link-account");
    fireEvent.click(await screen.findByRole("button", { name: "Confirm by signing in with GitLab" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://gitlab.example/authorize?x=1"));
    expect(calls.find(c => c.url.includes("/prove/"))!.body).toEqual({ pendingId: "pid-1" });
  });

  it("cancel -> POST cancel, explanatory toast, goes to /login", async () => {
    const calls = mockFetch({
      "GET /api/auth/oidc/pending": () => fakeResponse(200, PENDING),
      "POST /api/auth/oidc/pending/cancel": () => fakeResponse(204),
      "GET /api/auth/config": () => fakeResponse(200, { providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: true } }),
    });
    renderAt("/link-account");
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(loc()).toBe("/login"));
    expect(calls.some(c => c.method === "POST" && c.url === "/api/auth/oidc/pending/cancel")).toBe(true);
    expect(await screen.findByText(/This email is already in use/)).toBeInTheDocument();
  });

  it("no usable proof method (409 oidc_link_no_proof_method) -> only the explanation and a \"back to login\" button; the pending query does not retry (called exactly once)", async () => {
    const calls = mockFetch({ "GET /api/auth/oidc/pending": () => err(409, "oidc_link_no_proof_method") });
    // This case deliberately uses a QueryClient that does NOT disable retry: it guards the page's own `retry: false` on the `["oidc-pending"]` query.
    // Without it query-core retries 3 times by default (backoff ~7 s, within the global wait limit), so the error screen would appear after 4 calls -> the count goes red.
    renderAt("/link-account", new QueryClient());
    expect(await screen.findByText(/has no other way to confirm it's you/)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "GET" && c.url === "/api/auth/oidc/pending")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Back to sign in" })).toBeInTheDocument();
    expect(expectCardControls44()).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Password for this account")).not.toBeInTheDocument();
  });

  it("?error=oidc_link_proof_mismatch -> shows that text and the URL's error is cleared; a code not on the allow list -> fallback", async () => {
    mockFetch({ "GET /api/auth/oidc/pending": () => fakeResponse(200, PENDING) });
    renderAt("/link-account?error=oidc_link_proof_mismatch");
    expect(await screen.findByRole("alert")).toHaveTextContent("The identity you signed in with isn't one already linked to this account.");
    await waitFor(() => expect(loc()).toBe("/link-account"));
  });

  it("?error=oidc_state_mismatch / oidc_claim_too_long -> each shows its own text, not the fallback", async () => {
    for (const [code, text] of [
      ["oidc_state_mismatch", "Your sign-in session expired or is invalid. Please try signing in again."],
      ["oidc_claim_too_long", "Your identity provider sent an email address or account ID that is too long to use."],
    ] as const) {
      mockFetch({ "GET /api/auth/oidc/pending": () => fakeResponse(200, PENDING) });
      renderAt(`/link-account?error=${code}`);
      expect(await screen.findByRole("alert")).toHaveTextContent(text);
      cleanup();
    }
  });

  it("?error=constructor (not on the allow list) -> fallback text, does not blow up", async () => {
    mockFetch({ "GET /api/auth/oidc/pending": () => fakeResponse(200, PENDING) });
    renderAt("/link-account?error=constructor");
    expect(await screen.findByRole("alert")).toHaveTextContent("An unexpected error occurred.");
  });

  it("no pending (401) -> quietly goes to /login without sending any confirm; with ?error=oidc_link_expired it is carried along", async () => {
    for (const [path, expectAlert] of [["/link-account", false], ["/link-account?error=oidc_link_expired", true]] as const) {
      const calls = mockFetch({
        "GET /api/auth/oidc/pending": () => err(401, "unauthorized"),
        "GET /api/auth/config": () => fakeResponse(200, { providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: true } }),
      });
      renderAt(path);
      expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
      if (expectAlert) {
        // The carried-over ?error= is shown by LoginPage, which clears the URL's error with replace, so assert the text.
        expect(await screen.findByRole("alert")).toHaveTextContent(LINK_EXPIRED_TEXT);
      } else {
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      }
      await waitFor(() => expect(loc()).toBe("/login"));
      expect(calls.some(c => c.method === "POST")).toBe(false);
      cleanup();
    }
  });

  it("provider deleted (providerDisplayName null) -> shown with a generic name; an HTML-shaped provider name is rendered literally", async () => {
    const evil = '<img src=x onerror="alert(1)">';
    mockFetch({ "GET /api/auth/oidc/pending": () => fakeResponse(200, { ...PENDING, providerDisplayName: null, methods: { password: false, providers: [{ id: "22222222-2222-2222-2222-222222222222", displayName: evil }] } }) });
    renderAt("/link-account");
    expect(await screen.findByText(/To link this sign-in service to it/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Confirm by signing in with ${evil}` })).toBeInTheDocument();
    expect(document.querySelector("img[src='x']")).toBeNull();
  });

  it("GET pending returns 409 oidc_link_expired (account deleted / email changed) -> goes to /login, the login page shows that text, does not stay on Loading", async () => {
    const calls = mockFetch({
      "GET /api/auth/oidc/pending": () => err(409, "oidc_link_expired"),
      "GET /api/auth/config": () => fakeResponse(200, { providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: true } }),
    });
    renderAt("/link-account");
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(LINK_EXPIRED_TEXT);
    await waitFor(() => expect(loc()).toBe("/login"));
    expect(calls.some(c => c.method === "POST")).toBe(false);
  });

  it("password 429 (with a countdown) then SSO with a failing prove -> only the prove error is shown, no countdown left over", async () => {
    mockFetch({
      "GET /api/auth/oidc/pending": () => fakeResponse(200, PENDING),
      "POST /api/auth/oidc/pending/confirm": () => err(429, "too_many_attempts", { retryAfterMs: 4200 }),
      "POST /api/auth/oidc/pending/prove/11111111-1111-1111-1111-111111111111": () => err(503, "oidc_unavailable"),
    });
    renderAt("/link-account");
    fireEvent.change(await screen.findByLabelText("Password for this account"), { target: { value: "pw-123456789012" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm with password and link" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Try again in 5s."));
    fireEvent.click(screen.getByRole("button", { name: "Confirm by signing in with GitLab" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Single sign-on is unavailable right now."));
    expect(screen.getByRole("alert")).not.toHaveTextContent("Try again in");
  });

  it("GET pending fails with anything other than 401 / 409 (500, network error) -> generic error and an outline \"back to login\" button, does not stay on Loading", async () => {
    for (const fail of [() => err(500, "internal"), () => Promise.reject(new TypeError("Failed to fetch"))]) {
      mockFetch({
        "GET /api/auth/oidc/pending": fail,
        "POST /api/auth/oidc/pending/cancel": () => fakeResponse(204),
        "GET /api/auth/config": () => fakeResponse(200, { providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: true } }),
      });
      renderAt("/link-account");
      expect(await screen.findByRole("alert")).toHaveTextContent("An unexpected error occurred.");
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
      const back = screen.getByRole("button", { name: "Back to sign in" });
      expect(expectCardControls44()).toBeGreaterThan(0);
      expect(SOLID_BG.test(back.className)).toBe(false);
      fireEvent.click(back);
      await waitFor(() => expect(loc()).toBe("/login"));
      cleanup();
    }
  });
  it("provider-icon: the \"Confirm by signing in with X\" button has an icon before the text; a null icon is not rendered", async () => {
    mockFetch({
      "GET /api/auth/oidc/pending": () =>
        fakeResponse(200, {
          ...PENDING,
          methods: {
            password: true,
            providers: [
              { id: "11111111-1111-1111-1111-111111111111", displayName: "GitLab", icon: { type: "builtin", name: "generic" } },
              { id: "22222222-2222-2222-2222-222222222222", displayName: "Plain", icon: null },
            ],
          },
        }),
    });
    renderAt("/link-account");
    const gitlab = await screen.findByRole("button", { name: "Confirm by signing in with GitLab" });
    expect(gitlab.firstChild).toBe(gitlab.querySelector('[data-provider-icon="generic"]'));
    expect(gitlab.textContent).toBe("Confirm by signing in with GitLab");
    expect(screen.getByRole("button", { name: "Confirm by signing in with Plain" }).querySelector("[data-provider-icon]")).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import type { IdentitiesDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { AppRoutes } from "@/App";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { SignInMethodsSection } from "./SignInMethodsSection";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

function fakeResponse(status: number, body?: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: body === undefined ? () => Promise.reject(new Error("no body")) : () => Promise.resolve(body) } as unknown as Response;
}
function LocationProbe() {
  const l = useLocation();
  return <div data-testid="location">{`${l.pathname}${l.search}`}</div>;
}
const BASE: IdentitiesDto = {
  identities: [
    { id: "i1", issuer: "https://gitlab.example", providers: [{ id: "p1", displayName: "<b>GitLab</b>", icon: { type: "builtin", name: "gitlab" } }], createdAt: "2026-10-01T00:00:00.000Z", lastLoginAt: "2026-10-05T00:00:00.000Z", unlinkable: true },
    { id: "i2", issuer: "https://gone.example/realms/x", providers: [], createdAt: "2026-10-02T00:00:00.000Z", lastLoginAt: null, unlinkable: false },
  ],
  linkable: [{ providerId: "p2", displayName: "Google", template: "google", icon: { type: "builtin", name: "google" } }],
  hasPassword: true,
  passwordLoginEnabled: true,
};

function setup(data: IdentitiesDto, path = "/settings/login", extra: (m: string, u: string) => Response | null = () => null) {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url, body: typeof init?.body === "string" ? init.body : undefined });
    const r = extra(method, url);
    if (r) return r;
    if (method === "GET" && url === "/api/auth/identities") return fakeResponse(200, data);
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <SignInMethodsSection />
        <LocationProbe />
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
  return { calls };
}

describe("SignInMethodsSection (#187)", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); dismissAllToasts(); });
  afterEach(() => vi.unstubAllGlobals());

  it("linked row: provider name (HTML-looking names render literally), shows the issuer host when no provider matches, date; linkable row: Link X", async () => {
    setup(BASE);
    const row1 = within(await screen.findByRole("row", { name: "<b>GitLab</b>" }));
    expect(row1.getByRole("cell", { name: new Date("2026-10-01T00:00:00.000Z").toLocaleDateString("en") })).toBeInTheDocument();
    expect(row1.getByRole("cell", { name: new Date("2026-10-05T00:00:00.000Z").toLocaleDateString("en") })).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Sign-in methods" })).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "Service",
      "Linked",
      "Last used",
      "Actions",
    ]);
    expect(document.querySelector("b")).toBeNull();
    const row2 = within(screen.getByRole("row", { name: /gone\.example/ }));
    expect(row2.getByText("Removed or turned-off sign-in service")).toBeInTheDocument();
    expect(row2.getByText("Never used")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Link Google" })).toBeInTheDocument();
  });

  it("no linked sign-in methods -> shows the empty-state sentence, doesn't render the table (SettingsTable's empty); the linkable buttons stay as usual", async () => {
    setup({ ...BASE, identities: [] });
    expect(await screen.findByText("No sign-in services linked.")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Sign-in methods" })).toBeNull();
    expect(screen.getByRole("button", { name: "Link Google" })).toBeInTheDocument();
  });

  it("a row with no matching provider shows only the issuer's host (no scheme or path)", async () => {
    setup(BASE);
    const row2 = await screen.findByRole("row", { name: /gone\.example/ });
    expect(document.getElementById(row2.getAttribute("aria-labelledby")!)).toHaveTextContent(/^gone\.example$/);
  });

  it("unlinkable=false -> the unlink button is softDisabled (aria-disabled, focusable, title = reason, clicking doesn't open the confirm dialog), and the reason is also given as visible text + aria-describedby", async () => {
    setup(BASE);
    const row2 = within(await screen.findByRole("row", { name: /gone\.example/ }));
    const button = row2.getByRole("button", { name: "Unlink" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("title", "This is your only way to sign in, so it can't be unlinked.");
    const hint = document.getElementById(button.getAttribute("aria-describedby")!);
    expect(hint).toHaveTextContent("This is your only way to sign in, so it can't be unlinked.");
    expect(row2.getByText("This is your only way to sign in, so it can't be unlinked.")).toBe(hint);
    fireEvent.click(button);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("dialog", { name: "Unlink this sign-in service?" })).toBeNull();
  });

  it("unlink -> confirm dialog (destructive) -> DELETE, list refetched", async () => {
    let current = BASE;
    const { calls } = setup(BASE, "/settings/login", (m, u) => {
      if (m === "DELETE" && u === "/api/auth/identities/i1") { current = { ...BASE, identities: [BASE.identities[1]!] }; return fakeResponse(204); }
      if (m === "GET" && u === "/api/auth/identities") return fakeResponse(200, current);
      return null;
    });
    const row1 = within(await screen.findByRole("row", { name: "<b>GitLab</b>" }));
    const trigger = row1.getByRole("button", { name: "Unlink" });
    expect(trigger.querySelector('[data-icon="trash"]')).not.toBeNull();
    fireEvent.click(trigger);
    const dialog = within(await screen.findByRole("dialog", { name: "Unlink this sign-in service?" }));
    fireEvent.click(dialog.getByRole("button", { name: "Unlink" }));
    // After confirming the dialog is still open and Radix marks the background aria-hidden: first wait for the dialog to disappear (the row is removed by the refetch, taking the Dialog with it unmounted), then assert with hidden:true that the row is gone.
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole("row", { name: "<b>GitLab</b>", hidden: true })).not.toBeInTheDocument());
    expect(screen.getByRole("row", { name: /gone\.example/ })).toBeInTheDocument();
    expect(calls.some(c => c.method === "DELETE" && c.url === "/api/auth/identities/i1")).toBe(true);
    expect(calls.filter(c => c.method === "GET" && c.url === "/api/auth/identities").length).toBeGreaterThanOrEqual(2);
  });

  it("unlink 409 -> also refetches the list (server state differs from the screen): the list updates to the new state", async () => {
    let current = BASE;
    setup(BASE, "/settings/login", (m, u) => {
      if (m === "DELETE" && u === "/api/auth/identities/i1") {
        current = { ...BASE, identities: [BASE.identities[1]!] }; // at the moment of failure this row had already been unlinked elsewhere
        return fakeResponse(409, { error: { code: "last_login_method", message: "x" } });
      }
      if (m === "GET" && u === "/api/auth/identities") return fakeResponse(200, current);
      return null;
    });
    const row1 = within(await screen.findByRole("row", { name: "<b>GitLab</b>" }));
    fireEvent.click(row1.getByRole("button", { name: "Unlink" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Unlink this sign-in service?" }));
    fireEvent.click(dialog.getByRole("button", { name: "Unlink" }));
    expect(await screen.findByText("This is the account's only way to sign in, so it can't be unlinked.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole("row", { name: "<b>GitLab</b>", hidden: true })).not.toBeInTheDocument());
  });

  it("refetch fails when data already exists: the list stays, not replaced by error text", async () => {
    let failGets = false;
    setup(BASE, "/settings/login", (m, u) => {
      if (m === "DELETE" && u === "/api/auth/identities/i1") {
        failGets = true; // the refetch after the 409 will fail
        return fakeResponse(409, { error: { code: "last_login_method", message: "x" } });
      }
      if (failGets && m === "GET" && u === "/api/auth/identities") return fakeResponse(500, { error: { code: "internal", message: "x" } });
      return null;
    });
    const row1 = within(await screen.findByRole("row", { name: "<b>GitLab</b>" }));
    fireEvent.click(row1.getByRole("button", { name: "Unlink" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Unlink this sign-in service?" }));
    fireEvent.click(dialog.getByRole("button", { name: "Unlink" }));
    expect(await screen.findByText("This is the account's only way to sign in, so it can't be unlinked.")).toBeInTheDocument();
    await new Promise(r => setTimeout(r, 50)); // let the failed refetch settle
    expect(screen.getByRole("row", { name: "<b>GitLab</b>", hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("unlink 409 last_login_method -> toast error text, the list stays", async () => {
    setup(BASE, "/settings/login", (m, u) =>
      m === "DELETE" && u === "/api/auth/identities/i1" ? fakeResponse(409, { error: { code: "last_login_method", message: "x" } }) : null);
    const row1 = within(await screen.findByRole("row", { name: "<b>GitLab</b>" }));
    fireEvent.click(row1.getByRole("button", { name: "Unlink" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Unlink this sign-in service?" }));
    fireEvent.click(dialog.getByRole("button", { name: "Unlink" }));
    expect(await screen.findByText("This is the account's only way to sign in, so it can't be unlinked.")).toBeInTheDocument();
    // On failure the dialog stays open (the list is aria-hidden by the modal, so fetch the row with hidden:true).
    expect(screen.getByRole("dialog", { name: "Unlink this sign-in service?" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "<b>GitLab</b>", hidden: true })).toBeInTheDocument();
  });

  it("link -> POST /api/auth/oidc/link/p2 with JSON {} -> location.assign(url)", async () => {
    const assign = vi.fn();
    const { calls } = setup(BASE, "/settings/login", (m, u) => (m === "POST" && u === "/api/auth/oidc/link/p2" ? fakeResponse(200, { url: "https://idp.example/authorize?x=1" }) : null));
    vi.stubGlobal("location", { ...window.location, assign });
    fireEvent.click(await screen.findByRole("button", { name: "Link Google" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://idp.example/authorize?x=1"));
    expect(calls.find(c => c.method === "POST")!.body).toBe("{}");
  });

  it("?linked= -> success toast; only the linked / link_error keys are removed, other params are kept", async () => {
    setup(BASE, "/settings/login?linked=p2&keep=1");
    expect(await screen.findByText("Sign-in service linked.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/settings\/login\?keep=1$/));
  });

  it("?link_error= with keep=1 -> only link_error is removed, keep stays", async () => {
    setup(BASE, "/settings/login?link_error=identity_taken&keep=1");
    expect(await screen.findByText("This sign-in identity is already linked to a different account.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/settings\/login\?keep=1$/));
  });

  it("return params: ?link_error= is __proto__ -> fallback text, doesn't blow up, the param is cleared", async () => {
    setup(BASE, "/settings/login?link_error=__proto__");
    expect(await screen.findByText("An unexpected error occurred.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/settings\/login$/));
  });

  it("return params: ?link_error=forbidden (a valid errors key but not in the allowlist) -> fallback text, that key's text isn't rendered", async () => {
    setup(BASE, "/settings/login?link_error=forbidden");
    expect(await screen.findByText("An unexpected error occurred.")).toBeInTheDocument();
    expect(screen.queryByText("You don't have permission to do that.")).not.toBeInTheDocument();
  });

  it.each([
    ["identity_taken", "This sign-in identity is already linked to a different account."],
    ["identity_already_linked", "This account is already linked to a different identity on the same sign-in service."],
    ["oidc_link_session_mismatch", "You're no longer signed in as the account you were linking. Sign in and try again."],
    ["account_disabled", "This account has been disabled."],
    ["oidc_exchange_failed", "We couldn't complete sign-in with your identity provider. Please try again."],
    ["oidc_unavailable", "Single sign-on is unavailable right now. Please try again later or sign in with your password."],
    ["oidc_state_mismatch", "Your sign-in session expired or is invalid. Please try signing in again."],
    ["oidc_claim_too_long", "Your identity provider sent an email address or account ID that is too long to use."],
  ])("?link_error=%s -> the matching text", async (code, text) => {
    setup(BASE, `/settings/login?link_error=${code}`);
    expect(await screen.findByText(text)).toBeInTheDocument();
  });
  it("provider-icon: a linked row has an icon before the name - the first provider's icon, a host-labelled one uses the generic icon, a null icon isn't rendered; the \"Link X\" button has an icon before its text", async () => {
    setup({
      ...BASE,
      identities: [
        BASE.identities[0]!,
        BASE.identities[1]!,
        {
          id: "i3",
          issuer: "https://multi.example",
          providers: [
            { id: "p3", displayName: "First", icon: { type: "builtin", name: "google" } },
            { id: "p4", displayName: "Second", icon: { type: "builtin", name: "gitlab" } },
          ],
          createdAt: "2026-10-03T00:00:00.000Z",
          lastLoginAt: null,
          unlinkable: true,
        },
        { id: "i4", issuer: "https://hidden.example", providers: [{ id: "p5", displayName: "Hidden", icon: null }], createdAt: "2026-10-04T00:00:00.000Z", lastLoginAt: null, unlinkable: true },
      ],
    });
    const iconBeforeName = (row: HTMLElement) => document.getElementById(row.getAttribute("aria-labelledby")!)!.previousElementSibling;
    // Wait point: rows appear only after identities land.
    expect(iconBeforeName(await screen.findByRole("row", { name: "<b>GitLab</b>" }))).toHaveAttribute("data-provider-icon", "gitlab");
    expect(iconBeforeName(screen.getByRole("row", { name: /gone\.example/ }))).toHaveAttribute("data-provider-icon", "generic");
    expect(iconBeforeName(screen.getByRole("row", { name: "First / Second" }))).toHaveAttribute("data-provider-icon", "google");
    expect(screen.getByRole("row", { name: "Hidden" }).querySelector("[data-provider-icon]")).toBeNull();
    const link = screen.getByRole("button", { name: "Link Google" });
    expect(link.firstChild).toBe(link.querySelector('[data-provider-icon="google"]'));
  });
});

describe("return landing: render /settings/login via AppRoutes (#247)", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); dismissAllToasts(); });
  afterEach(() => vi.unstubAllGlobals());

  const USER: UserDto = {
    id: "u1", email: "a@example.com", handle: "a", displayName: "A",
    isAdmin: false, mustChangePassword: false, hasPassword: true, autoVersions: true,
    avatar: null,
  };

  function renderAppAt(path: string) {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url === "/api/auth/me") return fakeResponse(200, USER);
      if (method === "GET" && url === "/api/auth/identities") return fakeResponse(200, BASE);
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (method === "GET" && (url === "/api/groups" || url === "/api/notes")) return fakeResponse(200, []);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={[path]}>
            <AppRoutes />
            <LocationProbe />
          </MemoryRouter>
        </ThemeProvider>
        <Toaster />
      </QueryClientProvider>,
    );
  }

  it("/settings/login?linked=p2 -> the sign-in page shows the success toast, the param is cleared (goes red if SignInMethodsSection stays on the account info page)", async () => {
    renderAppAt("/settings/login?linked=p2");
    expect(await screen.findByText("Sign-in service linked.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/settings\/login$/));
  });

  it("/settings/login?link_error=identity_taken -> the matching error toast", async () => {
    renderAppAt("/settings/login?link_error=identity_taken");
    expect(await screen.findByText("This sign-in identity is already linked to a different account.")).toBeInTheDocument();
  });
});

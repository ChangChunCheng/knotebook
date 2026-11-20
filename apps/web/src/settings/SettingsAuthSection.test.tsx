import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AdminAuthProviderDto, SiteLimitItemDto, SiteLimitKey, SiteLimitsDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import { SITE_LIMITS_QUERY_KEY } from "@/api/siteLimits";
import { siteLimitsDto } from "@/test/site-limits-fixtures";
import { SettingsAuthSection } from "./SettingsAuthSection";

vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => true) }));

function fakeResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: body === undefined ? () => Promise.reject(new Error("no body")) : () => Promise.resolve(body),
  } as unknown as Response;
}

const LEGACY: AdminAuthProviderDto = {
  id: "11111111-1111-4111-8111-111111111111",
  template: "oidc",
  displayName: "SSO",
  issuerUrl: "http://idp.lan",
  clientId: "knotebook",
  hasSecret: true,
  enabled: true,
  autoCreateEnabled: true,
  sortOrder: 0,
  legacyCallback: true,
  callbackUrl: "https://notes.example.com/api/auth/oidc/callback",
  insecureIssuer: true,
  issuerResolved: true,
  createdAt: "2026-10-06T00:00:00.000Z",
  iconKind: "template",
  icon: { type: "builtin", name: "generic" },
};
const CUSTOM: AdminAuthProviderDto = {
  id: "22222222-2222-4222-8222-222222222222",
  template: "gitlab",
  displayName: "<b>Corp</b> & Co",
  issuerUrl: "https://gitlab.example.com",
  clientId: "corp-client",
  hasSecret: false,
  enabled: false,
  autoCreateEnabled: false,
  sortOrder: 1,
  legacyCallback: false,
  callbackUrl: "https://notes.example.com/api/auth/oidc/callback/22222222-2222-4222-8222-222222222222",
  insecureIssuer: false,
  issuerResolved: false,
  createdAt: "2026-10-06T00:00:00.000Z",
  iconKind: "template",
  icon: { type: "builtin", name: "generic" },
};

const LIMITS: SiteLimitsDto = siteLimitsDto();
const limitsWith = (key: SiteLimitKey, patch: Partial<SiteLimitItemDto>): SiteLimitsDto => ({
  ...LIMITS,
  items: LIMITS.items.map((item) => (item.key === key ? { ...item, ...patch } : item)),
});

type Handler = (method: string, url: string, body: unknown) => Response | Promise<Response> | null;

function fakeServer(initial: AdminAuthProviderDto[]) {
  const state = { providers: [...initial], limits: LIMITS };
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const handlers: Handler[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    for (const handler of handlers) {
      const res = handler(method, url, body);
      if (res) return res;
    }
    if (method === "GET" && url === "/api/admin/auth/providers") return fakeResponse(200, { providers: state.providers });
    if (method === "GET" && url === "/api/admin/auth/settings") {
      return fakeResponse(200, { registrationEnabled: true, passwordLoginEnabled: true, passwordLoginForced: false, passwordLoginImpact: { usersWithoutSso: 0, actingAdminHasSso: true, enabledProviders: 1 } });
    }
    if (method === "GET" && url === "/api/admin/limits") return fakeResponse(200, state.limits);
    const impact = /^\/api\/admin\/auth\/providers\/([^/]+)\/impact$/.exec(url);
    if (method === "GET" && impact) {
      return fakeResponse(200, { linkedUsers: impact[1] === LEGACY.id ? 11 : 0, lockedOutUsers: 0, issuerResolved: true, actingAdminLockedOut: false });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  return { state, calls, fetchMock, on: (handler: Handler) => handlers.push(handler) };
}

function renderSection(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SettingsAuthSection />
      <Toaster />
    </QueryClientProvider>,
  );
  return queryClient;
}

const row = (name: string) => within(screen.getByRole("row", { name }));
const details = (name: string) => within(screen.getByRole("row", { name: `${name} details` }));
const nameElementOf = (rowEl: HTMLElement) => document.getElementById(rowEl.getAttribute("aria-labelledby")!)!;

describe("SettingsAuthSection (#187 /admin/auth)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    vi.mocked(copyText).mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("row + detail row: display name (HTML-looking names render literally), template, legacy marker, issuer (once, on the row), client id, callback URL, secret state, not-connected note, http warning", async () => {
    const server = fakeServer([LEGACY, CUSTOM]);
    renderSection(server.fetchMock);
    await waitFor(() => expect(screen.getByRole("row", { name: "<b>Corp</b> & Co" })).toBeInTheDocument());
    expect(document.querySelector("b")).toBeNull();
    expect(screen.getByRole("row", { name: "SSO" }).nextElementSibling).toBe(screen.getByRole("row", { name: "SSO details" }));

    const legacy = row("SSO");
    expect(legacy.getByText(/Custom OIDC/)).toBeInTheDocument();
    expect(legacy.getByText(/Imported from OIDC_\*/)).toBeInTheDocument();
    expect(legacy.getByRole("cell", { name: "http://idp.lan" })).toBeInTheDocument();
    expect(screen.getAllByText("http://idp.lan")).toHaveLength(1);
    const legacyDetails = details("SSO");
    expect(legacyDetails.getByText("https://notes.example.com/api/auth/oidc/callback")).toBeInTheDocument();
    expect(legacyDetails.getByText("Client secret saved.")).toBeInTheDocument();
    expect(legacyDetails.getByText(/plain http/)).toBeInTheDocument();
    expect(legacyDetails.queryByText(/Hasn't connected successfully yet/)).toBeNull();

    const custom = row("<b>Corp</b> & Co");
    expect(custom.getByText(/GitLab/)).toBeInTheDocument();
    expect(custom.queryByText(/Imported from OIDC_\*/)).toBeNull();
    const customDetails = details("<b>Corp</b> & Co");
    expect(customDetails.getByText("corp-client")).toBeInTheDocument();
    expect(customDetails.getByText(CUSTOM.callbackUrl)).toBeInTheDocument();
    expect(customDetails.getByText(/No client secret yet/)).toBeInTheDocument();
    expect(customDetails.getByText(/Hasn't connected successfully yet/)).toBeInTheDocument();
    expect(customDetails.queryByText(/plain http/)).toBeNull();
  });

  it("zero sign-in services -> empty-state text", async () => {
    renderSection(fakeServer([]).fetchMock);
    await waitFor(() => expect(screen.getByText("No sign-in services yet.")).toBeInTheDocument());
  });

  it("copy the callback URL (detail row) -> copyText gets callbackUrl, toast", async () => {
    renderSection(fakeServer([CUSTOM]).fetchMock);
    await screen.findByRole("row", { name: "<b>Corp</b> & Co details" });
    fireEvent.click(details("<b>Corp</b> & Co").getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(screen.getByText("Callback URL copied.")).toBeInTheDocument());
    expect(vi.mocked(copyText)).toHaveBeenCalledWith(CUSTOM.callbackUrl);
  });

  it("turning on the switch -> PATCH {enabled:true}; 409 provider_secret_missing -> toast, the switch stays off", async () => {
    const server = fakeServer([CUSTOM]);
    server.on((method, url) =>
      method === "PATCH" && url === `/api/admin/auth/providers/${CUSTOM.id}`
        ? fakeResponse(409, { error: { code: "provider_secret_missing", message: "x" } })
        : null,
    );
    renderSection(server.fetchMock);
    const custom = within(await screen.findByRole("row", { name: "<b>Corp</b> & Co" }));
    fireEvent.click(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" }));
    await waitFor(() => expect(screen.getByText("Enter a client secret before turning this sign-in service on.")).toBeInTheDocument());
    expect(server.calls.find(c => c.method === "PATCH")!.body).toEqual({ enabled: true });
    expect(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" })).toHaveAttribute("aria-checked", "false");
  });

  it("turning on a service without a client ID -> 409 provider_client_id_missing -> toast, the switch stays off", async () => {
    const server = fakeServer([{ ...CUSTOM, clientId: null, hasSecret: true }]);
    server.on((method, url) =>
      method === "PATCH" && url === `/api/admin/auth/providers/${CUSTOM.id}`
        ? fakeResponse(409, { error: { code: "provider_client_id_missing", message: "x" } })
        : null,
    );
    renderSection(server.fetchMock);
    const custom = within(await screen.findByRole("row", { name: "<b>Corp</b> & Co" }));
    fireEvent.click(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" }));
    await waitFor(() => expect(screen.getByText("Enter a client ID before turning this sign-in service on.")).toBeInTheDocument());
    expect(server.calls.find(c => c.method === "PATCH")!.body).toEqual({ enabled: true });
    expect(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" })).toHaveAttribute("aria-checked", "false");
  });

  it("turning off the switch -> opens a dialog first (no PATCH), shows the member count and the not-connected note; confirm -> PATCH {enabled:false}, after the refetch the switch is off", async () => {
    const enabledUnresolved = { ...CUSTOM, hasSecret: true, enabled: true };
    const server = fakeServer([enabledUnresolved]);
    server.on((method, url) =>
      method === "GET" && url === `/api/admin/auth/providers/${CUSTOM.id}/impact`
        ? fakeResponse(200, { linkedUsers: 5, lockedOutUsers: 2, issuerResolved: false, actingAdminLockedOut: false })
        : null,
    );
    server.on((method, url) => {
      if (method !== "PATCH" || url !== `/api/admin/auth/providers/${CUSTOM.id}`) return null;
      server.state.providers = [{ ...enabledUnresolved, enabled: false }];
      return fakeResponse(200, server.state.providers[0]);
    });
    renderSection(server.fetchMock);
    const custom = within(await screen.findByRole("row", { name: "<b>Corp</b> & Co" }));
    fireEvent.click(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" }));

    const dialog = within(await screen.findByRole("dialog", { name: "Turn this sign-in service off?" }));
    await waitFor(() => expect(dialog.getByText("Linked accounts: 5")).toBeInTheDocument());
    expect(dialog.getByText("Of those, with no other way to sign in: 2")).toBeInTheDocument();
    expect(dialog.getByText(/these numbers may be off/)).toBeInTheDocument();
    expect(server.calls.some(c => c.method === "PATCH")).toBe(false);

    fireEvent.click(dialog.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" })).toHaveAttribute("aria-checked", "false"));
    expect(server.calls.find(c => c.method === "PATCH")!.body).toEqual({ enabled: false });
  });

  it("cancelling the disable dialog -> no PATCH, the switch stays on", async () => {
    const enabled = { ...CUSTOM, hasSecret: true, enabled: true };
    const server = fakeServer([enabled]);
    server.on((method, url) =>
      method === "GET" && url.endsWith("/impact") ? fakeResponse(200, { linkedUsers: 0, lockedOutUsers: 0, issuerResolved: true, actingAdminLockedOut: false }) : null,
    );
    renderSection(server.fetchMock);
    const custom = within(await screen.findByRole("row", { name: "<b>Corp</b> & Co" }));
    fireEvent.click(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Turn this sign-in service off?" }));
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.calls.some(c => c.method === "PATCH")).toBe(false);
    expect(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" })).toHaveAttribute("aria-checked", "true");
  });

  it("delete: the delete button of an enabled service is aria-disabled; for a disabled one -> dialog (legacy shows the old callback URL note; the confirm button is destructive) -> DELETE -> after the refetch the row is gone", async () => {
    const disabledLegacy = { ...LEGACY, enabled: false };
    const server = fakeServer([disabledLegacy, { ...CUSTOM, hasSecret: true, enabled: true }]);
    server.on((method, url) => {
      if (method !== "DELETE" || url !== `/api/admin/auth/providers/${LEGACY.id}`) return null;
      server.state.providers = server.state.providers.filter(p => p.id !== LEGACY.id);
      return fakeResponse(204);
    });
    renderSection(server.fetchMock);
    const custom = within(await screen.findByRole("row", { name: "<b>Corp</b> & Co" }));
    expect(custom.getByRole("button", { name: "Delete" })).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(row("SSO").getByRole("button", { name: "Delete" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Delete this sign-in service?" }));
    expect(dialog.getByText(/uses the old callback URL/)).toBeInTheDocument();
    const confirm = dialog.getByRole("button", { name: "Delete" });
    expect(confirm.className).toMatch(/destructive/);
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole("row", { name: "SSO" })).toBeNull());
    expect(server.calls.filter(c => c.method === "DELETE")).toHaveLength(1);
  });

  it("why the delete button is disabled: text visible in the detail row plus `title`, linked to the delete button via aria-describedby; after disabling the service the text goes away and delete is clickable", async () => {
    const enabled = { ...CUSTOM, hasSecret: true, enabled: true };
    const server = fakeServer([enabled]);
    server.on((method, url) =>
      method === "GET" && url.endsWith("/impact") ? fakeResponse(200, { linkedUsers: 0, lockedOutUsers: 0, issuerResolved: true, actingAdminLockedOut: false }) : null,
    );
    server.on((method, url) => {
      if (method !== "PATCH" || url !== `/api/admin/auth/providers/${CUSTOM.id}`) return null;
      server.state.providers = [{ ...enabled, enabled: false }];
      return fakeResponse(200, server.state.providers[0]);
    });
    renderSection(server.fetchMock);
    const custom = within(await screen.findByRole("row", { name: "<b>Corp</b> & Co" }));
    const customDetails = details("<b>Corp</b> & Co");
    const hint = customDetails.getByText("Turn it off before deleting it.");
    const deleteButton = custom.getByRole("button", { name: "Delete" });
    expect(deleteButton).toHaveAttribute("aria-disabled", "true");
    expect(hint.id).not.toBe("");
    expect(deleteButton).toHaveAttribute("aria-describedby", hint.id);
    expect(deleteButton).toHaveAccessibleDescription("Turn it off before deleting it.");

    fireEvent.click(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Turn this sign-in service off?" }));
    fireEvent.click(dialog.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" })).toHaveAttribute("aria-checked", "false"));
    expect(customDetails.queryByText("Turn it off before deleting it.")).toBeNull();
    expect(custom.getByRole("button", { name: "Delete" })).not.toHaveAttribute("aria-disabled");
    expect(custom.getByRole("button", { name: "Delete" })).not.toHaveAttribute("aria-describedby");
  });

  it("display name inside the disable dialog and the delete dialog: HTML-looking names render literally, not as elements", async () => {
    const enabled = { ...CUSTOM, hasSecret: true, enabled: true };
    const server = fakeServer([enabled]);
    server.on((method, url) =>
      method === "GET" && url.endsWith("/impact") ? fakeResponse(200, { linkedUsers: 1, lockedOutUsers: 0, issuerResolved: true, actingAdminLockedOut: false }) : null,
    );
    server.on((method, url) => {
      if (method !== "PATCH" || url !== `/api/admin/auth/providers/${CUSTOM.id}`) return null;
      server.state.providers = [{ ...enabled, enabled: false }];
      return fakeResponse(200, server.state.providers[0]);
    });
    renderSection(server.fetchMock);
    const custom = within(await screen.findByRole("row", { name: "<b>Corp</b> & Co" }));

    fireEvent.click(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" }));
    const disableDialog = within(await screen.findByRole("dialog", { name: "Turn this sign-in service off?" }));
    expect(disableDialog.getByText("<b>Corp</b> & Co")).toBeInTheDocument();
    expect(document.querySelector("b")).toBeNull();
    fireEvent.click(disableDialog.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(custom.getByRole("button", { name: "Delete" })).not.toHaveAttribute("aria-disabled"));

    fireEvent.click(custom.getByRole("button", { name: "Delete" }));
    const deleteDialog = within(await screen.findByRole("dialog", { name: "Delete this sign-in service?" }));
    expect(deleteDialog.getByText("<b>Corp</b> & Co")).toBeInTheDocument();
    expect(document.querySelector("b")).toBeNull();
  });

  it("test connection (button on the row, result in the detail row): success shows issuer, warning and a capability note, after the list refetch the \"not connected\" note disappears; 502 -> error text", async () => {
    const server = fakeServer([{ ...LEGACY, issuerResolved: false }]);
    let fail = false;
    server.on((method, url) => {
      if (method !== "POST" || url !== `/api/admin/auth/providers/${LEGACY.id}/test`) return null;
      if (fail) return fakeResponse(502, { error: { code: "oidc_discovery_failed", message: "x" } });
      server.state.providers = [{ ...LEGACY, issuerResolved: true }]; // a successful /test on the server writes resolved_issuer
      return fakeResponse(200, { issuer: "http://idp.lan", warnings: ["insecure_issuer", "client_secret_post_not_advertised"] });
    });
    renderSection(server.fetchMock);
    const legacy = within(await screen.findByRole("row", { name: "SSO" }));
    const legacyDetails = details("SSO");
    expect(legacyDetails.getByText(/Hasn't connected successfully yet/)).toBeInTheDocument();
    fireEvent.click(legacy.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(legacyDetails.queryByText(/Hasn't connected successfully yet/)).toBeNull());
    await waitFor(() => expect(legacyDetails.getByText("Connection OK. The identity provider reports issuer http://idp.lan.")).toBeInTheDocument());
    expect(legacyDetails.getByText("The issuer uses plain http.")).toBeInTheDocument();
    expect(legacyDetails.getByText(/doesn't list client_secret_post/)).toBeInTheDocument();
    expect(legacyDetails.getByText(/can't tell whether the client ID or secret is right/)).toBeInTheDocument();

    fail = true;
    fireEvent.click(legacy.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(legacyDetails.getByText("Couldn't read a usable OpenID Connect configuration from that issuer URL.")).toBeInTheDocument());
  });

  it("after a successful connection test, if the refetched list has a changed issuer -> the old \"Connection OK\" message disappears (doesn't coexist with the not-connected note)", async () => {
    const server = fakeServer([{ ...LEGACY, issuerResolved: false }]);
    server.on((method, url) => {
      if (method !== "POST" || url !== `/api/admin/auth/providers/${LEGACY.id}/test`) return null;
      return fakeResponse(200, { issuer: "http://idp.lan", warnings: [] });
    });
    server.on((method, url) =>
      method === "GET" && url === `/api/admin/auth/providers/${LEGACY.id}/impact`
        ? fakeResponse(200, { linkedUsers: 0, lockedOutUsers: 0, issuerResolved: true, actingAdminLockedOut: false })
        : null,
    );
    server.on((method, url) => {
      if (method !== "PATCH" || url !== `/api/admin/auth/providers/${LEGACY.id}`) return null;
      server.state.providers = [{ ...LEGACY, issuerUrl: "http://other.lan", issuerResolved: false, enabled: false }];
      return fakeResponse(200, server.state.providers[0]);
    });
    renderSection(server.fetchMock);
    const legacy = within(await screen.findByRole("row", { name: "SSO" }));
    fireEvent.click(legacy.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(details("SSO").getByText("Connection OK. The identity provider reports issuer http://idp.lan.")).toBeInTheDocument());

    fireEvent.click(legacy.getByRole("switch", { name: "Enabled SSO" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Turn this sign-in service off?" }));
    fireEvent.click(dialog.getByRole("button", { name: "Turn off" }));

    expect(await screen.findAllByText("http://other.lan")).toHaveLength(1);
    const refreshed = details("SSO");
    expect(refreshed.queryByText(/Connection OK/)).toBeNull();
    expect(refreshed.getByText(/Hasn't connected successfully yet/)).toBeInTheDocument();
  });

  it("test results per row: a result appears only in the tested row's detail row; changing one row's config clears only that row's result", async () => {
    const corp = { ...CUSTOM, hasSecret: true };
    const server = fakeServer([LEGACY, corp]);
    server.on((method, url) => {
      if (method !== "POST") return null;
      if (url === `/api/admin/auth/providers/${LEGACY.id}/test`) return fakeResponse(200, { issuer: "http://idp.lan", warnings: [] });
      if (url === `/api/admin/auth/providers/${CUSTOM.id}/test`) return fakeResponse(502, { error: { code: "oidc_discovery_failed", message: "x" } });
      return null;
    });
    server.on((method, url) => {
      if (method !== "PATCH" || url !== `/api/admin/auth/providers/${CUSTOM.id}`) return null;
      // Corp's issuer also changes on the server at the same moment it's turned on (simulating a config change elsewhere): Corp's test result goes stale, SSO's is unaffected.
      server.state.providers = [LEGACY, { ...corp, enabled: true, issuerUrl: "https://gitlab.other.example" }];
      return fakeResponse(200, server.state.providers[1]);
    });
    renderSection(server.fetchMock);
    const ok = "Connection OK. The identity provider reports issuer http://idp.lan.";
    const failed = "Couldn't read a usable OpenID Connect configuration from that issuer URL.";
    await screen.findByRole("row", { name: "SSO" });

    fireEvent.click(row("SSO").getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(details("SSO").getByText(ok)).toBeInTheDocument());
    expect(details("<b>Corp</b> & Co").queryByText(ok)).toBeNull();

    fireEvent.click(row("<b>Corp</b> & Co").getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(details("<b>Corp</b> & Co").getByText(failed)).toBeInTheDocument());
    expect(details("SSO").queryByText(failed)).toBeNull();
    expect(details("SSO").getByText(ok)).toBeInTheDocument();

    fireEvent.click(row("<b>Corp</b> & Co").getByRole("switch", { name: "Enabled <b>Corp</b> & Co" }));
    await waitFor(() => expect(row("<b>Corp</b> & Co").getByRole("cell", { name: "https://gitlab.other.example" })).toBeInTheDocument());
    expect(details("<b>Corp</b> & Co").queryByText(failed)).toBeNull();
    expect(details("SSO").getByText(ok)).toBeInTheDocument();
  });

  it("test in progress (POST /test not returned): \"Testing...\" appears only in the tested row's detail row; disappears after the response", async () => {
    const server = fakeServer([LEGACY, { ...CUSTOM, hasSecret: true }]);
    let release: (res: Response) => void = () => {};
    server.on((method, url) =>
      method === "POST" && url === `/api/admin/auth/providers/${LEGACY.id}/test`
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : null,
    );
    renderSection(server.fetchMock);
    await screen.findByRole("row", { name: "SSO" });

    fireEvent.click(row("SSO").getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(details("SSO").getByText("Testing…")).toBeInTheDocument());
    expect(details("<b>Corp</b> & Co").queryByText("Testing…")).toBeNull();

    release(fakeResponse(200, { issuer: "http://idp.lan", warnings: [] }));
    await waitFor(() => expect(details("SSO").getByText("Connection OK. The identity provider reports issuer http://idp.lan.")).toBeInTheDocument());
    expect(details("SSO").queryByText("Testing…")).toBeNull();
  });

  it("disable dialog: actingAdminLockedOut=true -> shows the warning that you won't be able to sign in with sign-in services after disabling", async () => {
    const enabled = { ...CUSTOM, hasSecret: true, enabled: true };
    const server = fakeServer([enabled]);
    server.on((method, url) =>
      method === "GET" && url === `/api/admin/auth/providers/${CUSTOM.id}/impact`
        ? fakeResponse(200, { linkedUsers: 1, lockedOutUsers: 0, issuerResolved: true, actingAdminLockedOut: true })
        : null,
    );
    renderSection(server.fetchMock);
    const custom = within(await screen.findByRole("row", { name: "<b>Corp</b> & Co" }));
    fireEvent.click(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Turn this sign-in service off?" }));
    expect(await dialog.findByText("After turning this off, you won't be able to sign in through a sign-in service yourself.")).toBeInTheDocument();
  });

  it("disable dialog: actingAdminLockedOut=false -> that sentence isn't shown (asserted after the member count has landed)", async () => {
    const enabled = { ...CUSTOM, hasSecret: true, enabled: true };
    const server = fakeServer([enabled]);
    server.on((method, url) =>
      method === "GET" && url === `/api/admin/auth/providers/${CUSTOM.id}/impact`
        ? fakeResponse(200, { linkedUsers: 4, lockedOutUsers: 0, issuerResolved: true, actingAdminLockedOut: false })
        : null,
    );
    renderSection(server.fetchMock);
    const custom = within(await screen.findByRole("row", { name: "<b>Corp</b> & Co" }));
    fireEvent.click(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Turn this sign-in service off?" }));
    expect(await dialog.findByText("Linked accounts: 4")).toBeInTheDocument();
    expect(dialog.queryByText("After turning this off, you won't be able to sign in through a sign-in service yourself.")).not.toBeInTheDocument();
  });

  it("provider-icon: an icon before the name (the icon computed in the admin DTO); the upload's <img src> equals the DTO's icon.url; the row name is unchanged", async () => {
    const url = `/api/auth/providers/${CUSTOM.id}/icon?v=5`;
    const server = fakeServer([LEGACY, { ...CUSTOM, iconKind: "upload", icon: { type: "upload", url } }]);
    renderSection(server.fetchMock);
    // Wait point: rows appear only after the list lands.
    const corp = await screen.findByRole("row", { name: "<b>Corp</b> & Co" });
    const corpIcon = nameElementOf(corp).previousElementSibling;
    expect(corpIcon?.tagName).toBe("IMG");
    expect(corpIcon).toHaveAttribute("src", url);
    expect(nameElementOf(screen.getByRole("row", { name: "SSO" })).previousElementSibling).toHaveAttribute("data-provider-icon", "generic");
  });

  // The "Icon" button is a RowIconButton: its appearance (ghost, no solid fill) is guarded by its own test and panel-no-solid-buttons; here only the name and behavior are checked.
  it("provider-icon: both rows have an \"Icon\" button, Edit / Delete are still there; clicking opens the icon dialog", async () => {
    const server = fakeServer([LEGACY, CUSTOM]);
    renderSection(server.fetchMock);
    await screen.findByRole("row", { name: "SSO" });
    for (const name of ["SSO", "<b>Corp</b> & Co"]) {
      const r = row(name);
      expect(r.getByRole("button", { name: "Icon" }), name).toBeInTheDocument();
      expect(r.getByRole("button", { name: "Edit" }), name).toBeInTheDocument();
      expect(r.getByRole("button", { name: "Delete" }), name).toBeInTheDocument();
    }
    fireEvent.click(row("SSO").getByRole("button", { name: "Icon" }));
    expect(await screen.findByRole("dialog", { name: "Sign-in service icon" })).toBeInTheDocument();
  });
});

describe("sign-in service table", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("table name Sign-in services; column names Service / Issuer / Linked / Creates accounts / Actions / Enabled; row contents: Issuer, linked count, Test connection / Icon / Edit / Delete (in order), the \"Enabled <name>\" switch", async () => {
    renderSection(fakeServer([LEGACY, CUSTOM]).fetchMock);
    const table = await screen.findByRole("table", { name: "Sign-in services" });
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Service", "Issuer", "Linked", "Creates accounts", "Actions", "Enabled"]);
    const legacyRow = within(table).getByRole("row", { name: "SSO" });
    expect(within(legacyRow).getByRole("cell", { name: "http://idp.lan" })).toBeInTheDocument();
    await waitFor(() => expect(within(legacyRow).getByRole("cell", { name: "11" })).toBeInTheDocument());
    expect(within(legacyRow).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Test connection",
      "Icon",
      "Edit",
      "Delete",
    ]);
    expect(within(legacyRow).getByRole("switch", { name: "Enabled SSO" })).toBeInTheDocument();
  });

  it("column widths: service and Issuer columns split 1 : 1.5 (real mount)", async () => {
    renderSection(fakeServer([LEGACY, CUSTOM]).fetchMock);
    const table = await screen.findByRole("table", { name: "Sign-in services" });
    expect(table.style.getPropertyValue("--kb-table-cols")).toBe("minmax(14ch,1fr) minmax(14ch,1.5fr) max-content max-content 8.75rem 3.5rem");
  });

  it("enabled Delete: aria-disabled + title \"Turn it off before deleting it.\", clicking doesn't open the delete dialog", async () => {
    renderSection(fakeServer([LEGACY]).fetchMock);
    const del = within(await screen.findByRole("row", { name: "SSO" })).getByRole("button", { name: "Delete" });
    expect(del).toHaveAttribute("title", "Turn it off before deleting it.");
    fireEvent.click(del);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("dialog", { name: "Delete this sign-in service?" })).not.toBeInTheDocument();
  });

  it("the disable confirm dialog is a snapshot taken when it opened: the old member count (A) already loaded on the row doesn't appear in the dialog, the new count (B) shows after the refetch finishes", async () => {
    const server = fakeServer([LEGACY]);
    let linkedUsers = 7;
    server.on((method, url) =>
      method === "GET" && url === `/api/admin/auth/providers/${LEGACY.id}/impact`
        ? fakeResponse(200, { linkedUsers, lockedOutUsers: 0, issuerResolved: true, actingAdminLockedOut: false })
        : null,
    );
    renderSection(server.fetchMock);
    const legacy = within(await screen.findByRole("row", { name: "SSO" }));
    await waitFor(() => expect(legacy.getByRole("cell", { name: "7" })).toBeInTheDocument());

    linkedUsers = 3;
    fireEvent.click(legacy.getByRole("switch", { name: "Enabled SSO" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Turn this sign-in service off?" }));
    expect(dialog.queryByText("Linked accounts: 7")).toBeNull();
    expect(await dialog.findByText("Linked accounts: 3")).toBeInTheDocument();
    expect(dialog.queryByText("Linked accounts: 7")).toBeNull();
  });

  it("\"Add sign-in service\" is outline (a panel-level action)", async () => {
    renderSection(fakeServer([]).fetchMock);
    const add = await screen.findByRole("button", { name: "Add sign-in service" });
    expect(add.className).not.toMatch(/(^|\s)bg-(primary|brand|brand-deep)(\s|$)/);
  });
});

describe("client ID not filled in yet (#299)", () => {
  const NO_ID: AdminAuthProviderDto = { ...CUSTOM, id: "66666666-6666-4666-8666-666666666666", displayName: "No ID SSO", clientId: null, hasSecret: true };
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("row with clientId null: the detail shows the full \"not filled in yet\" text; rows with a client ID still show the client ID", async () => {
    renderSection(fakeServer([NO_ID, LEGACY]).fetchMock);
    await screen.findByRole("row", { name: "No ID SSO" });
    expect(details("No ID SSO").getByText("Not set yet. The service can't be turned on until a client ID is saved.")).toBeInTheDocument();
    expect(details("SSO").getByText("knotebook")).toBeInTheDocument();
  });

  it("test connection returns client_id_missing -> the detail shows a reminder; after filling in the client ID and the list refetches -> the test result disappears", async () => {
    const server = fakeServer([NO_ID]);
    server.on((method, url) =>
      method === "POST" && url === `/api/admin/auth/providers/${NO_ID.id}/test`
        ? fakeResponse(200, { issuer: "https://gitlab.example.com", warnings: ["client_id_missing"] })
        : null,
    );
    server.on((method, url, body) => {
      if (method !== "PATCH" || url !== `/api/admin/auth/providers/${NO_ID.id}`) return null;
      server.state.providers = [{ ...NO_ID, clientId: (body as { clientId: string }).clientId }];
      return fakeResponse(200, server.state.providers[0]);
    });
    renderSection(server.fetchMock);
    const noId = within(await screen.findByRole("row", { name: "No ID SSO" }));
    fireEvent.click(noId.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(details("No ID SSO").getByText("No client ID yet. Add it with Edit before turning the service on.")).toBeInTheDocument());

    fireEvent.click(noId.getByRole("button", { name: "Edit" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Edit sign-in service" }));
    fireEvent.change(dialog.getByLabelText("Client ID"), { target: { value: "x" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(details("No ID SSO").getByText("x")).toBeInTheDocument());
    expect(details("No ID SSO").queryByText(/No client ID yet/)).toBeNull();
    expect(details("No ID SSO").queryByText(/Connection OK/)).toBeNull();
  });
});

describe("sign-in period and token group", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const group = async () => {
    const region = within(await screen.findByRole("region", { name: "Session and tokens" }));
    const input = (name: string) => region.getByLabelText(name, { selector: "input" });
    return { ...region, input };
  };
  const patches = (server: ReturnType<typeof fakeServer>) => server.calls.filter((c) => c.method === "PATCH" && c.url === "/api/admin/limits");

  it("an extra group beside the sign-in service table: sign-in validity is shown in hours, both rows have small text, and the sign-in service table is still there", async () => {
    renderSection(fakeServer([CUSTOM]).fetchMock);
    const g = await group();
    expect(g.input("Web sign-in lasts")).toHaveValue("168");
    expect(g.input("Active API tokens per person")).toHaveValue("20");
    expect(g.getByText(/Only affects people who sign in afterwards/)).toBeInTheDocument();
    expect(g.getByText(/Lowering it does not revoke existing tokens/)).toBeInTheDocument();
    expect(g.getAllByRole("group").map((r) => r.getAttribute("data-limit-key"))).toEqual(["sessionTtlSeconds", "apiTokensPerUser"]);
    expect(await screen.findByRole("table", { name: "Sign-in services" })).toBeInTheDocument();
  });

  it("position: after the \"allow self-registration\" switch, before the sign-in service table", async () => {
    renderSection(fakeServer([CUSTOM]).fetchMock);
    const region = await screen.findByRole("region", { name: "Session and tokens" });
    const access = await screen.findByRole("switch", { name: "Allow self-registration with a password" });
    const table = await screen.findByRole("table", { name: "Sign-in services" });
    expect(access.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(region.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("changing to 24 hours and saving -> PATCH sends only the changed item, in seconds", async () => {
    const server = fakeServer([CUSTOM]);
    server.on((method, url) => (method === "PATCH" && url === "/api/admin/limits" ? fakeResponse(200, server.state.limits) : null));
    renderSection(server.fetchMock);
    const g = await group();
    fireEvent.change(g.input("Web sign-in lasts"), { target: { value: "24" } });
    fireEvent.click(g.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches(server)).toHaveLength(1));
    expect(patches(server)[0]!.body).toEqual({ set: { sessionTtlSeconds: 86400 } });
  });

  it("an adjusted token limit has \"Restore default\", pressing it sends null", async () => {
    const server = fakeServer([CUSTOM]);
    server.state.limits = limitsWith("apiTokensPerUser", { value: 5, source: "admin", stored: 5 });
    server.on((method, url) => (method === "PATCH" && url === "/api/admin/limits" ? fakeResponse(200, LIMITS) : null));
    renderSection(server.fetchMock);
    const g = await group();
    expect(g.input("Active API tokens per person")).toHaveValue("5");
    fireEvent.click(g.getByRole("button", { name: "Restore default" }));
    await waitFor(() => expect(patches(server)).toHaveLength(1));
    expect(patches(server)[0]!.body).toEqual({ set: { apiTokensPerUser: null } });
  });

  it("out of range (0 hours) -> not sent, shows a range error", async () => {
    const server = fakeServer([CUSTOM]);
    renderSection(server.fetchMock);
    const g = await group();
    fireEvent.change(g.input("Web sign-in lasts"), { target: { value: "0" } });
    fireEvent.click(g.getByRole("button", { name: "Save" }));
    expect(await g.findByRole("alert")).toHaveTextContent(/Enter a whole number from 1 to 720/);
    expect(patches(server)).toHaveLength(0);
  });

  it("background refetch fails when data already exists: half-typed input and the whole group remain, no switch to an error", async () => {
    const server = fakeServer([CUSTOM]);
    const queryClient = renderSection(server.fetchMock);
    const g = await group();
    fireEvent.change(g.input("Web sign-in lasts"), { target: { value: "24" } });
    server.on((method, url) => (method === "GET" && url === "/api/admin/limits" ? fakeResponse(500, { error: { code: "internal", message: "x" } }) : null));
    await queryClient.refetchQueries({ queryKey: SITE_LIMITS_QUERY_KEY });
    await waitFor(() => expect(queryClient.getQueryState(SITE_LIMITS_QUERY_KEY)?.fetchStatus).toBe("idle"));
    expect(queryClient.getQueryState(SITE_LIMITS_QUERY_KEY)?.status).toBe("error");
    expect(screen.getByRole("region", { name: "Session and tokens" })).toBeInTheDocument();
    expect(g.input("Web sign-in lasts")).toHaveValue("24");
    expect(g.queryByRole("alert")).toBeNull();
  });

  it("zh-TW heading and notes of the sign-in period and token group", async () => {
    await i18n.changeLanguage("zh-TW");
    renderSection(fakeServer([CUSTOM]).fetchMock);
    const region = within(await screen.findByRole("region", { name: "登入期限與 token" }));
    expect(region.getByText(/只影響之後新登入的人/)).toBeInTheDocument();
    expect(region.getByText(/調低不會撤銷既有 token/)).toBeInTheDocument();
  });

  it("load failure: shows the server's error text (same set as the site-limits tab), not the generic message", async () => {
    const server = fakeServer([CUSTOM]);
    server.on((method, url) => (method === "GET" && url === "/api/admin/limits" ? fakeResponse(500, { error: { code: "limit_locked_by_env", message: "x" } }) : null));
    renderSection(server.fetchMock);
    expect(await screen.findByText(i18n.t("errors.limit_locked_by_env"))).toBeInTheDocument();
  });
});

describe("auto-create switch of the service table", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const CUSTOM_PATH = `/api/admin/auth/providers/${CUSTOM.id}`;

  it("each row has a \"Create accounts on first sign-in with <name>\" switch, aria-checked reflects autoCreateEnabled (the name is not treated as HTML)", async () => {
    renderSection(fakeServer([LEGACY, CUSTOM]).fetchMock);
    await screen.findByRole("row", { name: "SSO" });
    expect(row("SSO").getByRole("switch", { name: "Create accounts on first sign-in with SSO" })).toHaveAttribute("aria-checked", "true");
    expect(row("<b>Corp</b> & Co").getByRole("switch", { name: "Create accounts on first sign-in with <b>Corp</b> & Co" })).toHaveAttribute("aria-checked", "false");
  });

  it("clicking the switch of a disabled service -> PATCH exactly {autoCreateEnabled:true}; disabled while submitting; after a successful refetch aria-checked=true; no dialog at all", async () => {
    const server = fakeServer([CUSTOM]);
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    server.on((method, url) => {
      if (method !== "PATCH" || url !== CUSTOM_PATH) return null;
      return gate.then(() => {
        server.state.providers = [{ ...CUSTOM, autoCreateEnabled: true }];
        return fakeResponse(200, server.state.providers[0]);
      });
    });
    renderSection(server.fetchMock);
    const custom = within(await screen.findByRole("row", { name: "<b>Corp</b> & Co" }));
    const sw = custom.getByRole("switch", { name: "Create accounts on first sign-in with <b>Corp</b> & Co" });
    expect(CUSTOM.enabled).toBe(false);
    expect(sw).not.toBeDisabled();
    fireEvent.click(sw);
    await waitFor(() => expect(sw).toBeDisabled());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    release();
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    expect(sw).not.toBeDisabled();
    const patches = server.calls.filter(c => c.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]!.url).toBe(CUSTOM_PATH);
    expect(patches[0]!.body).toEqual({ autoCreateEnabled: true });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("PATCH returns 500 -> toast shows the error text, the switch stays aria-checked=false", async () => {
    const server = fakeServer([CUSTOM]);
    server.on((method, url) =>
      method === "PATCH" && url === CUSTOM_PATH ? fakeResponse(500, { error: { code: "internal", message: "x" } }) : null,
    );
    renderSection(server.fetchMock);
    const custom = within(await screen.findByRole("row", { name: "<b>Corp</b> & Co" }));
    const sw = custom.getByRole("switch", { name: "Create accounts on first sign-in with <b>Corp</b> & Co" });
    fireEvent.click(sw);
    expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();
    expect(sw).toHaveAttribute("aria-checked", "false");
  });

  it("the service group description (full en text) is visible", async () => {
    renderSection(fakeServer([LEGACY]).fetchMock);
    expect(
      await screen.findByText(
        "When Creates accounts is on, anyone who can sign in to that identity provider and whose email has no account here yet gets one the first time they sign in. Keep it off for providers anyone can sign up at, such as Google or gitlab.com.",
      ),
    ).toBeInTheDocument();
  });
});

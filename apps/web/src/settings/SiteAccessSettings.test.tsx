import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AdminAuthSettingsDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { SiteAccessSettings } from "./SiteAccessSettings";

function fakeResponse(status: number, body?: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: body === undefined ? () => Promise.reject(new Error("no body")) : () => Promise.resolve(body) } as unknown as Response;
}
const BASE: AdminAuthSettingsDto = {
  registrationEnabled: true,
  passwordLoginEnabled: true,
  passwordLoginForced: false,
  passwordLoginImpact: { usersWithoutSso: 3, actingAdminHasSso: true, enabledProviders: 1 },
};

function setup(initial: AdminAuthSettingsDto, onPatch: (body: Record<string, boolean>) => Response | AdminAuthSettingsDto) {
  const state = { settings: initial, failGets: false };
  const patches: Array<Record<string, boolean>> = [];
  const gets: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/admin/auth/settings" && method === "GET") {
      gets.push(url);
      if (state.failGets) return fakeResponse(500, { error: { code: "internal", message: "x" } });
      return fakeResponse(200, state.settings);
    }
    if (url === "/api/admin/auth/settings" && method === "PATCH") {
      const body = JSON.parse(String(init!.body));
      patches.push(body);
      const r = onPatch(body);
      if (typeof (r as Response).status === "number" && "ok" in r) return r as Response;
      state.settings = r as AdminAuthSettingsDto;
      return fakeResponse(200, state.settings);
    }
    if (url === "/api/auth/config") return fakeResponse(200, { providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: true } });
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SiteAccessSettings />
      <Toaster />
    </QueryClientProvider>,
  );
  return { patches, gets, state };
}
const pwSwitch = () => screen.getByRole("switch", { name: "Allow password sign-in" });

describe("SiteAccessSettings (#187)", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); dismissAllToasts(); });
  afterEach(() => vi.unstubAllGlobals());

  it("registration switch: toggling PATCHes {registrationEnabled} (description beside it)", async () => {
    const { patches } = setup(BASE, body => ({ ...BASE, ...body }));
    const sw = await screen.findByRole("switch", { name: "Allow self-registration with a password" });
    expect(screen.getByText("Anyone can create an account on the registration page with an email and a password. Whether a sign-in service creates accounts is set for each service below. Invitations created by an admin work either way.")).toBeInTheDocument();
    fireEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "false"));
    expect(patches).toEqual([{ registrationEnabled: false }]);
  });

  it("group title, order of the two switches (password sign-in first, then self-registration) and descriptions", async () => {
    setup(BASE, () => BASE);
    await screen.findByRole("switch", { name: "Allow password sign-in" });
    expect(screen.getByText("Password sign-in and registration")).toBeInTheDocument();
    const password = screen.getByRole("switch", { name: "Allow password sign-in" });
    const registration = screen.getByRole("switch", { name: "Allow self-registration with a password" });
    expect(screen.getAllByRole("switch")).toEqual([password, registration]);
    expect(screen.getByText("Anyone can create an account on the registration page with an email and a password. Whether a sign-in service creates accounts is set for each service below. Invitations created by an admin work either way.")).toBeInTheDocument();
  });

  it("password effectively off -> the self-registration switch stays operable, the visible description is linked to the switch via aria-describedby, clicking PATCHes {registrationEnabled:false}", async () => {
    const { patches } = setup({ ...BASE, passwordLoginEnabled: false, passwordLoginForced: false }, body => ({ ...BASE, passwordLoginEnabled: false, ...body }));
    const sw = await screen.findByRole("switch", { name: "Allow self-registration with a password" });
    expect(sw).not.toBeDisabled();
    expect(sw).toHaveAccessibleDescription("Has no effect while password sign-in is off.");
    expect(screen.getByText("Has no effect while password sign-in is off.")).toBeVisible();
    fireEvent.click(sw);
    await waitFor(() => expect(patches).toEqual([{ registrationEnabled: false }]));
  });

  it.each([
    ["password on", { passwordLoginEnabled: true, passwordLoginForced: false }],
    ["password off in DB but forced on by env", { passwordLoginEnabled: false, passwordLoginForced: true }],
  ])("%s -> no ineffective-setting note, the switch has no accessible description", async (_label, patch) => {
    setup({ ...BASE, ...patch }, () => BASE);
    const sw = await screen.findByRole("switch", { name: "Allow self-registration with a password" });
    expect(screen.queryByText("Has no effect while password sign-in is off.")).not.toBeInTheDocument();
    expect(sw).not.toHaveAccessibleDescription();
  });

  it("after a successful PATCH settings are refetched (invalidate)", async () => {
    const { gets } = setup(BASE, body => ({ ...BASE, ...body }));
    const sw = await screen.findByRole("switch", { name: "Allow self-registration with a password" });
    expect(gets).toHaveLength(1);
    fireEvent.click(sw);
    await waitFor(() => expect(gets).toHaveLength(2));
  });

  it("turning off password sign-in -> opens a confirm dialog first showing usersWithoutSso (no PATCH sent); confirm -> PATCH {passwordLoginEnabled:false}", async () => {
    const { patches } = setup(BASE, body => ({ ...BASE, ...body }));
    fireEvent.click(await screen.findByRole("switch", { name: "Allow password sign-in" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Turn off password sign-in?" }));
    expect(dialog.getByText("Accounts with no usable sign-in service: 3")).toBeInTheDocument();
    expect(patches).toEqual([]);
    fireEvent.click(dialog.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(pwSwitch()).toHaveAttribute("aria-checked", "false"));
    expect(patches).toEqual([{ passwordLoginEnabled: false }]);
  });

  it("turning on password sign-in: PATCH true directly, no dialog", async () => {
    const { patches } = setup({ ...BASE, passwordLoginEnabled: false }, body => ({ ...BASE, ...body }));
    fireEvent.click(await screen.findByRole("switch", { name: "Allow password sign-in" }));
    await waitFor(() => expect(patches).toEqual([{ passwordLoginEnabled: true }]));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each([
    [{ enabledProviders: 0, actingAdminHasSso: true, usersWithoutSso: 0 }, "Turn on at least one sign-in service first."],
    [{ enabledProviders: 1, actingAdminHasSso: false, usersWithoutSso: 0 }, "Link a sign-in service in your own settings first."],
  ])("on but can't be turned off (%o) -> switch disabled + reason (aria-describedby)", async (impact, reason) => {
    setup({ ...BASE, passwordLoginImpact: impact }, () => BASE);
    const sw = await screen.findByRole("switch", { name: "Allow password sign-in" });
    expect(sw).toBeDisabled();
    expect(document.getElementById(sw.getAttribute("aria-describedby")!)).toHaveTextContent(reason);
  });

  it("when it can be turned off (an enabled provider exists, and the user has SSO) -> the switch is operable, no reason text", async () => {
    setup(BASE, () => BASE);
    const sw = await screen.findByRole("switch", { name: "Allow password sign-in" });
    expect(sw).not.toBeDisabled();
    expect(sw).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByText("Turn on at least one sign-in service first.")).not.toBeInTheDocument();
    expect(screen.queryByText("Link a sign-in service in your own settings first.")).not.toBeInTheDocument();
  });

  it("password sign-in already off: not disabled even when enabledProviders=0 (it must be possible to turn it back on)", async () => {
    setup({ ...BASE, passwordLoginEnabled: false, passwordLoginImpact: { enabledProviders: 0, actingAdminHasSso: false, usersWithoutSso: 0 } }, () => BASE);
    const sw = await screen.findByRole("switch", { name: "Allow password sign-in" });
    expect(sw).not.toBeDisabled();
    expect(sw).toHaveAttribute("aria-checked", "false");
  });

  it("passwordLoginForced -> a warning at the top; the switch is still operable", async () => {
    setup({ ...BASE, passwordLoginForced: true, passwordLoginEnabled: false }, body => ({ ...BASE, ...body }));
    expect(await screen.findByText(/forced on by the environment variable PASSWORD_LOGIN_FORCE_ENABLE/)).toBeInTheDocument();
    expect(screen.getByText("Password sign-in is forced on by the environment variable PASSWORD_LOGIN_FORCE_ENABLE. The Allow password sign-in setting below takes effect only after you remove that variable and restart.")).toBeInTheDocument();
    expect(pwSwitch()).not.toBeDisabled();
  });

  it("no forced -> no environment variable warning", async () => {
    setup(BASE, () => BASE);
    await screen.findByRole("switch", { name: "Allow password sign-in" });
    expect(screen.queryByText(/PASSWORD_LOGIN_FORCE_ENABLE/)).not.toBeInTheDocument();
  });

  it("the forced warning is role=status (not alert: a static note present when the page loads shouldn't interrupt screen readers)", async () => {
    setup({ ...BASE, passwordLoginForced: true, passwordLoginEnabled: false }, body => ({ ...BASE, ...body }));
    const warning = await screen.findByText(/forced on by the environment variable PASSWORD_LOGIN_FORCE_ENABLE/);
    expect(warning).toHaveAttribute("role", "status");
  });

  it("refetch fails when data already exists: the switch and an open confirm dialog stay, not replaced by error text", async () => {
    const { state, gets } = setup(BASE, () => BASE);
    const sw = await screen.findByRole("switch", { name: "Allow password sign-in" });
    state.failGets = true;
    fireEvent.click(sw);
    await screen.findByRole("dialog", { name: "Turn off password sign-in?" });
    await waitFor(() => expect(gets).toHaveLength(2));
    // Let the failed refetch settle (the query enters isError) before asserting.
    await new Promise(r => setTimeout(r, 50));
    expect(screen.getByRole("dialog", { name: "Turn off password sign-in?" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Allow password sign-in", hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("refetching while the confirm dialog opens: the count is the one at the time the dialog opened (the server value changed after the page loaded)", async () => {
    const { state, gets } = setup(BASE, () => BASE);
    const sw = await screen.findByRole("switch", { name: "Allow password sign-in" });
    state.settings = { ...BASE, passwordLoginImpact: { ...BASE.passwordLoginImpact, usersWithoutSso: 7 } };
    fireEvent.click(sw);
    const dialog = within(await screen.findByRole("dialog", { name: "Turn off password sign-in?" }));
    expect(await dialog.findByText("Accounts with no usable sign-in service: 7")).toBeInTheDocument();
    expect(gets).toHaveLength(2);
  });

  it("after a 409 settings are refetched: the snapshot is stale -> the second GET returns actingAdminHasSso:false, the reason text appears and the switch becomes disabled", async () => {
    const { state, gets } = setup(BASE, () => {
      state.settings = { ...BASE, passwordLoginImpact: { ...BASE.passwordLoginImpact, actingAdminHasSso: false } };
      return fakeResponse(409, { error: { code: "admin_sso_link_required", message: "x" } });
    });
    const sw = await screen.findByRole("switch", { name: "Allow password sign-in" });
    expect(sw).not.toBeDisabled();
    fireEvent.click(sw);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Turn off" }));
    expect(await screen.findByText("Link a sign-in service in your own settings first.")).toBeInTheDocument();
    expect(pwSwitch()).toBeDisabled();
    expect(pwSwitch()).toHaveAttribute("aria-checked", "true");
    expect(gets.length).toBeGreaterThanOrEqual(3);
  });

  it("409 -> toast error text, the switch stays as it was", async () => {
    setup(BASE, () => fakeResponse(409, { error: { code: "admin_sso_link_required", message: "x" } }));
    fireEvent.click(await screen.findByRole("switch", { name: "Allow password sign-in" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Turn off" }));
    expect(await screen.findByText(/before turning off password sign-in/)).toBeInTheDocument();
    expect(pwSwitch()).toHaveAttribute("aria-checked", "true");
  });
});

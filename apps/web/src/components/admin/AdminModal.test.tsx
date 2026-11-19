import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, type Location } from "react-router";
import type { SiteLimitsDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { ThemeProvider } from "@/theme";
import { AppRoutes } from "@/App";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

// Site admin modal (`/admin/*`, #247): the real `AppRoutes`, so guard chaining, the two route trees and the layout route are checked as wired.

function fakeResponse(status: number, body?: unknown): Response {
  return { ok: status < 400, status, json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)) } as unknown as Response;
}

const ADMIN_USER: UserDto = { id: "u-admin", email: "admin@example.com", handle: "admin", displayName: "Admin", isAdmin: true, mustChangePassword: false, hasPassword: true, autoVersions: true, avatar: null };
const PLAIN_USER: UserDto = { ...ADMIN_USER, id: "u-plain", handle: "plain", displayName: "Plain", isAdmin: false };
const BG = { pathname: "/n/admin/some-note", search: "", hash: "", state: null, key: "bg1" } as Location;
/** The site limits page is only checked for "clicking swaps in that section", so it needs no items. */
const SITE_LIMITS_EMPTY: SiteLimitsDto = { items: [], machine: { cpus: 2, cpuSource: "os", memoryBytes: 2 * 1024 ** 3, memorySource: "os" }, changes: [] };

function mockFetch(getUser: () => UserDto | null) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/auth/me" && method === "GET") {
      const user = getUser();
      return Promise.resolve(user ? fakeResponse(200, user) : fakeResponse(401, { error: { code: "unauthorized", message: "no" } }));
    }
    if (url === "/api/auth/config" && method === "GET") {
      return Promise.resolve(fakeResponse(200, { providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: true }, autoVersionsEnabled: true }));
    }
    if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
    if ((url === "/api/groups" || url === "/api/notes" || url === "/api/admin/users" || url === "/api/admin/invites" || url === "/api/admin/groups") && method === "GET") {
      return Promise.resolve(fakeResponse(200, []));
    }
    if (url === "/api/admin/storage-plans" && method === "GET") return Promise.resolve(fakeResponse(200, { plans: [], defaults: { userPlanId: "", groupPlanId: "" } }));
    if (url === "/api/admin/versions/settings" && method === "GET") return Promise.resolve(fakeResponse(200, { keepAllDays: 7, dailyUntilDays: 30, autoVersionsEnabled: true, autoWaitMinutes: 5 }));
    if (url === "/api/admin/trash/settings" && method === "GET") return Promise.resolve(fakeResponse(200, { retentionDays: 7 }));
    if (url === "/api/admin/limits" && method === "GET") return Promise.resolve(fakeResponse(200, SITE_LIMITS_EMPTY));
    if (url.startsWith("/api/admin/ai/") && method === "GET") {
      const key = url.slice("/api/admin/ai/".length);
      return Promise.resolve(fakeResponse(200, { [key]: [] }));
    }
    if (url === "/api/admin/auth/providers" && method === "GET") return Promise.resolve(fakeResponse(200, { providers: [] }));
    if (url === "/api/admin/auth/settings" && method === "GET") {
      return Promise.resolve(
        fakeResponse(200, {
          registrationEnabled: true,
          passwordLoginEnabled: true,
          passwordLoginForced: false,
          passwordLoginImpact: { usersWithoutSso: 0, actingAdminHasSso: true, enabledProviders: 1 },
        }),
      );
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}|${JSON.stringify(location.state)}`}</div>;
}
const path = () => (screen.getByTestId("location").textContent ?? "").split("|")[0];

function renderAt(entry: string | { pathname: string; state?: unknown }, fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <ActiveNoteProvider>
            <AppRoutes />
            <LocationProbe />
          </ActiveNoteProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

/**
 * Negative criterion for "no flash of the settings panel": any `[role=dialog]` mounted during the redirect must not have the settings
 * panel title "Settings" as accessible name (the `DialogTitle` text `aria-labelledby` points to). It only records and does not require the
 * name to equal the destination (the group modal first shows a fallback title). Records `addedNodes` (with descendants) rather than
 * querying in the callback: a flashing node may be removed before the callback runs. The title is also looked up inside the added
 * subtree first (`getElementById` does not find nodes already detached from the document).
 */
function watchDialogTitles() {
  const titles = new Set<string>();
  const titleOf = (dialog: Element): string => {
    const labelId = dialog.getAttribute("aria-labelledby");
    if (!labelId) return "";
    const inSubtree = [...dialog.querySelectorAll("[id]")].find((el) => el.id === labelId);
    return (inSubtree ?? document.getElementById(labelId))?.textContent ?? "";
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        const dialogs = node.matches('[role="dialog"]') ? [node] : [];
        dialogs.push(...node.querySelectorAll('[role="dialog"]'));
        for (const dialog of dialogs) titles.add(titleOf(dialog));
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
  return { titles, stop: () => observer.disconnect() };
}

describe("AdminModal (/admin/*, #247)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("six items (nav accessible name Site admin): Users/Groups/Sign-in/Storage plans/AI agents/Site limits; no \"Back to notes\"; /admin/users is aria-current", async () => {
    renderAt("/admin/users", mockFetch(() => ADMIN_USER));
    const dialog = await screen.findByRole("dialog", { name: "Site admin" });
    const nav = within(dialog).getByRole("navigation", { name: "Site admin" });
    expect(within(nav).getAllByRole("link").map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["Users", "/admin/users"],
      ["Groups", "/admin/groups"],
      ["Sign-in", "/admin/login"],
      ["Storage plans", "/admin/storage"],
      ["AI agents", "/admin/ai"],
      ["Site limits", "/admin/limits"],
    ]);
    expect(within(nav).getByRole("link", { name: "Users" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link", { name: "Back to notes" })).not.toBeInTheDocument();
    expect(await within(dialog).findByRole("heading", { level: 1, name: "User management" })).toBeInTheDocument();
  });

  it.each([
    ["/admin", "/admin/users"],
    ["/admin/auth", "/admin/login"],
    ["/admin/versions", "/admin/storage"],
    ["/admin/xyz", "/admin/users"],
  ])("redirects %s -> %s (outside AdminModal, inside RequireAdmin)", async (from, to) => {
    renderAt(from, mockFetch(() => ADMIN_USER));
    await waitFor(() => expect(path()).toBe(to));
    expect(await screen.findByRole("dialog", { name: "Site admin" })).toBeInTheDocument();
  });

  it("guard: non-admin deep link /admin/ai -> / (no admin API calls, no site modal); signed out -> /login?next=%2Fadmin%2Fai; admin with mustChangePassword -> /change-password", async () => {
    const plain = mockFetch(() => PLAIN_USER);
    const v1 = renderAt("/admin/ai", plain);
    await waitFor(() => expect(path()).toBe("/"));
    await waitFor(() => expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument());
    expect(screen.queryByRole("dialog", { name: "Site admin" })).not.toBeInTheDocument();
    expect(plain.mock.calls.some(([input]) => String(input).startsWith("/api/admin/"))).toBe(false);
    v1.unmount();
    vi.unstubAllGlobals();

    const v2 = renderAt("/admin/ai", mockFetch(() => null));
    await waitFor(() => expect(path()).toBe("/login?next=%2Fadmin%2Fai"));
    v2.unmount();
    vi.unstubAllGlobals();

    renderAt("/admin/users", mockFetch(() => ({ ...ADMIN_USER, mustChangePassword: true })));
    await waitFor(() => expect(path()).toBe("/change-password"));
  });

  it("background: deep link /admin/users leaves the main tree on the /* HomePage (New note in the background); Esc -> /", async () => {
    renderAt("/admin/users", mockFetch(() => ADMIN_USER));
    const dialog = await screen.findByRole("dialog", { name: "Site admin" });
    expect(screen.getByRole("button", { name: "New note", hidden: true })).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(path()).toBe("/"));
  });

  it.each([["/settings/users"], ["/admin"], ["/admin/auth"], ["/admin/versions"]])(
    "redirect from %s to the site modal does not flash the settings panel (no dialog mounted midway ever has the title Settings)",
    async (from) => {
      const watcher = watchDialogTitles();
      try {
        renderAt(from, mockFetch(() => ADMIN_USER));
        await screen.findByRole("dialog", { name: "Site admin" });
        await waitFor(() => expect(path().startsWith("/admin/")).toBe(true));
        expect([...watcher.titles]).not.toContain("Settings");
        expect([...watcher.titles]).toContain("Site admin");
      } finally {
        watcher.stop();
      }
    },
  );

  it("opens with backgroundLocation -> state survives switching items -> the close button returns to the background page", async () => {
    renderAt({ pathname: "/admin/users", state: { backgroundLocation: BG } }, mockFetch(() => ADMIN_USER));
    const dialog = await screen.findByRole("dialog", { name: "Site admin" });
    fireEvent.click(within(within(dialog).getByRole("navigation", { name: "Site admin" })).getByRole("link", { name: "Groups" }));
    await waitFor(() => expect(path()).toBe("/admin/groups"));
    expect(JSON.parse((screen.getByTestId("location").textContent ?? "").split("|")[1])).toEqual({ backgroundLocation: BG });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(path()).toBe(BG.pathname));
  });

  it("each item's content: clicking Groups/Sign-in/Storage plans/AI agents/Site limits swaps in that section (h1)", async () => {
    renderAt("/admin/users", mockFetch(() => ADMIN_USER));
    const dialog = await screen.findByRole("dialog", { name: "Site admin" });
    const nav = within(within(dialog).getByRole("navigation", { name: "Site admin" }));
    for (const [link, url, heading] of [
      ["Groups", "/admin/groups", "Groups"],
      ["Sign-in", "/admin/login", "Sign-in"],
      ["Storage plans", "/admin/storage", "Storage plans"],
      ["AI agents", "/admin/ai", "AI providers & actions"],
      ["Site limits", "/admin/limits", "Site limits"],
    ] as const) {
      fireEvent.click(nav.getByRole("link", { name: link }));
      await waitFor(() => expect(path()).toBe(url));
      expect(await within(dialog).findByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
    }
  });

  it("the \"Storage plans\" page has the plan table, the version master switch and the retention policy form", async () => {
    renderAt("/admin/storage", mockFetch(() => ADMIN_USER));
    const dialog = await screen.findByRole("dialog", { name: "Site admin" });
    expect(await within(dialog).findByRole("heading", { level: 1, name: "Storage plans" })).toBeInTheDocument();
    expect(await within(dialog).findByRole("switch", { name: "Automatic versions" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Keep all for (days)")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "New plan" })).toBeInTheDocument();
  });
});

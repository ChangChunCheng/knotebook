import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import type { AdminGroupDto, StoragePlanDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";
import { useAssignGroupPlan } from "@/api/adminStorage";
import { ADMIN_GROUPS_QUERY_KEY, ADMIN_STORAGE_PLANS_QUERY_KEY, STORAGE_USAGE_QUERY_KEY, groupStorageKey } from "@/api/storage";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { chooseOption, displayedLabel, optionLabels, selectedValue } from "@/test/ui-select";

// /admin/groups. Group names are always plain text (the site admin manages plans, doesn't see group members or details).

function res(status: number, body?: unknown): Response {
  return { ok: status < 400, status, json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)) } as unknown as Response;
}
const ADMIN: UserDto = { id: "u-admin", email: "admin@example.com", handle: "admin", displayName: "Admin", isAdmin: true, mustChangePassword: false, hasPassword: true, autoVersions: true, avatar: null };
const T = "2026-01-01T00:00:00.000Z";
const BASIC_ID = "11111111-1111-4111-8111-111111111111";
const TIGHT_ID = "44444444-4444-4444-8444-444444444444";
const planDto = (id: string, name: string, quotaBytes: number | null): StoragePlanDto => ({
  id, name, quotaBytes, userCount: 0, groupCount: 1, overQuotaCount: 0, isDefaultForUsers: false, isDefaultForGroups: false, createdAt: T, updatedAt: T,
});
const PLANS = { plans: [planDto(BASIC_ID, "Basic", 2147483648), planDto(TIGHT_ID, "Tight", 2 * 1048576)], defaults: { userPlanId: BASIC_ID, groupPlanId: BASIC_ID } };
const ALPHA: AdminGroupDto = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Alpha", createdAt: T, memberCount: 3, storage: { planId: BASIC_ID, planName: "Basic", usedBytes: 1048576, quotaBytes: 2147483648 } };
const BETA: AdminGroupDto = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Beta", createdAt: T, memberCount: 1, storage: { planId: TIGHT_ID, planName: "Tight", usedBytes: 3 * 1048576, quotaBytes: 2 * 1048576 } };

type Handler = (url: string, method: string, init?: RequestInit) => Response | Promise<Response> | null;
function renderGroups(rows: AdminGroupDto[], extra: Handler = () => null) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const custom = extra(url, method, init);
    if (custom) return Promise.resolve(custom);
    if (url === "/api/auth/me") return Promise.resolve(res(200, ADMIN));
    if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
    if (url === "/api/notes") return Promise.resolve(res(200, []));
    if (url === "/api/groups" && method === "GET") return Promise.resolve(res(200, []));
    if (url === "/api/admin/groups" && method === "GET") return Promise.resolve(res(200, rows));
    if (url === "/api/admin/storage-plans" && method === "GET") return Promise.resolve(res(200, PLANS));
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/admin/groups"]}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
      <Toaster />
    </QueryClientProvider>,
  );
  return fetchMock;
}
/** Waits for that row's plan dropdown (= the plan list has arrived), then finds the row by row name (= group name). */
const rowByDropdown = async (name: string) => {
  await screen.findByRole("combobox", { name: `Storage plan for ${name}` });
  return screen.getByRole("row", { name });
};
/** For when the plan list failed and there is no dropdown to wait on. */
const rowByName = (name: string) => screen.getByRole("row", { name });
const requested = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map(([u, i]) => `${((i as RequestInit | undefined)?.method ?? "GET").toUpperCase()} ${String(u)}`);
const PLANS_URL = "/api/admin/storage-plans";
const plansGets = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([u, i]) => String(u) === PLANS_URL && (((i as RequestInit | undefined)?.method ?? "GET").toUpperCase() === "GET")).length;
const patchUrl = (g: AdminGroupDto) => `/api/admin/groups/${g.id}/storage-plan`;
/** Lets in-flight promises and react-query notifications land; use before negative assertions. */
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

describe("/admin/groups", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); dismissAllToasts(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("each row: name, member count, creation time, usage (over-limit warning color), plan dropdown", async () => {
    renderGroups([ALPHA, BETA]);
    expect(await screen.findByRole("heading", { level: 1, name: "Groups" })).toBeInTheDocument();
    const beta = await rowByDropdown("Beta");
    for (const text of ["Beta", "1", new Date(T).toLocaleDateString("en"), "3 MB of 2 MB"]) {
      expect(within(beta).getByRole("cell", { name: text })).toBeInTheDocument();
    }
    expect(within(beta).getByText("3 MB of 2 MB")).toHaveClass("text-destructive");
    expect(selectedValue(within(beta).getByRole("combobox", { name: "Storage plan for Beta" }))).toBe(TIGHT_ID);
    expect(within(await rowByDropdown("Alpha")).getByText("1 MB of 2 GB")).not.toHaveClass("text-destructive");
  });

  it("table name Groups, column names Name / Members / Created / Storage / Plan", async () => {
    renderGroups([ALPHA, BETA]);
    const table = await screen.findByRole("table", { name: "Groups" });
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Name", "Members", "Created", "Storage", "Plan"]);
  });

  it("group names are always plain text, and no member / role / group-usage endpoint is called", async () => {
    const fetchMock = renderGroups([ALPHA, BETA]);
    for (const g of [ALPHA, BETA]) {
      // Locate rows by the dropdown: its presence means the plan list has arrived and all of this page's queries have landed; if the name cell were to become a link, it would be one by now
      const row = await rowByDropdown(g.name);
      const nameCell = within(row).getByRole("cell", { name: g.name });
      expect(nameCell).toHaveTextContent(g.name);
      expect(within(nameCell).queryByRole("link")).toBeNull();
    }
    await flush();
    // The background HomePage (site admin is a modal over the home page) sidebar loads "my groups" (`GET /api/groups`) and the note list, but they're stubbed to empty arrays,
    // so the sidebar has no groups; this page itself calls only the two admin endpoints below - with no member / role / group-usage endpoint, the group name has no reason to become a link.
    expect([...new Set(requested(fetchMock))].filter((r) => r.includes(" /api/admin/")).sort()).toEqual(["GET /api/admin/groups", "GET /api/admin/storage-plans"]);
    expect(requested(fetchMock).some((r) => /\/api\/groups\/[^/]+\/(members|roles|storage)$/.test(r))).toBe(false);
  });

  it("same-named groups: each row's dropdown uses aria-describedby pointing to that row's creation time cell (id based on the group id), so the descriptions tell them apart", async () => {
    const OLDER: AdminGroupDto = { ...ALPHA, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", createdAt: "2025-03-04T12:00:00.000Z" };
    renderGroups([ALPHA, OLDER]);
    const selects = await screen.findAllByRole("combobox", { name: "Storage plan for Alpha" });
    expect(selects).toHaveLength(2);
    expect(selects[0]).toHaveAccessibleDescription(new Date(T).toLocaleDateString("en"));
    expect(selects[1]).toHaveAccessibleDescription(new Date(OLDER.createdAt).toLocaleDateString("en"));
    expect(selects[0]!.getAttribute("aria-describedby")).not.toBe(selects[1]!.getAttribute("aria-describedby"));
  });

  it("changing the plan: PATCH {planId}; on success the dropdown and usage cell switch to the new plan, the plan list (member counts) is refetched, personal usage /api/storage isn't touched", async () => {
    const updated: AdminGroupDto = { ...BETA, storage: { planId: BASIC_ID, planName: "Basic", usedBytes: 3 * 1048576, quotaBytes: 2147483648 } };
    const fetchMock = renderGroups([BETA], (url, method) => (url === patchUrl(BETA) && method === "PATCH" ? res(200, updated) : null));
    const select = await screen.findByRole("combobox", { name: "Storage plan for Beta" });
    await chooseOption(select, "Basic");
    await waitFor(() => expect(selectedValue(select)).toBe(BASIC_ID));
    const patch = fetchMock.mock.calls.find(([u, i]) => String(u) === patchUrl(BETA) && (i as RequestInit).method === "PATCH");
    expect(JSON.parse(String((patch![1] as RequestInit).body))).toEqual({ planId: BASIC_ID });
    expect(screen.getByText("3 MB of 2 GB")).not.toHaveClass("text-destructive");
    // The plan list is refetched after success; this wait is also the wait point for the negative assertions below.
    await waitFor(() => expect(plansGets(fetchMock)).toBeGreaterThanOrEqual(2));
    await flush();
    expect(fetchMock.mock.calls.some(([u]) => String(u) === "/api/storage")).toBe(false);
    // The group list itself isn't refetched (setQueryData already replaced the row), so exactly one GET.
    expect(fetchMock.mock.calls.filter(([u, i]) => String(u) === "/api/admin/groups" && (((i as RequestInit | undefined)?.method ?? "GET") === "GET")).length).toBe(1);
  });

  it("while saving (PATCH not returned): the dropdown is disabled and shows the just-chosen plan, doesn't jump back to the old plan", async () => {
    renderGroups([BETA], (url, method) => (url === patchUrl(BETA) && method === "PATCH" ? (new Promise(() => undefined) as unknown as Promise<Response>) : null));
    const select = await screen.findByRole("combobox", { name: "Storage plan for Beta" });
    await chooseOption(select, "Basic");
    await waitFor(() => expect(select).toBeDisabled());
    expect(selectedValue(select)).toBe(BASIC_ID);
    expect(displayedLabel(select)).toBe("Basic");
  });

  it("plan change failure (404 group_not_found, the group was just deleted) -> toast, the dropdown stays on the original plan, the plan list is refetched", async () => {
    const fetchMock = renderGroups([BETA], (url, method) =>
      url === patchUrl(BETA) && method === "PATCH" ? res(404, { error: { code: "group_not_found", message: "x" } }) : null);
    const select = await screen.findByRole("combobox", { name: "Storage plan for Beta" });
    await chooseOption(select, "Basic");
    expect(await screen.findByText("We couldn't find that group.")).toBeInTheDocument();
    await waitFor(() => expect(selectedValue(select)).toBe(TIGHT_ID));
    expect(select).not.toBeDisabled();
    await waitFor(() => expect(plansGets(fetchMock)).toBeGreaterThanOrEqual(2));
  });

  it("a row's plan isn't in the list -> the dropdown still shows that plan (adds an option), not the first in the list", async () => {
    const NEWPLAN_ID = "99999999-9999-4999-8999-999999999999";
    const row: AdminGroupDto = { ...ALPHA, storage: { planId: NEWPLAN_ID, planName: "Brand new", usedBytes: 0, quotaBytes: 1048576 } };
    renderGroups([row]);
    const select = await screen.findByRole("combobox", { name: "Storage plan for Alpha" });
    await waitFor(() => expect(selectedValue(select)).toBe(NEWPLAN_ID));
    expect(displayedLabel(select)).toBe("Brand new");
    expect(await optionLabels(select)).toContain("Brand new");
  });

  it("plan list failure: the plan column shows only the plan name, no dropdown", async () => {
    const fetchMock = renderGroups([ALPHA], (url, method) => (url === PLANS_URL && method === "GET" ? res(500, { error: { code: "internal", message: "x" } }) : null));
    expect(await screen.findByRole("cell", { name: "Alpha" })).toBeInTheDocument();
    // Wait point: while the list is pending plans is also undefined and "no dropdown" is always true - first wait for the request to actually go out, then let the failure land
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u) === PLANS_URL)).toBe(true));
    await flush();
    expect(screen.queryByRole("combobox", { name: "Storage plan for Alpha" })).not.toBeInTheDocument();
    expect(within(rowByName("Alpha")).getByText("Basic")).toBeInTheDocument();
  });

  it("group list load failure -> error row (role=alert), no table", async () => {
    renderGroups([], (url, method) => (url === "/api/admin/groups" && method === "GET" ? res(500, { error: { code: "internal", message: "x" } }) : null));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("no groups -> \"No groups yet.\"", async () => {
    renderGroups([]);
    expect(await screen.findByText("No groups yet.")).toBeInTheDocument();
  });
});

describe("cache invalidation of useAssignGroupPlan", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function setup(patchResponse: () => Response) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(patchResponse())));
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    client.setQueryData(ADMIN_GROUPS_QUERY_KEY, [ALPHA, BETA]);
    client.setQueryData(ADMIN_STORAGE_PLANS_QUERY_KEY, PLANS);
    client.setQueryData(STORAGE_USAGE_QUERY_KEY, { sentinel: true });
    client.setQueryData(groupStorageKey(BETA.id), { sentinel: true });
    client.setQueryData(groupStorageKey(ALPHA.id), { sentinel: true });
    return { client, ...renderHook(() => useAssignGroupPlan(), { wrapper }) };
  }
  const invalidated = (client: QueryClient, key: readonly unknown[]) => client.getQueryState(key)!.isInvalidated;

  it("success: replaces that row, invalidates the plan list and that group's usage key; doesn't invalidate personal usage, other groups or the group list", async () => {
    const updated: AdminGroupDto = { ...BETA, storage: { planId: BASIC_ID, planName: "Basic", usedBytes: 3 * 1048576, quotaBytes: 2147483648 } };
    const { client, result } = setup(() => res(200, updated));
    await act(async () => { await result.current.mutateAsync({ groupId: BETA.id, planId: BASIC_ID }); });
    expect(client.getQueryData<AdminGroupDto[]>(ADMIN_GROUPS_QUERY_KEY)).toEqual([ALPHA, updated]);
    expect(invalidated(client, ADMIN_STORAGE_PLANS_QUERY_KEY)).toBe(true);
    expect(invalidated(client, groupStorageKey(BETA.id))).toBe(true);
    expect(invalidated(client, STORAGE_USAGE_QUERY_KEY)).toBe(false);
    expect(invalidated(client, groupStorageKey(ALPHA.id))).toBe(false);
    expect(invalidated(client, ADMIN_GROUPS_QUERY_KEY)).toBe(false);
  });

  it("failure: rows untouched, only the plan list is invalidated", async () => {
    const { client, result } = setup(() => res(404, { error: { code: "storage_plan_not_found", message: "x" } }));
    await act(async () => { await result.current.mutateAsync({ groupId: BETA.id, planId: BASIC_ID }).catch(() => undefined); });
    expect(client.getQueryData<AdminGroupDto[]>(ADMIN_GROUPS_QUERY_KEY)).toEqual([ALPHA, BETA]);
    expect(invalidated(client, ADMIN_STORAGE_PLANS_QUERY_KEY)).toBe(true);
    expect(invalidated(client, groupStorageKey(BETA.id))).toBe(false);
    expect(invalidated(client, STORAGE_USAGE_QUERY_KEY)).toBe(false);
  });
});

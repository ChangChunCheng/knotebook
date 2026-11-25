import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { ONLINE_WINDOW_MS, avatarUrl, type AdminInviteDto, type StoragePlanDto, type UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { clickOutside } from "@/test/outside-click";
import { chooseOption, displayedLabel, optionLabels, selectedValue } from "@/test/ui-select";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";
import type { AdminUserDto } from "@/api/admin";
import { copyText } from "@/lib/clipboard";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => true) }));

// Cases here query headings / rows directly and don't depend on the shell; only the shell smoke case does.
// - `/api/notes` and `/api/groups` in the fetch mock: the site admin modal sits over the main tree's background `HomePage`,
//   whose sidebar NoteList calls these two.
// - The status column and trailing text buttons (Disable / Enable / Promote) became a role dropdown plus an enable toggle (#247); the old button cases are replaced by the cases in the `users table (#247)` describe;
//   the disable-confirm dialog stacks over the site admin modal, and its cases locate it by the dialog name "Disable this user?".
//
// "Non-admin -> redirect to `/`" and the signed-out redirect are in `components/admin/AdminModal.test.tsx` (route level, verifying
// that `RequireAdmin` is wired), not repeated here.

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const BASIC_ID = "11111111-1111-4111-8111-111111111111";
const BIG_ID = "22222222-2222-4222-8222-222222222222";
const PLAN_META = { overQuotaCount: 0, isDefaultForUsers: false, isDefaultForGroups: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
const BASIC_PLAN: StoragePlanDto = { ...PLAN_META, id: BASIC_ID, name: "Basic", quotaBytes: 2147483648, userCount: 3, groupCount: 0 };
const BIG_PLAN: StoragePlanDto = { ...PLAN_META, id: BIG_ID, name: "Big", quotaBytes: null, userCount: 0, groupCount: 0 };

const ADMIN_USER: UserDto = {
  id: "u-admin",
  email: "admin@example.com",
  handle: "tester",
  displayName: "Admin",
  isAdmin: true,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
  avatar: null,
};

const ACTIVE_OTHER: AdminUserDto = {
  id: "u-active",
  email: "alice@example.com",
  handle: "u-active-h",
  displayName: "Alice",
  isAdmin: false,
  disabledAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastLoginAt: null,
  lastActiveAt: null,
  hasPassword: true,
  passwordResetExpiresAt: null,
  storage: { planId: BASIC_ID, planName: "Basic", usedBytes: 0, quotaBytes: 2147483648, contentBytes: 0 },
  avatar: null,
};

const DISABLED_OTHER: AdminUserDto = {
  id: "u-disabled",
  email: "bob@example.com",
  handle: "u-disabled-h",
  displayName: "Bob",
  isAdmin: false,
  disabledAt: "2026-01-02T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastLoginAt: null,
  lastActiveAt: null,
  hasPassword: true,
  passwordResetExpiresAt: null,
  storage: { planId: BASIC_ID, planName: "Basic", usedBytes: 0, quotaBytes: 2147483648, contentBytes: 0 },
  avatar: null,
};

/** A row that is already admin but isn't the current login - the demote and `last_site_admin` cases need
 * "someone else's admin row"; that and "own row disabled" are two independent things, so they can't share one fixture. */
const OTHER_ADMIN: AdminUserDto = {
  id: "u-other-admin",
  email: "carol@example.com",
  handle: "u-other-admin-h",
  displayName: "Carol",
  isAdmin: true,
  disabledAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastLoginAt: null,
  lastActiveAt: null,
  hasPassword: true,
  passwordResetExpiresAt: null,
  storage: { planId: BASIC_ID, planName: "Basic", usedBytes: 0, quotaBytes: 2147483648, contentBytes: 0 },
  avatar: null,
};

const ADMIN_USERS_URL = "/api/admin/users";

/** Basic fetch mock: `/api/auth/me` (always `ADMIN_USER` - every case in this file
 * needs admin to pass `RequireAdmin`; the "non-admin" route-level behavior is covered in
 * `SettingsModal.test.tsx`, not repeated), `/api/notes` (needed by the background `HomePage`). */
function baseFetchHandlers(): (url: string, method: string) => Response | null {
  return (url: string, method: string): Response | null => {
    if (url === "/api/groups" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url === "/api/auth/me" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ADMIN_USER) });
    }
    if (url === "/api/folders") return new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url === "/api/notes" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url === "/api/admin/storage-plans" && method === "GET") {
      return fakeResponse({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ plans: [BASIC_PLAN, BIG_PLAN], defaults: { userPlanId: BASIC_ID, groupPlanId: BASIC_ID } }),
      });
    }
    if (url === "/api/admin/invites" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    return null;
  };
}

/**
 * Default `/api/auth/config` response, used only as a fallback before each stub throws `unexpected fetch`: `InvitesGroup` reads it at the group top level,
 * and every case that renders the users page calls it. Not put in `baseFetchHandlers` - each stub asks base first and then judges its own config, so putting it there would shadow each case's own setting.
 */
function defaultAuthConfig(url: string, method: string): Response | null {
  if (url !== "/api/auth/config" || method !== "GET") return null;
  return fakeResponse({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: true } }),
  });
}

function renderUsersRoute(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/admin/users"]}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
      <Toaster />
    </QueryClientProvider>,
  );
}

describe("SettingsUsersSection (/admin/users: the users area of the site admin page)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shell smoke: /admin/users is inside the site admin modal (dialog named Site admin)", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers()(url, method);
      if (base) return Promise.resolve(base);
      if (url === ADMIN_USERS_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      const config = defaultAuthConfig(url, method);
      if (config) return Promise.resolve(config);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderUsersRoute(fetchMock);

    // First load of the AdminSections lazy chunk in this file
    expect(await screen.findByRole("heading", { name: "User management" })).toBeInTheDocument();
    const dialog = await screen.findByRole("dialog", { name: "Site admin" });
    expect(within(within(dialog).getByRole("navigation", { name: "Site admin" })).getByRole("link", { name: "Users" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(dialog).getByRole("button", { name: "Create invitation" }).className).not.toMatch(/(^|\s)bg-(primary|brand|brand-deep)(\s|$)/);
  });
});

describe("storage and plan in the users table", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); dismissAllToasts(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const OVER: AdminUserDto = { ...ACTIVE_OTHER, id: "u-over", email: "over@example.com", storage: { planId: BASIC_ID, planName: "Basic", usedBytes: 3 * 1048576, quotaBytes: 2 * 1048576, contentBytes: 7 * 1048576 } };
  const FREE: AdminUserDto = { ...OTHER_ADMIN, storage: { planId: BIG_ID, planName: "Big", usedBytes: 5 * 1048576, quotaBytes: null, contentBytes: 0 } };

  function stub(rows: AdminUserDto[], extra: (url: string, method: string, init?: RequestInit) => Response | null = () => null) {
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const custom = extra(url, method, init) ?? baseFetchHandlers()(url, method);
      if (custom) return Promise.resolve(custom);
      if (url === ADMIN_USERS_URL && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(rows) }));
      const config = defaultAuthConfig(url, method);
      if (config) return Promise.resolve(config);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
  }

  it("usage cell: normal / unlimited / over / exactly equal (warning color, >=)", async () => {
    const FULL: AdminUserDto = { ...ACTIVE_OTHER, id: "u-full", email: "full@example.com", storage: { planId: BASIC_ID, planName: "Basic", usedBytes: 1048576, quotaBytes: 1048576, contentBytes: 0 } };
    renderUsersRoute(stub([ACTIVE_OTHER, OVER, FREE, FULL]));
    expect(await screen.findByText("over@example.com")).toBeInTheDocument();
    expect(screen.getByText("3 MB of 2 MB")).toHaveClass("text-destructive");
    expect(screen.getByText("1 MB of 1 MB")).toHaveClass("text-destructive");
    expect(screen.getByText("5 MB (no limit)")).not.toHaveClass("text-destructive");
    expect(screen.getByText("0 B of 2 GB")).not.toHaveClass("text-destructive");
  });

  it("second muted line under the usage: notes and history size; never red, even for a space over its limit", async () => {
    renderUsersRoute(stub([ACTIVE_OTHER, OVER]));
    expect(await screen.findByText("over@example.com")).toBeInTheDocument();
    const lines = screen.getAllByTestId("content-bytes");
    expect(lines.map((el) => el.textContent)).toEqual(["Notes and history: 0 B", "Notes and history: 7 MB"]);
    for (const el of lines) {
      expect(el).toHaveClass("text-muted-foreground");
      expect(el).not.toHaveClass("text-destructive");
      expect(el.closest(".text-destructive")).toBeNull();
    }
  });

  it("column widths: the main column and the email column split 1 : 1.5 (the main column no longer takes 2/3 alone and squeezes email)", async () => {
    renderUsersRoute(stub([ACTIVE_OTHER]));
    expect(await screen.findByText("alice@example.com")).toBeInTheDocument();
    expect(screen.getAllByRole("table")[0].style.getPropertyValue("--kb-table-cols")).toBe(
      "minmax(14ch,1fr) minmax(14ch,1.5fr) max-content max-content max-content max-content 2rem 3.5rem",
    );
  });

  it("changing the plan: PATCH {planId}; after success the row's dropdown shows the new plan", async () => {
    const updated = { ...ACTIVE_OTHER, storage: { planId: BIG_ID, planName: "Big", usedBytes: 0, quotaBytes: null, contentBytes: 0 } };
    const fetchMock = stub([ACTIVE_OTHER], (url, method) =>
      url === `/api/admin/users/${ACTIVE_OTHER.id}/storage-plan` && method === "PATCH" ? fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(updated) }) : null);
    renderUsersRoute(fetchMock);
    const select = await screen.findByRole("combobox", { name: `Storage plan for ${ACTIVE_OTHER.email}` });
    expect(selectedValue(select)).toBe(BASIC_ID);
    await chooseOption(select, "Big");
    await waitFor(() => expect(selectedValue(select)).toBe(BIG_ID));
    const patch = fetchMock.mock.calls.find(([u, i]) => String(u) === `/api/admin/users/${ACTIVE_OTHER.id}/storage-plan` && (i as RequestInit).method === "PATCH");
    expect(JSON.parse(String((patch![1] as RequestInit).body))).toEqual({ planId: BIG_ID });
    expect(screen.getByText("0 B (no limit)")).toBeInTheDocument();
    // After success the plan list (member counts) must be refetched - GET storage-plans fires once more after the PATCH
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u, i]) => String(u) === "/api/admin/storage-plans" && ((i as RequestInit | undefined)?.method ?? "GET") === "GET").length).toBeGreaterThanOrEqual(2));
  });

  it("while saving (PATCH not returned): the dropdown is disabled and shows the just-chosen plan, doesn't jump back to the old plan", async () => {
    renderUsersRoute(stub([ACTIVE_OTHER], (url, method) =>
      url === `/api/admin/users/${ACTIVE_OTHER.id}/storage-plan` && method === "PATCH" ? (new Promise(() => undefined) as unknown as Response) : null));
    const select = await screen.findByRole("combobox", { name: `Storage plan for ${ACTIVE_OTHER.email}` });
    await chooseOption(select, "Big");
    await waitFor(() => expect(select).toBeDisabled());
    expect(selectedValue(select)).toBe(BIG_ID);
    expect(displayedLabel(select)).toBe("Big");
  });

  it("plan change failure (404 storage_plan_not_found): toast, the dropdown stays on the original plan", async () => {
    const fetchMock = stub([ACTIVE_OTHER], (url, method) =>
      url === `/api/admin/users/${ACTIVE_OTHER.id}/storage-plan` && method === "PATCH"
        ? fakeResponse({ ok: false, status: 404, json: () => Promise.resolve({ error: { code: "storage_plan_not_found", message: "x" } }) })
        : null);
    renderUsersRoute(fetchMock);
    const select = await screen.findByRole("combobox", { name: `Storage plan for ${ACTIVE_OTHER.email}` });
    await chooseOption(select, "Big");
    expect(await screen.findByText("Plan not found")).toBeInTheDocument();
    expect(selectedValue(select)).toBe(BASIC_ID);
    // Failure also refetches the plan list (the plan may have just been deleted)
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => String(u) === "/api/admin/storage-plans").length).toBeGreaterThanOrEqual(2));
  });

  it("a row's plan isn't in the list -> the dropdown still shows that plan (adds an option), not the first in the list", async () => {
    const NEWPLAN_ID = "99999999-9999-4999-8999-999999999999";
    const row: AdminUserDto = { ...ACTIVE_OTHER, storage: { planId: NEWPLAN_ID, planName: "Brand new", usedBytes: 0, quotaBytes: 1048576, contentBytes: 0 } };
    renderUsersRoute(stub([row]));
    const select = await screen.findByRole("combobox", { name: `Storage plan for ${ACTIVE_OTHER.email}` });
    await waitFor(() => expect(selectedValue(select)).toBe(NEWPLAN_ID));
    expect(displayedLabel(select)).toBe("Brand new");
    expect(await optionLabels(select)).toContain("Brand new");
  });

  it("plan list failure: the plan column shows only the plan name, no dropdown", async () => {
    const fetchMock = stub([ACTIVE_OTHER], (url, method) =>
      url === "/api/admin/storage-plans" && method === "GET" ? fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "x" } }) }) : null);
    renderUsersRoute(fetchMock);
    expect(await screen.findByText(ACTIVE_OTHER.email)).toBeInTheDocument();
    // Wait point: while the list is pending plans is also undefined and "no dropdown" is always true - first wait for the request to actually go out, then let the failure land
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u) === "/api/admin/storage-plans")).toBe(true));
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.queryByRole("combobox", { name: `Storage plan for ${ACTIVE_OTHER.email}` })).not.toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: ACTIVE_OTHER.email })).getByText("Basic")).toBeInTheDocument();
  });
});

describe("users table (#247)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const SELF_ROW: AdminUserDto = { ...OTHER_ADMIN, id: ADMIN_USER.id, email: ADMIN_USER.email, handle: ADMIN_USER.handle, displayName: ADMIN_USER.displayName, lastLoginAt: "2026-10-01T09:12:00.000Z", lastActiveAt: "2026-10-01T09:12:00.000Z" };

  function stubUsers(getRows: () => AdminUserDto[], extra: (url: string, method: string, init?: RequestInit) => Response | Promise<Response> | null = () => null) {
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const custom = extra(url, method, init) ?? baseFetchHandlers()(url, method);
      if (custom) return Promise.resolve(custom);
      if (url === ADMIN_USERS_URL && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(getRows()) }));
      const config = defaultAuthConfig(url, method);
      if (config) return Promise.resolve(config);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
  }
  const posts = (fetchMock: ReturnType<typeof vi.fn>, url: string) =>
    fetchMock.mock.calls.filter(([u, i]) => String(u) === url && (i as RequestInit | undefined)?.method === "POST");
  const rowOf = (email: string) => screen.getByRole("row", { name: email });

  it("columns: User (display name plus gray @handle), Email, Storage, Last active, Role, Plan, Actions, Enabled; no Status column, no trailing text buttons", async () => {
    renderUsersRoute(stubUsers(() => [SELF_ROW, ACTIVE_OTHER]));
    await screen.findByText(ACTIVE_OTHER.email);
    expect(within(screen.getByRole("table", { name: "Users" })).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "User",
      "Email",
      "Storage",
      "Last active",
      "Role",
      "Plan",
      "Actions",
      "Enabled",
    ]);
    expect(within(rowOf(ACTIVE_OTHER.email)).getByRole("switch", { name: `Enabled ${ACTIVE_OTHER.email}` })).toBeInTheDocument();
    const row = within(rowOf(ACTIVE_OTHER.email));
    expect(row.getByText("Alice")).toBeInTheDocument();
    expect(row.getByText(`@${ACTIVE_OTHER.handle}`)).toBeInTheDocument();
    expect(row.queryByRole("button", { name: /^(Disable|Enable|Promote to admin)$/ })).not.toBeInTheDocument();
  });

  it("role dropdown: regular -> admin sends promote; admin -> regular sends demote (bodyless POST)", async () => {
    let rows = [SELF_ROW, ACTIVE_OTHER, OTHER_ADMIN];
    const fetchMock = stubUsers(() => rows, (url, method) => {
      if (method !== "POST") return null;
      if (url === `${ADMIN_USERS_URL}/${ACTIVE_OTHER.id}/promote`) {
        rows = rows.map((r) => (r.id === ACTIVE_OTHER.id ? { ...r, isAdmin: true } : r));
        return fakeResponse({ ok: true, status: 204 });
      }
      if (url === `${ADMIN_USERS_URL}/${OTHER_ADMIN.id}/demote`) {
        rows = rows.map((r) => (r.id === OTHER_ADMIN.id ? { ...r, isAdmin: false } : r));
        return fakeResponse({ ok: true, status: 204 });
      }
      return null;
    });
    renderUsersRoute(fetchMock);
    const alice = await screen.findByRole("combobox", { name: `Role for ${ACTIVE_OTHER.email}` });
    expect(selectedValue(alice)).toBe("user");
    await chooseOption(alice, "Admin");
    await waitFor(() => expect(posts(fetchMock, `${ADMIN_USERS_URL}/${ACTIVE_OTHER.id}/promote`)).toHaveLength(1));
    expect(posts(fetchMock, `${ADMIN_USERS_URL}/${ACTIVE_OTHER.id}/promote`)[0][1]).not.toHaveProperty("body");
    await waitFor(() => expect(selectedValue(alice)).toBe("admin"));

    const carol = screen.getByRole("combobox", { name: `Role for ${OTHER_ADMIN.email}` });
    await chooseOption(carol, "User");
    await waitFor(() => expect(posts(fetchMock, `${ADMIN_USERS_URL}/${OTHER_ADMIN.id}/demote`)).toHaveLength(1));
    await waitFor(() => expect(selectedValue(carol)).toBe("user"));
  });

  it("after promote 204, while the list refetch (GET) is delayed: the dropdown value stays admin (doesn't bounce back to user first)", async () => {
    let rows = [SELF_ROW, ACTIVE_OTHER];
    let holdGet = false;
    let releaseGet: () => void = () => {};
    const fetchMock = stubUsers(() => rows, (url, method) => {
      if (url === `${ADMIN_USERS_URL}/${ACTIVE_OTHER.id}/promote` && method === "POST") {
        rows = rows.map((r) => (r.id === ACTIVE_OTHER.id ? { ...r, isAdmin: true } : r));
        holdGet = true;
        return fakeResponse({ ok: true, status: 204 });
      }
      if (url === ADMIN_USERS_URL && method === "GET" && holdGet) {
        holdGet = false;
        return new Promise<Response>((resolve) => (releaseGet = () => resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(rows) }))));
      }
      return null;
    });
    renderUsersRoute(fetchMock);
    const alice = await screen.findByRole("combobox", { name: `Role for ${ACTIVE_OTHER.email}` });
    await chooseOption(alice, "Admin");
    await waitFor(() => expect(posts(fetchMock, `${ADMIN_USERS_URL}/${ACTIVE_OTHER.id}/promote`)).toHaveLength(1));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u, i]) => String(u) === ADMIN_USERS_URL && ((i as RequestInit | undefined)?.method ?? "GET") === "GET").length).toBeGreaterThanOrEqual(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(selectedValue(alice)).toBe("admin");
    releaseGet();
    await waitFor(() => expect(alice).not.toBeDisabled());
    expect(selectedValue(alice)).toBe("admin");
  });

  it("own row: role dropdown disabled + title \"You can't remove your own admin role.\"", async () => {
    renderUsersRoute(stubUsers(() => [SELF_ROW, ACTIVE_OTHER]));
    const mine = await screen.findByRole("combobox", { name: `Role for ${SELF_ROW.email}` });
    expect(mine).toBeDisabled();
    expect(mine).toHaveAttribute("title", "You can't remove your own admin role.");
  });

  it("demote 409 last_site_admin -> the dropdown bounces back to admin + the error row's red text is the site sentence (not the group's last_admin text)", async () => {
    const fetchMock = stubUsers(() => [SELF_ROW, OTHER_ADMIN], (url, method) =>
      url === `${ADMIN_USERS_URL}/${OTHER_ADMIN.id}/demote` && method === "POST"
        ? fakeResponse({ ok: false, status: 409, json: () => Promise.resolve({ error: { code: "last_site_admin", message: "x" } }) })
        : null,
    );
    renderUsersRoute(fetchMock);
    const carol = await screen.findByRole("combobox", { name: `Role for ${OTHER_ADMIN.email}` });
    await chooseOption(carol, "User");
    // Row-level errors go in the error row after the data row, not in the role cell (it would widen the max-content track).
    const errorRow = await screen.findByRole("row", { name: `${OTHER_ADMIN.email} error` });
    expect(within(rowOf(OTHER_ADMIN.email)).queryByRole("alert")).toBeNull();
    const alert = within(errorRow).getByRole("alert");
    expect(alert).toHaveTextContent("The site needs at least one enabled admin.");
    expect(alert).not.toHaveTextContent(i18n.t("errors.last_admin"));
    expect(selectedValue(carol)).toBe("admin");
  });

  it("while the role is pending the dropdown is disabled and shows the just-chosen value; changing it again doesn't send a second request", async () => {
    const fetchMock = stubUsers(() => [SELF_ROW, ACTIVE_OTHER], (url, method) =>
      url === `${ADMIN_USERS_URL}/${ACTIVE_OTHER.id}/promote` && method === "POST" ? new Promise<Response>(() => {}) : null,
    );
    renderUsersRoute(fetchMock);
    const alice = await screen.findByRole("combobox", { name: `Role for ${ACTIVE_OTHER.email}` });
    await chooseOption(alice, "Admin");
    await waitFor(() => expect(alice).toBeDisabled());
    expect(selectedValue(alice)).toBe("admin");
    fireEvent.keyDown(alice, { key: "Enter" });
    expect(screen.queryByRole("listbox")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posts(fetchMock, `${ADMIN_USERS_URL}/${ACTIVE_OTHER.id}/demote`)).toHaveLength(0);
    expect(posts(fetchMock, `${ADMIN_USERS_URL}/${ACTIVE_OTHER.id}/promote`)).toHaveLength(1);
  });

  it("enable toggle: turning off -> opens the confirm dialog first (nothing sent) -> confirm -> POST disable, after the refetch the toggle is off; turning on (a disabled user) -> POST enable directly", async () => {
    let rows = [SELF_ROW, ACTIVE_OTHER, DISABLED_OTHER];
    const fetchMock = stubUsers(() => rows, (url, method) => {
      if (method !== "POST") return null;
      if (url === `${ADMIN_USERS_URL}/${ACTIVE_OTHER.id}/disable`) {
        rows = rows.map((r) => (r.id === ACTIVE_OTHER.id ? { ...r, disabledAt: "2026-10-11T00:00:00.000Z" } : r));
        return fakeResponse({ ok: true, status: 204 });
      }
      if (url === `${ADMIN_USERS_URL}/${DISABLED_OTHER.id}/enable`) {
        rows = rows.map((r) => (r.id === DISABLED_OTHER.id ? { ...r, disabledAt: null } : r));
        return fakeResponse({ ok: true, status: 204 });
      }
      return null;
    });
    renderUsersRoute(fetchMock);
    const aliceSwitch = await screen.findByRole("switch", { name: `Enabled ${ACTIVE_OTHER.email}` });
    expect(aliceSwitch).toHaveAttribute("aria-checked", "true");
    fireEvent.click(aliceSwitch);
    const confirm = await screen.findByRole("dialog", { name: "Disable this user?" });
    expect(posts(fetchMock, `${ADMIN_USERS_URL}/${ACTIVE_OTHER.id}/disable`)).toHaveLength(0);
    fireEvent.click(within(confirm).getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(posts(fetchMock, `${ADMIN_USERS_URL}/${ACTIVE_OTHER.id}/disable`)).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("switch", { name: `Enabled ${ACTIVE_OTHER.email}` })).toHaveAttribute("aria-checked", "false"));

    const bobSwitch = screen.getByRole("switch", { name: `Enabled ${DISABLED_OTHER.email}` });
    expect(bobSwitch).toHaveAttribute("aria-checked", "false");
    fireEvent.click(bobSwitch);
    await waitFor(() => expect(posts(fetchMock, `${ADMIN_USERS_URL}/${DISABLED_OTHER.id}/enable`)).toHaveLength(1));
    expect(screen.queryByRole("dialog", { name: "Disable this user?" })).not.toBeInTheDocument();
  });

  it("cancelling the disable confirm dialog -> no request, the toggle stays on", async () => {
    const fetchMock = stubUsers(() => [SELF_ROW, ACTIVE_OTHER]);
    renderUsersRoute(fetchMock);
    fireEvent.click(await screen.findByRole("switch", { name: `Enabled ${ACTIVE_OTHER.email}` }));
    const confirm = await screen.findByRole("dialog", { name: "Disable this user?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Disable this user?" })).not.toBeInTheDocument());
    expect(screen.getByRole("switch", { name: `Enabled ${ACTIVE_OTHER.email}` })).toHaveAttribute("aria-checked", "true");
    expect(fetchMock.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === "POST")).toHaveLength(0);
  });

  it("own row's enable toggle: renders as usual, always on, aria-disabled + title \"You can't disable your own account.\"; pressing sends nothing and opens no confirm dialog", async () => {
    const fetchMock = stubUsers(() => [SELF_ROW, ACTIVE_OTHER]);
    renderUsersRoute(fetchMock);
    const mine = await screen.findByRole("switch", { name: `Enabled ${SELF_ROW.email}` });
    expect(mine).toHaveAttribute("aria-checked", "true");
    expect(mine).toHaveAttribute("aria-disabled", "true");
    expect(mine).toHaveAttribute("title", "You can't disable your own account.");
    fireEvent.click(mine);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("dialog", { name: "Disable this user?" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === "POST")).toHaveLength(0);
  });

  it("last active (#267): inside the window shows \"Online\", older shows date + time (toLocaleString(en, short/short)), null shows \"Not recorded\" (lastLoginAt isn't consulted)", async () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    const justOutside = ago(ONLINE_WINDOW_MS + 60_000);
    const dateTime = (iso: string) => new Date(iso).toLocaleString("en", { dateStyle: "short", timeStyle: "short" });
    renderUsersRoute(stubUsers(() => [
      SELF_ROW,
      { ...ACTIVE_OTHER, lastLoginAt: "2026-09-01T00:00:00.000Z", lastActiveAt: ago(3 * 60_000) }, // outside the write interval (1 minute), inside the online window (5 minutes)
      { ...DISABLED_OTHER, lastLoginAt: "2026-09-01T00:00:00.000Z", lastActiveAt: null },
      { ...OTHER_ADMIN, lastActiveAt: justOutside },
    ]));
    await screen.findByText(ACTIVE_OTHER.email);
    const lastActiveCell = (email: string, text: string) => within(rowOf(email)).getByRole("cell", { name: text });
    expect(lastActiveCell(SELF_ROW.email, dateTime("2026-10-01T09:12:00.000Z"))).toBeInTheDocument();
    expect(dateTime("2026-10-01T09:12:00.000Z")).toMatch(/\d{1,2}:\d{2}/); // has a time, not just a date
    expect(lastActiveCell(ACTIVE_OTHER.email, "Online")).toBeInTheDocument();
    expect(lastActiveCell(DISABLED_OTHER.email, "Not recorded")).toBeInTheDocument();
    expect(lastActiveCell(OTHER_ADMIN.email, dateTime(justOutside))).toBeInTheDocument();
  });

  it("role change failure -> error row \"<email> error\"; changing again succeeds -> the error row disappears and leaves no empty alert", async () => {
    let fail = true;
    let rows = [SELF_ROW, OTHER_ADMIN];
    const fetchMock = stubUsers(() => rows, (url, method) => {
      if (url !== `${ADMIN_USERS_URL}/${OTHER_ADMIN.id}/demote` || method !== "POST") return null;
      if (fail) return fakeResponse({ ok: false, status: 409, json: () => Promise.resolve({ error: { code: "last_site_admin", message: "x" } }) });
      rows = rows.map((r) => (r.id === OTHER_ADMIN.id ? { ...r, isAdmin: false } : r));
      return fakeResponse({ ok: true, status: 204 });
    });
    renderUsersRoute(fetchMock);
    const carol = await screen.findByRole("combobox", { name: `Role for ${OTHER_ADMIN.email}` });
    await chooseOption(carol, "User");
    const errorRow = await screen.findByRole("row", { name: `${OTHER_ADMIN.email} error` });
    expect(within(errorRow).getByRole("alert")).toHaveTextContent("The site needs at least one enabled admin.");
    await waitFor(() => expect(carol).not.toBeDisabled());
    expect(selectedValue(carol)).toBe("admin");

    fail = false;
    await chooseOption(carol, "User");
    await waitFor(() => expect(screen.queryByRole("row", { name: `${OTHER_ADMIN.email} error` })).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(selectedValue(carol)).toBe("user"));
  });

  it("error state is keyed by user id: failures in role, enable and disable-confirm each go only into their own row's error row; a row starting a new action clears only its own row", async () => {
    const notFound = () => fakeResponse({ ok: false, status: 404, json: () => Promise.resolve({ error: { code: "user_not_found", message: "x" } }) });
    const fetchMock = stubUsers(() => [SELF_ROW, ACTIVE_OTHER, OTHER_ADMIN, DISABLED_OTHER], (url, method) => {
      if (method !== "POST") return null;
      if (url === `${ADMIN_USERS_URL}/${OTHER_ADMIN.id}/demote`) {
        return fakeResponse({ ok: false, status: 409, json: () => Promise.resolve({ error: { code: "last_site_admin", message: "x" } }) });
      }
      if (url === `${ADMIN_USERS_URL}/${DISABLED_OTHER.id}/enable`) return notFound();
      if (url === `${ADMIN_USERS_URL}/${ACTIVE_OTHER.id}/disable`) return notFound();
      return null;
    });
    renderUsersRoute(fetchMock);
    const errorRowOf = (email: string) => screen.queryByRole("row", { name: `${email} error` });

    await chooseOption(await screen.findByRole("combobox", { name: `Role for ${OTHER_ADMIN.email}` }), "User");
    await waitFor(() => expect(errorRowOf(OTHER_ADMIN.email)).not.toBeNull());
    expect(errorRowOf(ACTIVE_OTHER.email)).toBeNull();
    expect(errorRowOf(DISABLED_OTHER.email)).toBeNull();
    expect(errorRowOf(SELF_ROW.email)).toBeNull();
    expect(screen.getAllByRole("alert")).toHaveLength(1);

    fireEvent.click(screen.getByRole("switch", { name: `Enabled ${DISABLED_OTHER.email}` }));
    await waitFor(() => expect(errorRowOf(DISABLED_OTHER.email)).not.toBeNull());
    expect(within(errorRowOf(DISABLED_OTHER.email)!).getByRole("alert")).toHaveTextContent("We couldn't find that user.");
    expect(within(errorRowOf(OTHER_ADMIN.email)!).getByRole("alert")).toHaveTextContent("The site needs at least one enabled admin.");
    expect(errorRowOf(ACTIVE_OTHER.email)).toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: `Enabled ${ACTIVE_OTHER.email}` }));
    const confirm = await screen.findByRole("dialog", { name: "Disable this user?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(errorRowOf(ACTIVE_OTHER.email)).not.toBeNull());
    expect(within(errorRowOf(ACTIVE_OTHER.email)!).getByRole("alert")).toHaveTextContent("We couldn't find that user.");
    expect(errorRowOf(OTHER_ADMIN.email)).not.toBeNull();
    expect(errorRowOf(DISABLED_OTHER.email)).not.toBeNull();
    expect(errorRowOf(SELF_ROW.email)).toBeNull();
    expect(screen.getAllByRole("alert")).toHaveLength(3);
  });
});

describe("reset password (#286)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    vi.mocked(copyText).mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const SELF_ROW: AdminUserDto = { ...OTHER_ADMIN, id: ADMIN_USER.id, email: ADMIN_USER.email, handle: ADMIN_USER.handle, displayName: ADMIN_USER.displayName };
  const NO_PASSWORD: AdminUserDto = { ...ACTIVE_OTHER, id: "u-sso", email: "sso@example.com", handle: "u-sso-h", hasPassword: false };
  const PENDING_AT = "2030-05-06T07:08:00.000Z";
  const whenOf = (iso: string) => new Date(iso).toLocaleString("en", { dateStyle: "short", timeStyle: "short" });
  const resetUrl = (id: string) => `${ADMIN_USERS_URL}/${id}/password-reset`;
  const rowOf = (email: string) => screen.getByRole("row", { name: email });
  const calls = (fetchMock: ReturnType<typeof vi.fn>, url: string, method: string) =>
    fetchMock.mock.calls.filter(([u, i]) => String(u) === url && ((i as RequestInit | undefined)?.method ?? "GET") === method);
  const actionName = (email: string) => `Reset password for ${email}`;
  const openFor = async (email: string) => {
    fireEvent.click(await within(await screen.findByRole("row", { name: email })).findByRole("button", { name: actionName(email) }));
    return screen.findByRole("dialog", { name: "Reset password" });
  };

  function stub(
    getRows: () => AdminUserDto[],
    opts: { passwordLoginEnabled?: boolean; extra?: (url: string, method: string, init?: RequestInit) => Response | null } = {},
  ) {
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const custom = opts.extra?.(url, method, init) ?? baseFetchHandlers()(url, method);
      if (custom) return Promise.resolve(custom);
      if (url === ADMIN_USERS_URL && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(getRows()) }));
      if (url === "/api/auth/config" && method === "GET") {
        return Promise.resolve(
          fakeResponse({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: opts.passwordLoginEnabled ?? true } }),
          }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
  }

  it("hasPassword:false rows have no reset button; rows with a password (including your own row) do", async () => {
    renderUsersRoute(stub(() => [SELF_ROW, ACTIVE_OTHER, NO_PASSWORD]));
    await screen.findByText(NO_PASSWORD.email);
    expect(within(rowOf(NO_PASSWORD.email)).queryByRole("button", { name: actionName(NO_PASSWORD.email) })).toBeNull();
    expect(within(rowOf(ACTIVE_OTHER.email)).getByRole("button", { name: actionName(ACTIVE_OTHER.email) })).toBeInTheDocument();
    expect(within(rowOf(SELF_ROW.email)).getByRole("button", { name: actionName(SELF_ROW.email) })).toBeInTheDocument();
  });

  it("a disabled row's button is aria-disabled + title explains why; clicking doesn't open the dialog", async () => {
    renderUsersRoute(stub(() => [SELF_ROW, DISABLED_OTHER]));
    const button = await within(await screen.findByRole("row", { name: DISABLED_OTHER.email })).findByRole("button", { name: actionName(DISABLED_OTHER.email) });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAttribute("title", "This account is disabled. Enable it before resetting its password.");
    fireEvent.click(button);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("dialog", { name: "Reset password" })).toBeNull();
  });

  it("main flow: choose hours -> POST the exact body -> result screen (link, expiry) -> copy (success / failure toast) -> done -> reopening returns to the form with the plaintext gone", async () => {
    const expiresAt = "2030-01-02T03:04:00.000Z";
    const fetchMock = stub(() => [SELF_ROW, ACTIVE_OTHER], {
      extra: (url, method) =>
        url === resetUrl(ACTIVE_OTHER.id) && method === "POST"
          ? fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ token: "knbp_TEST", expiresAt }) })
          : null,
    });
    renderUsersRoute(fetchMock);
    const dialog = await openFor(ACTIVE_OTHER.email);
    expect(dialog).toHaveTextContent(ACTIVE_OTHER.email);
    const select = within(dialog).getByLabelText("Link expires after");
    expect(selectedValue(select)).toBe("1");
    const hourLabels = await optionLabels(select);
    expect(hourLabels).toHaveLength(24);
    expect(hourLabels[0]).toBe("1 hour");
    expect(hourLabels[1]).toBe("2 hours");
    await chooseOption(select, "3 hours");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));

    const result = await screen.findByRole("dialog", { name: "Password reset link" });
    const post = calls(fetchMock, resetUrl(ACTIVE_OTHER.id), "POST");
    expect(post).toHaveLength(1);
    expect(JSON.parse(String((post[0][1] as RequestInit).body))).toEqual({ expiresInHours: 3 });
    const url = `${window.location.origin}/reset-password#token=knbp_TEST`;
    expect((within(result).getByLabelText("Link") as HTMLInputElement).value).toBe(url);
    expect(result).toHaveTextContent(`It works once and expires ${whenOf(expiresAt)}.`);

    fireEvent.click(within(result).getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(vi.mocked(copyText)).toHaveBeenCalledWith(url));
    expect(await screen.findByText("Link copied.")).toBeInTheDocument();
    vi.mocked(copyText).mockResolvedValueOnce(false);
    fireEvent.click(within(result).getByRole("button", { name: "Copy link" }));
    expect(await screen.findByText("Couldn't copy automatically — select the link above and copy it by hand.")).toBeInTheDocument();

    fireEvent.click(within(result).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Password reset link" })).toBeNull());
    fireEvent.click(within(rowOf(ACTIVE_OTHER.email)).getByRole("button", { name: actionName(ACTIVE_OTHER.email) }));
    expect(await screen.findByRole("dialog", { name: "Reset password" })).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/knbp_/)).toBeNull();
    expect(selectedValue(screen.getByLabelText("Link expires after"))).toBe("1");
  });

  it("pending link: shows the expiry sentence; Cancel link sends DELETE, after the refetch that line disappears and the dialog stays open", async () => {
    let rows = [SELF_ROW, { ...ACTIVE_OTHER, passwordResetExpiresAt: PENDING_AT }];
    const fetchMock = stub(() => rows, {
      extra: (url, method) => {
        if (url === resetUrl(ACTIVE_OTHER.id) && method === "DELETE") {
          rows = [SELF_ROW, ACTIVE_OTHER];
          return fakeResponse({ ok: true, status: 204 });
        }
        return null;
      },
    });
    renderUsersRoute(fetchMock);
    const dialog = await openFor(ACTIVE_OTHER.email);
    const pending = `An unused link expires ${whenOf(PENDING_AT)}. Creating a new one cancels it.`;
    expect(within(dialog).getByText(pending)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel link" }));
    await waitFor(() => expect(calls(fetchMock, resetUrl(ACTIVE_OTHER.id), "DELETE")).toHaveLength(1));
    await waitFor(() => expect(within(dialog).queryByText(pending)).toBeNull());
    expect(screen.getByRole("dialog", { name: "Reset password" })).toBeInTheDocument();
  });

  it("password sign-in off: the description paragraph, Create link disabled, pending links become pendingSuspended, Cancel link can still be sent", async () => {
    const fetchMock = stub(() => [SELF_ROW, { ...ACTIVE_OTHER, passwordResetExpiresAt: PENDING_AT }], {
      passwordLoginEnabled: false,
      extra: (url, method) => (url === resetUrl(ACTIVE_OTHER.id) && method === "DELETE" ? fakeResponse({ ok: true, status: 204 }) : null),
    });
    renderUsersRoute(fetchMock);
    const dialog = await openFor(ACTIVE_OTHER.email);
    expect(await within(dialog).findByText("Password sign-in is off on this site, so password reset links can't be created or used.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Create link" })).toBeDisabled();
    expect(within(dialog).getByText(`An unused link expires ${whenOf(PENDING_AT)}. It can't be used while password sign-in is off.`)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel link" }));
    await waitFor(() => expect(calls(fetchMock, resetUrl(ACTIVE_OTHER.id), "DELETE")).toHaveLength(1));
  });

  it("create failure (409 user_disabled): the dialog closes, the row error shows errors.user_disabled", async () => {
    const fetchMock = stub(() => [SELF_ROW, ACTIVE_OTHER], {
      extra: (url, method) =>
        url === resetUrl(ACTIVE_OTHER.id) && method === "POST"
          ? fakeResponse({ ok: false, status: 409, json: () => Promise.resolve({ error: { code: "user_disabled", message: "x" } }) })
          : null,
    });
    renderUsersRoute(fetchMock);
    const dialog = await openFor(ACTIVE_OTHER.email);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Reset password" })).toBeNull());
    const errorRow = await screen.findByRole("row", { name: `${ACTIVE_OTHER.email} error` });
    expect(within(errorRow).getByRole("alert")).toHaveTextContent("This account is disabled. Enable it before resetting its password.");
  });

  it("pressing Esc to close while the create request is in flight: after the response returns the result is discarded; reopening shows the form, no plaintext", async () => {
    let release: () => void = () => {};
    const fetchMock = stub(() => [SELF_ROW, ACTIVE_OTHER], {
      extra: (url, method) =>
        url === resetUrl(ACTIVE_OTHER.id) && method === "POST"
          ? (new Promise<Response>((resolve) => {
              release = () => resolve(fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ token: "knbp_LATE", expiresAt: PENDING_AT }) }));
            }) as unknown as Response)
          : null,
    });
    renderUsersRoute(fetchMock);
    const dialog = await openFor(ACTIVE_OTHER.email);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    await waitFor(() => expect(calls(fetchMock, resetUrl(ACTIVE_OTHER.id), "POST")).toHaveLength(1));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Reset password" })).toBeNull());
    release();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    fireEvent.click(within(rowOf(ACTIVE_OTHER.email)).getByRole("button", { name: actionName(ACTIVE_OTHER.email) }));
    expect(await screen.findByRole("dialog", { name: "Reset password" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Password reset link" })).toBeNull();
    expect(screen.queryByDisplayValue(/knbp_/)).toBeNull();
  });

  it.each([
    ["success", () => fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ token: "knbp_LATE", expiresAt: PENDING_AT }) })],
    ["failure", () => fakeResponse({ ok: false, status: 409, json: () => Promise.resolve({ error: { code: "user_disabled", message: "x" } }) })],
  ] as const)("closed while generating, reopened before the response: the previous open's request arriving late (%s) doesn't affect the newly opened dialog", async (_label, late) => {
    let release: () => void = () => {};
    const fetchMock = stub(() => [SELF_ROW, ACTIVE_OTHER], {
      extra: (url, method) =>
        url === resetUrl(ACTIVE_OTHER.id) && method === "POST"
          ? (new Promise<Response>((resolve) => {
              release = () => resolve(late());
            }) as unknown as Response)
          : null,
    });
    renderUsersRoute(fetchMock);
    const dialog = await openFor(ACTIVE_OTHER.email);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    await waitFor(() => expect(calls(fetchMock, resetUrl(ACTIVE_OTHER.id), "POST")).toHaveLength(1));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Reset password" })).toBeNull());
    fireEvent.click(within(rowOf(ACTIVE_OTHER.email)).getByRole("button", { name: actionName(ACTIVE_OTHER.email) }));
    const reopened = await screen.findByRole("dialog", { name: "Reset password" });
    release();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(screen.getByRole("dialog", { name: "Reset password" })).toBe(reopened);
    expect(screen.queryByRole("dialog", { name: "Password reset link" })).toBeNull();
    expect(screen.queryByDisplayValue(/knbp_/)).toBeNull();
    expect(screen.queryByRole("row", { name: `${ACTIVE_OTHER.email} error` })).toBeNull();
  });

  it("cancel failure (DELETE 404 user_not_found): the dialog closes, the row error shows errors.user_not_found", async () => {
    const fetchMock = stub(() => [SELF_ROW, { ...ACTIVE_OTHER, passwordResetExpiresAt: PENDING_AT }], {
      extra: (url, method) =>
        url === resetUrl(ACTIVE_OTHER.id) && method === "DELETE"
          ? fakeResponse({ ok: false, status: 404, json: () => Promise.resolve({ error: { code: "user_not_found", message: "x" } }) })
          : null,
    });
    renderUsersRoute(fetchMock);
    const dialog = await openFor(ACTIVE_OTHER.email);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel link" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Reset password" })).toBeNull());
    const errorRow = await screen.findByRole("row", { name: `${ACTIVE_OTHER.email} error` });
    expect(within(errorRow).getByRole("alert")).toHaveTextContent("We couldn't find that user.");
  });

  it("while generating: the cancel-link button is also disabled", async () => {
    const hang = () => new Promise<Response>(() => {}) as unknown as Response;
    const fetchMock = stub(() => [SELF_ROW, { ...ACTIVE_OTHER, passwordResetExpiresAt: PENDING_AT }], {
      extra: (url, method) => (url === resetUrl(ACTIVE_OTHER.id) && (method === "POST" || method === "DELETE") ? hang() : null),
    });
    renderUsersRoute(fetchMock);
    const dialog = await openFor(ACTIVE_OTHER.email);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel link" })).toBeDisabled());
  });

  it("while cancelling: the generate-link button is also disabled", async () => {
    const fetchMock = stub(() => [SELF_ROW, { ...ACTIVE_OTHER, passwordResetExpiresAt: PENDING_AT }], {
      extra: (url, method) => (url === resetUrl(ACTIVE_OTHER.id) && method === "DELETE" ? (new Promise<Response>(() => {}) as unknown as Response) : null),
    });
    renderUsersRoute(fetchMock);
    const dialog = await openFor(ACTIVE_OTHER.email);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel link" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Create link" })).toBeDisabled());
  });

  it("clicking outside the dialog doesn't close it", async () => {
    renderUsersRoute(stub(() => [SELF_ROW, ACTIVE_OTHER]));
    await openFor(ACTIVE_OTHER.email);
    await clickOutside();
    expect(screen.getByRole("dialog", { name: "Reset password" })).toBeInTheDocument();
  });
});

describe("invitations (#285)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    vi.mocked(copyText).mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const INVITES_URL = "/api/admin/invites";
  const CREATE_DESCRIPTION =
    "Creates a one-time link someone can use to create their own account with an email and a password. Accounts created this way are regular users. Anyone who has the link can use it, with any email — send it only to the person you're inviting.";
  const EXPIRES_AT = "2030-01-02T03:04:00.000Z";
  const inv = (over: Partial<AdminInviteDto> & Pick<AdminInviteDto, "id">): AdminInviteDto => ({
    label: null,
    status: "pending",
    createdAt: "2026-10-20T08:00:00.000Z",
    expiresAt: EXPIRES_AT,
    usedAt: null,
    revokedAt: null,
    createdBy: { id: "u-admin", email: "admin@example.com" },
    usedBy: null,
    ...over,
  });
  const calls = (fetchMock: ReturnType<typeof vi.fn>, url: string, method: string) =>
    fetchMock.mock.calls.filter(([u, i]) => String(u) === url && ((i as RequestInit | undefined)?.method ?? "GET") === method);
  const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)) as unknown;

  function stub(opts: { passwordLoginEnabled?: boolean; getInvites?: () => AdminInviteDto[]; extra?: (url: string, method: string) => Response | null } = {}) {
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      // The invitations GET is handled before base (base's empty array serves the other groups).
      if (url === INVITES_URL && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve((opts.getInvites ?? (() => []))()) }));
      const custom = opts.extra?.(url, method) ?? baseFetchHandlers()(url, method);
      if (custom) return Promise.resolve(custom);
      if (url === ADMIN_USERS_URL && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      if (url === "/api/auth/config" && method === "GET") {
        return Promise.resolve(
          fakeResponse({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: opts.passwordLoginEnabled ?? true } }),
          }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
  }
  const createdResponse = (extra: (url: string, method: string) => Response | null = () => null) => (url: string, method: string) =>
    url === INVITES_URL && method === "POST"
      ? fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ invite: inv({ id: "i-new" }), token: "knbi_TEST" }) })
      : extra(url, method);
  const openCreate = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Create invitation" }));
    return screen.findByRole("dialog", { name: "Create an invitation" });
  };

  it("the header has a \"Create invitation\" button and no \"Create user\"", async () => {
    renderUsersRoute(stub());
    expect(await screen.findByRole("button", { name: "Create invitation" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create user" })).toBeNull();
  });

  it("main flow: default 3 days, seven options -> POST the exact body -> result screen (link) -> the invitation table is refetched -> done -> reopening returns to the form with the plaintext gone", async () => {
    const fetchMock = stub({ extra: createdResponse() });
    renderUsersRoute(fetchMock);
    const dialog = await openCreate();
    expect(within(dialog).getByText(CREATE_DESCRIPTION)).toBeInTheDocument();
    const select = within(dialog).getByLabelText("Link expires after");
    expect(selectedValue(select)).toBe("3");
    const dayLabels = await optionLabels(select);
    expect(dayLabels).toHaveLength(7);
    expect(dayLabels[0]).toBe("1 day");
    expect(dayLabels[1]).toBe("2 days");
    await chooseOption(select, "5 days");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));

    const result = await screen.findByRole("dialog", { name: "Invitation link" });
    const post = calls(fetchMock, INVITES_URL, "POST");
    expect(post).toHaveLength(1);
    expect(bodyOf(post[0])).toEqual({ expiresInDays: 5 });
    expect((within(result).getByLabelText("Link") as HTMLInputElement).value).toBe(`${window.location.origin}/register#invite=knbi_TEST`);
    await waitFor(() => expect(calls(fetchMock, INVITES_URL, "GET")).toHaveLength(2));

    fireEvent.click(within(result).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Invitation link" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Create invitation" }));
    expect(await screen.findByRole("dialog", { name: "Create an invitation" })).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/knbi_/)).toBeNull();
    expect(selectedValue(screen.getByLabelText("Link expires after"))).toBe("3");
  });

  it("note: sent as typed (trim is done by the server)", async () => {
    const fetchMock = stub({ extra: createdResponse() });
    renderUsersRoute(fetchMock);
    const dialog = await openCreate();
    fireEvent.change(within(dialog).getByLabelText("Note (optional)"), { target: { value: "  Alice  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    await screen.findByRole("dialog", { name: "Invitation link" });
    expect(bodyOf(calls(fetchMock, INVITES_URL, "POST")[0])).toEqual({ expiresInDays: 3, label: "  Alice  " });
  });

  it("note of only whitespace: the body has no label", async () => {
    const fetchMock = stub({ extra: createdResponse() });
    renderUsersRoute(fetchMock);
    const dialog = await openCreate();
    fireEvent.change(within(dialog).getByLabelText("Note (optional)"), { target: { value: "   " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    await screen.findByRole("dialog", { name: "Invitation link" });
    expect(bodyOf(calls(fetchMock, INVITES_URL, "POST")[0])).toEqual({ expiresInDays: 3 });
  });

  it("note counts code points: 100 emoji (JS length 200) are sent as usual", async () => {
    const fetchMock = stub({ extra: createdResponse() });
    renderUsersRoute(fetchMock);
    const dialog = await openCreate();
    fireEvent.change(within(dialog).getByLabelText("Note (optional)"), { target: { value: "😀".repeat(100) } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    await screen.findByRole("dialog", { name: "Invitation link" });
    expect(calls(fetchMock, INVITES_URL, "POST")).toHaveLength(1);
  });

  it("note of 101 characters: shows labelTooLong, no POST", async () => {
    const fetchMock = stub({ extra: createdResponse() });
    renderUsersRoute(fetchMock);
    const dialog = await openCreate();
    fireEvent.change(within(dialog).getByLabelText("Note (optional)"), { target: { value: "字".repeat(101) } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    expect(await within(dialog).findByText("A note can be at most 100 characters.")).toBeInTheDocument();
    expect(calls(fetchMock, INVITES_URL, "POST")).toHaveLength(0);
  });

  it("password sign-in off: the dialog has an explanation, Create link disabled", async () => {
    renderUsersRoute(stub({ passwordLoginEnabled: false }));
    const dialog = await openCreate();
    expect(await within(dialog).findByText("Password sign-in is off on this site, so invitations can't be created or used.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Create link" })).toBeDisabled();
  });

  it("clicking outside the dialog doesn't close it and typed content remains", async () => {
    renderUsersRoute(stub());
    const dialog = await openCreate();
    fireEvent.change(within(dialog).getByLabelText("Note (optional)"), { target: { value: "keep me" } });
    await clickOutside();
    expect(screen.getByRole("dialog", { name: "Create an invitation" })).toBeInTheDocument();
    expect(screen.getByLabelText("Note (optional)")).toHaveValue("keep me");
    expect(screen.getByLabelText("Note (optional)")).toHaveAccessibleDescription("Only admins see it, in the invitations list. Up to 100 characters.");
  });

  const TABLE_ROWS: AdminInviteDto[] = [
    inv({ id: "i-p1", label: "Alice", createdAt: "2026-10-20T08:00:00.000Z" }),
    inv({ id: "i-p2", label: null, createdAt: "2026-10-20T08:15:07.000Z", createdBy: null }),
    inv({ id: "i-p3", label: null, createdAt: "2026-10-20T08:15:42.000Z" }),
    inv({ id: "i-used", label: "Bob", status: "used", usedAt: "2026-10-20T09:00:00.000Z", usedBy: { id: "u-bob", email: "bob@example.com" } }),
    inv({ id: "i-revoked", label: "Carol", status: "revoked", revokedAt: "2026-10-20T09:00:00.000Z", createdBy: null }),
    inv({ id: "i-expired", label: "Dave", status: "expired" }),
  ];

  it("invitation table: header, status text, the account used, subtitle, only pending rows have a revoke button (without a note, button names include seconds so they differ from each other)", async () => {
    renderUsersRoute(stub({ getInvites: () => TABLE_ROWS }));
    const table = await screen.findByRole("table", { name: "Invitations" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Invitation", "Status", "Expires", "Used by", "Actions"]);
    const row = (name: string | RegExp) => within(table).getByRole("row", { name });
    expect(within(row(/Alice/)).getByText("Unused")).toBeInTheDocument();
    expect(within(row(/Bob/)).getByText("Used")).toBeInTheDocument();
    expect(within(row(/Alice/)).getByText("Unused")).not.toHaveClass("text-muted-foreground");
    expect(within(row(/Bob/)).getByText("Used")).toHaveClass("text-muted-foreground");
    expect(within(row(/Dave/)).getByText("—")).toHaveClass("text-muted-foreground");
    expect(within(row(/Bob/)).getByText("bob@example.com")).not.toHaveClass("text-muted-foreground");
    expect(within(row(/Alice/)).getByText(new Date(EXPIRES_AT).toLocaleString("en", { dateStyle: "short", timeStyle: "short" }))).toBeInTheDocument();
    expect(within(row(/Carol/)).getByText("Revoked")).toBeInTheDocument();
    expect(within(row(/Dave/)).getByText("Expired")).toBeInTheDocument();
    expect(within(row(/Bob/)).getByText("bob@example.com")).toBeInTheDocument();
    expect(within(row(/Alice/)).getByText("—")).toBeInTheDocument();
    expect(within(row(/Dave/)).getByText("—")).toBeInTheDocument();
    expect(within(row(/Carol/)).getByText(/^Created (?!by)/)).toBeInTheDocument();
    expect(within(row(/Alice/)).getByText(/^Created by admin@example\.com, /)).toBeInTheDocument();

    const revokes = within(table).getAllByRole("button", { name: /^Revoke invitation/ });
    expect(revokes).toHaveLength(3);
    const secs = (iso: string) => new Date(iso).toLocaleString("en", { dateStyle: "short", timeStyle: "medium" });
    const names = revokes.map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(names).toContain("Revoke invitation Alice");
    expect(names).toContain(`Revoke invitation created ${secs("2026-10-20T08:15:07.000Z")}`);
    expect(names).toContain(`Revoke invitation created ${secs("2026-10-20T08:15:42.000Z")}`);
    expect(secs("2026-10-20T08:15:07.000Z")).not.toBe(secs("2026-10-20T08:15:42.000Z"));
    expect(within(row(/Bob/)).queryByRole("button", { name: /^Revoke invitation/ })).toBeNull();
    expect(within(row(/Carol/)).queryByRole("button", { name: /^Revoke invitation/ })).toBeNull();
    expect(within(row(/Dave/)).queryByRole("button", { name: /^Revoke invitation/ })).toBeNull();
  });

  it("revoke: confirm dialog -> DELETE -> refetch", async () => {
    let rows = [inv({ id: "i-p1", label: "Alice" })];
    const fetchMock = stub({
      getInvites: () => rows,
      extra: (url, method) => {
        if (url === `${INVITES_URL}/i-p1` && method === "DELETE") {
          rows = [];
          return fakeResponse({ ok: true, status: 204 });
        }
        return null;
      },
    });
    renderUsersRoute(fetchMock);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke invitation Alice" }));
    const confirm = await screen.findByRole("dialog", { name: "Revoke this invitation?" });
    expect(within(confirm).getByText("The link stops working right away. This can't be undone; create a new invitation if you need one.")).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(calls(fetchMock, `${INVITES_URL}/i-p1`, "DELETE")).toHaveLength(1));
    await waitFor(() => expect(calls(fetchMock, INVITES_URL, "GET")).toHaveLength(2));
    expect(await screen.findByText("No invitations yet.")).toBeInTheDocument();
  });

  it("revoke failure (409 invite_used): toast is errors.invite_used", async () => {
    const fetchMock = stub({
      getInvites: () => [inv({ id: "i-p1", label: "Alice" })],
      extra: (url, method) =>
        url === `${INVITES_URL}/i-p1` && method === "DELETE"
          ? fakeResponse({ ok: false, status: 409, json: () => Promise.resolve({ error: { code: "invite_used", message: "used" } }) })
          : null,
    });
    renderUsersRoute(fetchMock);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke invitation Alice" }));
    const confirm = await screen.findByRole("dialog", { name: "Revoke this invitation?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Revoke" }));
    expect(await screen.findByText("This invitation has already been used and can't be revoked.")).toBeInTheDocument();
  });

  const hangingPost = () => {
    let release: (res: Response) => void = () => {};
    const extra = (url: string, method: string) =>
      url === INVITES_URL && method === "POST" ? (new Promise<Response>((resolve) => { release = resolve; }) as unknown as Response) : null;
    return { extra, release: (res: Response) => release(res) };
  };
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  const okCreated = () => fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ invite: inv({ id: "i-late" }), token: "knbi_LATE" }) });

  it("pressing Esc to close while the create request is in flight: after the response returns the result is discarded; reopening shows the form, no plaintext", async () => {
    const hang = hangingPost();
    const fetchMock = stub({ extra: hang.extra });
    renderUsersRoute(fetchMock);
    const dialog = await openCreate();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    await waitFor(() => expect(calls(fetchMock, INVITES_URL, "POST")).toHaveLength(1));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Create an invitation" })).toBeNull());
    hang.release(okCreated());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Create invitation" }));
    expect(await screen.findByRole("dialog", { name: "Create an invitation" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Invitation link" })).toBeNull();
    expect(screen.queryByDisplayValue(/knbi_/)).toBeNull();
  });

  it.each([
    ["success", okCreated],
    ["failure", () => fakeResponse({ ok: false, status: 403, json: () => Promise.resolve({ error: { code: "password_login_disabled", message: "x" } }) })],
  ] as const)("closed after submitting, reopened before the response: the previous open's request arriving late (%s) doesn't affect the newly opened dialog", async (_label, late) => {
    const hang = hangingPost();
    const fetchMock = stub({ extra: hang.extra });
    renderUsersRoute(fetchMock);
    const dialog = await openCreate();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    await waitFor(() => expect(calls(fetchMock, INVITES_URL, "POST")).toHaveLength(1));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Create an invitation" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Create invitation" }));
    const reopened = await screen.findByRole("dialog", { name: "Create an invitation" });
    hang.release(late());
    await settle();
    expect(screen.getByRole("dialog", { name: "Create an invitation" })).toBe(reopened);
    expect(screen.queryByRole("dialog", { name: "Invitation link" })).toBeNull();
    expect(screen.queryByDisplayValue(/knbi_/)).toBeNull();
    expect(within(reopened).queryByRole("alert")).toBeNull();
  });

  it("after submit, close and reopen (the old request hasn't returned): the submit button is Create link and clickable, not Creating... / disabled", async () => {
    const hang = hangingPost();
    const fetchMock = stub({ extra: hang.extra });
    renderUsersRoute(fetchMock);
    const dialog = await openCreate();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Creating…" })).toBeDisabled());
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Create an invitation" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Create invitation" }));
    const reopened = await screen.findByRole("dialog", { name: "Create an invitation" });
    expect(within(reopened).getByRole("button", { name: "Create link" })).toBeEnabled();
    expect(within(reopened).queryByRole("button", { name: "Creating…" })).toBeNull();
  });

  it("create failure (403 password_login_disabled): role=alert in the dialog shows that error, the form remains", async () => {
    const fetchMock = stub({
      extra: (url, method) =>
        url === INVITES_URL && method === "POST"
          ? fakeResponse({ ok: false, status: 403, json: () => Promise.resolve({ error: { code: "password_login_disabled", message: "x" } }) })
          : null,
    });
    renderUsersRoute(fetchMock);
    const dialog = await openCreate();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("This site only allows signing in through a sign-in service.");
    expect(screen.getByRole("dialog", { name: "Create an invitation" })).toBe(dialog);
    expect(within(dialog).getByRole("button", { name: "Create link" })).toBeEnabled();
  });

  it("the length check trims first: leading / trailing whitespace doesn't count (100 characters plus whitespace is sent as usual)", async () => {
    const fetchMock = stub({ extra: createdResponse() });
    renderUsersRoute(fetchMock);
    const dialog = await openCreate();
    fireEvent.change(within(dialog).getByLabelText("Note (optional)"), { target: { value: `  ${"a".repeat(100)}  ` } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    await screen.findByRole("dialog", { name: "Invitation link" });
    expect(calls(fetchMock, INVITES_URL, "POST")).toHaveLength(1);
  });

  it("revoke hits 409 invite_used: toast, then the list is refetched", async () => {
    const fetchMock = stub({
      getInvites: () => [inv({ id: "i-p1", label: "Alice" })],
      extra: (url, method) =>
        url === `${INVITES_URL}/i-p1` && method === "DELETE"
          ? fakeResponse({ ok: false, status: 409, json: () => Promise.resolve({ error: { code: "invite_used", message: "used" } }) })
          : null,
    });
    renderUsersRoute(fetchMock);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke invitation Alice" }));
    const confirm = await screen.findByRole("dialog", { name: "Revoke this invitation?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Revoke" }));
    expect(await screen.findByText("This invitation has already been used and can't be revoked.")).toBeInTheDocument();
    await waitFor(() => expect(calls(fetchMock, INVITES_URL, "GET")).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Revoke this invitation?" })).toBeNull());
  });

  const SUSPENDED = "Password sign-in is off, so unused invitations can't be used right now. Turn it back on and the ones that haven't expired work again.";

  it("password sign-in off -> role=status notice above the table", async () => {
    renderUsersRoute(stub({ passwordLoginEnabled: false, getInvites: () => [inv({ id: "i-p1", label: "Alice" })] }));
    expect(await screen.findByRole("status")).toHaveTextContent(SUSPENDED);
  });

  it("password sign-in on -> no notice (judged only after both config and the invitation rows have arrived)", async () => {
    const fetchMock = stub({ getInvites: () => [inv({ id: "i-p1", label: "Alice" })] });
    renderUsersRoute(fetchMock);
    await screen.findByRole("button", { name: "Revoke invitation Alice" });
    await waitFor(() => expect(calls(fetchMock, "/api/auth/config", "GET").length).toBeGreaterThanOrEqual(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByText(SUSPENDED)).toBeNull();
  });

  it("no invitations -> No invitations yet.", async () => {
    renderUsersRoute(stub());
    expect(await screen.findByText("No invitations yet.")).toBeInTheDocument();
  });
});

describe("avatars in the users table", () => {
  const REF = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", v: 2 };

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const SELF: AdminUserDto = { ...ACTIVE_OTHER, id: ADMIN_USER.id, email: ADMIN_USER.email, handle: ADMIN_USER.handle, displayName: ADMIN_USER.displayName };

  async function renderWith(alice: AdminUserDto) {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers()(url, method);
      if (base) return Promise.resolve(base);
      if (url === ADMIN_USERS_URL && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([SELF, alice]) }));
      const config = defaultAuthConfig(url, method);
      if (config) return Promise.resolve(config);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    renderUsersRoute(fetchMock);
    const row = await screen.findByRole("row", { name: alice.email });
    return within(row).getByText("Alice").previousElementSibling as HTMLElement;
  }

  it("with an avatar: an avatar before the name, src carries the version, lazy, outer aria-hidden", async () => {
    const avatar = await renderWith({ ...ACTIVE_OTHER, avatar: REF });
    const img = avatar.querySelector("img");
    expect(img).toHaveAttribute("src", avatarUrl(REF.id, REF.v));
    expect(img).toHaveAttribute("loading", "lazy");
    expect(avatar).toHaveAttribute("aria-hidden", "true");
  });

  it("avatar is null: the initial letter, no img", async () => {
    const avatar = await renderWith(ACTIVE_OTHER);
    expect(avatar.querySelector("img")).toBeNull();
    expect(avatar.textContent).toBe("A");
  });

  it("old server without an avatar field: no throw, shows the initial letter", async () => {
    const row = { ...ACTIVE_OTHER } as Record<string, unknown>;
    delete row.avatar;
    const avatar = await renderWith(row as unknown as AdminUserDto);
    expect(avatar.querySelector("img")).toBeNull();
    expect(avatar.textContent).toBe("A");
  });

  it("image load failure -> falls back to the initial letter", async () => {
    const avatar = await renderWith({ ...ACTIVE_OTHER, avatar: REF });
    fireEvent.error(avatar.querySelector("img")!);
    expect(avatar.querySelector("img")).toBeNull();
    expect(avatar.textContent).toBe("A");
  });
});

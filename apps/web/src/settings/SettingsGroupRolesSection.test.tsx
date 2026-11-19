import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { GroupDto, GroupRoleDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { clickOutside } from "@/test/outside-click";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";
import { adminRole, customRole, groupDto, memberRole } from "@/test/fixtures";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

// Group modal "Roles" (`/groups/:id/roles`, #247): real `AppRoutes`, `MemoryRouter`, fetch dispatch.
// A switch sends a PATCH (six keys) as soon as it is pressed; a card has at most one in flight, pending covers the `onSettled` refetch; there is no "Apply".

function fakeResponse({ ok: okFlag, status, json }: { ok: boolean; status: number; json?: () => Promise<unknown> }): Response {
  return { ok: okFlag, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}
function ok(body: unknown, status = 200): Response {
  return fakeResponse({ ok: true, status, json: () => Promise.resolve(body) });
}
function fail(status: number, code: string): Response {
  return fakeResponse({ ok: false, status, json: () => Promise.resolve({ error: { code, message: "x" } }) });
}

const ME: UserDto = { id: "u-me", email: "me@example.com", handle: "me", displayName: "Me", isAdmin: false, mustChangePassword: false, hasPassword: true, autoVersions: true, avatar: null };
const ADMIN_ROLE = adminRole({ id: "11111111-1111-1111-1111-111111111111" });
const MEMBER_ROLE = memberRole({ id: "22222222-2222-2222-2222-222222222222" });
const READER = customRole({ id: "33333333-3333-3333-3333-333333333333", memberCount: 2 });
const ROLES: GroupRoleDto[] = [ADMIN_ROLE, MEMBER_ROLE, READER];
const GROUP_ADMIN: GroupDto = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Team Alpha" }, ADMIN_ROLE);
const GROUP_MEMBER: GroupDto = groupDto({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "Team Beta" }, MEMBER_ROLE);

const ALL_OFF = { create: false, edit: false, delete: false, managePublicLink: false, manageMembers: false, manageGroup: false };
const FLAG_LABELS = ["Create", "Edit", "Delete", "Manage public links", "Manage members", "Manage roles & group"];
const READ_ALWAYS = "Every role can read the group's notes, their backlinks and their AI edit history.";
const ADMIN_LOCKED = "The built-in Admin role always has every permission and can't be changed.";

type Handler = (url: string, method: string, init: RequestInit | undefined) => Response | Promise<Response> | null;

function fetchFor(getGroups: () => GroupDto[], getRoles: () => GroupRoleDto[], extra: Handler = () => null) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const custom = extra(url, method, init);
    if (custom) return Promise.resolve(custom);
    if (url === "/api/auth/me" && method === "GET") return Promise.resolve(ok(ME));
    if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
    if (url === "/api/notes" && method === "GET") return Promise.resolve(ok([]));
    if (url === "/api/groups" && method === "GET") return Promise.resolve(ok(getGroups()));
    for (const group of getGroups()) {
      if (url === `/api/groups/${group.id}/members` && method === "GET") return Promise.resolve(ok([]));
      if (url === `/api/groups/${group.id}/roles` && method === "GET") return Promise.resolve(ok(getRoles()));
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
}

function callsTo(fetchMock: ReturnType<typeof vi.fn>, method: string, url: string): RequestInit[] {
  return fetchMock.mock.calls
    .filter(([u, i]) => String(u) === url && ((i as RequestInit | undefined)?.method ?? "GET").toUpperCase() === method)
    .map(([, i]) => i as RequestInit);
}
function bodyOf(init: RequestInit): unknown {
  return JSON.parse(String(init.body));
}

const roleUrl = (group: GroupDto, role: GroupRoleDto) => `/api/groups/${group.id}/roles/${role.id}`;
const rolesListUrl = (group: GroupDto) => `/api/groups/${group.id}/roles`;

async function openRoles(group: GroupDto, fetchMock: ReturnType<typeof vi.fn>, waitFor_ = "Admin") {
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[`/groups/${group.id}/roles`]}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
      <Toaster />
    </QueryClientProvider>,
  );
  const dialog = await screen.findByRole("dialog", { name: group.name });
  // This file cold-loads the GroupSections lazy chunk the first time; the wait limit comes from the global asyncUtilTimeout in test/setup.ts.
  await within(dialog).findByRole("region", { name: waitFor_ });
  return dialog;
}

const region = (dialog: HTMLElement, name: string) => within(dialog).getByRole("region", { name });
const flagSwitch = (scope: HTMLElement, flag: string, role: string) => within(scope).getByRole("switch", { name: `${flag} for ${role}` });
const SOLID_BG = /(^|\s)bg-(primary|destructive|brand|brand-deep)(\s|$)/;
const solidButtons = (scope: HTMLElement) => within(scope).queryAllByRole("button").filter((b) => SOLID_BG.test(b.className));
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("SettingsGroupRolesSection (/groups/:id/roles, #247)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("manager view: three cards; the always-true read note; the admin card is locked (disabled + explanation, no buttons); the regular member card has no pencil / trash; the custom role card has a pencil and a red trash; no \"Apply\"; New role is outline and the page has no solid buttons", async () => {
    const dialog = await openRoles(GROUP_ADMIN, fetchFor(() => [GROUP_ADMIN], () => ROLES), "Reader");
    expect(within(dialog).getByRole("heading", { level: 1, name: "Roles" })).toBeInTheDocument();
    expect(within(dialog).getAllByText(READ_ALWAYS)).toHaveLength(1);
    expect(within(dialog).queryAllByRole("button", { name: /^Apply/ })).toHaveLength(0);

    const admin = region(dialog, "Admin");
    for (const label of FLAG_LABELS) {
      expect(flagSwitch(admin, label, "Admin")).toBeChecked();
      expect(flagSwitch(admin, label, "Admin")).toBeDisabled();
    }
    expect(within(admin).queryAllByRole("button")).toHaveLength(0);
    const hint = within(admin).getByText(ADMIN_LOCKED);
    for (const sw of within(admin).getAllByRole("switch")) expect(sw).toHaveAttribute("aria-describedby", hint.id);

    const memberCard = region(dialog, "Member");
    for (const label of FLAG_LABELS) expect(flagSwitch(memberCard, label, "Member")).not.toBeDisabled();
    expect(within(memberCard).queryByRole("button", { name: /^(Rename|Delete) / })).not.toBeInTheDocument();

    const reader = region(dialog, "Reader");
    expect(within(reader).getByRole("heading", { level: 3, name: "Reader" })).toBeInTheDocument();
    const rename = within(reader).getByRole("button", { name: "Rename Reader" });
    const del = within(reader).getByRole("button", { name: "Delete Reader" });
    expect(rename).toHaveAttribute("title", "Rename Reader");
    expect(del).toBeInTheDocument();

    expect(within(dialog).getByRole("button", { name: "New role" })).toBeInTheDocument();
    expect(solidButtons(dialog)).toEqual([]);
  });

  it("press-to-send: the PATCH body has all six keys with only the target key flipped (no linkage, no read / name); the pressed switch shows the new value before the response", async () => {
    let release: (r: Response) => void = () => {};
    const fetchMock = fetchFor(() => [GROUP_ADMIN], () => ROLES, (url, method) =>
      url === roleUrl(GROUP_ADMIN, MEMBER_ROLE) && method === "PATCH" ? new Promise<Response>((resolve) => (release = resolve)) : null,
    );
    const dialog = await openRoles(GROUP_ADMIN, fetchMock, "Member");
    const memberCard = region(dialog, "Member");
    fireEvent.click(flagSwitch(memberCard, "Delete", "Member"));
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", roleUrl(GROUP_ADMIN, MEMBER_ROLE))).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, "PATCH", roleUrl(GROUP_ADMIN, MEMBER_ROLE))[0])).toEqual({
      permissions: { ...ALL_OFF, create: true, edit: true, delete: true },
    });
    expect(flagSwitch(memberCard, "Delete", "Member")).toBeChecked();
    expect(flagSwitch(memberCard, "Create", "Member")).toBeChecked();
    expect(flagSwitch(memberCard, "Manage members", "Member")).not.toBeChecked();
    release(ok({ ...MEMBER_ROLE, permissions: { ...MEMBER_ROLE.permissions, delete: true } }));
  });

  it("while pending the whole card is disabled: pressing Create with the PATCH hanging -> six switches aria-disabled; then pressing Edit -> no second request and Edit stays off", async () => {
    let roles = ROLES;
    let release: (r: Response) => void = () => {};
    const fetchMock = fetchFor(() => [GROUP_ADMIN], () => roles, (url, method) =>
      url === roleUrl(GROUP_ADMIN, READER) && method === "PATCH" ? new Promise<Response>((resolve) => (release = resolve)) : null,
    );
    const dialog = await openRoles(GROUP_ADMIN, fetchMock, "Reader");
    const reader = region(dialog, "Reader");
    const patches = () => callsTo(fetchMock, "PATCH", roleUrl(GROUP_ADMIN, READER));

    fireEvent.click(flagSwitch(reader, "Create", "Reader"));
    await waitFor(() => expect(patches()).toHaveLength(1));
    for (const label of FLAG_LABELS) expect(flagSwitch(reader, label, "Reader")).toHaveAttribute("aria-disabled", "true");
    // Not native disabled: the focus of the pressed switch must not fall to body
    expect(flagSwitch(reader, "Create", "Reader")).not.toBeDisabled();

    fireEvent.click(flagSwitch(reader, "Edit", "Reader"));
    await tick();
    expect(patches()).toHaveLength(1);
    expect(flagSwitch(reader, "Edit", "Reader")).not.toBeChecked();

    const updated = { ...READER, permissions: { ...READER.permissions, create: true } };
    roles = [ADMIN_ROLE, MEMBER_ROLE, updated];
    release(ok(updated));
    await waitFor(() => expect(flagSwitch(reader, "Create", "Reader")).not.toHaveAttribute("aria-disabled"));
    expect(flagSwitch(reader, "Create", "Reader")).toBeChecked();
  });

  it("the next request after settle carries the previous value: PATCH 200 with the roles GET delayed -> until the GET returns the card stays disabled and pressing Edit sends nothing; after the GET returns, pressing Edit -> six keys including Create's new value", async () => {
    let roles = ROLES;
    let holdNextRolesGet = false;
    let releaseGet: () => void = () => {};
    const fetchMock = fetchFor(() => [GROUP_ADMIN], () => roles, (url, method, init) => {
      if (url === roleUrl(GROUP_ADMIN, READER) && method === "PATCH") {
        const body = bodyOf(init!) as { permissions: typeof ALL_OFF };
        const updated = { ...READER, permissions: { read: true, ...body.permissions } };
        roles = [ADMIN_ROLE, MEMBER_ROLE, updated];
        holdNextRolesGet = true;
        return ok(updated);
      }
      if (url === rolesListUrl(GROUP_ADMIN) && method === "GET" && holdNextRolesGet) {
        holdNextRolesGet = false;
        return new Promise<Response>((resolve) => (releaseGet = () => resolve(ok(roles))));
      }
      return null;
    });
    const dialog = await openRoles(GROUP_ADMIN, fetchMock, "Reader");
    const reader = region(dialog, "Reader");
    const patches = () => callsTo(fetchMock, "PATCH", roleUrl(GROUP_ADMIN, READER));
    const rolesGets = () => callsTo(fetchMock, "GET", rolesListUrl(GROUP_ADMIN)).length;
    const getsBefore = rolesGets();

    fireEvent.click(flagSwitch(reader, "Create", "Reader"));
    await waitFor(() => expect(patches()).toHaveLength(1));
    await waitFor(() => expect(rolesGets()).toBe(getsBefore + 1));
    expect(flagSwitch(reader, "Edit", "Reader")).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(flagSwitch(reader, "Edit", "Reader"));
    await tick();
    expect(patches()).toHaveLength(1);

    releaseGet();
    await waitFor(() => expect(flagSwitch(reader, "Edit", "Reader")).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(flagSwitch(reader, "Edit", "Reader"));
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(bodyOf(patches()[1])).toEqual({ permissions: { ...ALL_OFF, create: true, edit: true } });
  });

  it("PATCH 200 then roles GET 500: the card stays (not replaced by error text), pressing Edit still sends six keys including Create's new value (onSuccess writes it back)", async () => {
    let failRolesGet = false;
    const fetchMock = fetchFor(() => [GROUP_ADMIN], () => ROLES, (url, method, init) => {
      if (url === roleUrl(GROUP_ADMIN, READER) && method === "PATCH") {
        const body = bodyOf(init!) as { permissions: typeof ALL_OFF };
        failRolesGet = true;
        return ok({ ...READER, permissions: { read: true, ...body.permissions } });
      }
      if (url === rolesListUrl(GROUP_ADMIN) && method === "GET" && failRolesGet) return fail(500, "internal");
      return null;
    });
    const dialog = await openRoles(GROUP_ADMIN, fetchMock, "Reader");
    const patches = () => callsTo(fetchMock, "PATCH", roleUrl(GROUP_ADMIN, READER));

    fireEvent.click(flagSwitch(region(dialog, "Reader"), "Create", "Reader"));
    await waitFor(() => expect(patches()).toHaveLength(1));
    await waitFor(() => expect(flagSwitch(region(dialog, "Reader"), "Edit", "Reader")).not.toHaveAttribute("aria-disabled"));
    expect(flagSwitch(region(dialog, "Reader"), "Create", "Reader")).toBeChecked();

    fireEvent.click(flagSwitch(region(dialog, "Reader"), "Edit", "Reader"));
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(bodyOf(patches()[1])).toEqual({ permissions: { ...ALL_OFF, create: true, edit: true } });
  });

  it("failure: PATCH 403 -> role=alert in the card, after the refetch the switch returns to the server value; the next press clears the alert", async () => {
    let outcome: "fail" | "ok" = "fail";
    const fetchMock = fetchFor(() => [GROUP_ADMIN], () => ROLES, (url, method) => {
      if (url !== roleUrl(GROUP_ADMIN, READER) || method !== "PATCH") return null;
      return outcome === "fail" ? fail(403, "forbidden") : ok({ ...READER, permissions: { ...READER.permissions, edit: true } });
    });
    const dialog = await openRoles(GROUP_ADMIN, fetchMock, "Reader");
    const reader = region(dialog, "Reader");
    fireEvent.click(flagSwitch(reader, "Create", "Reader"));
    const alert = await within(reader).findByRole("alert");
    expect(alert).toHaveTextContent(i18n.t("errors.forbidden", { defaultValue: i18n.t("errors.fallback") }));
    await waitFor(() => expect(flagSwitch(reader, "Create", "Reader")).not.toBeChecked());

    outcome = "ok";
    await waitFor(() => expect(flagSwitch(reader, "Edit", "Reader")).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(flagSwitch(reader, "Edit", "Reader"));
    await waitFor(() => expect(within(reader).queryByRole("alert")).not.toBeInTheDocument());
  });

  it("rename: pencil -> name input (prefilled, accessible name \"Name of Reader\") -> Save sends {name} (trimmed); 409 -> alert in the card; 400 invalid_name -> the role-name sentence; cleared -> Save disabled; Cancel sends nothing", async () => {
    const outcomes = [fail(409, "role_name_taken"), fail(400, "invalid_name")];
    const fetchMock = fetchFor(() => [GROUP_ADMIN], () => ROLES, (url, method) =>
      url === roleUrl(GROUP_ADMIN, READER) && method === "PATCH" ? (outcomes.shift() ?? null) : null,
    );
    const dialog = await openRoles(GROUP_ADMIN, fetchMock, "Reader");
    const reader = region(dialog, "Reader");
    const url = roleUrl(GROUP_ADMIN, READER);

    fireEvent.click(within(reader).getByRole("button", { name: "Rename Reader" }));
    const input = within(reader).getByRole("textbox", { name: "Name of Reader" });
    expect(input).toHaveValue("Reader");
    fireEvent.click(within(reader).getByRole("button", { name: "Cancel" }));
    expect(within(reader).queryByRole("textbox")).not.toBeInTheDocument();
    expect(callsTo(fetchMock, "PATCH", url)).toHaveLength(0);

    fireEvent.click(within(reader).getByRole("button", { name: "Rename Reader" }));
    fireEvent.change(within(reader).getByRole("textbox", { name: "Name of Reader" }), { target: { value: "  Writers " } });
    fireEvent.click(within(reader).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", url)).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, "PATCH", url)[0])).toEqual({ name: "Writers" });
    expect(await within(reader).findByRole("alert")).toHaveTextContent(i18n.t("errors.role_name_taken"));

    fireEvent.click(within(reader).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", url)).toHaveLength(2));
    await waitFor(() => expect(within(reader).getByRole("alert")).toHaveTextContent("Role names must be 1–40 characters."));

    fireEvent.change(within(reader).getByRole("textbox", { name: "Name of Reader" }), { target: { value: "   " } });
    expect(within(reader).getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("the rename form's save / cancel are icon buttons (no visible text, accessible names Save / Cancel), save is a submit, both come after the input (form's far right; role card)", async () => {
    const dialog = await openRoles(GROUP_ADMIN, fetchFor(() => [GROUP_ADMIN], () => ROLES), "Reader");
    const reader = region(dialog, "Reader");
    fireEvent.click(within(reader).getByRole("button", { name: "Rename Reader" }));
    const input = within(reader).getByRole("textbox", { name: "Name of Reader" });
    const save = within(reader).getByRole("button", { name: "Save" });
    const cancel = within(reader).getByRole("button", { name: "Cancel" });
    expect(save.textContent).toBe("");
    expect(cancel.textContent).toBe("");
    expect(save).toHaveAttribute("type", "submit");
    expect(input.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(save.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("while the rename request is pending: the six switches are also disabled (when variables.permissions is absent the cached values are used, the values don't flip)", async () => {
    const fetchMock = fetchFor(() => [GROUP_ADMIN], () => ROLES, (url, method) =>
      url === roleUrl(GROUP_ADMIN, READER) && method === "PATCH" ? new Promise<Response>(() => {}) : null,
    );
    const dialog = await openRoles(GROUP_ADMIN, fetchMock, "Reader");
    const reader = region(dialog, "Reader");
    fireEvent.click(within(reader).getByRole("button", { name: "Rename Reader" }));
    fireEvent.change(within(reader).getByRole("textbox", { name: "Name of Reader" }), { target: { value: "Writers" } });
    fireEvent.click(within(reader).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", roleUrl(GROUP_ADMIN, READER))).toHaveLength(1));
    for (const label of FLAG_LABELS) {
      expect(flagSwitch(reader, label, "Reader")).toHaveAttribute("aria-disabled", "true");
      expect(flagSwitch(reader, label, "Reader")).not.toBeChecked();
    }
  });

  it("delete: the red trash opens a confirm dialog (member count note, destructive confirm) -> DELETE -> after the refetch the card disappears; a role with no members shows descriptionEmpty", async () => {
    const EMPTY = customRole({ id: "44444444-4444-4444-4444-444444444444", name: "Empty", memberCount: 0 });
    let roles: GroupRoleDto[] = [...ROLES, EMPTY];
    const fetchMock = fetchFor(() => [GROUP_ADMIN], () => roles, (url, method) => {
      if (url === roleUrl(GROUP_ADMIN, READER) && method === "DELETE") {
        roles = roles.filter((r) => r.id !== READER.id);
        return fakeResponse({ ok: true, status: 204 });
      }
      return null;
    });
    const dialog = await openRoles(GROUP_ADMIN, fetchMock, "Empty");
    fireEvent.click(within(region(dialog, "Empty")).getByRole("button", { name: "Delete Empty" }));
    const emptyConfirm = await screen.findByRole("dialog", { name: "Delete role?" });
    expect(emptyConfirm).toHaveTextContent("Nobody has this role.");
    fireEvent.click(within(emptyConfirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete role?" })).not.toBeInTheDocument());

    fireEvent.click(within(region(dialog, "Reader")).getByRole("button", { name: "Delete Reader" }));
    const confirm = await screen.findByRole("dialog", { name: "Delete role?" });
    expect(confirm).toHaveTextContent("2 members who have this role will become Members.");
    const confirmButton = within(confirm).getByRole("button", { name: "Delete role" });
    expect(confirmButton.className).toContain("bg-destructive");
    fireEvent.click(confirmButton);
    await waitFor(() => expect(callsTo(fetchMock, "DELETE", roleUrl(GROUP_ADMIN, READER))).toHaveLength(1));
    await waitFor(() => expect(within(dialog).queryByRole("region", { name: "Reader" })).not.toBeInTheDocument());
  });

  it("new role dialog: clicking outside doesn't close; six switches all off and no Read; blank name -> Create disabled; the submit button in the dialog is still brandDeep; success POSTs {name, six keys} and closes", async () => {
    const outcomes = [fail(409, "role_name_taken"), ok(customRole({ id: "55555555-5555-5555-5555-555555555555", name: "Reviewers" }), 201)];
    const fetchMock = fetchFor(() => [GROUP_ADMIN], () => ROLES, (url, method) =>
      url === rolesListUrl(GROUP_ADMIN) && method === "POST" ? (outcomes.shift() ?? null) : null,
    );
    const dialog = await openRoles(GROUP_ADMIN, fetchMock);
    fireEvent.click(within(dialog).getByRole("button", { name: "New role" }));
    const newDialog = await screen.findByRole("dialog", { name: "New role" });
    fireEvent.change(within(newDialog).getByRole("textbox", { name: "Role name" }), { target: { value: "Keep" } });
    await clickOutside();
    expect(screen.getByRole("dialog", { name: "New role" })).toBeInTheDocument();

    const switches = within(newDialog).getAllByRole("switch");
    expect(switches).toHaveLength(6);
    for (const sw of switches) expect(sw).not.toBeChecked();
    const submit = within(newDialog).getByRole("button", { name: "Create" });
    expect(submit.className).toContain("bg-brand-deep");
    fireEvent.change(within(newDialog).getByRole("textbox", { name: "Role name" }), { target: { value: "  " } });
    expect(submit).toBeDisabled();
    fireEvent.change(within(newDialog).getByRole("textbox", { name: "Role name" }), { target: { value: "Reviewers" } });
    fireEvent.click(within(newDialog).getByRole("switch", { name: "Create" }));
    expect(within(newDialog).getByRole("switch", { name: "Edit" })).not.toBeChecked();

    const expected = { name: "Reviewers", permissions: { ...ALL_OFF, create: true } };
    fireEvent.click(submit);
    await waitFor(() => expect(callsTo(fetchMock, "POST", rolesListUrl(GROUP_ADMIN))).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, "POST", rolesListUrl(GROUP_ADMIN))[0])).toEqual(expected);
    expect(await within(newDialog).findByRole("alert")).toHaveTextContent(i18n.t("errors.role_name_taken"));
    fireEvent.click(submit);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New role" })).not.toBeInTheDocument());
  });

  it("read-only view (no canManageGroup): no New role, no pencil / trash; all 18 switches natively disabled; the note is descriptionView; no admin-lock note", async () => {
    const dialog = await openRoles(GROUP_MEMBER, fetchFor(() => [GROUP_MEMBER], () => ROLES), "Reader");
    expect(within(dialog).queryByRole("button", { name: "New role" })).not.toBeInTheDocument();
    expect(within(dialog).queryAllByRole("button", { name: /^(Rename|Delete) / })).toHaveLength(0);
    const switches = within(dialog).getAllByRole("switch");
    expect(switches).toHaveLength(18);
    for (const sw of switches) expect(sw).toBeDisabled();
    expect(
      within(dialog).getByText("Each member has one role, and the role decides what they can do. Only people whose role can manage roles and the group can change these."),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(ADMIN_LOCKED)).not.toBeInTheDocument();
  });

  it("my custom role Leads has Manage roles & group turned off -> GET /api/groups returns canManageGroup false -> the page immediately becomes read-only", async () => {
    const LEADS = customRole({ id: "66666666-6666-6666-6666-666666666666", name: "Leads", memberCount: 1, permissions: { read: true, ...ALL_OFF, manageGroup: true } });
    let group: GroupDto = groupDto({ id: GROUP_ADMIN.id, name: "Team Alpha" }, LEADS);
    let roles: GroupRoleDto[] = [ADMIN_ROLE, MEMBER_ROLE, LEADS];
    const fetchMock = fetchFor(() => [group], () => roles, (url, method) => {
      if (url === `/api/groups/${group.id}/roles/${LEADS.id}` && method === "PATCH") {
        const demoted = { ...LEADS, permissions: { ...LEADS.permissions, manageGroup: false } };
        roles = [ADMIN_ROLE, MEMBER_ROLE, demoted];
        group = groupDto({ id: GROUP_ADMIN.id, name: "Team Alpha" }, demoted);
        return ok(demoted);
      }
      return null;
    });
    const dialog = await openRoles(group, fetchMock, "Leads");
    fireEvent.click(flagSwitch(region(dialog, "Leads"), "Manage roles & group", "Leads"));
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: "New role" })).not.toBeInTheDocument());
    for (const sw of within(dialog).getAllByRole("switch")) expect(sw).toBeDisabled();
    expect(bodyOf(callsTo(fetchMock, "PATCH", `/api/groups/${group.id}/roles/${LEADS.id}`)[0])).toEqual({ permissions: ALL_OFF });
  });
});

const DELETE_DESCRIPTION = "Move the group's notes to the trash. With Edit as well, also restore them from the trash or delete them permanently.";
const DELETE_HINT = "Without Edit, notes deleted with this role can't be restored from the trash by its holders.";
const DELETER = customRole({ id: "66666666-6666-6666-6666-666666666666", name: "Deleter", permissions: { ...READER.permissions, delete: true } });
const EDIT_DELETER = customRole({ id: "77777777-7777-7777-7777-777777777777", name: "Curators", permissions: { ...READER.permissions, edit: true, delete: true } });
/** Data that never occurs (the built-in admin always has all flags), used only to pin `!isAdmin`: the admin card never shows the hint. */
const ODD_ADMIN = adminRole({ id: ADMIN_ROLE.id, permissions: { ...ADMIN_ROLE.permissions, edit: false } });

describe("SettingsGroupRolesSection: trash-related notes and hints (#181)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("the Delete note in the description area has the new wording (moves to trash; Edit as well is needed to restore / permanently delete)", async () => {
    const dialog = await openRoles(GROUP_ADMIN, fetchFor(() => [GROUP_ADMIN], () => ROLES), "Reader");
    const legend = within(dialog).getByRole("heading", { level: 2, name: "What each permission allows" }).closest("section");
    expect(legend).not.toBeNull();
    const term = within(legend as HTMLElement).getByText("Delete", { selector: "dt" });
    expect(term.nextElementSibling).toHaveTextContent(DELETE_DESCRIPTION);
  });

  it("a custom role card with delete but no edit has the hint; edit + delete doesn't; the built-in admin (even if data is delete without edit) doesn't; a Member with only Edit doesn't", async () => {
    const roles = [ODD_ADMIN, MEMBER_ROLE, DELETER, EDIT_DELETER];
    const dialog = await openRoles(GROUP_ADMIN, fetchFor(() => [GROUP_ADMIN], () => roles), "Curators");
    expect(within(region(dialog, "Deleter")).getByText(DELETE_HINT, { exact: true })).toHaveClass("text-xs", "text-muted-foreground");
    expect(within(region(dialog, "Curators")).queryByText(DELETE_HINT)).not.toBeInTheDocument();
    expect(within(region(dialog, "Admin")).queryByText(DELETE_HINT)).not.toBeInTheDocument();
    expect(within(region(dialog, "Member")).queryByText(DELETE_HINT)).not.toBeInTheDocument();
    expect(within(dialog).getAllByText(DELETE_HINT)).toHaveLength(1);
    expect(flagSwitch(region(dialog, "Deleter"), "Edit", "Deleter")).not.toBeDisabled();
  });

  it("read-only view (no canManageGroup): the Deleter card still has the hint (on purpose: members holding this role are themselves affected by this consequence)", async () => {
    const roles = [ADMIN_ROLE, MEMBER_ROLE, DELETER];
    const dialog = await openRoles(GROUP_MEMBER, fetchFor(() => [GROUP_MEMBER], () => roles), "Deleter");
    expect(flagSwitch(region(dialog, "Deleter"), "Delete", "Deleter")).toBeDisabled();
    expect(within(region(dialog, "Deleter")).getByText(DELETE_HINT, { exact: true })).toBeInTheDocument();
  });

  it("while pending the hint is judged by the submitted value: Curators turns off Edit, PATCH hanging -> the hint appears immediately; after settle it follows the server value", async () => {
    let roles = [ADMIN_ROLE, MEMBER_ROLE, EDIT_DELETER];
    let release: (r: Response) => void = () => {};
    const fetchMock = fetchFor(() => [GROUP_ADMIN], () => roles, (url, method) =>
      url === roleUrl(GROUP_ADMIN, EDIT_DELETER) && method === "PATCH" ? new Promise<Response>((resolve) => (release = resolve)) : null,
    );
    const dialog = await openRoles(GROUP_ADMIN, fetchMock, "Curators");
    expect(within(region(dialog, "Curators")).queryByText(DELETE_HINT)).not.toBeInTheDocument();
    fireEvent.click(flagSwitch(region(dialog, "Curators"), "Edit", "Curators"));
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", roleUrl(GROUP_ADMIN, EDIT_DELETER))).toHaveLength(1));
    expect(within(region(dialog, "Curators")).getByText(DELETE_HINT, { exact: true })).toBeInTheDocument();
    const updated = { ...EDIT_DELETER, permissions: { ...EDIT_DELETER.permissions, edit: false } };
    roles = [ADMIN_ROLE, MEMBER_ROLE, updated];
    release(ok(updated));
    await waitFor(() => expect(flagSwitch(region(dialog, "Curators"), "Edit", "Curators")).not.toHaveAttribute("aria-disabled"));
    expect(within(region(dialog, "Curators")).getByText(DELETE_HINT, { exact: true })).toBeInTheDocument();
  });

  it("new role dialog: turning on Delete -> the hint appears; then turning on Edit -> it disappears", async () => {
    const dialog = await openRoles(GROUP_ADMIN, fetchFor(() => [GROUP_ADMIN], () => ROLES));
    fireEvent.click(within(dialog).getByRole("button", { name: "New role" }));
    const newDialog = await screen.findByRole("dialog", { name: "New role" });
    expect(within(newDialog).queryByText(DELETE_HINT)).not.toBeInTheDocument();
    fireEvent.click(within(newDialog).getByRole("switch", { name: "Delete" }));
    expect(within(newDialog).getByText(DELETE_HINT, { exact: true })).toBeInTheDocument();
    fireEvent.click(within(newDialog).getByRole("switch", { name: "Edit" }));
    expect(within(newDialog).queryByText(DELETE_HINT)).not.toBeInTheDocument();
  });
});

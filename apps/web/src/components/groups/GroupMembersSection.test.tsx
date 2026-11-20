import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { avatarUrl, type GroupDto, type GroupRoleDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts } from "@/components/ui/toast";
import { chooseOption, displayedLabel, optionLabels, selectedValue } from "@/test/ui-select";
import { ADMIN_ROLE, BG_NOTE, GROUP_ADMIN, GROUP_CO_ADMIN, GROUP_MEMBER, ME, MEMBER_ROLE, ROLES, callsTo, fail, fakeResponse, groupFetch, locationText, member, ok, renderGroupRoute } from "./group-test-utils";

// Group modal "Members" page (`/groups/:id`, #247). The background sidebar's group section reads the same `useGroups()` cache and renders the same group names,
// so always use `within(dialog)` to avoid matching the background layer.

const ROLE_LABELS = ["Admin", "Member"];

describe("GroupMembersSection (/groups/:id, #247)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("column widths: the name and email columns are allotted 1 : 1.5 (real mount)", async () => {
    const members = [member(ME.id, ME.email, "Me", ADMIN_ROLE)];
    renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, groupFetch(() => [GROUP_ADMIN], () => members));
    const dialog = await screen.findByRole("dialog", { name: GROUP_ADMIN.name });
    const table = await within(dialog).findByRole("table", { name: "Members" });
    expect(table.style.getPropertyValue("--kb-table-cols")).toBe("minmax(14ch,1fr) minmax(14ch,1.5fr) max-content 2.75rem");
  });

  it("canManageMembers: the member table has email, a role dropdown (options from GET .../roles), a remove button; the add form", async () => {
    const group = { ...GROUP_ADMIN };
    const members = [member(ME.id, ME.email, "Me", ADMIN_ROLE), member("u-bob", "bob@example.com", "Bob", MEMBER_ROLE)];
    const fetchMock = groupFetch(() => [GROUP_ADMIN], () => members, (url, method) => {
      if (url === "/api/groups" && method === "GET") return ok([group]);
      return null;
    });

    renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, fetchMock);

    const dialog = await screen.findByRole("dialog", { name: GROUP_ADMIN.name });
    // first load of the group section's lazy chunk in this file (the dialog shell is in the first bundle, no need to wait)
    await within(dialog).findByRole("heading", { level: 1, name: "Members" });
    await waitFor(() => expect(within(dialog).getByText("bob@example.com")).toBeInTheDocument());

    expect(within(dialog).getByText("bob@example.com")).toBeInTheDocument();
    expect(within(dialog).getByText("me@example.com")).toBeInTheDocument();
    const bobSelect = within(dialog).getByLabelText("Role for bob@example.com");
    await waitFor(() => expect(bobSelect).not.toBeDisabled());
    expect(await optionLabels(bobSelect)).toEqual(ROLE_LABELS);
    expect(selectedValue(bobSelect)).toBe(MEMBER_ROLE.id);
    expect(selectedValue(within(dialog).getByLabelText("Role for me@example.com"))).toBe(ADMIN_ROLE.id);
    expect(within(dialog).getByRole("button", { name: "Remove bob@example.com" })).toBeInTheDocument();
    expect(callsTo(fetchMock, "GET", `/api/groups/${GROUP_ADMIN.id}/roles`).length).toBeGreaterThanOrEqual(1);

    expect(within(dialog).getByLabelText("Email address")).toBeInTheDocument();
    expect(await optionLabels(within(dialog).getByLabelText("Role for new member"))).toEqual(ROLE_LABELS);
    expect(within(dialog).getByRole("button", { name: "Add" })).toBeInTheDocument();
  });

  it("#183 long email: the row name = email, the remove button's visible text excludes the email (its accessible name carries it); table name Members, column names Name/Email/Role/Actions", async () => {
    // Column width (wrap-anywhere, 14ch minimum, horizontal scroll inside the frame) is covered by SettingsTable.test.tsx and e2e 26-settings-tables.
    const LONG = "e2e-24c8c7dd-e54e-4237-9f72-a87df48a3fc2@e2e.local";
    renderGroupRoute(
      `/groups/${GROUP_CO_ADMIN.id}`,
      groupFetch(() => [GROUP_CO_ADMIN], () => [
        member(ME.id, ME.email, "Me", ADMIN_ROLE),
        member("u-long", LONG, "A-very-long-display-name-without-any-spaces-at-all", MEMBER_ROLE),
      ]),
    );
    const dialog = await screen.findByRole("dialog", { name: GROUP_CO_ADMIN.name });
    const row = await within(dialog).findByRole("row", { name: LONG });
    expect(within(row).getByRole("cell", { name: "A-very-long-display-name-without-any-spaces-at-all" })).toBeInTheDocument();
    const removeButton = within(row).getByRole("button", { name: `Remove ${LONG}` });
    expect(removeButton.textContent ?? "").not.toContain(LONG);
    expect(removeButton.textContent ?? "").not.toContain("@");
    const table = within(dialog).getByRole("table", { name: "Members" });
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Name", "Email", "Role", "Actions"]);
  });

  it("last admin's row (the builtin admin is one person): the role dropdown is disabled, the remove button aria-disabled, both title=lastAdminHint, and a visible hint under the table; with two admins nothing is disabled and there is no hint", async () => {
    const HINT = "The only admin can't be demoted or removed. Make someone else an admin first.";
    const phase1 = renderGroupRoute(
      `/groups/${GROUP_ADMIN.id}`,
      groupFetch(() => [GROUP_ADMIN], () => [member(ME.id, ME.email, "Me", ADMIN_ROLE), member("u-bob", "bob@example.com", "Bob", MEMBER_ROLE)]),
    );
    const dialog = await screen.findByRole("dialog", { name: GROUP_ADMIN.name });
    await waitFor(() => expect(within(dialog).getByText("bob@example.com")).toBeInTheDocument());

    const meRoleSelect = within(dialog).getByLabelText("Role for me@example.com");
    expect(meRoleSelect).toBeDisabled();
    expect(meRoleSelect).toHaveAttribute("title", HINT);
    const meRemoveButton = within(dialog).getByRole("button", { name: "Remove me@example.com" });
    expect(meRemoveButton).toHaveAttribute("aria-disabled", "true");
    expect(meRemoveButton).toHaveAttribute("title", HINT);
    expect(within(dialog).getByText(HINT)).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Role for bob@example.com")).not.toBeDisabled();

    phase1.unmount();
    vi.unstubAllGlobals();

    renderGroupRoute(
      `/groups/${GROUP_CO_ADMIN.id}`,
      groupFetch(() => [GROUP_CO_ADMIN], () => [member(ME.id, ME.email, "Me", ADMIN_ROLE), member("u-bob", "bob@example.com", "Bob", ADMIN_ROLE)]),
    );
    const dialog2 = await screen.findByRole("dialog", { name: GROUP_CO_ADMIN.name });
    await waitFor(() => expect(within(dialog2).getByText("bob@example.com")).toBeInTheDocument());

    expect(within(dialog2).getByLabelText("Role for me@example.com")).not.toBeDisabled();
    expect(within(dialog2).getByLabelText("Role for bob@example.com")).not.toBeDisabled();
    expect(within(dialog2).getByRole("button", { name: "Remove me@example.com" })).not.toHaveAttribute("aria-disabled");
    expect(within(dialog2).getByRole("button", { name: "Remove bob@example.com" })).not.toHaveAttribute("aria-disabled");
    expect(within(dialog2).queryByText(HINT)).not.toBeInTheDocument();
  });

  it("add member: PUT {email, roleId} (choosing admin in the dropdown -> the admin role id) -> list updates; after submit the dropdown returns to the built-in member's id; 409 already_member -> alert under the form", async () => {
    let members = [member(ME.id, ME.email, "Me", ADMIN_ROLE)];
    const fetchMock = groupFetch(() => [GROUP_ADMIN], () => members, (url, method, init) => {
      if (url === `/api/groups/${GROUP_ADMIN.id}/members` && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as { email: string; roleId?: string };
        if (body.email === "dup@example.com") return fail(409, "already_member");
        const role = ROLES.find((r) => r.id === body.roleId) ?? MEMBER_ROLE;
        const added = member("u-carol", body.email, "Carol", role);
        members = [...members, added];
        return ok(added, 201);
      }
      return null;
    });

    renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog", { name: GROUP_ADMIN.name });
    const roleSelect = await within(dialog).findByLabelText("Role for new member");
    await waitFor(() => expect(selectedValue(roleSelect)).toBe(MEMBER_ROLE.id));

    fireEvent.change(within(dialog).getByLabelText("Email address"), { target: { value: "carol@example.com" } });
    await chooseOption(roleSelect, "Admin");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    const url = `/api/groups/${GROUP_ADMIN.id}/members`;
    await waitFor(() => expect(callsTo(fetchMock, "PUT", url)).toHaveLength(1));
    expect(JSON.parse(String(callsTo(fetchMock, "PUT", url)[0].body))).toEqual({ email: "carol@example.com", roleId: ADMIN_ROLE.id });
    await waitFor(() => expect(within(dialog).getByText("carol@example.com")).toBeInTheDocument());
    expect(selectedValue(within(dialog).getByLabelText("Role for carol@example.com"))).toBe(ADMIN_ROLE.id);
    expect(selectedValue(roleSelect)).toBe(MEMBER_ROLE.id);

    // 409 already_member -> alert under the form; this request uses the reset default role.
    fireEvent.change(within(dialog).getByLabelText("Email address"), { target: { value: "dup@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("That person is already in this group.");
    expect(JSON.parse(String(callsTo(fetchMock, "PUT", url)[1].body))).toEqual({ email: "dup@example.com", roleId: MEMBER_ROLE.id });
  });

  it("add member: typing a few characters -> suggestion list (existing members not listed) -> selecting fills the email (multi-address field: appends \", \") -> submit PUT carries the selected email", async () => {
    const members = [member(ME.id, ME.email, "Me", ADMIN_ROLE), member("u-bob", "bob@example.com", "Bob Example", MEMBER_ROLE)];
    const fetchMock = groupFetch(() => [GROUP_ADMIN], () => members, (url, method) => {
      if (url === "/api/users/suggest?q=ex" && method === "GET") {
        return ok({
          users: [
            { userId: "u-bob", email: "bob@example.com", displayName: "Bob Example" },
            { userId: "u-carol", email: "carol@example.com", displayName: "Carol Example" },
          ],
        });
      }
      if (url === `/api/groups/${GROUP_ADMIN.id}/members` && method === "PUT") return ok(member("u-carol", "carol@example.com", "Carol Example", MEMBER_ROLE), 201);
      return null;
    });

    renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog", { name: GROUP_ADMIN.name });
    const roleSelect = await within(dialog).findByLabelText("Role for new member");
    await waitFor(() => expect(selectedValue(roleSelect)).toBe(MEMBER_ROLE.id));
    const box = within(dialog).getByRole("combobox", { name: "Email address" });
    // #331 several addresses: text + inputMode email, #331's placeholder and description
    expect(box).toHaveAttribute("type", "text");
    expect(box).toHaveAttribute("inputmode", "email");
    expect(box).toHaveAttribute("placeholder", "Email addresses (separate several with commas)");
    expect(box).toHaveAccessibleDescription(/You can enter several addresses at once/);
    fireEvent.change(box, { target: { value: "ex" } });
    const list = await within(dialog).findByRole("listbox", { name: "People you know" });
    const options = within(list).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveAccessibleName("Carol Examplecarol@example.com");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box).toHaveValue("carol@example.com, ");
    expect(callsTo(fetchMock, "PUT", `/api/groups/${GROUP_ADMIN.id}/members`)).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    const url = `/api/groups/${GROUP_ADMIN.id}/members`;
    await waitFor(() => expect(callsTo(fetchMock, "PUT", url)).toHaveLength(1));
    expect(JSON.parse(String(callsTo(fetchMock, "PUT", url)[0].body))).toEqual({ email: "carol@example.com", roleId: MEMBER_ROLE.id });
  });

  it("add member: when roles has not arrived roleId is not sent (body is only {email}, the server defaults to the built-in member)", async () => {
    const members = [member(ME.id, ME.email, "Me", ADMIN_ROLE)];
    const fetchMock = groupFetch(() => [GROUP_ADMIN], () => members, (url, method) => {
      if (url === `/api/groups/${GROUP_ADMIN.id}/roles` && method === "GET") return new Promise<Response>(() => {});
      if (url === `/api/groups/${GROUP_ADMIN.id}/members` && method === "PUT") return ok(member("u-carol", "carol@example.com", "Carol", MEMBER_ROLE), 201);
      return null;
    });

    renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog", { name: GROUP_ADMIN.name });
    await waitFor(() => expect(within(dialog).getByLabelText("Email address")).toBeInTheDocument());
    fireEvent.change(within(dialog).getByLabelText("Email address"), { target: { value: "carol@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    const url = `/api/groups/${GROUP_ADMIN.id}/members`;
    await waitFor(() => expect(callsTo(fetchMock, "PUT", url)).toHaveLength(1));
    expect(JSON.parse(String(callsTo(fetchMock, "PUT", url)[0].body))).toEqual({ email: "carol@example.com" });
  });

  it("change role: PATCH /members/:userId {roleId: admin role id}; remove: DELETE /members/:userId after confirmation", async () => {
    let members = [
      member(ME.id, ME.email, "Me", ADMIN_ROLE),
      member("u-bob", "bob@example.com", "Bob", ADMIN_ROLE),
      member("u-carol", "carol@example.com", "Carol", MEMBER_ROLE),
    ];
    const fetchMock = groupFetch(() => [GROUP_CO_ADMIN], () => members, (url, method) => {
      if (url === `/api/groups/${GROUP_CO_ADMIN.id}/members/u-carol` && method === "PATCH") {
        members = members.map((m) => (m.userId === "u-carol" ? { ...m, roleId: ADMIN_ROLE.id, builtin: "admin" } : m));
        return ok(members[2]);
      }
      if (url === `/api/groups/${GROUP_CO_ADMIN.id}/members/u-bob` && method === "DELETE") {
        members = members.filter((m) => m.userId !== "u-bob");
        return fakeResponse({ ok: true, status: 204 });
      }
      return null;
    });

    renderGroupRoute(`/groups/${GROUP_CO_ADMIN.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog", { name: GROUP_CO_ADMIN.name });
    const carolSelect = await within(dialog).findByLabelText("Role for carol@example.com");
    await waitFor(() => expect(carolSelect).not.toBeDisabled());
    expect(await optionLabels(carolSelect)).toEqual(ROLE_LABELS);

    await chooseOption(carolSelect, "Admin");
    const patchUrl = `/api/groups/${GROUP_CO_ADMIN.id}/members/u-carol`;
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", patchUrl)).toHaveLength(1));
    expect(JSON.parse(String(callsTo(fetchMock, "PATCH", patchUrl)[0].body))).toEqual({ roleId: ADMIN_ROLE.id });

    // Remove: a confirmation first (#395), DELETE only after confirming.
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove bob@example.com" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Remove member?" })).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(callsTo(fetchMock, "DELETE", `/api/groups/${GROUP_CO_ADMIN.id}/members/u-bob`)).toHaveLength(1));
    await waitFor(() => expect(within(dialog).queryByText("bob@example.com")).not.toBeInTheDocument());
  });

  it("#175: in a group with two admins and no ordinary member, demoting one to member: PATCH body is {roleId: member role id}", async () => {
    let members = [member(ME.id, ME.email, "Me", ADMIN_ROLE), member("u-bob", "bob@example.com", "Bob", ADMIN_ROLE)];
    const fetchMock = groupFetch(() => [GROUP_CO_ADMIN], () => members, (url, method) => {
      if (url === `/api/groups/${GROUP_CO_ADMIN.id}/members/u-bob` && method === "PATCH") {
        members = members.map((m) => (m.userId === "u-bob" ? { ...m, roleId: MEMBER_ROLE.id, builtin: "member" } : m));
        return ok(members[1]);
      }
      return null;
    });

    renderGroupRoute(`/groups/${GROUP_CO_ADMIN.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog", { name: GROUP_CO_ADMIN.name });
    const bobSelect = await within(dialog).findByLabelText("Role for bob@example.com");
    // The list has no ordinary member - the member role id can only come from GET .../roles
    await waitFor(() => expect(bobSelect).not.toBeDisabled());
    expect(await optionLabels(bobSelect)).toEqual(ROLE_LABELS);
    expect(bobSelect).not.toBeDisabled();

    await chooseOption(bobSelect, "Member");
    const patchUrl = `/api/groups/${GROUP_CO_ADMIN.id}/members/u-bob`;
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", patchUrl)).toHaveLength(1));
    expect(JSON.parse(String(callsTo(fetchMock, "PATCH", patchUrl)[0].body))).toEqual({ roleId: MEMBER_ROLE.id });
    // After the demotion only I am admin: my row is locked
    await waitFor(() => expect(within(dialog).getByLabelText("Role for me@example.com")).toBeDisabled());
    expect(selectedValue(within(dialog).getByLabelText("Role for bob@example.com"))).toBe(MEMBER_ROLE.id);
  });

  it("roles has not arrived: the row's role trigger shows the current role text and is disabled, with only that option", async () => {
    const fetchMock = groupFetch(() => [GROUP_ADMIN], () => [member("u-bob", "bob@example.com", "Bob", MEMBER_ROLE)], (url, method) => {
      if (url === `/api/groups/${GROUP_ADMIN.id}/roles` && method === "GET") return new Promise<Response>(() => {}) as unknown as Response;
      return null;
    });
    renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog", { name: GROUP_ADMIN.name });
    const bobSelect = await within(dialog).findByLabelText("Role for bob@example.com");
    expect(displayedLabel(bobSelect)).toBe("Member");
    expect(selectedValue(bobSelect)).toBe(MEMBER_ROLE.id);
    expect(bobSelect).toBeDisabled();
  });

  it("member's view: the member table is read-only (role names via roles: built-ins i18n, custom ones by name), no add form", async () => {
    const READER: GroupRoleDto = { ...MEMBER_ROLE, id: "33333333-3333-3333-3333-333333333333", builtin: null, name: "Reader" };
    const members = [
      member("u-admin2", "admin2@example.com", "Admin2", ADMIN_ROLE),
      member(ME.id, ME.email, "Me", MEMBER_ROLE),
      member("u-dan", "dan@example.com", "Dan", READER),
    ];
    const fetchMock = groupFetch(() => [GROUP_MEMBER], () => members, (url, method) => {
      if (url === `/api/groups/${GROUP_MEMBER.id}/roles` && method === "GET") return ok([...ROLES, READER]);
      return null;
    });

    renderGroupRoute(`/groups/${GROUP_MEMBER.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog", { name: GROUP_MEMBER.name });
    await waitFor(() => expect(within(dialog).getByText("admin2@example.com")).toBeInTheDocument());

    expect(within(dialog).queryByLabelText(/Role for/)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
    // Without manage rights the role column is plain text (fixed): find the row by its name (email) and the role by the cell's accessible name.
    const rowOf = (email: string) => within(within(dialog).getByRole("row", { name: email }));
    expect(rowOf("admin2@example.com").getByRole("cell", { name: "Admin" })).toBeInTheDocument();
    expect(rowOf("me@example.com").getByRole("cell", { name: "Member" })).toBeInTheDocument();
    await waitFor(() => expect(rowOf("dan@example.com").getByRole("cell", { name: "Reader" })).toBeInTheDocument());
    expect(within(within(dialog).getByRole("table", { name: "Members" })).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "Name",
      "Email",
      "Role",
    ]);
    expect(within(dialog).queryByText("[object Object]", { exact: false })).not.toBeInTheDocument();

    expect(within(dialog).queryByLabelText("Email address")).not.toBeInTheDocument();
  });

  it("the two management flags are separate: with only canManageMembers -> role dropdown/remove/add; with only canManageGroup -> member table read-only, no add", async () => {
    const members = [member("u-admin2", "admin2@example.com", "Admin2", ADMIN_ROLE), member(ME.id, ME.email, "Me", MEMBER_ROLE)];
    const membersOnly: GroupDto = { ...GROUP_MEMBER, canManageMembers: true, canManageGroup: false };
    const phase1 = renderGroupRoute(`/groups/${membersOnly.id}`, groupFetch(() => [membersOnly], () => members));
    const dialog = await screen.findByRole("dialog", { name: membersOnly.name });
    await waitFor(() => expect(within(dialog).getByText("admin2@example.com")).toBeInTheDocument());
    expect(within(dialog).getByLabelText("Role for admin2@example.com")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Remove admin2@example.com" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Email address")).toBeInTheDocument();

    phase1.unmount();
    vi.unstubAllGlobals();

    const groupOnly: GroupDto = { ...GROUP_MEMBER, canManageMembers: false, canManageGroup: true };
    renderGroupRoute(`/groups/${groupOnly.id}`, groupFetch(() => [groupOnly], () => members));
    const dialog2 = await screen.findByRole("dialog", { name: groupOnly.name });
    await waitFor(() => expect(within(dialog2).getByText("admin2@example.com")).toBeInTheDocument());
    expect(within(dialog2).queryByLabelText(/Role for/)).not.toBeInTheDocument();
    expect(within(dialog2).queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
    expect(within(dialog2).queryByLabelText("Email address")).not.toBeInTheDocument();
  });

  describe("#395 confirmation before removing a member", () => {
    const BOB = member("u-bob", "bob@example.com", "Bob", MEMBER_ROLE);
    const bobUrl = `/api/groups/${GROUP_CO_ADMIN.id}/members/u-bob`;
    const meUrl = `/api/groups/${GROUP_CO_ADMIN.id}/members/${ME.id}`;

    function setup(entry: string | { pathname: string; state?: unknown } = `/groups/${GROUP_CO_ADMIN.id}`) {
      let members = [member(ME.id, ME.email, "Me", ADMIN_ROLE), member("u-co", "co@example.com", "Co", ADMIN_ROLE), BOB];
      const fetchMock = groupFetch(() => [GROUP_CO_ADMIN], () => members, (url, method) => {
        if (method === "DELETE" && (url === bobUrl || url === meUrl)) {
          members = members.filter((m) => `/api/groups/${GROUP_CO_ADMIN.id}/members/${m.userId}` !== url);
          return fakeResponse({ ok: true, status: 204 });
        }
        return null;
      });
      renderGroupRoute(entry, fetchMock);
      return fetchMock;
    }

    it("pressing the trash first shows a confirmation carrying the removed person's email; cancel sends no DELETE and the member stays", async () => {
      const fetchMock = setup();
      const dialog = await screen.findByRole("dialog", { name: GROUP_CO_ADMIN.name });
      fireEvent.click(await within(dialog).findByRole("button", { name: "Remove bob@example.com" }));

      const confirm = await screen.findByRole("dialog", { name: "Remove member?" });
      expect(within(confirm).getByText(/bob@example\.com/)).toBeInTheDocument();
      expect(within(confirm).queryByText(/cannot add yourself back/)).not.toBeInTheDocument();
      expect(callsTo(fetchMock, "DELETE", bobUrl)).toHaveLength(0);

      fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Remove member?" })).not.toBeInTheDocument());
      expect(callsTo(fetchMock, "DELETE", bobUrl)).toHaveLength(0);
      expect(within(dialog).getByText("bob@example.com")).toBeInTheDocument();
    });

    it("only confirming sends DELETE; the list updates", async () => {
      const fetchMock = setup();
      const dialog = await screen.findByRole("dialog", { name: GROUP_CO_ADMIN.name });
      fireEvent.click(await within(dialog).findByRole("button", { name: "Remove bob@example.com" }));
      fireEvent.click(within(await screen.findByRole("dialog", { name: "Remove member?" })).getByRole("button", { name: "Remove" }));

      await waitFor(() => expect(callsTo(fetchMock, "DELETE", bobUrl)).toHaveLength(1));
      await waitFor(() => expect(within(dialog).queryByText("bob@example.com")).not.toBeInTheDocument());
      expect(callsTo(fetchMock, "DELETE", meUrl)).toHaveLength(0);
    });

    it("removing yourself: the text says you lose access, unlike a normal removal; confirming DELETEs yourself and returns to the background page", async () => {
      const fetchMock = setup({ pathname: `/groups/${GROUP_CO_ADMIN.id}`, state: { backgroundLocation: BG_NOTE } });
      const dialog = await screen.findByRole("dialog", { name: GROUP_CO_ADMIN.name });
      fireEvent.click(await within(dialog).findByRole("button", { name: "Remove me@example.com" }));

      const confirm = await screen.findByRole("dialog", { name: "Remove yourself?" });
      expect(within(confirm).getByText(/You \(me@example\.com\) will lose access to the notes in "Team Alpha"/)).toBeInTheDocument();
      expect(within(confirm).getByText(/me@example\.com/)).toBeInTheDocument();
      expect(callsTo(fetchMock, "DELETE", meUrl)).toHaveLength(0);

      fireEvent.click(within(confirm).getByRole("button", { name: "Remove me" }));
      await waitFor(() => expect(callsTo(fetchMock, "DELETE", meUrl)).toHaveLength(1));
      await waitFor(() => expect(locationText().startsWith(`${BG_NOTE.pathname}|`)).toBe(true));
    });

    it("removing yourself then cancel: no DELETE, position unchanged", async () => {
      const fetchMock = setup({ pathname: `/groups/${GROUP_CO_ADMIN.id}`, state: { backgroundLocation: BG_NOTE } });
      const dialog = await screen.findByRole("dialog", { name: GROUP_CO_ADMIN.name });
      fireEvent.click(await within(dialog).findByRole("button", { name: "Remove me@example.com" }));
      fireEvent.click(within(await screen.findByRole("dialog", { name: "Remove yourself?" })).getByRole("button", { name: "Cancel" }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(callsTo(fetchMock, "DELETE", meUrl)).toHaveLength(0);
      expect(locationText().startsWith(`/groups/${GROUP_CO_ADMIN.id}|`)).toBe(true);
    });
  });

  it("the last admin's remove button: clicking sends no DELETE (blocked by aria-disabled)", async () => {
    const fetchMock = groupFetch(() => [GROUP_ADMIN], () => [member(ME.id, ME.email, "Me", ADMIN_ROLE), member("u-bob", "bob@example.com", "Bob", MEMBER_ROLE)]);
    renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog", { name: GROUP_ADMIN.name });
    const me = await within(dialog).findByRole("button", { name: "Remove me@example.com" });
    fireEvent.click(me);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(callsTo(fetchMock, "DELETE", `/api/groups/${GROUP_ADMIN.id}/members/${ME.id}`)).toHaveLength(0);
  });
});

describe("GroupMembersSection member avatars", () => {
  const REF = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", v: 3 };

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function renderWith(bob: ReturnType<typeof member>) {
    renderGroupRoute(
      `/groups/${GROUP_ADMIN.id}`,
      groupFetch(() => [GROUP_ADMIN], () => [member(ME.id, ME.email, "Me", ADMIN_ROLE), bob]),
    );
    const dialog = await screen.findByRole("dialog", { name: GROUP_ADMIN.name });
    const name = await within(dialog).findByText("Bob");
    return name.previousElementSibling as HTMLElement;
  }

  it("with an avatar: the sibling before the name is the avatar, the img src carries the version and is lazy, the wrapper is aria-hidden", async () => {
    const avatar = await renderWith({ ...member("u-bob", "bob@example.com", "Bob", MEMBER_ROLE), avatar: REF });
    const img = avatar.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", avatarUrl(REF.id, REF.v));
    expect(img).toHaveAttribute("loading", "lazy");
    expect(avatar).toHaveAttribute("aria-hidden", "true");
  });

  it("avatar null: initial letter, no img", async () => {
    const avatar = await renderWith(member("u-bob", "bob@example.com", "Bob", MEMBER_ROLE));
    expect(avatar.querySelector("img")).toBeNull();
    expect(avatar.textContent).toBe("B");
  });

  it("old server without the avatar field (undefined): no error, shows the initial", async () => {
    const bob = member("u-bob", "bob@example.com", "Bob", MEMBER_ROLE) as unknown as Record<string, unknown>;
    delete bob.avatar;
    const avatar = await renderWith(bob as unknown as ReturnType<typeof member>);
    expect(avatar.querySelector("img")).toBeNull();
    expect(avatar.textContent).toBe("B");
  });

  it("image load failure falls back to the initial", async () => {
    const avatar = await renderWith({ ...member("u-bob", "bob@example.com", "Bob", MEMBER_ROLE), avatar: REF });
    fireEvent.error(avatar.querySelector("img")!);
    expect(avatar.querySelector("img")).toBeNull();
    expect(avatar.textContent).toBe("B");
  });

  it("the row's accessible name and the name cell are unaffected by the avatar", async () => {
    await renderWith(member("u-bob", "bob@example.com", "Bob", MEMBER_ROLE));
    expect(screen.getByRole("row", { name: "bob@example.com" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Bob" })).toBeInTheDocument();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { GroupDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { adminRole, customRole, groupDto, memberRole } from "@/test/fixtures";
import { SettingsGroupsOverview } from "./SettingsGroupsOverview";

function fakeResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}

function renderOverview(groups: GroupDto[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/groups") return Promise.resolve(fakeResponse(groups));
      throw new Error(`unexpected fetch: ${String(input)}`);
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <SettingsGroupsOverview />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const pillsOf = (row: HTMLElement) => Array.from(row.querySelectorAll("[data-pill]")).map((p) => p.textContent);

const ADMIN_G = groupDto({ id: "g-admin", name: "WRATB" }, adminRole());
const MEMBER_G = groupDto({ id: "g-member", name: "RD Weekly" }, memberRole());
const CUSTOM_G = groupDto({ id: "g-custom", name: "Book club" }, customRole({ name: "Reader" }));
const NULL_G = groupDto({ id: "g-null", name: "Orphan" }, null);

describe("SettingsGroupsOverview (#247, read-only)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("title, description, \"you're in N groups\"", async () => {
    renderOverview([ADMIN_G, MEMBER_G, CUSTOM_G]);
    expect(screen.getByRole("heading", { level: 1, name: "Groups" })).toBeInTheDocument();
    expect(screen.getByText("Groups you belong to, and your role in each. Create or manage groups from the sidebar.")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 2, name: "You're in 3 groups" })).toBeInTheDocument();
  });

  it("singular: \"You're in 1 group\"", async () => {
    renderOverview([MEMBER_G]);
    expect(await screen.findByRole("heading", { level: 2, name: "You're in 1 group" })).toBeInTheDocument();
  });

  it("my role goes through roleLabel: built-in admin -> Admin, built-in member -> Member (not blank), custom -> its name", async () => {
    renderOverview([ADMIN_G, MEMBER_G, CUSTOM_G]);
    const admin = await screen.findByRole("row", { name: "WRATB" });
    expect(within(admin).getByText("Admin")).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: "RD Weekly" })).getByText("Member")).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: "Book club" })).getByText("Reader")).toBeInTheDocument();
  });

  it("permission pill: each row starts with one Read, the rest list only the flags that are true, in the order of GROUP_ROLE_FLAGS", async () => {
    renderOverview([ADMIN_G, MEMBER_G, CUSTOM_G]);
    const admin = await screen.findByRole("row", { name: "WRATB" });
    expect(pillsOf(admin)).toEqual(["Read", "Create", "Edit", "Delete", "Manage public links", "Manage members", "Manage roles & group"]);
    expect(pillsOf(screen.getByRole("row", { name: "RD Weekly" }))).toEqual(["Read", "Create", "Edit"]);
    expect(pillsOf(screen.getByRole("row", { name: "Book club" }))).toEqual(["Read"]);
  });

  it("myRole: null (possible by type) -> role shows a dash, only the Read pill, no throw", async () => {
    renderOverview([NULL_G]);
    const row = await screen.findByRole("row", { name: "Orphan" });
    expect(within(row).getByText("—")).toBeInTheDocument();
    expect(pillsOf(row)).toEqual(["Read"]);
  });

  it("no links and no buttons (no menu button, no \"New group\", the group name isn't a link)", async () => {
    renderOverview([ADMIN_G, MEMBER_G]);
    await screen.findByText("WRATB");
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("table name Groups; column names Group / My role / Permissions", async () => {
    renderOverview([ADMIN_G, MEMBER_G]);
    const table = await screen.findByRole("table", { name: "Groups" });
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Group", "My role", "Permissions"]);
  });

  it("zero groups -> empty-state sentence", async () => {
    renderOverview([]);
    expect(await screen.findByText("You're not in any group yet.")).toBeInTheDocument();
  });
});

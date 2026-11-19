import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { GroupStorageUsageDto, StorageUsageDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { AppRoutes } from "@/App";
import { adminRole, groupDto, memberRole } from "@/test/fixtures";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

// The usage on the personal settings "Storage" page and the group modal "Storage" page (`/groups/:id/storage`, #247).
// The group page's by-member / versions switch details are in `components/groups/GroupStorageSection.test.tsx`. Runs through the real AppRoutes (same convention as SettingsAccountSection.test.tsx).

function fakeResponse(status: number, body: unknown): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

const TRASH_NOTE = "Notes in the trash count toward usage too, until they're permanently deleted.";

const ME: UserDto = { id: "u-me", email: "me@example.com", handle: "me", displayName: "Me", isAdmin: false, mustChangePassword: false, hasPassword: true, autoVersions: true, avatar: null };

function renderAt(path: string, handlers: (url: string, method: string) => Response | Promise<Response> | null) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const custom = handlers(url, method);
    if (custom) return Promise.resolve(custom);
    if (url === "/api/auth/me") return Promise.resolve(fakeResponse(200, ME));
    if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
    if (url === "/api/notes") return Promise.resolve(fakeResponse(200, []));
    if (url === "/api/auth/identities") return Promise.resolve(fakeResponse(200, { identities: [], linkable: [], hasPassword: true, passwordLoginEnabled: true }));
    if (url === "/api/auth/tokens") return Promise.resolve(fakeResponse(200, { tokens: [] }));
    // The storage page's version history switch needs to be called (#247; the response shape is the same as SettingsAccountSection.test.tsx's baseFetchHandlers)
    if (url === "/api/auth/config") return Promise.resolve(fakeResponse(200, { providers: [], registration: { enabled: false, providerIds: [] }, passwordLogin: { enabled: true }, autoVersionsEnabled: true }));
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return fetchMock;
}

const usage = (u: Partial<StorageUsageDto>): StorageUsageDto => ({ usedBytes: 1048576, quotaBytes: 2147483648, planName: "Basic", byKind: { image: 1048576, audio: 0, video: 0, document: 0, other: 0 }, ...u });

describe("account page storage", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("with a limit: \"1 MB of 2 GB (Basic)\", no warning", async () => {
    renderAt("/settings/storage", (url) => (url === "/api/groups" ? fakeResponse(200, []) : url === "/api/storage" ? fakeResponse(200, usage({})) : null));
    expect(await screen.findByRole("heading", { level: 1, name: "Storage" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("storage-usage")).toHaveTextContent("1 MB of 2 GB (Basic)"));
    expect(screen.getByTestId("storage-usage")).not.toHaveClass("text-destructive");
    expect(screen.queryByText("Limit reached — no new attachments can be added")).not.toBeInTheDocument();
  });

  it("unlimited: \"5 MB used (unlimited, Big)\", no warning", async () => {
    renderAt("/settings/storage", (url) => (url === "/api/groups" ? fakeResponse(200, []) : url === "/api/storage" ? fakeResponse(200, usage({ usedBytes: 5 * 1048576, quotaBytes: null, planName: "Big" })) : null));
    await waitFor(() => expect(screen.getByTestId("storage-usage")).toHaveTextContent("5 MB used (unlimited, Big)"));
    expect(screen.getByTestId("storage-usage")).not.toHaveClass("text-destructive");
    expect(screen.queryByText("Limit reached — no new attachments can be added")).not.toBeInTheDocument();
  });

  it("over the limit: warning color + \"Limit reached...\"", async () => {
    renderAt("/settings/storage", (url) => (url === "/api/groups" ? fakeResponse(200, []) : url === "/api/storage" ? fakeResponse(200, usage({ usedBytes: 3 * 1048576, quotaBytes: 2 * 1048576, planName: "Tight" })) : null));
    await waitFor(() => expect(screen.getByTestId("storage-usage")).toHaveTextContent("3 MB of 2 MB (Tight)"));
    expect(screen.getByTestId("storage-usage")).toHaveClass("text-destructive");
    expect(screen.getByText("Limit reached — no new attachments can be added")).toHaveClass("text-destructive");
  });

  it("exactly equal to the limit: also warns", async () => {
    renderAt("/settings/storage", (url) => (url === "/api/groups" ? fakeResponse(200, []) : url === "/api/storage" ? fakeResponse(200, usage({ usedBytes: 1048576, quotaBytes: 1048576 })) : null));
    await waitFor(() => expect(screen.getByTestId("storage-usage")).toHaveTextContent("1 MB of 1 MB (Basic)"));
    expect(screen.getByTestId("storage-usage")).toHaveClass("text-destructive");
    expect(screen.getByText("Limit reached — no new attachments can be added")).toHaveClass("text-destructive");
  });

  it("1 byte short of the limit: no warning (the other side of the >= boundary)", async () => {
    renderAt("/settings/storage", (url) => (url === "/api/groups" ? fakeResponse(200, []) : url === "/api/storage" ? fakeResponse(200, usage({ usedBytes: 1048575, quotaBytes: 1048576 })) : null));
    await waitFor(() => expect(screen.getByTestId("storage-usage")).toHaveTextContent("1 MB of 1 MB (Basic)"));
    expect(screen.getByTestId("storage-usage")).not.toHaveClass("text-destructive");
    expect(screen.queryByText("Limit reached — no new attachments can be added")).not.toBeInTheDocument();
  });

  it("success state ends with a note that the trash counts toward usage (#181); loading and error states don't", async () => {
    renderAt("/settings/storage", (url) => (url === "/api/groups" ? fakeResponse(200, []) : url === "/api/storage" ? fakeResponse(200, usage({})) : null));
    await waitFor(() => expect(screen.getByTestId("storage-usage")).toHaveTextContent("1 MB of 2 GB (Basic)"));
    const note = screen.getByText(TRASH_NOTE, { exact: true });
    expect(note).toHaveClass("text-xs", "text-muted-foreground");
    expect(screen.getByTestId("storage-usage").compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("loading (/api/storage hanging) -> no trash note", async () => {
    renderAt("/settings/storage", (url) => (url === "/api/groups" ? fakeResponse(200, []) : url === "/api/storage" ? new Promise<Response>(() => {}) : null));
    expect(await screen.findByRole("heading", { level: 1, name: "Storage" })).toBeInTheDocument();
    await screen.findByRole("switch");
    expect(screen.getAllByText("Loading…").length).toBeGreaterThan(0);
    expect(screen.queryByText(TRASH_NOTE)).not.toBeInTheDocument();
  });

  it("error state (/api/storage 500) -> no trash note", async () => {
    renderAt("/settings/storage", (url) =>
      url === "/api/groups" ? fakeResponse(200, []) : url === "/api/storage" ? fakeResponse(500, { error: { code: "boom", message: "x" } }) : null,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("errors.fallback"));
    expect(screen.queryByText(TRASH_NOTE)).not.toBeInTheDocument();
  });
});

const ADMIN_ROLE = adminRole({ id: "11111111-1111-1111-1111-111111111111" });
const MEMBER_ROLE = memberRole({ id: "22222222-2222-2222-2222-222222222222" });
const groupUsage = (u: Partial<GroupStorageUsageDto>): GroupStorageUsageDto => ({ ...usage({}), byMember: [{ userId: "u-me", handle: "me", displayName: "Me", bytes: 1048576 }], ...u });

describe("group storage page (/groups/:id/storage, #247)", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("canManageGroup: calls GET /api/groups/:id/storage and shows \"1 MB of 2 GB (Team plan)\"", async () => {
    const g = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Team Alpha" }, ADMIN_ROLE);
    const fetchMock = renderAt(`/groups/${g.id}/storage`, (url) => {
      if (url === "/api/groups") return fakeResponse(200, [g]);
      if (url === `/api/groups/${g.id}/storage`) return fakeResponse(200, groupUsage({ planName: "Team plan" }));
      return null;
    });
    const dialog = await screen.findByRole("dialog", { name: "Team Alpha" });
    expect(await within(dialog).findByRole("heading", { level: 1, name: "Storage" })).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByTestId("storage-usage")).toHaveTextContent("1 MB of 2 GB (Team plan)"));
    expect(within(dialog).getByText(TRASH_NOTE, { exact: true })).toBeInTheDocument(); // the same sentence as in the group panel (StorageUsageGroup is shared)
    expect(fetchMock.mock.calls.some(([u]) => String(u) === `/api/groups/${g.id}/storage`)).toBe(true);
  });

  it("not a group manager: after loosening it still renders and still calls the storage endpoint (before #247 it didn't render or call)", async () => {
    const g = groupDto({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "Team Beta" }, MEMBER_ROLE);
    const fetchMock = renderAt(`/groups/${g.id}/storage`, (url) => {
      if (url === "/api/groups") return fakeResponse(200, [g]);
      if (url === `/api/groups/${g.id}/storage`) return fakeResponse(200, groupUsage({ usedBytes: 3 * 1048576, quotaBytes: 2 * 1048576, planName: "Tight" }));
      return null;
    });
    const dialog = await screen.findByRole("dialog", { name: "Team Beta" });
    await within(dialog).findByRole("heading", { level: 1, name: "Storage" });
    await waitFor(() => expect(within(dialog).getByTestId("storage-usage")).toHaveTextContent("3 MB of 2 MB (Tight)"));
    expect(within(dialog).getByTestId("storage-usage")).toHaveClass("text-destructive");
    expect(fetchMock.mock.calls.some(([u]) => String(u) === `/api/groups/${g.id}/storage`)).toBe(true);
  });
});

import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, type Location } from "react-router";
import { vi } from "vitest";
import type { GroupDto, GroupMemberDto, GroupRoleDto, UserDto } from "@knotebook/shared";
import { ThemeProvider } from "@/theme";
import { Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";
import { ActiveNoteProvider } from "@/lib/active-note";
import { adminRole, groupDto, memberRole } from "@/test/fixtures";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

export function fakeResponse({ ok: okFlag, status, json }: { ok: boolean; status: number; json?: () => Promise<unknown> }): Response {
  return { ok: okFlag, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}
export function ok(body: unknown, status = 200): Response {
  return fakeResponse({ ok: true, status, json: () => Promise.resolve(body) });
}
export function fail(status: number, code: string): Response {
  return fakeResponse({ ok: false, status, json: () => Promise.resolve({ error: { code, message: "x" } }) });
}

export const ME: UserDto = {
  id: "u-me",
  email: "me@example.com",
  handle: "me",
  displayName: "Me",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
  avatar: null,
};
export const ADMIN_ROLE = adminRole({ id: "11111111-1111-1111-1111-111111111111" });
export const MEMBER_ROLE = memberRole({ id: "22222222-2222-2222-2222-222222222222" });
export const ROLES: GroupRoleDto[] = [ADMIN_ROLE, MEMBER_ROLE];
/** I am the only admin (`memberCount` 1). */
export const GROUP_ADMIN: GroupDto = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Team Alpha", createdAt: "2026-01-01T00:00:00.000Z" }, ADMIN_ROLE);
export const GROUP_CO_ADMIN: GroupDto = { ...GROUP_ADMIN, myRole: { ...ADMIN_ROLE, memberCount: 2 } };
export const GROUP_MEMBER: GroupDto = groupDto({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "Team Beta", createdAt: "2026-01-02T00:00:00.000Z" }, MEMBER_ROLE);
export const BG_NOTE = { pathname: "/n/me/some-note", search: "", hash: "", state: null, key: "bg1" } as Location;

export function member(userId: string, email: string, displayName: string, role: GroupRoleDto): GroupMemberDto {
  return { userId, email, displayName, roleId: role.id, builtin: role.builtin, avatar: null };
}

export type Handler = (url: string, method: string, init: RequestInit | undefined) => Response | Promise<Response> | null;

export const EMPTY_GROUP_USAGE = {
  usedBytes: 0,
  quotaBytes: 2147483648,
  planName: "Basic",
  byKind: { image: 0, audio: 0, video: 0, document: 0, other: 0 }, content: { noteBytes: 0, historyBytes: 0 },
  byMember: [],
};

/** Auth config has site auto-versions on. The suggest endpoint returns an empty list so typing doesn't take the query-failure path. `extra` is matched first. */
export function groupFetch(
  getGroups: () => GroupDto[],
  getMembers: () => GroupMemberDto[] | Promise<Response> = () => [],
  extra: Handler = () => null,
) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const custom = extra(url, method, init);
    if (custom) return Promise.resolve(custom);
    if (url === "/api/auth/me" && method === "GET") return Promise.resolve(ok(ME));
    if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
    if (url === "/api/notes" && method === "GET") return Promise.resolve(ok([]));
    if (url.startsWith("/api/users/suggest?") && method === "GET") return Promise.resolve(ok({ users: [] }));
    if (url === "/api/auth/config" && method === "GET") {
      return Promise.resolve(ok({ providers: [], registration: { enabled: false, providerIds: [] }, passwordLogin: { enabled: true }, autoVersionsEnabled: true }));
    }
    if (url === "/api/groups" && method === "GET") return Promise.resolve(ok(getGroups()));
    for (const group of getGroups()) {
      if (url === `/api/groups/${group.id}/members` && method === "GET") {
        const members = getMembers();
        return members instanceof Promise ? members : Promise.resolve(ok(members));
      }
      if (url === `/api/groups/${group.id}/roles` && method === "GET") return Promise.resolve(ok(ROLES));
      if (url === `/api/groups/${group.id}/storage` && method === "GET") return Promise.resolve(ok(EMPTY_GROUP_USAGE));
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
}

export function callsTo(fetchMock: ReturnType<typeof vi.fn>, method: string, url: string): RequestInit[] {
  return fetchMock.mock.calls
    .filter(([u, i]) => String(u) === url && ((i as RequestInit | undefined)?.method ?? "GET").toUpperCase() === method)
    .map(([, i]) => i as RequestInit);
}

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">
      {location.pathname}|{JSON.stringify(location.state)}
    </div>
  );
}

export function locationText(): string {
  return screen.getByTestId("location").textContent ?? "";
}

/** The background `HomePage` also uses `useGroups()`, so query `within(dialog)`. */
export function renderGroupRoute(entry: string | { pathname: string; state?: unknown }, fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          {/* Same as `App()`: NotePage needs ActiveNoteProvider after leave/delete navigates back to the background note. */}
          <ActiveNoteProvider>
            <LocationProbe />
            <AppRoutes />
          </ActiveNoteProvider>
        </MemoryRouter>
      </ThemeProvider>
      <Toaster />
    </QueryClientProvider>,
  );
}

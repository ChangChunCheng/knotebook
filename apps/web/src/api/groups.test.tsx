import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { GroupDto, GroupMemberDto, GroupRoleFlags } from "@knotebook/shared";
import {
  GROUPS_QUERY_KEY,
  groupMembersKey,
  useAddMember,
  useCreateGroup,
  useCreateRole,
  useDeleteGroup,
  useDeleteRole,
  useGroupMembers,
  useGroupRoles,
  useGroups,
  useRemoveMember,
  useRenameGroup,
  useSetMemberRole,
  useUpdateRole,
} from "./groups";
import { useCreateNote, useNote } from "./notes";
import { usePublicLink } from "./public-link";
import { adminRole, customRole, groupDto, memberRole } from "@/test/fixtures";

const ADMIN_ROLE = adminRole({ id: "dddddddd-dddd-dddd-dddd-000000000001" });
const MEMBER_ROLE = memberRole({ id: "dddddddd-dddd-dddd-dddd-000000000002" });
const GROUP: GroupDto = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "工作坊", createdAt: "2026-09-26T00:00:00.000Z" }, ADMIN_ROLE);
const MEMBER: GroupMemberDto = {
  userId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  email: "bob@example.com",
  displayName: "Bob",
  roleId: MEMBER_ROLE.id,
  builtin: "member",
  avatar: null,
};

const FLAGS: GroupRoleFlags = { create: false, edit: false, delete: false, managePublicLink: false, manageMembers: false, manageGroup: false };

function fakeResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)),
  } as unknown as Response;
}

function stubFetch(routes: Record<string, () => Response>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      const handler = routes[`${method} ${url}`];
      if (!handler) throw new Error(`unexpected fetch: ${method} ${url}`);
      return Promise.resolve(handler());
    }),
  );
  return calls;
}

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("api/groups", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("useGroups GETs /api/groups; key is ['groups']", async () => {
    stubFetch({ "GET /api/groups": () => fakeResponse(200, [GROUP]) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useGroups(), { wrapper: wrapper(queryClient) });
    await waitFor(() => expect(result.current.data).toEqual([GROUP]));
    expect(queryClient.getQueryData(GROUPS_QUERY_KEY)).toEqual([GROUP]);
  });

  it("useGroupMembers GETs /api/groups/:id/members; no GET when enabled:false", async () => {
    const calls = stubFetch({ [`GET /api/groups/${GROUP.id}/members`]: () => fakeResponse(200, [MEMBER]) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const disabled = renderHook(() => useGroupMembers(GROUP.id, { enabled: false }), { wrapper: wrapper(queryClient) });
    expect(disabled.result.current.fetchStatus).toBe("idle");
    expect(calls).toHaveLength(0);

    const { result } = renderHook(() => useGroupMembers(GROUP.id), { wrapper: wrapper(queryClient) });
    await waitFor(() => expect(result.current.data).toEqual([MEMBER]));
    expect(queryClient.getQueryData(groupMembersKey(GROUP.id))).toEqual([MEMBER]);
  });

  it("#175 useGroupRoles GETs /api/groups/:id/roles; key is ['groups', id, 'roles'] (under the ['groups'] prefix, so group mutation invalidation covers it)", async () => {
    const calls = stubFetch({ [`GET /api/groups/${GROUP.id}/roles`]: () => fakeResponse(200, [ADMIN_ROLE, MEMBER_ROLE]) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useGroupRoles(GROUP.id), { wrapper: wrapper(queryClient) });
    await waitFor(() => expect(result.current.data).toEqual([ADMIN_ROLE, MEMBER_ROLE]));
    expect(calls).toEqual([{ method: "GET", url: `/api/groups/${GROUP.id}/roles`, body: undefined }]);
    expect(queryClient.getQueryData(["groups", GROUP.id, "roles"])).toEqual([ADMIN_ROLE, MEMBER_ROLE]);
    expect(queryClient.getQueryCache().findAll({ queryKey: GROUPS_QUERY_KEY }).map((q) => q.queryKey)).toContainEqual(["groups", GROUP.id, "roles"]);
  });

  it("useCreateGroup: POST {name}, on success invalidates ['groups'] and ['notes']", async () => {
    const calls = stubFetch({ "POST /api/groups": () => fakeResponse(201, GROUP) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useCreateGroup(), { wrapper: wrapper(queryClient) });
    await expect(result.current.mutateAsync({ name: "工作坊" })).resolves.toEqual(GROUP);
    expect(calls[0]).toEqual({ method: "POST", url: "/api/groups", body: { name: "工作坊" } });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["groups"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["notes"] });
  });

  it("hooks via useInvalidateGroupsAndNotes also invalidate ['trash'] (a role change alters who can see the group trash)", async () => {
    stubFetch({ "POST /api/groups": () => fakeResponse(201, GROUP) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useCreateGroup(), { wrapper: wrapper(queryClient) });
    await result.current.mutateAsync({ name: "工作坊" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["trash"] });
  });

  it("regaining read access must bring favorites back: hooks via useInvalidateGroupsAndNotes and useUpdateRole invalidate ['favorites']", async () => {
    stubFetch({
      "POST /api/groups": () => fakeResponse(201, GROUP),
      [`PATCH /api/groups/${GROUP.id}/roles/r-new`]: () => fakeResponse(200, customRole({ id: "r-new" })),
    });
    const favoritesCalls = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.filter(([arg]) => JSON.stringify((arg as { queryKey?: unknown } | undefined)?.queryKey) === '["favorites"]').length;

    const qcCreate = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spyCreate = vi.spyOn(qcCreate, "invalidateQueries");
    const create = renderHook(() => useCreateGroup(), { wrapper: wrapper(qcCreate) });
    await create.result.current.mutateAsync({ name: "工作坊" });
    expect(favoritesCalls(spyCreate)).toBe(1);

    const qcRole = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spyRole = vi.spyOn(qcRole, "invalidateQueries");
    const update = renderHook(() => useUpdateRole(GROUP.id), { wrapper: wrapper(qcRole) });
    await update.result.current.mutateAsync({ roleId: "r-new", permissions: FLAGS });
    expect(favoritesCalls(spyRole)).toBe(1);
  });

  it("useRenameGroup: PATCH /api/groups/:id {name}; useDeleteGroup: DELETE /api/groups/:id with {mode}; both invalidate the two keys", async () => {
    const calls = stubFetch({
      [`PATCH /api/groups/${GROUP.id}`]: () => fakeResponse(200, { ...GROUP, name: "新名" }),
      [`DELETE /api/groups/${GROUP.id}`]: () => fakeResponse(204),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const rename = renderHook(() => useRenameGroup(), { wrapper: wrapper(queryClient) });
    await expect(rename.result.current.mutateAsync({ id: GROUP.id, name: "新名" })).resolves.toMatchObject({ name: "新名" });
    expect(calls[0]).toEqual({ method: "PATCH", url: `/api/groups/${GROUP.id}`, body: { name: "新名" } });
    const del = renderHook(() => useDeleteGroup(), { wrapper: wrapper(queryClient) });
    await expect(del.result.current.mutateAsync({ id: GROUP.id, body: { mode: "delete" } })).resolves.toBeUndefined();
    expect(calls[1]).toEqual({ method: "DELETE", url: `/api/groups/${GROUP.id}`, body: { mode: "delete" } });
    expect(invalidate.mock.calls.filter(([arg]) => JSON.stringify(arg?.queryKey) === '["groups"]')).toHaveLength(2);
    expect(invalidate.mock.calls.filter(([arg]) => JSON.stringify(arg?.queryKey) === '["notes"]')).toHaveLength(2);
  });

  it("useRenameGroup also invalidates the three single-note keys ['note'], ['note-by-path'], ['note-by-group-path'] (the open note needs the new group name)", async () => {
    stubFetch({ [`PATCH /api/groups/${GROUP.id}`]: () => fakeResponse(200, { ...GROUP, name: "新名" }) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useRenameGroup(), { wrapper: wrapper(queryClient) });
    await result.current.mutateAsync({ id: GROUP.id, name: "新名" });
    const keys = invalidate.mock.calls.map(([arg]) => JSON.stringify(arg?.queryKey));
    expect(keys).toEqual(expect.arrayContaining(['["note"]', '["note-by-path"]', '["note-by-group-path"]', '["groups"]', '["notes"]']));
  });

  it("useDeleteGroup invalidation set and order: the three note keys (['note'], ['note-by-path'], ['note-by-group-path']) before ['groups']/['notes']; includes ['public-link'] (a transfer clears the token); excludes ['shares'] (neither mode produces per-person shares)", async () => {
    stubFetch({ [`DELETE /api/groups/${GROUP.id}`]: () => fakeResponse(204) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useDeleteGroup(), { wrapper: wrapper(queryClient) });
    await result.current.mutateAsync({ id: GROUP.id, body: { mode: "delete" } });
    const keys = invalidate.mock.calls.map(([arg]) => JSON.stringify(arg?.queryKey));
    const at = (k: string) => {
      const i = keys.indexOf(k);
      expect(i, `${k} 應該被 invalidate`).toBeGreaterThanOrEqual(0);
      return i;
    };
    const noteLayer = ['["note"]', '["note-by-path"]', '["note-by-group-path"]'].map(at);
    expect(Math.max(...noteLayer)).toBeLessThan(Math.min(at('["groups"]'), at('["notes"]')));
    expect(keys).toContain('["public-link"]');
    expect(keys).not.toContain('["shares"]');
  });

  it("useDeleteGroup (transfer to self): the open ['note', id] and active ['public-link', id] refetches finish only after mutateAsync resolves - mutateAsync doesn't wait for them; once released the note becomes personal form and public-link becomes {token:null, slug:null}", async () => {
    const NOTE_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const groupNote = { id: NOTE_ID, title: "x", groupId: GROUP.id, group: { id: GROUP.id, name: GROUP.name }, role: "editor" };
    const personalNote = { ...groupNote, groupId: null, group: null, role: "owner" };
    const linkBefore = { token: "tok", slug: "pub" };
    const linkAfter = { token: null, slug: null };
    let transferred = false;
    const gate: { release?: () => void } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "DELETE" && url === `/api/groups/${GROUP.id}`) {
          transferred = true;
          return Promise.resolve(fakeResponse(204));
        }
        if (url === `/api/notes/${NOTE_ID}`) return Promise.resolve(fakeResponse(200, transferred ? personalNote : groupNote));
        if (url === `/api/notes/${NOTE_ID}/public-link`) {
          if (!transferred) return Promise.resolve(fakeResponse(200, linkBefore));
          // Refetch after the transfer is left hanging: if mutateAsync were waiting for it, the assertions below would time out
          return new Promise<Response>((resolve) => {
            gate.release = () => resolve(fakeResponse(200, linkAfter));
          });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => ({ note: useNote(NOTE_ID), link: usePublicLink(NOTE_ID), del: useDeleteGroup() }),
      { wrapper: wrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.note.data).toMatchObject({ group: { id: GROUP.id } }));
    await waitFor(() => expect(result.current.link.data).toEqual(linkBefore));

    // Invalidations aren't awaited: mutateAsync resolves while the public-link refetch is still pending, so feedback isn't slowed by open queries.
    await result.current.del.mutateAsync({ id: GROUP.id, body: { mode: "transfer", transferTo: MEMBER.userId } });
    await waitFor(() => expect(gate.release).toBeDefined());
    expect(result.current.link.data).toEqual(linkBefore);
    gate.release?.();

    await waitFor(() => expect(result.current.note.data).toMatchObject({ group: null, role: "owner" }));
    await waitFor(() => expect(result.current.link.data).toEqual(linkAfter));
  });

  it("useDeleteGroup with a transfer body: {mode:'transfer', transferTo}", async () => {
    const calls = stubFetch({ [`DELETE /api/groups/${GROUP.id}`]: () => fakeResponse(204) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useDeleteGroup(), { wrapper: wrapper(queryClient) });
    await result.current.mutateAsync({ id: GROUP.id, body: { mode: "transfer", transferTo: MEMBER.userId } });
    expect(calls[0]).toEqual({ method: "DELETE", url: `/api/groups/${GROUP.id}`, body: { mode: "transfer", transferTo: MEMBER.userId } });
  });

  it("#175 useSetMemberRole also invalidates the three single-note keys: changing your own role re-fetches permissions of the open group note", async () => {
    stubFetch({
      [`PATCH /api/groups/${GROUP.id}/members/${MEMBER.userId}`]: () => fakeResponse(200, { ...MEMBER, roleId: ADMIN_ROLE.id, builtin: "admin" }),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useSetMemberRole(GROUP.id), { wrapper: wrapper(queryClient) });
    await result.current.mutateAsync({ userId: MEMBER.userId, roleId: ADMIN_ROLE.id });
    const keys = invalidate.mock.calls.map(([arg]) => JSON.stringify(arg?.queryKey));
    expect(keys).toEqual(expect.arrayContaining(['["note"]', '["note-by-path"]', '["note-by-group-path"]', '["groups"]', '["notes"]']));
  });

  it("three member calls: PUT {email,roleId?} / PATCH :userId {roleId} / DELETE :userId; on success invalidate ['groups'] and ['notes']", async () => {
    const promoted: GroupMemberDto = { ...MEMBER, roleId: ADMIN_ROLE.id, builtin: "admin" };
    const calls = stubFetch({
      [`PUT /api/groups/${GROUP.id}/members`]: () => fakeResponse(200, MEMBER),
      [`PATCH /api/groups/${GROUP.id}/members/${MEMBER.userId}`]: () => fakeResponse(200, promoted),
      [`DELETE /api/groups/${GROUP.id}/members/${MEMBER.userId}`]: () => fakeResponse(204),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const add = renderHook(() => useAddMember(GROUP.id), { wrapper: wrapper(queryClient) });
    await expect(add.result.current.mutateAsync({ email: MEMBER.email })).resolves.toEqual(MEMBER);
    // Omit the key when roleId isn't given: the server body is `.strict()`, so no extra keys are sent (the server defaults to the built-in ordinary member)
    expect(calls[0].body).toEqual({ email: MEMBER.email });
    const addWithRole = renderHook(() => useAddMember(GROUP.id), { wrapper: wrapper(queryClient) });
    await expect(addWithRole.result.current.mutateAsync({ email: MEMBER.email, roleId: ADMIN_ROLE.id })).resolves.toEqual(MEMBER);
    // A given roleId is sent as is (not always omitted); the key is roleId, not the old `role` (the server answers 400 to a `role` key)
    expect(calls[1].body).toEqual({ email: MEMBER.email, roleId: ADMIN_ROLE.id });
    const setRole = renderHook(() => useSetMemberRole(GROUP.id), { wrapper: wrapper(queryClient) });
    await expect(setRole.result.current.mutateAsync({ userId: MEMBER.userId, roleId: ADMIN_ROLE.id })).resolves.toEqual(promoted);
    expect(calls[2]).toEqual({ method: "PATCH", url: `/api/groups/${GROUP.id}/members/${MEMBER.userId}`, body: { roleId: ADMIN_ROLE.id } });
    const remove = renderHook(() => useRemoveMember(GROUP.id), { wrapper: wrapper(queryClient) });
    await expect(remove.result.current.mutateAsync(MEMBER.userId)).resolves.toBeUndefined();
    expect(calls[3]).toEqual({ method: "DELETE", url: `/api/groups/${GROUP.id}/members/${MEMBER.userId}`, body: undefined });
    // ['groups'] is a prefix of ['groups', id, 'members'], so one invalidation also covers the member list
    expect(invalidate.mock.calls.filter(([arg]) => JSON.stringify(arg?.queryKey) === '["groups"]')).toHaveLength(4);
    expect(invalidate.mock.calls.filter(([arg]) => JSON.stringify(arg?.queryKey) === '["notes"]')).toHaveLength(4);
  });

  it("useCreateNote includes groupId in the body when given; body is {} otherwise", async () => {
    const note = { id: "n1", title: "x" };
    const calls = stubFetch({ "POST /api/notes": () => fakeResponse(201, note) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useCreateNote(), { wrapper: wrapper(queryClient) });
    await result.current.mutateAsync({ groupId: GROUP.id });
    await result.current.mutateAsync(undefined);
    expect(calls[0].body).toEqual({ groupId: GROUP.id });
    expect(calls[1].body).toEqual({});
  });

  it("#175 useCreateRole: POST /roles, body is {name, permissions}; invalidates ['groups'], ['notes'], ['trash'], ['folders'], ['favorites'] and not single-note keys", async () => {
    const role = customRole({ id: "r-new", name: "Editor" });
    const calls = stubFetch({ [`POST /api/groups/${GROUP.id}/roles`]: () => fakeResponse(201, role) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useCreateRole(GROUP.id), { wrapper: wrapper(queryClient) });
    await expect(result.current.mutateAsync({ name: "Editor", permissions: FLAGS })).resolves.toEqual(role);
    expect(calls).toEqual([{ method: "POST", url: `/api/groups/${GROUP.id}/roles`, body: { name: "Editor", permissions: FLAGS } }]);
    const keys = invalidate.mock.calls.map(([arg]) => JSON.stringify(arg?.queryKey));
    expect([...keys].sort()).toEqual(['["favorites"]', '["folders"]', '["groups"]', '["notes"]', '["trash"]']);
  });

  it("#175 useUpdateRole: PATCH /roles/:roleId, body is {permissions} when only permissions given; invalidates eight keys (including ['trash'], ['folders'], ['favorites'])", async () => {
    const role = customRole({ id: "r-new", permissions: { ...customRole().permissions, edit: true } });
    const calls = stubFetch({ [`PATCH /api/groups/${GROUP.id}/roles/r-new`]: () => fakeResponse(200, role) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useUpdateRole(GROUP.id), { wrapper: wrapper(queryClient) });
    await expect(result.current.mutateAsync({ roleId: "r-new", permissions: { ...FLAGS, edit: true } })).resolves.toEqual(role);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toBe(`/api/groups/${GROUP.id}/roles/r-new`);
    // No roleId and no name key (the server body is .strict())
    expect(Object.keys(calls[0].body as object)).toEqual(["permissions"]);
    expect(calls[0].body).toEqual({ permissions: { ...FLAGS, edit: true } });
    const keys = invalidate.mock.calls.map(([arg]) => JSON.stringify(arg?.queryKey));
    expect([...keys].sort()).toEqual(['["favorites"]', '["folders"]', '["groups"]', '["note"]', '["note-by-group-path"]', '["note-by-path"]', '["notes"]', '["trash"]']);
  });

  it("#175 useDeleteRole: DELETE /roles/:roleId, no body; same invalidations as useUpdateRole", async () => {
    const calls = stubFetch({ [`DELETE /api/groups/${GROUP.id}/roles/r-new`]: () => fakeResponse(204) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useDeleteRole(GROUP.id), { wrapper: wrapper(queryClient) });
    await expect(result.current.mutateAsync("r-new")).resolves.toBeUndefined();
    expect(calls).toEqual([{ method: "DELETE", url: `/api/groups/${GROUP.id}/roles/r-new`, body: undefined }]);
    const keys = invalidate.mock.calls.map(([arg]) => JSON.stringify(arg?.queryKey));
    expect([...keys].sort()).toEqual(['["favorites"]', '["folders"]', '["groups"]', '["note"]', '["note-by-group-path"]', '["note-by-path"]', '["notes"]', '["trash"]']);
  });

  it("folders: useDeleteGroup / useRemoveMember / useUpdateRole each invalidate ['folders'] on success", async () => {
    stubFetch({
      [`DELETE /api/groups/${GROUP.id}`]: () => fakeResponse(204),
      [`DELETE /api/groups/${GROUP.id}/members/${MEMBER.userId}`]: () => fakeResponse(204),
      [`PATCH /api/groups/${GROUP.id}/roles/r-new`]: () => fakeResponse(200, customRole({ id: "r-new" })),
    });
    const foldersCalls = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.filter(([arg]) => JSON.stringify((arg as { queryKey?: unknown } | undefined)?.queryKey) === '["folders"]').length;

    const qcDelete = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spyDelete = vi.spyOn(qcDelete, "invalidateQueries");
    const del = renderHook(() => useDeleteGroup(), { wrapper: wrapper(qcDelete) });
    await del.result.current.mutateAsync({ id: GROUP.id, body: { mode: "delete" } });
    expect(foldersCalls(spyDelete)).toBe(1);

    const qcRemove = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spyRemove = vi.spyOn(qcRemove, "invalidateQueries");
    const remove = renderHook(() => useRemoveMember(GROUP.id), { wrapper: wrapper(qcRemove) });
    await remove.result.current.mutateAsync(MEMBER.userId);
    expect(foldersCalls(spyRemove)).toBe(1);

    const qcRole = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spyRole = vi.spyOn(qcRole, "invalidateQueries");
    const update = renderHook(() => useUpdateRole(GROUP.id), { wrapper: wrapper(qcRole) });
    await update.result.current.mutateAsync({ roleId: "r-new", permissions: FLAGS });
    expect(foldersCalls(spyRole)).toBe(1);
  });
});

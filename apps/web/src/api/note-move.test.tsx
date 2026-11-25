import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { NoteDto, ShareDto } from "@knotebook/shared";
import { applyMovedNote, refetchAfterFailure, useCopyNote, useConfirmNoteStillPersonal, useMoveNoteToGroup } from "./note-move";
import { usePublicLink } from "./public-link";
import { versionCurrentKey, versionListKey } from "./versions";
import { useShares } from "./shares";

/**
 * #175: cache contract of the move / copy / pre-submit check hooks. renderHook itself mounts two observers, `useShares` and `usePublicLink`: with no active observer `invalidateQueries` only marks stale, doesn't refetch and its promise resolves immediately, so neither "await the refetch first" nor "refetch left hanging" could be reproduced.
 */

const ID = "11111111-1111-1111-1111-111111111111";
const GID = "33333333-3333-3333-3333-333333333333";
const SHARES_URL = `/api/notes/${ID}/shares`;
const PUBLIC_URL = `/api/notes/${ID}/public-link`;
const NOTE_URL = `/api/notes/${ID}`;

const SHARE: ShareDto = { userId: "u2", email: "bob@example.com", displayName: "Bob", role: "viewer", avatar: null };

function noteDto(over: Partial<NoteDto>): NoteDto {
  return {
    id: ID,
    title: "N",
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slug: "n",
    slugIsCustom: false,
    prevSlug: null,
    ownerHandle: "tester",
    lastEdited: null,
    groupId: null,
    group: null,
    permissions: { moveToGroup: true },
    ...over,
  } as unknown as NoteDto;
}

function fakeResponse(status: number, json?: unknown): Response {
  return {
    ok: status < 400,
    status,
    json: () => (json === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(json)),
  } as unknown as Response;
}

type GateName = "shares" | "public";

/** After arming, the shares and public-link GETs each have their own gate, released manually by the test (so it can tell which one wasn't waited for). */
function setupFetch(handlers: Record<string, () => Response>) {
  let armed = false;
  const releases = {} as Record<GateName, () => void>;
  const gates: Record<GateName, Promise<void>> = {
    shares: new Promise<void>(r => (releases.shares = r)),
    public: new Promise<void>(r => (releases.public = r)),
  };
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url, body: init?.body as string | undefined });
    if (armed && method === "GET" && url === SHARES_URL) await gates.shares;
    if (armed && method === "GET" && url === PUBLIC_URL) await gates.public;
    const h = handlers[`${method} ${url}`];
    if (!h) throw new Error(`unexpected fetch ${method} ${url}`);
    return h();
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    arm: () => {
      armed = true;
    },
    release: (name: GateName) => releases[name](),
  };
}

const KEY_OF: Record<GateName, unknown[]> = { shares: ["shares", ID], public: ["public-link", ID] };

/** Releases the named gate and waits for its refetch to finish (fetchStatus idle), then yields one macrotask. What catches an implementation that writes after waiting for only one refetch is mainly waitFor's ~50 ms polling, which gives it time to write early (yielding a macrotask is an extra layer); an implementation that delays its write by >= 50 ms can't be told apart from outside, an accepted limitation. */
async function releaseAndSettle(client: QueryClient, f: { release: (n: GateName) => void }, name: GateName) {
  f.release(name);
  await waitFor(() => expect(client.getQueryState(KEY_OF[name])?.fetchStatus).toBe("idle"));
  await new Promise(r => setTimeout(r, 0));
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const baseHandlers = {
  [`GET ${SHARES_URL}`]: () => fakeResponse(200, [SHARE]),
  [`GET ${PUBLIC_URL}`]: () => fakeResponse(200, { token: "T", slug: null, width: "full" }),
};

async function waitObserversReady(client: QueryClient) {
  await waitFor(() => {
    expect(client.getQueryState(["shares", ID])?.status).toBe("success");
    expect(client.getQueryState(["public-link", ID])?.status).toBe("success");
  });
}

function keysOf(spy: { mock: { calls: unknown[][] } }): unknown[] {
  return spy.mock.calls.map(c => {
    const arg = c[0];
    return typeof arg === "object" && arg !== null && "queryKey" in arg ? (arg as { queryKey: unknown }).queryKey : arg;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useMoveNoteToGroup", () => {
  it("move success: cache write order is shares -> public-link -> note (three synchronous writes, no await between them)", async () => {
    // After a move, trust the response and don't assume editor (a create-only move can leave a viewer)
    const moved = noteDto({ groupId: GID, ownerId: "u9", role: "viewer", permissions: { moveToGroup: false, edit: false } as never });
    const f = setupFetch({ ...baseHandlers, [`POST ${NOTE_URL}/move`]: () => fakeResponse(200, moved) });
    const client = makeClient();
    const { result } = renderHook(
      () => {
        useShares(ID);
        usePublicLink(ID);
        return useMoveNoteToGroup(ID);
      },
      { wrapper: wrapperFor(client) },
    );
    await waitObserversReady(client);
    const setSpy = vi.spyOn(client, "setQueryData");
    const invSpy = vi.spyOn(client, "invalidateQueries");

    await result.current.mutateAsync({ groupId: GID, keepHistory: true });

    const post = f.calls.find(c => c.method === "POST");
    expect(post).toMatchObject({ url: `${NOTE_URL}/move` });
    expect(JSON.parse(post!.body!)).toEqual({ groupId: GID, keepHistory: true });

    const sets = setSpy.mock.calls.slice(0, 3);
    expect(sets.map(c => c[0])).toEqual([["shares", ID], ["public-link", ID], ["note", ID]]);
    expect(sets[0]![1]).toEqual([]);
    expect(client.getQueryData(["public-link", ID])).toEqual({ token: null, slug: null, width: "full" });
    expect(sets[2]![1]).toEqual(moved);
    const inv = keysOf(invSpy as never);
    for (const k of ["notes", "note-by-path", "note-by-group-path", "backlinks"]) {
      expect(inv).toContainEqual([k]);
    }
  });

  it("move success with an empty public-link cache -> no cache entry is created from nothing", async () => {
    const moved = noteDto({ groupId: GID, ownerId: "u9", role: "viewer", permissions: { moveToGroup: false, edit: false } as never });
    setupFetch({ [`POST ${NOTE_URL}/move`]: () => fakeResponse(200, moved) });
    const client = makeClient();
    const { result } = renderHook(() => useMoveNoteToGroup(ID), { wrapper: wrapperFor(client) });
    await result.current.mutateAsync({ groupId: GID, keepHistory: true });
    expect(client.getQueryData(["public-link", ID])).toBeUndefined();
  });

  it.each<[GateName, GateName]>([
    ["shares", "public"],
    ["public", "shares"],
  ])("move failure: release %s first, %s second - note and groups are invalidated only after both refetches finish; mutateAsync rejects before the refetches end (onError doesn't return a promise)", async (first, second) => {
    const f = setupFetch({
      ...baseHandlers,
      [`POST ${NOTE_URL}/move`]: () => fakeResponse(403, { error: { code: "forbidden", message: "no" } }),
    });
    const client = makeClient();
    const { result } = renderHook(
      () => {
        useShares(ID);
        usePublicLink(ID);
        return useMoveNoteToGroup(ID);
      },
      { wrapper: wrapperFor(client) },
    );
    await waitObserversReady(client);
    const invSpy = vi.spyOn(client, "invalidateQueries");
    f.arm();

    let rejected = false;
    const p = result.current.mutateAsync({ groupId: GID, keepHistory: true }).catch(() => {
      rejected = true;
    });
    await waitFor(() => {
      expect(f.calls.filter(c => c.method === "GET" && c.url === SHARES_URL)).toHaveLength(2);
      expect(f.calls.filter(c => c.method === "GET" && c.url === PUBLIC_URL)).toHaveLength(2);
    });
    await waitFor(() => expect(rejected).toBe(true));
    const mid = keysOf(invSpy as never);
    expect(mid).toContainEqual(["shares", ID]);
    expect(mid).toContainEqual(["public-link", ID]);
    expect(mid).not.toContainEqual(["note", ID]);
    expect(mid).not.toContainEqual(["groups"]);

    // Release only one and wait for it: the other still hangs, so note and groups must still not be invalidated (waiting for fewer than both fails here)
    await releaseAndSettle(client, f, first);
    const half = keysOf(invSpy as never);
    expect(half).not.toContainEqual(["note", ID]);
    expect(half).not.toContainEqual(["groups"]);

    await releaseAndSettle(client, f, second);
    await p;
    await waitFor(() => {
      const after = keysOf(invSpy as never);
      expect(after).toContainEqual(["note", ID]);
      expect(after).toContainEqual(["groups"]);
    });
  });
});

describe("applyMovedNote / refetchAfterFailure (shared by batch)", () => {
  it("applyMovedNote: shares = [], public-link token/slug cleared, note written; order shares -> public-link -> note; invalidates ['notes']", () => {
    const client = makeClient();
    client.setQueryData(["shares", ID], [SHARE]);
    client.setQueryData(["public-link", ID], { token: "T", slug: "s", width: "full" });
    const moved = noteDto({ groupId: GID });
    const setSpy = vi.spyOn(client, "setQueryData");
    const invSpy = vi.spyOn(client, "invalidateQueries");

    applyMovedNote(client, ID, moved);

    expect(setSpy.mock.calls.map(c => c[0])).toEqual([["shares", ID], ["public-link", ID], ["note", ID]]);
    expect(client.getQueryData(["shares", ID])).toEqual([]);
    expect(client.getQueryData(["public-link", ID])).toEqual({ token: null, slug: null, width: "full" });
    expect(client.getQueryData(["note", ID])).toEqual(moved);
    expect(keysOf(invSpy as never)).toContainEqual(["notes"]);
  });

  it("refetchAfterFailure: note is invalidated only after both the shares and public-link invalidations resolve", async () => {
    const client = makeClient();
    const releases: Record<string, () => void> = {};
    const invSpy = vi.spyOn(client, "invalidateQueries").mockImplementation(((filters: { queryKey: unknown[] }) => {
      const name = String(filters.queryKey[0]);
      if (name === "shares" || name === "public-link") return new Promise<void>(r => (releases[name] = r));
      return Promise.resolve();
    }) as never);
    const flush = () => new Promise(r => setTimeout(r, 0));

    const done = refetchAfterFailure(client, ID);
    await flush();
    expect(keysOf(invSpy as never)).not.toContainEqual(["note", ID]);
    releases.shares!();
    await flush();
    expect(keysOf(invSpy as never)).not.toContainEqual(["note", ID]);
    releases["public-link"]!();
    await done;
    expect(keysOf(invSpy as never)).toContainEqual(["note", ID]);
    expect(keysOf(invSpy as never)).toContainEqual(["groups"]);
  });
});

describe("useCopyNote", () => {
  it("copy to personal: body is {}; success writes ['note', copy.id], invalidates ['notes'], leaves the source ['note', id] alone", async () => {
    const copy = noteDto({ id: "44444444-4444-4444-4444-444444444444", slug: "n-copy" });
    const f = setupFetch({ [`POST ${NOTE_URL}/copy`]: () => fakeResponse(201, copy) });
    const client = makeClient();
    const setSpy = vi.spyOn(client, "setQueryData");
    const invSpy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useCopyNote(ID), { wrapper: wrapperFor(client) });

    const got = await result.current.mutateAsync({});

    expect(got).toEqual(copy);
    expect(f.calls[0]).toMatchObject({ method: "POST", url: `${NOTE_URL}/copy` });
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({});
    expect(setSpy.mock.calls.map(c => c[0])).toEqual([["note", copy.id]]);
    expect(keysOf(invSpy as never)).toContainEqual(["notes"]);
    expect(client.getQueryData(["note", ID])).toBeUndefined();
  });

  it("copy to a group: body is { groupId }", async () => {
    const copy = noteDto({ id: "44444444-4444-4444-4444-444444444444", groupId: GID });
    const f = setupFetch({ [`POST ${NOTE_URL}/copy`]: () => fakeResponse(201, copy) });
    const client = makeClient();
    const { result } = renderHook(() => useCopyNote(ID), { wrapper: wrapperFor(client) });
    await result.current.mutateAsync({ groupId: GID });
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ groupId: GID });
  });
});

describe("useConfirmNoteStillPersonal", () => {
  it("pre-submit check: still my personal note -> true, no cache write", async () => {
    setupFetch({ ...baseHandlers, [`GET ${NOTE_URL}`]: () => fakeResponse(200, noteDto({})) });
    const client = makeClient();
    const { result } = renderHook(
      () => {
        useShares(ID);
        usePublicLink(ID);
        return useConfirmNoteStillPersonal(ID);
      },
      { wrapper: wrapperFor(client) },
    );
    await waitObserversReady(client);
    const setSpy = vi.spyOn(client, "setQueryData");

    await expect(result.current()).resolves.toBe(true);
    expect(setSpy).not.toHaveBeenCalled();
    expect(client.getQueryData(["note", ID])).toBeUndefined();
  });

  it("pre-submit check: still personal but permissions.moveToGroup=false (not movable by me) -> false, latest note written", async () => {
    const latest = noteDto({ groupId: null, role: "viewer", permissions: { moveToGroup: false } as never });
    setupFetch({ ...baseHandlers, [`GET ${NOTE_URL}`]: () => fakeResponse(200, latest) });
    const client = makeClient();
    const { result } = renderHook(
      () => {
        useShares(ID);
        usePublicLink(ID);
        return useConfirmNoteStillPersonal(ID);
      },
      { wrapper: wrapperFor(client) },
    );
    await waitObserversReady(client);

    await expect(result.current()).resolves.toBe(false);
    expect(client.getQueryData(["note", ID])).toEqual(latest);
  });

  it.each<[GateName, GateName]>([
    ["shares", "public"],
    ["public", "shares"],
  ])("pre-submit check: now a group note -> release %s first, %s second; ['note', id] is written and false returned only after both refetches finish (fetchQuery is deliberately not used)", async (first, second) => {
    const latest = noteDto({ groupId: GID, role: "viewer", permissions: { moveToGroup: false } as never });
    const f = setupFetch({ ...baseHandlers, [`GET ${NOTE_URL}`]: () => fakeResponse(200, latest) });
    const client = makeClient();
    const { result } = renderHook(
      () => {
        useShares(ID);
        usePublicLink(ID);
        return useConfirmNoteStillPersonal(ID);
      },
      { wrapper: wrapperFor(client) },
    );
    await waitObserversReady(client);
    const setSpy = vi.spyOn(client, "setQueryData");
    const invSpy = vi.spyOn(client, "invalidateQueries");
    f.arm();

    let settled: boolean | undefined;
    const p = result.current().then(v => {
      settled = v;
    });
    await waitFor(() => {
      expect(f.calls.filter(c => c.method === "GET" && c.url === SHARES_URL)).toHaveLength(2);
      expect(f.calls.filter(c => c.method === "GET" && c.url === PUBLIC_URL)).toHaveLength(2);
    });
    expect(client.getQueryData(["note", ID])).toBeUndefined();
    expect(settled).toBeUndefined();

    // Release only one and wait for it: the other still hangs, so note still isn't written and the promise is still pending (waiting for fewer than both would briefly flash the note as public, failing here)
    await releaseAndSettle(client, f, first);
    expect(client.getQueryData(["note", ID])).toBeUndefined();
    expect(setSpy).not.toHaveBeenCalled();
    expect(settled).toBeUndefined();

    await releaseAndSettle(client, f, second);
    await p;
    expect(settled).toBe(false);
    expect(client.getQueryData(["note", ID])).toEqual(latest);
    expect(setSpy.mock.calls[0]![0]).toEqual(["note", ID]);
    const keys = keysOf(invSpy as never);
    for (const k of [["shares", ID], ["public-link", ID]]) {
      expect(keys).toContainEqual(k);
    }
    for (const k of ["notes", "note-by-path", "note-by-group-path", "groups"]) {
      expect(keys).toContainEqual([k]);
    }
  });
});

describe("move / copy with a folder", () => {
  it("move body contains only keys with values (no folderId given = no such key); keepHistory is always sent, true or false", async () => {
    const f = setupFetch({ [`POST ${NOTE_URL}/move`]: () => fakeResponse(200, noteDto({ groupId: GID })) });
    const client = makeClient();
    const { result } = renderHook(() => useMoveNoteToGroup(ID), { wrapper: wrapperFor(client) });
    await result.current.mutateAsync({ groupId: "G", keepHistory: true });
    expect(Object.keys(JSON.parse(f.calls[0]!.body!))).toEqual(["groupId", "keepHistory"]);
    await result.current.mutateAsync({ groupId: "G", folderId: "GF", keepHistory: false });
    expect(JSON.parse(f.calls[1]!.body!)).toEqual({ groupId: "G", folderId: "GF", keepHistory: false });
  });

  it("a move refetches an open versions list: applyMovedNote's ['notes'] invalidation covers the versions keys", () => {
    const client = makeClient();
    client.setQueryData(versionListKey(ID, "all"), { pages: [], pageParams: [] });
    client.setQueryData(versionCurrentKey(ID), { id: "x" });
    expect(client.getQueryState(versionListKey(ID, "all"))?.isInvalidated).toBe(false);
    applyMovedNote(client, ID, noteDto({ groupId: GID }));
    expect(client.getQueryState(versionListKey(ID, "all"))?.isInvalidated).toBe(true);
    expect(client.getQueryState(versionCurrentKey(ID))?.isInvalidated).toBe(true);
  });

  it("copy body: {} has no keys; { folderId } has only folderId", async () => {
    const f = setupFetch({ [`POST ${NOTE_URL}/copy`]: () => fakeResponse(201, noteDto({ id: "44444444-4444-4444-4444-444444444444" })) });
    const client = makeClient();
    const { result } = renderHook(() => useCopyNote(ID), { wrapper: wrapperFor(client) });
    await result.current.mutateAsync({});
    expect(Object.keys(JSON.parse(f.calls[0]!.body!))).toHaveLength(0);
    await result.current.mutateAsync({ folderId: "A" });
    expect(JSON.parse(f.calls[1]!.body!)).toEqual({ folderId: "A" });
  });

  it.each([
    ["move success", "move", 200],
    ["move failure", "move", 409],
    ["copy success", "copy", 201],
    ["copy failure", "copy", 409],
  ] as const)("after %s invalidates ['folders']", async (_name, kind, status) => {
    const body = status < 400 ? noteDto({ id: "44444444-4444-4444-4444-444444444444", groupId: GID }) : { error: { code: "x", message: "x" } };
    setupFetch({ ...baseHandlers, [`POST ${NOTE_URL}/${kind}`]: () => fakeResponse(status, body) });
    const client = makeClient();
    const invSpy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => ({ move: useMoveNoteToGroup(ID), copy: useCopyNote(ID) }), { wrapper: wrapperFor(client) });
    await (kind === "move" ? result.current.move.mutateAsync({ groupId: GID, keepHistory: true }) : result.current.copy.mutateAsync({ groupId: GID })).catch(() => undefined);
    await waitFor(() => expect(keysOf(invSpy)).toContainEqual(["folders"]));
  });
});

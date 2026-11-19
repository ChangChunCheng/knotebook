import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { FavoriteDto } from "@knotebook/shared";
import { ApiFail } from "./client";
import { FAVORITES_QUERY_KEY, useAddFavorite, useFavoriteLookup, useFavorites, useFavoriteStatus, useRemoveFavorite } from "./favorites";

function fakeResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)),
  } as unknown as Response;
}

type Handler = () => Response | Promise<Response>;

function stubFetch(routes: Record<string, Handler[]>) {
  const calls: Array<{ method: string; url: string; init: RequestInit | undefined }> = [];
  const used: Record<string, number> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, init });
      const key = `${method} ${url}`;
      const list = routes[key];
      if (!list) throw new Error(`unexpected fetch: ${key}`);
      const i = used[key] ?? 0;
      used[key] = i + 1;
      return Promise.resolve(list[Math.min(i, list.length - 1)]!());
    }),
  );
  return calls;
}

function deferred() {
  let resolve!: (r: Response) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { handler: (() => promise) as Handler, resolve, reject };
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const fav = (noteId: string, favoritedAt: string): FavoriteDto => ({ noteId, favoritedAt });
const NOT_FOUND = () => fakeResponse(404, { error: { code: "not_found", message: "No note with that id." } });
const NO_CONTENT = () => fakeResponse(204);
const getCount = (calls: Array<{ method: string; url: string }>) =>
  calls.filter((c) => c.method === "GET" && c.url === "/api/favorites").length;
const cached = (qc: QueryClient) => qc.getQueryData<FavoriteDto[]>(FAVORITES_QUERY_KEY);
/** 20 ms lets queued promise callbacks and React Query notifications finish. */
const flush = () => act(() => new Promise((r) => setTimeout(r, 20)));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useFavorites", () => {
  it("key is ['favorites']; GET /api/favorites succeeds with an array", async () => {
    const list = [fav("b", "2026-03-02T00:00:00.000Z"), fav("a", "2026-03-01T00:00:00.000Z")];
    const calls = stubFetch({ "GET /api/favorites": [() => fakeResponse(200, list)] });
    const qc = client();
    const { result } = renderHook(() => useFavorites(), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.data).toEqual(list));
    expect(cached(qc)).toEqual(list);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /api/favorites"]);
  });

  it("does not GET with enabled: false; GETs once true", async () => {
    const calls = stubFetch({ "GET /api/favorites": [() => fakeResponse(200, [])] });
    const qc = client();
    const { result, rerender } = renderHook(({ enabled }) => useFavorites({ enabled }), {
      wrapper: wrapper(qc),
      initialProps: { enabled: false },
    });
    await flush();
    expect(calls).toHaveLength(0);
    expect(result.current.fetchStatus).toBe("idle");
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.data).toEqual([]));
    expect(getCount(calls)).toBe(1);
  });
});

describe("useAddFavorite", () => {
  it("PUT /api/favorites/:id with no body and no Content-Type", async () => {
    const calls = stubFetch({ "PUT /api/favorites/n1": [() => fakeResponse(200, fav("n1", "2026-03-01T00:00:00.000Z"))] });
    const qc = client();
    const { result } = renderHook(() => useAddFavorite(), { wrapper: wrapper(qc) });
    await act(() => result.current.mutateAsync({ noteId: "n1" }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.body).toBeUndefined();
    expect(new Headers(calls[0]!.init?.headers).has("Content-Type")).toBe(false);
  });

  it("optimistic insert orders by added time, newest first; on the same millisecond the larger noteId comes first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = "2026-03-05T10:00:00.000Z";
    vi.setSystemTime(new Date(now));
    const putZ = deferred();
    const putC = deferred();
    stubFetch({ "PUT /api/favorites/z": [putZ.handler], "PUT /api/favorites/c": [putC.handler] });
    const qc = client();
    qc.setQueryData(FAVORITES_QUERY_KEY, [fav("m", now), fav("x", "2026-03-04T00:00:00.000Z")]);
    const { result } = renderHook(() => useAddFavorite(), { wrapper: wrapper(qc) });

    act(() => result.current.mutate({ noteId: "z" }));
    await waitFor(() => expect(cached(qc)?.map((f) => f.noteId)).toEqual(["z", "m", "x"]));
    expect(cached(qc)?.[0]).toEqual(fav("z", now));

    act(() => result.current.mutate({ noteId: "c" }));
    await waitFor(() => expect(cached(qc)?.map((f) => f.noteId)).toEqual(["z", "m", "c", "x"]));
    putZ.resolve(fakeResponse(200, fav("z", now)));
    putC.resolve(fakeResponse(200, fav("c", now)));
  });

  it("add failure (404) -> cache returns to the original value, mutateAsync rejects with ApiFail", async () => {
    stubFetch({ "PUT /api/favorites/a": [NOT_FOUND] });
    const qc = client();
    const before = [fav("x", "2026-03-04T00:00:00.000Z")];
    qc.setQueryData(FAVORITES_QUERY_KEY, before);
    const { result } = renderHook(() => useAddFavorite(), { wrapper: wrapper(qc) });
    let err: unknown;
    await act(async () => {
      await result.current.mutateAsync({ noteId: "a" }).catch((e: unknown) => {
        err = e;
      });
    });
    expect(err).toBeInstanceOf(ApiFail);
    expect((err as ApiFail).code).toBe("not_found");
    expect(cached(qc)).toEqual(before);
  });

  it("adding a note already in the cache doesn't remove it when the add fails", async () => {
    stubFetch({ "PUT /api/favorites/a": [NOT_FOUND] });
    const qc = client();
    const before = [fav("a", "2026-03-04T00:00:00.000Z")];
    qc.setQueryData(FAVORITES_QUERY_KEY, before);
    const { result } = renderHook(() => useAddFavorite(), { wrapper: wrapper(qc) });
    await act(async () => {
      await result.current.mutateAsync({ noteId: "a" }).catch(() => undefined);
    });
    expect(cached(qc)).toEqual(before);
  });

  it("A add in flight, B removal completes first, then A fails -> cache has neither A nor B", async () => {
    const putA = deferred();
    stubFetch({ "PUT /api/favorites/a": [putA.handler], "DELETE /api/favorites/b": [NO_CONTENT] });
    const qc = client();
    qc.setQueryData(FAVORITES_QUERY_KEY, [fav("b", "2026-03-04T00:00:00.000Z")]);
    const { result } = renderHook(() => ({ add: useAddFavorite(), remove: useRemoveFavorite() }), { wrapper: wrapper(qc) });

    let addDone!: Promise<unknown>;
    act(() => {
      addDone = result.current.add.mutateAsync({ noteId: "a" }).catch(() => undefined);
    });
    await waitFor(() => expect(cached(qc)?.map((f) => f.noteId)).toEqual(["a", "b"]));
    await act(() => result.current.remove.mutateAsync({ noteId: "b" }));
    expect(cached(qc)?.map((f) => f.noteId)).toEqual(["a"]);

    putA.resolve(NOT_FOUND());
    await act(() => addDone);
    expect(cached(qc)).toEqual([]);
  });

  it("after success favoritedAt becomes the server's value", async () => {
    const server = "2026-03-05T10:00:00.123Z";
    stubFetch({ "PUT /api/favorites/a": [() => fakeResponse(200, fav("a", server))] });
    const qc = client();
    qc.setQueryData(FAVORITES_QUERY_KEY, []);
    const { result } = renderHook(() => useAddFavorite(), { wrapper: wrapper(qc) });
    await act(() => result.current.mutateAsync({ noteId: "a" }));
    expect(cached(qc)).toEqual([fav("a", server)]);
  });

  it("a refetch lands mid-flight and overwrites the cache without A, then A succeeds -> A is restored, in order", async () => {
    const putA = deferred();
    stubFetch({ "PUT /api/favorites/a": [putA.handler] });
    const qc = client();
    const x = fav("x", "2026-03-04T00:00:00.000Z");
    const y = fav("y", "2026-03-06T00:00:00.000Z");
    qc.setQueryData(FAVORITES_QUERY_KEY, [x]);
    const { result } = renderHook(() => useAddFavorite(), { wrapper: wrapper(qc) });

    let done!: Promise<unknown>;
    act(() => {
      done = result.current.mutateAsync({ noteId: "a" });
    });
    await waitFor(() => expect(cached(qc)?.map((f) => f.noteId)).toContain("a"));
    act(() => {
      qc.setQueryData(FAVORITES_QUERY_KEY, [y, x]);
    });

    const server = fav("a", "2026-03-05T00:00:00.000Z");
    putA.resolve(fakeResponse(200, server));
    await act(() => done);
    expect(cached(qc)).toEqual([y, server, x]);
  });

  it("a refetch already in flight before the add is cancelled; the stale list that comes back doesn't overwrite the optimistic row", async () => {
    const refetch = deferred();
    const putA = deferred();
    const rowA = fav("a", "2026-03-05T00:00:00.000Z");
    stubFetch({
      "GET /api/favorites": [() => fakeResponse(200, []), refetch.handler, () => fakeResponse(200, [rowA])],
      "PUT /api/favorites/a": [putA.handler],
    });
    const qc = client();
    const { result } = renderHook(() => ({ list: useFavorites(), add: useAddFavorite() }), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.list.data).toEqual([]));
    act(() => {
      void qc.invalidateQueries({ queryKey: FAVORITES_QUERY_KEY });
    });
    await waitFor(() => expect(qc.getQueryState(FAVORITES_QUERY_KEY)?.fetchStatus).toBe("fetching"));

    let done!: Promise<unknown>;
    act(() => {
      done = result.current.add.mutateAsync({ noteId: "a" });
    });
    await waitFor(() => expect(cached(qc)?.map((f) => f.noteId)).toEqual(["a"]));
    refetch.resolve(fakeResponse(200, []));
    await flush();
    expect(cached(qc)?.map((f) => f.noteId)).toEqual(["a"]);

    putA.resolve(fakeResponse(200, rowA));
    await act(() => done);
    await waitFor(() => expect(result.current.list.data).toEqual([rowA]));
  });

  it("A and B added together: no refetch when B finishes first; one refetch after A finishes", async () => {
    const putA = deferred();
    const putB = deferred();
    const rowA = fav("a", "2026-03-05T00:00:00.000Z");
    const rowB = fav("b", "2026-03-05T00:00:01.000Z");
    const calls = stubFetch({
      "GET /api/favorites": [() => fakeResponse(200, []), () => fakeResponse(200, [rowB, rowA])],
      "PUT /api/favorites/a": [putA.handler],
      "PUT /api/favorites/b": [putB.handler],
    });
    const qc = client();
    const { result } = renderHook(() => ({ list: useFavorites(), add: useAddFavorite() }), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.list.data).toEqual([]));
    expect(getCount(calls)).toBe(1);

    let doneA!: Promise<unknown>;
    let doneB!: Promise<unknown>;
    act(() => {
      doneA = result.current.add.mutateAsync({ noteId: "a" });
    });
    act(() => {
      doneB = result.current.add.mutateAsync({ noteId: "b" });
    });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2));

    putB.resolve(fakeResponse(200, rowB));
    await act(() => doneB);
    await flush();
    expect(getCount(calls)).toBe(1);
    expect(result.current.list.data?.map((f) => f.noteId).sort()).toEqual(["a", "b"]);

    putA.resolve(fakeResponse(200, rowA));
    await act(() => doneA);
    await waitFor(() => expect(getCount(calls)).toBe(2));
    await flush();
    expect(getCount(calls)).toBe(2);
    expect(result.current.list.data).toEqual([rowB, rowA]);
  });

  it("A add in flight, B removal finishes first: no refetch when B finishes; one refetch after A finishes", async () => {
    const putA = deferred();
    const rowA = fav("a", "2026-03-05T00:00:00.000Z");
    const rowB = fav("b", "2026-03-04T00:00:00.000Z");
    const calls = stubFetch({
      "GET /api/favorites": [() => fakeResponse(200, [rowB]), () => fakeResponse(200, [rowA])],
      "PUT /api/favorites/a": [putA.handler],
      "DELETE /api/favorites/b": [NO_CONTENT],
    });
    const qc = client();
    const { result } = renderHook(() => ({ list: useFavorites(), add: useAddFavorite(), remove: useRemoveFavorite() }), {
      wrapper: wrapper(qc),
    });
    await waitFor(() => expect(result.current.list.data).toEqual([rowB]));
    expect(getCount(calls)).toBe(1);

    let doneA!: Promise<unknown>;
    act(() => {
      doneA = result.current.add.mutateAsync({ noteId: "a" });
    });
    await waitFor(() => expect(cached(qc)?.map((f) => f.noteId)).toEqual(["a", "b"]));
    await act(() => result.current.remove.mutateAsync({ noteId: "b" }));
    await flush();
    expect(getCount(calls)).toBe(1);
    expect(cached(qc)?.map((f) => f.noteId)).toEqual(["a"]);

    putA.resolve(fakeResponse(200, rowA));
    await act(() => doneA);
    await waitFor(() => expect(getCount(calls)).toBe(2));
    await flush();
    expect(getCount(calls)).toBe(2);
    expect(result.current.list.data).toEqual([rowA]);
  });

  it("one refetch after a failed add too (when the list is mounted)", async () => {
    const rowX = fav("x", "2026-03-04T00:00:00.000Z");
    const calls = stubFetch({ "GET /api/favorites": [() => fakeResponse(200, [rowX])], "PUT /api/favorites/a": [NOT_FOUND] });
    const qc = client();
    const { result } = renderHook(() => ({ list: useFavorites(), add: useAddFavorite() }), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.list.data).toEqual([rowX]));
    expect(getCount(calls)).toBe(1);

    await act(async () => {
      await result.current.add.mutateAsync({ noteId: "a" }).catch(() => undefined);
    });
    await waitFor(() => expect(getCount(calls)).toBe(2));
    await flush();
    expect(getCount(calls)).toBe(2);
  });
});

describe("useRemoveFavorite", () => {
  it("a single removal triggers one refetch after it completes (when the list is mounted)", async () => {
    const rowA = fav("a", "2026-03-05T00:00:00.000Z");
    const calls = stubFetch({
      "GET /api/favorites": [() => fakeResponse(200, [rowA]), () => fakeResponse(200, [])],
      "DELETE /api/favorites/a": [NO_CONTENT],
    });
    const qc = client();
    const { result } = renderHook(() => ({ list: useFavorites(), remove: useRemoveFavorite() }), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.list.data).toEqual([rowA]));
    expect(getCount(calls)).toBe(1);

    await act(() => result.current.remove.mutateAsync({ noteId: "a" }));
    await waitFor(() => expect(getCount(calls)).toBe(2));
    await flush();
    expect(getCount(calls)).toBe(2);
    expect(result.current.list.data).toEqual([]);
  });

  it("DELETE /api/favorites/:id; cache unchanged before the response, that note filtered out after 204", async () => {
    const del = deferred();
    const calls = stubFetch({ "DELETE /api/favorites/a": [del.handler] });
    const qc = client();
    const a = fav("a", "2026-03-05T00:00:00.000Z");
    const b = fav("b", "2026-03-04T00:00:00.000Z");
    qc.setQueryData(FAVORITES_QUERY_KEY, [a, b]);
    const { result } = renderHook(() => useRemoveFavorite(), { wrapper: wrapper(qc) });

    let done!: Promise<unknown>;
    act(() => {
      done = result.current.mutateAsync({ noteId: "a" });
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    await flush();
    expect(cached(qc)).toEqual([a, b]);

    del.resolve(NO_CONTENT());
    await act(() => done);
    expect(cached(qc)).toEqual([b]);
  });

  it("removal failure (network error) -> cache unchanged, mutateAsync rejects", async () => {
    const del = deferred();
    stubFetch({ "DELETE /api/favorites/a": [del.handler] });
    const qc = client();
    const before = [fav("a", "2026-03-05T00:00:00.000Z")];
    qc.setQueryData(FAVORITES_QUERY_KEY, before);
    const { result } = renderHook(() => useRemoveFavorite(), { wrapper: wrapper(qc) });
    let err: unknown;
    act(() => {
      void result.current.mutateAsync({ noteId: "a" }).catch((e: unknown) => {
        err = e;
      });
    });
    del.reject(new TypeError("Failed to fetch"));
    await waitFor(() => expect(err).toBeInstanceOf(TypeError));
    expect(cached(qc)).toEqual(before);
  });
});

describe("useFavoriteStatus", () => {
  it("ready=false while the query is pending; pending=true while this note is in flight, other notes unaffected; pending=false when done", async () => {
    const get = deferred();
    const putA = deferred();
    const rowA = fav("a", "2026-03-05T00:00:00.000Z");
    const rowB = fav("b", "2026-03-04T00:00:00.000Z");
    // The second GET is the refetch after the add completes.
    stubFetch({ "GET /api/favorites": [get.handler, () => fakeResponse(200, [rowA, rowB])], "PUT /api/favorites/a": [putA.handler] });
    const qc = client();
    const { result } = renderHook(() => ({ a: useFavoriteStatus("a"), b: useFavoriteStatus("b"), add: useAddFavorite() }), {
      wrapper: wrapper(qc),
    });
    await flush();
    expect(result.current.a).toEqual({ ready: false, favorite: false, pending: false });

    get.resolve(fakeResponse(200, [rowB]));
    await waitFor(() => expect(result.current.a.ready).toBe(true));
    expect(result.current.a).toEqual({ ready: true, favorite: false, pending: false });
    expect(result.current.b).toEqual({ ready: true, favorite: true, pending: false });

    let done!: Promise<unknown>;
    act(() => {
      done = result.current.add.mutateAsync({ noteId: "a" });
    });
    await waitFor(() => expect(result.current.a).toEqual({ ready: true, favorite: true, pending: true }));
    expect(result.current.b.pending).toBe(false);

    putA.resolve(fakeResponse(200, rowA));
    await act(() => done);
    await waitFor(() => expect(result.current.a.pending).toBe(false));
    expect(result.current.a.favorite).toBe(true);
  });

  it("pending=true while this note's removal is in flight, pending=false after 204", async () => {
    const del = deferred();
    const rowA = fav("a", "2026-03-05T00:00:00.000Z");
    // The second GET is the refetch after the removal completes.
    stubFetch({ "GET /api/favorites": [() => fakeResponse(200, [rowA]), () => fakeResponse(200, [])], "DELETE /api/favorites/a": [del.handler] });
    const qc = client();
    const { result } = renderHook(() => ({ a: useFavoriteStatus("a"), remove: useRemoveFavorite() }), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.a).toEqual({ ready: true, favorite: true, pending: false }));

    let done!: Promise<unknown>;
    act(() => {
      done = result.current.remove.mutateAsync({ noteId: "a" });
    });
    await waitFor(() => expect(result.current.a).toEqual({ ready: true, favorite: true, pending: true }));

    del.resolve(NO_CONTENT());
    await act(() => done);
    await waitFor(() => expect(result.current.a).toEqual({ ready: true, favorite: false, pending: false }));
  });

  it("background refetch fails while mounted -> ready=false, favorite=false (even if the cache still has this note)", async () => {
    const rowA = fav("a", "2026-03-05T00:00:00.000Z");
    stubFetch({
      "GET /api/favorites": [() => fakeResponse(200, [rowA]), () => fakeResponse(500, { error: { code: "internal", message: "x" } })],
    });
    const qc = client();
    const { result } = renderHook(() => useFavoriteStatus("a"), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current).toEqual({ ready: true, favorite: true, pending: false }));
    await act(() => qc.invalidateQueries({ queryKey: FAVORITES_QUERY_KEY }));
    await waitFor(() => expect(qc.getQueryState(FAVORITES_QUERY_KEY)?.status).toBe("error"));
    await flush();
    expect(cached(qc)).toEqual([rowA]);
    expect(result.current).toEqual({ ready: false, favorite: false, pending: false });
  });

  it("query failure -> ready=false", async () => {
    stubFetch({ "GET /api/favorites": [() => fakeResponse(500, { error: { code: "internal", message: "x" } })] });
    const qc = client();
    const { result } = renderHook(() => useFavoriteStatus("a"), { wrapper: wrapper(qc) });
    await waitFor(() => expect(qc.getQueryState(FAVORITES_QUERY_KEY)?.status).toBe("error"));
    expect(result.current).toEqual({ ready: false, favorite: false, pending: false });
  });

  it("mounted after a refetch failure (e.g. reopening the menu) -> ready=false even though the cache still has the old list", async () => {
    const rowA = fav("a", "2026-03-05T00:00:00.000Z");
    stubFetch({
      "GET /api/favorites": [() => fakeResponse(200, [rowA]), () => fakeResponse(500, { error: { code: "internal", message: "x" } })],
    });
    const qc = client();
    const first = renderHook(() => useFavorites(), { wrapper: wrapper(qc) });
    await waitFor(() => expect(first.result.current.data).toEqual([rowA]));
    await act(() => qc.invalidateQueries({ queryKey: FAVORITES_QUERY_KEY }));
    await waitFor(() => expect(qc.getQueryState(FAVORITES_QUERY_KEY)?.status).toBe("error"));
    first.unmount();

    const { result } = renderHook(() => useFavoriteStatus("a"), { wrapper: wrapper(qc) });
    await flush();
    expect(cached(qc)).toEqual([rowA]);
    expect(result.current).toEqual({ ready: false, favorite: false, pending: false });
  });
});

describe("useFavoriteLookup", () => {
  it("list succeeds -> ready, ids is the set of favorite noteIds; GET only once in total", async () => {
    const calls = stubFetch({ "GET /api/favorites": [() => fakeResponse(200, [fav("b", "2026-03-02T00:00:00.000Z"), fav("a", "2026-03-01T00:00:00.000Z")])] });
    const qc = client();
    const { result } = renderHook(() => useFavoriteLookup(), { wrapper: wrapper(qc) });
    expect(result.current.ready).toBe(false);
    expect(result.current.ids.size).toBe(0);
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect([...result.current.ids].sort()).toEqual(["a", "b"]);
    expect(result.current.pendingIds.size).toBe(0);
    expect(getCount(calls)).toBe(1);
  });

  it("query failure -> ready=false, ids empty (callers check ready and don't treat an empty set as 'none are favorites')", async () => {
    stubFetch({ "GET /api/favorites": [() => fakeResponse(500, { error: { code: "internal", message: "x" } })] });
    const qc = client();
    const { result } = renderHook(() => useFavoriteLookup(), { wrapper: wrapper(qc) });
    await waitFor(() => expect(qc.getQueryState(FAVORITES_QUERY_KEY)?.status).toBe("error"));
    expect(result.current.ready).toBe(false);
    expect(result.current.ids.size).toBe(0);
  });

  it("pendingIds holds only the in-flight note; cleared on completion", async () => {
    const put = deferred();
    stubFetch({
      "GET /api/favorites": [() => fakeResponse(200, [])],
      "PUT /api/favorites/a": [put.handler],
    });
    const qc = client();
    const { result } = renderHook(() => ({ lookup: useFavoriteLookup(), add: useAddFavorite() }), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.lookup.ready).toBe(true));
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = result.current.add.mutateAsync({ noteId: "a" });
    });
    await waitFor(() => expect([...result.current.lookup.pendingIds]).toEqual(["a"]));
    expect(result.current.lookup.ids.has("a")).toBe(true);
    await act(async () => {
      put.resolve(fakeResponse(200, fav("a", "2026-03-05T00:00:00.000Z")));
      await done;
    });
    await waitFor(() => expect(result.current.lookup.pendingIds.size).toBe(0));
  });
});

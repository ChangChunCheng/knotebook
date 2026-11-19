import { afterEach, describe, expect, it, vi } from "vitest";
import { baseRef } from "@/test/version-fixtures";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { VersionListDto } from "@knotebook/shared";
import {
  VersionSnapshotMismatch,
  applyVersion,
  base64ToBytes,
  fetchCurrent,
  fetchVersionList,
  saveVersion,
  useRenameVersion,
  useVersionList,
  useVersionSnapshot,
  versionListKey,
  versionSnapshotKey,
  versionsKey,
} from "./versions";

const NOTE = "11111111-1111-1111-1111-111111111111";
const V1 = "aaaaaaaa-0000-0000-0000-000000000001";
const V1_OTHER = "aaaaaaaa-0000-0000-0000-0000000000ff";

function fakeResponse(status: number, json?: unknown): Response {
  return {
    ok: status < 400,
    status,
    json: () => (json === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(json)),
  } as unknown as Response;
}

function listBody(over: Partial<VersionListDto> = {}): VersionListDto {
  return {
    versions: [],
    current: { baseSeq: null, base: null, dirty: false, nextSeq: 1, autoEnabled: true },
    nextBefore: null,
    ...over,
  };
}

/** "AQID" is bytes [1,2,3] */
const SNAP = (id: string) => ({ id, seq: 1, ydoc: "AQID" });

/** The default harness turns retry off; a case guarding the hook's own `retry: false` passes `new QueryClient()` (retry not disabled). */
function setup(
  handler: (url: string, init?: RequestInit) => Response,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${(init?.method ?? "GET").toUpperCase()} ${url}`);
      return Promise.resolve(handler(url, init));
    }),
  );
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { calls, queryClient, wrapper };
}

describe("api/versions", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("query keys: list is under the ['notes'] prefix, snapshot under its own prefix ['note-versions', noteId, id]", () => {
    expect(versionsKey(NOTE)).toEqual(["notes", NOTE, "versions"]);
    // #258: list key = versionsKey prefix + "list" + filter, so invalidate(versionsKey) refreshes both filters at once.
    expect(versionListKey(NOTE, "all")).toEqual(["notes", NOTE, "versions", "list", "all"]);
    expect(versionListKey(NOTE, "manual")).toEqual(["notes", NOTE, "versions", "list", "manual"]);
    expect(versionSnapshotKey(NOTE, V1)).toEqual(["note-versions", NOTE, V1]);
  });

  it("invalidate ['notes'] refetches the list, not the snapshot", async () => {
    const { calls, queryClient, wrapper } = setup((url) => {
      if (url === `/api/notes/${NOTE}/versions?limit=50`) return fakeResponse(200, listBody());
      if (url === `/api/notes/${NOTE}/versions/1`) return fakeResponse(200, SNAP(V1));
      throw new Error(`unexpected fetch: ${url}`);
    });
    const list = renderHook(() => useVersionList(NOTE, true), { wrapper });
    const snap = renderHook(() => useVersionSnapshot(NOTE, { seq: 1, id: V1, name: null }), { wrapper });
    await waitFor(() => expect(list.result.current.isSuccess && snap.result.current.isSuccess).toBe(true));
    const before = { list: calls.filter((c) => c.includes("?limit=50")).length, snap: calls.filter((c) => c.endsWith("/versions/1")).length };

    await queryClient.invalidateQueries({ queryKey: ["notes"] });

    await waitFor(() => expect(calls.filter((c) => c.includes("?limit=50")).length).toBe(before.list + 1));
    expect(calls.filter((c) => c.endsWith("/versions/1")).length).toBe(before.snap);
  });

  it("same seq, different id -> cache miss, one request each (a move can make the same seq point to different content)", async () => {
    let served = V1;
    const { calls, wrapper } = setup((url) => {
      if (url === `/api/notes/${NOTE}/versions/1`) return fakeResponse(200, SNAP(served));
      throw new Error(`unexpected fetch: ${url}`);
    });
    const first = renderHook(() => useVersionSnapshot(NOTE, { seq: 1, id: V1, name: null }), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    served = V1_OTHER;
    const second = renderHook(() => useVersionSnapshot(NOTE, { seq: 1, id: V1_OTHER, name: null }), { wrapper });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    expect(calls.filter((c) => c.endsWith("/versions/1"))).toHaveLength(2);
    expect(Array.from(second.result.current.data!)).toEqual([1, 2, 3]);
  });

  it("response id differs from the requested one -> discarded (error = VersionSnapshotMismatch, no data) and the list is invalidated", async () => {
    const { calls, wrapper } = setup((url) => {
      if (url === `/api/notes/${NOTE}/versions?limit=50`) return fakeResponse(200, listBody());
      if (url === `/api/notes/${NOTE}/versions/1`) return fakeResponse(200, SNAP(V1_OTHER));
      throw new Error(`unexpected fetch: ${url}`);
    });
    const list = renderHook(() => useVersionList(NOTE, true), { wrapper });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    const listCalls = calls.filter((c) => c.includes("?limit=50")).length;

    const snap = renderHook(() => useVersionSnapshot(NOTE, { seq: 1, id: V1, name: null }), { wrapper });
    await waitFor(() => expect(snap.result.current.isError).toBe(true));
    expect(snap.result.current.error).toBeInstanceOf(VersionSnapshotMismatch);
    expect(snap.result.current.data).toBeUndefined();
    await waitFor(() => expect(calls.filter((c) => c.includes("?limit=50")).length).toBe(listCalls + 1));
  });

  it("snapshot failure (404) -> error, no retry: snapshot endpoint hit once (QueryClient doesn't disable retry, guarding the hook's own retry: false)", async () => {
    // Deliberately a QueryClient that doesn't disable retry: without the hook's `retry: false`, query-core's default retries 3 times (backoff about 7 s, which fits within the global wait limit), so 4 requests have been made by the time isError appears and the count assertion fails.
    const { calls, wrapper } = setup((url) => {
      if (url === `/api/notes/${NOTE}/versions/1`) return fakeResponse(404, { error: { code: "not_found", message: "x" } });
      throw new Error(`unexpected fetch: ${url}`);
    }, new QueryClient());
    const snap = renderHook(() => useVersionSnapshot(NOTE, { seq: 1, id: V1, name: null }), { wrapper });
    await waitFor(() => expect(snap.result.current.isError).toBe(true));
    expect(calls.filter((c) => c === `GET /api/notes/${NOTE}/versions/1`)).toHaveLength(1);
  });

  it("list cursor: before and limit are sent as given; the second page uses the previous page's nextBefore", async () => {
    const { calls, wrapper } = setup((url) => {
      if (url === `/api/notes/${NOTE}/versions?limit=50`) return fakeResponse(200, listBody({ nextBefore: 51 }));
      if (url === `/api/notes/${NOTE}/versions?before=51&limit=50`) return fakeResponse(200, listBody());
      throw new Error(`unexpected fetch: ${url}`);
    });
    const list = renderHook(() => useVersionList(NOTE, true), { wrapper });
    await waitFor(() => expect(list.result.current.hasNextPage).toBe(true));
    await list.result.current.fetchNextPage();
    await waitFor(() => expect(list.result.current.data?.pages).toHaveLength(2));
    expect(list.result.current.hasNextPage).toBe(false);
    expect(calls).toContain(`GET /api/notes/${NOTE}/versions?before=51&limit=50`);
    await expect(fetchVersionList(NOTE, { before: 7, limit: 1 })).rejects.toThrow("unexpected fetch");
  });

  it("enabled=false -> list not requested", async () => {
    const { calls, wrapper } = setup(() => {
      throw new Error("unexpected fetch");
    });
    renderHook(() => useVersionList(NOTE, false), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]);
  });

  it("fetchCurrent always refetches (staleTime 0): two calls make two limit=1 requests, returns current", async () => {
    let dirty = false;
    const { calls, queryClient } = setup((url) => {
      if (url === `/api/notes/${NOTE}/versions?limit=1`)
        return fakeResponse(200, listBody({ current: { baseSeq: 3, base: baseRef(3), dirty, nextSeq: 4, autoEnabled: true } }));
      throw new Error(`unexpected fetch: ${url}`);
    });
    expect((await fetchCurrent(queryClient, NOTE)).dirty).toBe(false);
    dirty = true;
    expect((await fetchCurrent(queryClient, NOTE)).dirty).toBe(true);
    expect(calls.filter((c) => c.endsWith("?limit=1"))).toHaveLength(2);
  });

  it("saveVersion: name is trimmed; all-whitespace or null -> body has no name", async () => {
    const bodies: unknown[] = [];
    setup((url, init) => {
      if (url === `/api/notes/${NOTE}/versions` && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)));
        return fakeResponse(201, { id: V1, seq: 1, kind: "manual", name: null, editors: [], baseSeq: null, base: null, createdAt: "x", upgraded: false });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    await saveVersion(NOTE, "  里程碑 ");
    await saveVersion(NOTE, "   ");
    await saveVersion(NOTE, null);
    expect(bodies).toEqual([{ name: "里程碑" }, {}, {}]);
  });

  it("applyVersion: POST .../:seq/apply, body is { versionId, discardUnsaved }", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    setup((url, init) => {
      seen.push({ url, body: JSON.parse(String(init?.body)) });
      return fakeResponse(200, { current: { baseSeq: 2, base: baseRef(2), dirty: false, nextSeq: 5, autoEnabled: true } });
    });
    const out = await applyVersion(NOTE, 2, { versionId: V1, discardUnsaved: true });
    expect(seen).toEqual([{ url: `/api/notes/${NOTE}/versions/2/apply`, body: { versionId: V1, discardUnsaved: true } }]);
    expect(out.current.baseSeq).toBe(2);
  });

  it("base64ToBytes: binary round trip (including 0x00 and 0xff)", () => {
    expect(Array.from(base64ToBytes("AP8A"))).toEqual([0, 255, 0]);
  });

  it("snapshot query also has Infinity staleTime at the useQuery level: remount doesn't refetch", async () => {
    const { calls, wrapper } = setup((url) => {
      if (url === `/api/notes/${NOTE}/versions/1`) return fakeResponse(200, SNAP(V1));
      throw new Error(`unexpected fetch: ${url}`);
    });
    const a = renderHook(() => useVersionSnapshot(NOTE, { seq: 1, id: V1, name: null }), { wrapper });
    await waitFor(() => expect(a.result.current.isSuccess).toBe(true));
    a.unmount();
    const b = renderHook(() => useQuery({ queryKey: versionSnapshotKey(NOTE, V1), enabled: false }), { wrapper });
    expect(b.result.current.data).toBeDefined();
    renderHook(() => useVersionSnapshot(NOTE, { seq: 1, id: V1, name: null }), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.endsWith("/versions/1"))).toHaveLength(1);
  });

  it("#258 list filter: kind=manual is sent as given (together with before and limit); no kind for all; each filter has its own cache entry", async () => {
    const { calls, queryClient, wrapper } = setup((url) => {
      if (url === `/api/notes/${NOTE}/versions?limit=50`) return fakeResponse(200, listBody());
      if (url === `/api/notes/${NOTE}/versions?kind=manual&limit=50`) return fakeResponse(200, listBody({ nextBefore: 9 }));
      if (url === `/api/notes/${NOTE}/versions?kind=manual&before=9&limit=50`) return fakeResponse(200, listBody());
      throw new Error(`unexpected fetch: ${url}`);
    });
    const all = renderHook(() => useVersionList(NOTE, true), { wrapper });
    const manual = renderHook(() => useVersionList(NOTE, true, "manual"), { wrapper });
    await waitFor(() => expect(all.result.current.isSuccess && manual.result.current.isSuccess).toBe(true));
    expect(manual.result.current.hasNextPage).toBe(true);
    expect(all.result.current.hasNextPage).toBe(false);
    await manual.result.current.fetchNextPage();
    await waitFor(() => expect(manual.result.current.data?.pages).toHaveLength(2));
    expect(calls).toEqual([
      `GET /api/notes/${NOTE}/versions?limit=50`,
      `GET /api/notes/${NOTE}/versions?kind=manual&limit=50`,
      `GET /api/notes/${NOTE}/versions?kind=manual&before=9&limit=50`,
    ]);
    expect(queryClient.getQueryData(versionListKey(NOTE, "all"))).toBeDefined();
    expect(queryClient.getQueryData(versionListKey(NOTE, "manual"))).toBeDefined();
    await expect(fetchVersionList(NOTE, { kind: "auto" })).rejects.toThrow("unexpected fetch");
    expect(calls.at(-1)).toBe(`GET /api/notes/${NOTE}/versions?kind=auto`);
  });

  it("#258 invalidating by the versionsKey prefix marks both filters' lists and refetches them (when subscribed); the single-shot current refetch key is also under the prefix", async () => {
    const { calls, queryClient, wrapper } = setup((url) => {
      if (url.includes("?")) return fakeResponse(200, listBody());
      throw new Error(`unexpected fetch: ${url}`);
    });
    const all = renderHook(() => useVersionList(NOTE, true), { wrapper });
    const manual = renderHook(() => useVersionList(NOTE, true, "manual"), { wrapper });
    await waitFor(() => expect(all.result.current.isSuccess && manual.result.current.isSuccess).toBe(true));
    await fetchCurrent(queryClient, NOTE);
    expect(queryClient.getQueryState(["notes", NOTE, "versions", "current"])).toBeDefined();
    const before = calls.length;
    await queryClient.invalidateQueries({ queryKey: versionsKey(NOTE) });
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(before + 2));
    expect(calls.slice(before).sort()).toEqual([
      `GET /api/notes/${NOTE}/versions?kind=manual&limit=50`,
      `GET /api/notes/${NOTE}/versions?limit=50`,
    ].sort());
  });

  it("#258 renaming an auto version (PATCH) succeeds -> the list with kind refetches at once, and the version turned manual appears in the manual-only list", async () => {
    let renamed = false;
    const row = (kind: "auto" | "manual") => ({ id: V1, seq: 1, kind, name: null, editors: [], baseSeq: null, base: null, createdAt: "x" });
    const { calls, wrapper } = setup((url, init) => {
      if (init?.method === "PATCH") {
        renamed = true;
        return fakeResponse(200, row("manual"));
      }
      if (url === `/api/notes/${NOTE}/versions?kind=manual&limit=50`) return fakeResponse(200, listBody({ versions: renamed ? [row("manual")] : [] }));
      throw new Error(`unexpected fetch: ${url}`);
    });
    const manual = renderHook(() => useVersionList(NOTE, true, "manual"), { wrapper });
    const rename = renderHook(() => useRenameVersion(NOTE), { wrapper });
    await waitFor(() => expect(manual.result.current.isSuccess).toBe(true));
    expect(manual.result.current.data?.pages[0]?.versions).toEqual([]);
    await rename.result.current.mutateAsync({ seq: 1, name: "命名" });
    await waitFor(() => expect(manual.result.current.data?.pages[0]?.versions.map((v) => v.seq)).toEqual([1]));
    expect(calls.filter((c) => c.includes("kind=manual"))).toHaveLength(2);
  });
});

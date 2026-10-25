import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import type { NoteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import type { PublicLinkDto } from "@/api/public-link";
import { personalNote } from "@/test/select-fixtures";
import { classifyBatchError, copyNotesInOrder, moveNotesInOrder, runSequential, trashNotesInOrder } from "./select-batch";

type Reply = Response | Promise<Response>;
interface Call {
  method: string;
  url: string;
  body: unknown;
}

function fakeResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)),
  } as unknown as Response;
}

const ok = (body?: unknown): Response => fakeResponse(body === undefined ? 204 : 200, body);
const fail = (status: number, code: string): Response => fakeResponse(status, { error: { code, message: "x" } });

/** 記下每次 `method url body`；回應依 `method url` 查表，未列的 throw（讓測試紅在這裡）。 */
function stubFetch(routes: Record<string, () => Reply>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      const route = routes[`${method} ${url}`];
      if (!route) throw new Error(`unexpected fetch ${method} ${url}`);
      return Promise.resolve(route());
    }),
  );
  return calls;
}

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** invalidateQueries 的呼叫序（照常執行，只記 queryKey）。 */
function spyInvalidations(qc: QueryClient): string[] {
  const keys: string[] = [];
  const original = qc.invalidateQueries.bind(qc);
  vi.spyOn(qc, "invalidateQueries").mockImplementation(((filters?: { queryKey?: readonly unknown[] }) => {
    keys.push(JSON.stringify(filters?.queryKey ?? null));
    return original(filters);
  }) as QueryClient["invalidateQueries"]);
  return keys;
}

const k = (...key: unknown[]): string => JSON.stringify(key);
const sorted = (keys: readonly string[]): string[] => [...new Set(keys)].sort();
const notes = (...ids: string[]): NoteDto[] => ids.map((id) => personalNote({ id, title: `T-${id}` }));
const del = (id: string): string => `DELETE /api/notes/${id}`;
const move = (id: string): string => `POST /api/notes/${id}/move`;
const copy = (id: string): string => `POST /api/notes/${id}/copy`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runSequential（spec §6.11 執行、D-M4）", () => {
  it("SB1 依序：前一篇回來之前不送下一篇；全部成功 → done 三篇、沒有略過與停下", async () => {
    let release!: (r: Response) => void;
    const calls = stubFetch({
      [del("a")]: () => new Promise<Response>((resolve) => { release = resolve; }),
      [del("b")]: () => ok(),
      [del("c")]: () => ok(),
    });
    const [a, b, c] = notes("a", "b", "c");
    const pending = trashNotesInOrder([a, b, c], { queryClient: newClient() });
    await waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(1);
    release(ok());
    const out = await pending;
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([del("a"), del("b"), del("c")]);
    expect(out).toEqual({ done: [a, b, c], skipped: 0, stopped: null });
  });

  it("SB2 classifyBatchError：403、404 not_found 略過；其餘一律停下", () => {
    expect(classifyBatchError(new ApiFail(403, "forbidden", "x"))).toBe("skip");
    expect(classifyBatchError(new ApiFail(404, "not_found", "x"))).toBe("skip");
    expect(classifyBatchError(new ApiFail(404, "role_not_found", "x"))).toBe("stop");
    expect(classifyBatchError(new ApiFail(404, "group_not_found", "x"))).toBe("stop");
    expect(classifyBatchError(new ApiFail(409, "storage_quota_exceeded", "x"))).toBe("stop");
    expect(classifyBatchError(new ApiFail(409, "server_busy", "x"))).toBe("stop");
    expect(classifyBatchError(new ApiFail(429, "too_many_requests", "x"))).toBe("stop");
    expect(classifyBatchError(new ApiFail(500, "internal", "x"))).toBe("stop");
    expect(classifyBatchError(new TypeError("Failed to fetch"))).toBe("stop");
  });

  it("SB3 略過繼續：403 與 404 not_found 計入 skipped，其餘照送", async () => {
    const calls = stubFetch({
      [del("a")]: () => ok(),
      [del("b")]: () => fail(403, "forbidden"),
      [del("c")]: () => fail(404, "not_found"),
      [del("d")]: () => ok(),
    });
    const [a, b, c, d] = notes("a", "b", "c", "d");
    const out = await trashNotesInOrder([a, b, c, d], { queryClient: newClient() });
    expect(calls).toHaveLength(4);
    expect(out.done).toEqual([a, d]);
    expect(out.skipped).toBe(2);
    expect(out.stopped).toBeNull();
  });

  it("SB4 停下：429 之後不再送；remaining 是停下那篇（含）之後的選取鍵形", async () => {
    const calls = stubFetch({
      [del("a")]: () => ok(),
      [del("b")]: () => fail(429, "too_many_requests"),
      [del("c")]: () => ok(),
      [del("d")]: () => ok(),
    });
    const [a, b, c, d] = notes("a", "b", "c", "d");
    const out = await trashNotesInOrder([a, b, c, d], { queryClient: newClient() });
    expect(calls.map((x) => x.url)).toEqual(["/api/notes/a", "/api/notes/b"]);
    expect(out.done).toEqual([a]);
    expect(out.skipped).toBe(0);
    expect(out.stopped?.remaining).toEqual([
      { kind: "note", id: "b" },
      { kind: "note", id: "c" },
      { kind: "note", id: "d" },
    ]);
    expect(out.stopped?.cause).toBeInstanceOf(ApiFail);
    expect((out.stopped?.cause as ApiFail).status).toBe(429);
  });

  it("SB5 hook 時機：beforeEach 在送出前；afterFailure 收到分類", async () => {
    const calls = stubFetch({
      [del("a")]: () => ok(),
      [del("b")]: () => fail(403, "forbidden"),
      [del("c")]: () => fail(429, "too_many_requests"),
    });
    const sentBefore: Array<[string, number]> = [];
    const failures: Array<[string, number, string]> = [];
    await trashNotesInOrder(notes("a", "b", "c"), {
      queryClient: newClient(),
      beforeEach: (n) => sentBefore.push([n.id, calls.length]),
      afterFailure: (n, err, kind) => failures.push([n.id, (err as ApiFail).status, kind]),
    });
    expect(sentBefore).toEqual([["a", 0], ["b", 1], ["c", 2]]);
    expect(failures).toEqual([["b", 403, "skip"], ["c", 429, "stop"]]);
  });

  it("SB9 空陣列：三種動作都不送請求", async () => {
    const calls = stubFetch({});
    const qc = newClient();
    const empty = { done: [], skipped: 0, stopped: null };
    expect(await trashNotesInOrder([], { queryClient: qc })).toEqual(empty);
    expect(await moveNotesInOrder([], "g1", { queryClient: qc })).toEqual(empty);
    expect(await copyNotesInOrder([], { kind: "personal" }, { queryClient: qc })).toEqual(empty);
    expect(await runSequential([], () => ({ kind: "note", id: "x" }), () => Promise.resolve(1))).toEqual(empty);
    expect(calls).toHaveLength(0);
  });

  it("SB10 進度：每篇成功或略過後回報；停下那篇不回報", async () => {
    stubFetch({ [del("a")]: () => ok(), [del("b")]: () => fail(403, "forbidden"), [del("c")]: () => ok() });
    const progress: Array<[number, number]> = [];
    await trashNotesInOrder(notes("a", "b", "c"), { queryClient: newClient(), onProgress: (p, t) => progress.push([p, t]) });
    expect(progress).toEqual([[1, 3], [2, 3], [3, 3]]);

    vi.unstubAllGlobals();
    stubFetch({ [del("a")]: () => ok(), [del("b")]: () => fail(429, "too_many_requests"), [del("c")]: () => ok() });
    const stopped: Array<[number, number]> = [];
    await trashNotesInOrder(notes("a", "b", "c"), { queryClient: newClient(), onProgress: (p, t) => stopped.push([p, t]) });
    expect(stopped).toEqual([[1, 3]]);
  });
});

describe("trashNotesInOrder 快取", () => {
  it("SB6 整批後恰失效 notes／backlinks／trash 與每篇成功的 note；停下時也失效", async () => {
    stubFetch({ [del("a")]: () => ok(), [del("b")]: () => ok() });
    const qc = newClient();
    const keys = spyInvalidations(qc);
    await trashNotesInOrder(notes("a", "b"), { queryClient: qc });
    expect(sorted(keys)).toEqual(sorted([k("notes"), k("backlinks"), k("trash"), k("note", "a"), k("note", "b")]));

    vi.unstubAllGlobals();
    stubFetch({ [del("a")]: () => ok(), [del("b")]: () => fail(429, "too_many_requests") });
    const qc2 = newClient();
    const keys2 = spyInvalidations(qc2);
    const out = await trashNotesInOrder(notes("a", "b"), { queryClient: qc2 });
    expect(out.stopped).not.toBeNull();
    expect(sorted(keys2)).toEqual(sorted([k("notes"), k("backlinks"), k("trash"), k("note", "a")]));
  });
});

describe("moveNotesInOrder", () => {
  it("SB7 body、成功的快取寫入、失敗的對帳序；停下時 groups 仍失效", async () => {
    const [a, b, c] = notes("a", "b", "c");
    const movedA = { ...a, groupId: "g1", group: { id: "g1", name: "R&D" } };
    const movedB = { ...b, groupId: "g1", group: { id: "g1", name: "R&D" } };
    const calls = stubFetch({
      [move("a")]: () => ok(movedA),
      [move("b")]: () => ok(movedB),
      [move("c")]: () => fail(403, "forbidden"),
    });
    const qc = newClient();
    qc.setQueryData<PublicLinkDto>(["public-link", "a"], { token: "tok", slug: "pub", width: "standard" } as PublicLinkDto);
    const keys = spyInvalidations(qc);
    const out = await moveNotesInOrder([a, b, c], "g1", { queryClient: qc });
    expect(calls.map((x) => x.body)).toEqual([{ groupId: "g1" }, { groupId: "g1" }, { groupId: "g1" }]);
    expect(out.done).toEqual([movedA, movedB]);
    expect(out.skipped).toBe(1);
    expect(qc.getQueryData(["shares", "a"])).toEqual([]);
    expect(qc.getQueryData<PublicLinkDto>(["public-link", "a"])).toMatchObject({ token: null, slug: null });
    expect(qc.getQueryData(["note", "a"])).toEqual(movedA);
    expect(qc.getQueryData(["note", "b"])).toEqual(movedB);
    await waitFor(() => expect(keys).toContain(k("note", "c")));
    const noteC = keys.indexOf(k("note", "c"));
    expect(keys.indexOf(k("shares", "c"))).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf(k("public-link", "c"))).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf(k("shares", "c"))).toBeLessThan(noteC);
    expect(keys.indexOf(k("public-link", "c"))).toBeLessThan(noteC);

    // 停下案：第一篇 429。finally 的 groups 一次＋對帳序裡的一次。
    vi.unstubAllGlobals();
    stubFetch({ [move("a")]: () => fail(429, "too_many_requests") });
    const qc2 = newClient();
    const keys2 = spyInvalidations(qc2);
    const out2 = await moveNotesInOrder([a, b], "g1", { queryClient: qc2 });
    expect(out2.stopped?.remaining).toEqual([{ kind: "note", id: "a" }, { kind: "note", id: "b" }]);
    expect(keys2).toContain(k("groups"));
    await waitFor(() => expect(keys2).toContain(k("note", "a")));
    expect(keys2.filter((x) => x === k("groups"))).toHaveLength(2);
  });
});

describe("copyNotesInOrder", () => {
  it("SB8 body 依目的地、副本寫入快取、整批後失效 notes；停下時也失效", async () => {
    const [a, b] = notes("a", "b");
    const copyA = personalNote({ id: "ca", title: "T-a" });
    const copyB = personalNote({ id: "cb", title: "T-b", groupId: "g1", group: { id: "g1", name: "R&D" } });
    const calls = stubFetch({ [copy("a")]: () => ok(copyA), [copy("b")]: () => ok(copyB) });
    const qc = newClient();
    const keys = spyInvalidations(qc);
    const out = await copyNotesInOrder([a], { kind: "personal" }, { queryClient: qc });
    expect(calls[0].body).toEqual({});
    expect(out.done).toEqual([copyA]);
    expect(qc.getQueryData(["note", "ca"])).toEqual(copyA);
    expect(keys).toContain(k("notes"));

    const out2 = await copyNotesInOrder([b], { kind: "group", groupId: "g1", name: "R&D" }, { queryClient: qc });
    expect(calls[1].body).toEqual({ groupId: "g1" });
    expect(out2.done).toEqual([copyB]);
    expect(qc.getQueryData(["note", "cb"])).toEqual(copyB);

    vi.unstubAllGlobals();
    stubFetch({ [copy("a")]: () => ok(copyA), [copy("b")]: () => fail(429, "too_many_requests") });
    const qc2 = newClient();
    const keys2 = spyInvalidations(qc2);
    const out3 = await copyNotesInOrder([a, b], { kind: "personal" }, { queryClient: qc2 });
    expect(out3.stopped).not.toBeNull();
    expect(keys2).toContain(k("notes"));
  });
});

describe("hook 丟例外（finally 的意義）", () => {
  it("SB11 onProgress 丟例外 → 整批 reject，三種動作的整批失效仍做", async () => {
    const boom = (): never => {
      throw new Error("boom");
    };
    const [a] = notes("a");
    stubFetch({
      [del("a")]: () => ok(),
      [move("a")]: () => ok({ ...a, groupId: "g1" }),
      [copy("a")]: () => ok(personalNote({ id: "ca", title: "T-a" })),
    });

    const qc1 = newClient();
    const keys1 = spyInvalidations(qc1);
    await expect(trashNotesInOrder([a], { queryClient: qc1, onProgress: boom })).rejects.toThrow("boom");
    expect(sorted(keys1)).toEqual(sorted([k("notes"), k("backlinks"), k("trash"), k("note", "a")]));

    const qc2 = newClient();
    const keys2 = spyInvalidations(qc2);
    await expect(moveNotesInOrder([a], "g1", { queryClient: qc2, onProgress: boom })).rejects.toThrow("boom");
    expect(keys2).toContain(k("groups"));

    const qc3 = newClient();
    const keys3 = spyInvalidations(qc3);
    await expect(copyNotesInOrder([a], { kind: "personal" }, { queryClient: qc3, onProgress: boom })).rejects.toThrow("boom");
    expect(keys3).toContain(k("notes"));
  });
});

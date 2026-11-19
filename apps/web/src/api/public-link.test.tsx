import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCreatePublicLink, useDeletePublicLink, useSetPublicWidth, type PublicLinkDto } from "./public-link";

/**
 * #122: the two mutation write points of the public-link cache. Failure shape: a wrong write here turns no render test red, it only makes ShareDialog's public-link row or alias row vanish or linger.
 * - Revoke (DELETE): 204 has no body, so the cache must write `{token: null, slug: null}` (both keys); omitting slug leaves the alias on screen after revoking.
 * - Regenerate (PUT): onSuccess writes the server response directly; the server returns the full `{token, slug}`, and the cached slug must keep the original alias instead of becoming undefined.
 */

const NOTE_ID = "11111111-1111-1111-1111-111111111111";
const KEY = ["public-link", NOTE_ID];

function fakeResponse(status: number, json?: unknown): Response {
  return {
    ok: status < 400,
    status,
    json: () => (json === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(json)),
  } as unknown as Response;
}

function Harness() {
  const create = useCreatePublicLink(NOTE_ID);
  const del = useDeletePublicLink(NOTE_ID);
  const width = useSetPublicWidth(NOTE_ID);
  return (
    <div>
      <button onClick={() => create.mutate()}>put</button>
      <button onClick={() => del.mutate()}>del</button>
      <button onClick={() => width.mutate("wide")}>width</button>
    </div>
  );
}

function setup(fetchImpl: (method: string, url: string) => Response | Promise<Response>, seed = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  if (seed) queryClient.setQueryData(KEY, { token: "T".repeat(43), slug: "my-alias", width: "full" } satisfies PublicLinkDto);
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(fetchImpl((init?.method ?? "GET").toUpperCase(), String(input))),
  );
  vi.stubGlobal("fetch", fetchMock);
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
  );
  return { queryClient, fetchMock, ...utils };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public-link cache write points (#122)", () => {
  it("revoke (DELETE 204, no body) -> cache writes {token: null, slug: null}, both keys - alias doesn't linger", async () => {
    const { queryClient, getByText } = setup(() => fakeResponse(204));
    fireEvent.click(getByText("del"));
    await waitFor(() => {
      expect(queryClient.getQueryData(KEY)).toEqual({ token: null, slug: null, width: "full" });
    });
  });

  it("revoke with an empty cache -> no cache entry is created from nothing", async () => {
    const { queryClient, getByText, fetchMock } = setup(() => fakeResponse(204), false);
    fireEvent.click(getByText("del"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(queryClient.getQueryData(KEY)).toBeUndefined();
  });

  it("regenerate (PUT returns the full shape) -> cache gets the response directly, slug keeps the original alias, token is new", async () => {
    const NEW_TOKEN = "U".repeat(43);
    const { queryClient, getByText } = setup((method) =>
      method === "PUT" ? fakeResponse(200, { token: NEW_TOKEN, slug: "my-alias", width: "full" }) : fakeResponse(500),
    );
    fireEvent.click(getByText("put"));
    await waitFor(() => {
      expect(queryClient.getQueryData(KEY)).toEqual({ token: NEW_TOKEN, slug: "my-alias", width: "full" });
    });
  });

  it("width mutation success -> merges only width: a token regenerated meanwhile isn't overwritten by the old value", async () => {
    let resolveWidth!: (r: Response) => void;
    const { queryClient, getByText, fetchMock } = setup(
      () => new Promise<Response>((resolve) => (resolveWidth = resolve)),
    );
    fireEvent.click(getByText("width"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`/api/notes/${NOTE_ID}/public-width`);
    expect((init as RequestInit).method).toBe("PUT");
    expect((init as RequestInit).body).toBe('{"width":"wide"}');
    queryClient.setQueryData(KEY, { token: "U".repeat(43), slug: "my-alias", width: "full" });
    resolveWidth(fakeResponse(200, { width: "wide" }));
    await waitFor(() => {
      expect(queryClient.getQueryData(KEY)).toEqual({ token: "U".repeat(43), slug: "my-alias", width: "wide" });
    });
  });

  it("width mutation success with an empty cache -> nothing written", async () => {
    const { queryClient, getByText, fetchMock } = setup(() => fakeResponse(200, { width: "wide" }), false);
    fireEvent.click(getByText("width"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(queryClient.getQueryData(KEY)).toBeUndefined();
  });
});

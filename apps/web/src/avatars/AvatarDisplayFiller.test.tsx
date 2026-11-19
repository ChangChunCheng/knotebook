import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UserDto } from "@knotebook/shared";
import { SESSION_QUERY_KEY } from "@/auth/useSession";
import { AvatarDisplayFiller } from "./AvatarDisplayFiller";
import { enqueueFill, registerCropOpen, resetFiller } from "./display-filler";

vi.mock("./encode", () => ({
  decodeImage: async () => ({ width: 600, height: 400, close: () => undefined }),
  renderDisplay: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" }),
}));

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

function user(avatar: UserDto["avatar"]): UserDto {
  return {
    id: "u-alice",
    email: "alice@example.com",
    handle: "alice",
    displayName: "Alice",
    isAdmin: false,
    mustChangePassword: false,
    hasPassword: true,
    autoVersions: true,
    avatar,
  };
}

interface Call {
  method: string;
  url: string;
}

function setup(avatar: UserDto["avatar"], putResponse?: (url: string) => Response | undefined, userId = "u-alice") {
  const calls: Call[] = [];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { method: (init?.method ?? "GET").toUpperCase(), url: String(input) };
      calls.push(call);
      if (call.url === `/api/auth/avatars/${ID}/original`) {
        return new Response(new Uint8Array([9, 9]), { status: 200, headers: { "content-type": "image/png" } });
      }
      const custom = call.method === "PUT" ? putResponse?.(call.url) : undefined;
      if (custom) return custom;
      if (call.url.endsWith("/original")) {
        return new Response(new Uint8Array([9, 9]), { status: 200, headers: { "content-type": "image/png" } });
      }
      if (call.url.endsWith("/display") && call.method === "PUT") {
        return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(queryClient.getQueryData(SESSION_QUERY_KEY) ?? user(avatar)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  queryClient.setQueryData(SESSION_QUERY_KEY, { ...user(avatar), id: userId });
  const ui = (
    <QueryClientProvider client={queryClient}>
      <AvatarDisplayFiller />
    </QueryClientProvider>
  );
  return { calls, ui, queryClient };
}

const originals = (calls: Call[]) => calls.filter(c => c.url.endsWith("/original"));
const puts = (calls: Call[]) => calls.filter(c => c.method === "PUT");
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 80));

describe("AvatarDisplayFiller", () => {
  beforeEach(() => resetFiller());
  afterEach(() => {
    cleanup();
    resetFiller();
    vi.unstubAllGlobals();
  });

  it("renders no nodes", () => {
    const { ui } = setup(null);
    const { container } = render(ui);
    expect(container).toBeEmptyDOMElement();
  });

  it("current avatar pending -> reads the original and sends the display image back with the version", async () => {
    const { calls, ui } = setup({ id: ID, v: 4, pending: true });
    render(ui);
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(originals(calls)).toHaveLength(1);
  });

  it.each([
    ["pending is false", { id: ID, v: 4, pending: false }],
    ["no avatar (null)", null],
  ] as const)("%s -> does nothing", async (_name, avatar) => {
    const { calls, ui } = setup(avatar);
    render(ui);
    await settle();
    expect(originals(calls)).toHaveLength(0);
    expect(puts(calls)).toHaveLength(0);
  });

  it("after a remount from a page change (unmount then mount), the same version isn't sent again", async () => {
    const { calls, ui } = setup({ id: ID, v: 4, pending: true });
    const first = render(ui);
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    first.unmount();
    render(ui);
    await settle();
    expect(originals(calls)).toHaveLength(1);
    expect(puts(calls)).toHaveLength(1);
  });

  it("user switched (same tab): the previous user's processed memory is invalidated, the same (id, v) is processed again for the new user", async () => {
    const { calls, ui, queryClient } = setup({ id: ID, v: 4, pending: true });
    render(ui);
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    await settle();
    // Let the refetch invalidated after a successful write land first, so it doesn't overwrite the next user's data below.
    await act(async () => {
      queryClient.setQueryData(SESSION_QUERY_KEY, { ...user(null), id: "u-bob" });
      await settle(); // react-query notifications are queued for the next tick; wait for render and effects to catch up
    });
    enqueueFill({ id: ID, v: 4 });
    await waitFor(() => expect(puts(calls)).toHaveLength(2));
  });

  it("same user reloaded (id unchanged) doesn't clear the memory", async () => {
    const { calls, ui, queryClient } = setup({ id: ID, v: 4, pending: true });
    render(ui);
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    act(() => {
      queryClient.setQueryData(SESSION_QUERY_KEY, { ...user({ id: ID, v: 4, pending: true }), displayName: "Alice B" });
    });
    await settle();
    expect(puts(calls)).toHaveLength(1);
  });

  it("stale version (409 avatar_outdated) only refetches, not treated as a write: items that failed for lack of space aren't requeued", async () => {
    const OTHER = "1a2b3c4d-d9cb-469f-a165-70867728950f";
    const { calls, ui, queryClient } = setup(null, url =>
      url.includes(ID)
        ? new Response(JSON.stringify({ error: { code: "storage_quota_exceeded", message: "full" } }), { status: 409, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ error: { code: "avatar_outdated", message: "old" } }), { status: 409, headers: { "content-type": "application/json" } }),
    );
    render(ui);
    (await import("./filler-runtime")).configureForClient(queryClient);
    enqueueFill({ id: ID, v: 1 });
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    enqueueFill({ id: OTHER, v: 1 });
    await waitFor(() => expect(puts(calls)).toHaveLength(2));
    await settle();
    expect(originals(calls).filter(c => c.url.includes(ID))).toHaveLength(1);
    expect(puts(calls)).toHaveLength(2);
  });

  it("another user signs in after logout (shell unmount): the previous user's queued items aren't processed", async () => {
    const alice = setup(null);
    const first = render(alice.ui);
    await settle();
    (await import("./filler-runtime")).configureForClient(alice.queryClient); // backfill is loaded and can be processed
    const release = registerCropOpen(ID); // keeps alice's item in the queue
    enqueueFill({ id: ID, v: 1 });
    first.unmount();
    const bob = setup(null, undefined, "u-bob");
    render(bob.ui);
    await settle();
    release();
    await settle();
    expect(originals(alice.calls)).toHaveLength(0);
    expect(originals(bob.calls)).toHaveLength(0);
  });
});

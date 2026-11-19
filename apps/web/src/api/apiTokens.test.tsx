import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCreateApiToken } from "./apiTokens";
import { useCreateInvite, useCreatePasswordReset } from "./admin";

const SECRET = "knb_one-time-secret";

function stubFetch(json: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(json) } as unknown as Response)),
  );
}

function setup<T>(useHook: () => T) {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, ...renderHook(useHook, { wrapper }) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("one-time secrets are not kept in the mutation cache", () => {
  it("useCreateApiToken drops the response once the dialog stops observing it", async () => {
    stubFetch({ token: SECRET, id: "t1" });
    const { queryClient, result, unmount } = setup(useCreateApiToken);
    let created: unknown;
    await act(async () => {
      created = await result.current.mutateAsync({ name: "ci", scope: "notes:read", expiresInDays: 30 });
    });
    expect(created).toMatchObject({ token: SECRET });
    unmount();
    await waitFor(() => expect(queryClient.getMutationCache().getAll()).toHaveLength(0));
  });

  it("useCreateInvite drops the response once nothing observes it", async () => {
    stubFetch({ invite: { id: "i1" }, token: SECRET });
    const { queryClient, result, unmount } = setup(useCreateInvite);
    await act(async () => {
      await result.current.mutateAsync({ expiresInDays: 7, label: "x" });
    });
    unmount();
    await waitFor(() => expect(queryClient.getMutationCache().getAll()).toHaveLength(0));
  });

  it("useCreatePasswordReset drops the response once nothing observes it", async () => {
    stubFetch({ token: SECRET, expiresAt: "2030-01-01T00:00:00Z" });
    const { queryClient, result, unmount } = setup(useCreatePasswordReset);
    await act(async () => {
      await result.current.mutateAsync({ userId: "u1", expiresInHours: 24 });
    });
    unmount();
    await waitFor(() => expect(queryClient.getMutationCache().getAll()).toHaveLength(0));
  });
});

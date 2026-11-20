import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useLocation } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { useSidebarQuery } from "@/lib/sidebar-query";
import { useTour } from "@/lib/tour-context";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import App from "./App";

// Wraps the real TourProvider, with a probe beneath it, to confirm it's mounted inside App, inside the router and the sidebar-search provider. Without the sidebar-search provider useSidebarQuery() falls back to its own empty string, so the check types in the sidebar and sees whether the probe reads the same text.
const probe = vi.hoisted(() => ({ mounted: 0, hasTour: false, path: "", query: null as string | null }));
vi.mock("@/components/tour/TourProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/tour/TourProvider")>();
  function Probe() {
    probe.hasTour = useTour() !== null;
    probe.path = useLocation().pathname;
    probe.query = useSidebarQuery().query;
    return null;
  }
  return {
    ...actual,
    TourProvider: ({ children }: { children: ReactNode }) => {
      probe.mounted += 1;
      return (
        <actual.TourProvider>
          {children}
          <Probe />
        </actual.TourProvider>
      );
    },
  };
});

const USER: UserDto = {
  id: "u1",
  email: "a@example.com",
  handle: "tester",
  displayName: "Ann",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
  avatar: null,
};

interface Call {
  method: string;
  url: string;
}
let calls: Call[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url });
      if (url === "/api/auth/me") return json(USER);
      if (url === "/api/groups") return json([]);
      if (url === "/api/folders") return json(FOLDER_LIST_EMPTY);
      if (url === "/api/notes" && method === "GET") return json([]);
      return json({ error: { code: "not_found", message: url } }, 404);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App mounts the feature tour, but it doesn't appear by itself", () => {
  it("signed in on home: no sample notes created, no AI actions read, no overlay; the tour's context sits inside the router and the sidebar-search provider", async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <App />
      </QueryClientProvider>,
    );
    await screen.findByRole("button", { name: USER.displayName });
    await new Promise((r) => setTimeout(r, 300));
    expect(calls.filter((c) => c.method === "POST" && c.url === "/api/notes")).toEqual([]);
    expect(calls.filter((c) => c.url === "/api/ai/actions")).toEqual([]);
    expect(document.querySelector("[data-tour-overlay]")).toBeNull();
    expect(probe.mounted).toBeGreaterThan(0);
    expect(probe.hasTour).toBe(true);
    expect(probe.path).toBe("/");
    expect(probe.query).toBe("");

    fireEvent.change(screen.getAllByRole("textbox", { name: "Search notes" })[0]!, { target: { value: "needle" } });
    await waitFor(() => expect(probe.query).toBe("needle"));
  });
});

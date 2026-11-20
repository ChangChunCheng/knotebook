import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { ThemeProvider } from "@/theme";
import { __resetCollapseForTests } from "@/components/sidebar/collapse";
import { personalNote } from "@/test/select-fixtures";
import { AppShell } from "./AppShell";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

// Placeholders in the list and bottom while the SelectLazy chunk (normal-tab selection mode) is pending (#181): its load is held on a manually released promise (as in AppShell.trash-lazy.test.tsx).
// The gate only holds SidebarFooter and NoteList's first import (title row): NoteList issues two `import()`s of SelectLazy in one render and vitest 3.2.7 lets one of two concurrent imports from the same importer bypass the factory and load the real module (see AppShell.select-lazy-error.test.tsx), so the list's import is not gated. Before release "the list is ordinary rows" holds only because the real import needs several rounds and doesn't survive one act flush: add no wait (waitFor/find*/timers) before release, or the list swaps to the checkbox tree and the assertion turns red or vacuous.

const gate = vi.hoisted(() => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
});

vi.mock("@/components/sidebar/SelectLazy", async (importOriginal) => {
  await gate.promise;
  return importOriginal();
});

afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
});

function fakeResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

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

const NOTES = [personalNote({ id: "p1", title: "p1" }), personalNote({ id: "p2", title: "p2" })];

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse([]));
      if (url === "/api/auth/me") return Promise.resolve(fakeResponse(USER));
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse(NOTES));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

const aside = () => document.querySelector("aside") as HTMLElement;
const header = () => aside().querySelector("[data-sidebar-header]") as HTMLElement;

describe("AppShell - placeholders while the normal-tab selection chunk loads", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("chunk pending: list shows ordinary rows, bottom is a same-height blank (no New note); after release it becomes checkboxes and the action bar", async () => {
    stubFetch();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <ActiveNoteProvider>
              <Routes>
                <Route path="/" element={<AppShell>{null}</AppShell>} />
              </Routes>
            </ActiveNoteProvider>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
    await within(aside()).findByRole("link", { name: "p1" });
    fireEvent.click(within(header()).getByRole("button", { name: "Select" }));
    // Flush once (see the file header): the list's import bypasses the gate, so waiting longer would load the real checkbox tree.
    await act(async () => {});

    const panel = within(aside()).getByRole("tabpanel");
    expect(within(panel).getByRole("link", { name: "p1" })).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "p2" })).toBeInTheDocument();
    expect(within(panel).queryAllByRole("checkbox")).toHaveLength(0);
    expect(within(header()).queryByRole("button", { name: "Done" })).toBeNull();
    // SidebarFooter's placeholder: a blank the height of the action bar.
    expect(aside().querySelector(":scope > div.m-2.h-8")).not.toBeNull();
    expect(within(aside()).queryByRole("button", { name: "New note" })).toBeNull();

    await act(async () => {
      gate.release();
    });
    expect(await within(panel).findAllByRole("checkbox")).toHaveLength(2);
    expect(await within(aside()).findByRole("button", { name: "Copy to" })).toBeInTheDocument();
    expect(aside().querySelector(":scope > div.m-2.h-8")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

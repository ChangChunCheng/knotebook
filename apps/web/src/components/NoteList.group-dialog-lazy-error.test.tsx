import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { SidebarTabProvider } from "@/lib/sidebar-tab";
import { __resetCollapseForTests } from "@/components/sidebar/collapse";
import { __resetFolderSortForTests } from "@/components/sidebar/folder-sort";
import { AppErrorBoundary } from "./ErrorBoundary";
import { NoteList } from "./NoteList";

// The new-group dialog's lazy chunk fails to load: only an inline error in place, the sidebar and the whole app don't crash.
// `vi.mock` applies to the whole file, hence a separate file (as in NoteList.folder-lazy-error.test.tsx).
vi.mock("@/components/groups/GroupNameDialog", () =>
  Promise.reject(new TypeError("Failed to fetch dynamically imported module: http://localhost/assets/GroupNameDialog-abc.js")),
);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("NoteList - new group dialog chunk fails to load", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    sessionStorage.clear();
    localStorage.setItem("sidebar.tab", "workspace");
    vi.stubGlobal("location", { ...window.location, reload: vi.fn() });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/notes") return Promise.resolve(json([]));
        if (url === "/api/groups") return Promise.resolve(json([]));
        if (url === "/api/folders") return Promise.resolve(json({ folders: [] }));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
    localStorage.clear();
    __resetCollapseForTests();
    __resetFolderSortForTests();
  });

  it("reload allowance used up: pressing New group shows an inline error in the tabpanel, the sidebar header row is still there, the app didn't crash", async () => {
    sessionStorage.setItem("knotebook:chunk-reload:groupDialog", "1");
    render(
      <AppErrorBoundary reload={vi.fn()}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter>
            <ActiveNoteProvider>
              <SidebarTabProvider>
                <div role="tabpanel">
                  <NoteList />
                </div>
              </SidebarTabProvider>
            </ActiveNoteProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </AppErrorBoundary>,
    );
    const panel = screen.getByRole("tabpanel");
    const add = await within(panel).findByRole("button", { name: "New group" });
    fireEvent.click(add);
    const alert = await within(panel).findByRole("alert");
    expect(alert).toHaveTextContent(i18n.t("app.chunkLoadError"));
    expect(alert.parentElement?.className).toBe("p-2");
    expect(within(panel).getByRole("button", { name: "New group" })).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).toBeNull();
  });
});

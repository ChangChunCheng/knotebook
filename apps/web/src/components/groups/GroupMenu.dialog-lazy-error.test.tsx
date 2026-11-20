import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import i18n from "@/i18n";
import { AppErrorBoundary } from "@/components/ErrorBoundary";
import { adminRole, groupDto } from "@/test/fixtures";
import { GroupMenu } from "./GroupMenu";

// The lazy chunk of the rename/delete group dialog fails to load: only an inline error is shown in place, and the kebab button and the whole app do not crash.
// `vi.mock` applies to the whole file, so this is its own file (like NoteList.folder-lazy-error.test.tsx).
const fail = (name: string) => Promise.reject(new TypeError(`Failed to fetch dynamically imported module: http://localhost/assets/${name}-abc.js`));
vi.mock("./GroupNameDialog", () => fail("GroupNameDialog"));
vi.mock("./DeleteGroupDialog", () => fail("DeleteGroupDialog"));

const GROUP = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Workshop A" }, adminRole());

describe("GroupMenu - rename/delete dialog chunk load failure", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    sessionStorage.clear();
    sessionStorage.setItem("knotebook:chunk-reload:groupDialog", "1");
    vi.stubGlobal("location", { ...window.location, reload: vi.fn() });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }))));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it.each(["Rename", "Delete group"])("kebab -> %s: an inline error appears, the kebab button remains, the app does not crash", async (item) => {
    render(
      <AppErrorBoundary reload={vi.fn()}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter>
            <GroupMenu group={GROUP} />
          </MemoryRouter>
        </QueryClientProvider>
      </AppErrorBoundary>,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Group actions for Workshop A" }), { button: 0 });
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: item }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(i18n.t("app.chunkLoadError"));
    expect(screen.getByRole("button", { name: "Group actions for Workshop A", hidden: true })).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).toBeNull();
  });
});

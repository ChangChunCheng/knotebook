import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { NoteDto, TrashItemDto, UserDto } from "@knotebook/shared";
import type { SidebarTab } from "@/lib/sidebar-tab";
import i18n from "@/i18n";
import { SESSION_QUERY_KEY } from "@/auth/useSession";
import { ActiveNoteProvider } from "@/lib/active-note";
import { SidebarTabProvider, useSidebarTabActions } from "@/lib/sidebar-tab";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { OWNER_PERMS } from "@/test/fixtures";
import { TRASH_ME, trashItem, trashList } from "@/test/trash-fixtures";
import { personalNote } from "@/test/select-fixtures";
import { SidebarTabList } from "./SidebarTabList";
import { SidebarFooter } from "./SidebarFooter";
import { TrashPanel } from "./TrashPanel";
import { PHONE_BAR_CONTROL_HEIGHT, PHONE_BAR_FRAME } from "./phone-bar";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { mockWidePointer } from "@/test/wide-pointer";


afterEach(() => {
  localStorage.clear();
});

function fakeResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

function stubTrash(retentionDays: number | null = 7, list?: "pending" | number) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      urls.push(`${method} ${url}`);
      if (url === "/api/trash" && method === "GET") {
        if (list === "pending") return new Promise<Response>(() => {});
        if (typeof list === "number") return Promise.resolve(fakeResponse({ error: { code: "internal", message: "x" } }, list));
        return Promise.resolve(fakeResponse(trashList([], { retentionDays })));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return urls;
}

function renderFooter(tab: SidebarTab, props: { searching?: boolean; newNotePending?: boolean } = {}) {
  localStorage.setItem("sidebar.tab", tab);
  const onCreateNote = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SidebarTabProvider>
        <SidebarTabList idBase="t" />
        <SidebarFooter searching={props.searching ?? false} onCreateNote={onCreateNote} newNotePending={props.newNotePending ?? false} />
      </SidebarTabProvider>
    </QueryClientProvider>,
  );
  return { onCreateNote };
}

describe("SidebarFooter", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("trash tab: 7-day retention note and no New note", async () => {
    stubTrash(7);
    renderFooter("trash");
    expect(await screen.findByTestId("trash-footer")).toHaveTextContent(/^Permanently deleted 7 days after deletion$/);
    expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
    // Phone: the note sits above the floating Search button (56 + 16 px) and the safe area.
    expect(screen.getByTestId("trash-footer")).toHaveClass("max-sm:pb-[calc(5rem+env(safe-area-inset-bottom))]");
  });

  it("retention of 1 day: singular", async () => {
    stubTrash(1);
    renderFooter("trash");
    expect(await screen.findByTestId("trash-footer")).toHaveTextContent(/^Permanently deleted 1 day after deletion$/);
  });

  it("no auto-delete (null)", async () => {
    stubTrash(null);
    renderFooter("trash");
    expect(await screen.findByTestId("trash-footer")).toHaveTextContent(/^The trash isn't emptied automatically$/);
  });

  it("normal tab: New note calls onCreateNote when pressed", async () => {
    stubTrash();
    const { onCreateNote } = renderFooter("myNotes");
    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    expect(onCreateNote).toHaveBeenCalledTimes(1);
  });

  it.each(["myNotes", "recent"] as const)("%s tab: has New note", (tab) => {
    stubTrash();
    renderFooter(tab);
    expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
  });

  it.each(["workspace", "shared"] as const)("%s tab: no New note (it only creates personal notes)", (tab) => {
    stubTrash();
    renderFooter(tab);
    expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
  });

  it.each(["workspace", "shared"] as const)("%s tab while searching: still has New note (search results are not split by tab)", (tab) => {
    stubTrash();
    renderFooter(tab, { searching: true });
    expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
  });

  it("newNotePending -> disabled", () => {
    stubTrash();
    renderFooter("myNotes", { newNotePending: true });
    expect(screen.getByRole("button", { name: "New note" })).toBeDisabled();
  });

  it.each([
    ["loading", "pending" as const],
    ["failed", 500],
  ])("trash tab %s: no retention note, keeps an h-7 placeholder (layout does not jump)", async (_label, list) => {
    const urls = stubTrash(7, list);
    renderFooter("trash");
    await waitFor(() => expect(urls).toContain("GET /api/trash"));
    await act(async () => {});
    expect(screen.queryByTestId("trash-footer")).toBeNull();
    expect(document.querySelector("div.h-7")).not.toBeNull();
  });

  it("trash tab while searching: New note, no retention note", async () => {
    const urls = stubTrash();
    renderFooter("trash", { searching: true });
    expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
    expect(screen.queryByTestId("trash-footer")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(urls).not.toContain("GET /api/trash");
  });

  it("normal tab does not call GET /api/trash; switching to trash calls it once", async () => {
    const urls = stubTrash();
    renderFooter("myNotes");
    expect(await screen.findByRole("button", { name: "New note" })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(urls).not.toContain("GET /api/trash");

    fireEvent.click(screen.getByRole("tab", { name: "Trash" }));
    expect(await screen.findByTestId("trash-footer")).toBeInTheDocument();
    await waitFor(() => expect(urls.filter((url) => url === "GET /api/trash")).toHaveLength(1));
  });
});

describe("SidebarFooter - normal-tab select mode", () => {
  function SelectionProbe() {
    const { updateSelection } = useSidebarTabActions();
    return (
      <>
        <button type="button" onClick={() => updateSelection({ type: "start" })}>
          probe-start
        </button>
        <button type="button" onClick={() => updateSelection({ type: "end" })}>
          probe-end
        </button>
      </>
    );
  }

  function renderSelectFooter(props: { searching?: boolean; phone?: boolean } = {}) {
    localStorage.setItem("sidebar.tab", "myNotes");
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
        if (url === "/api/notes") return Promise.resolve(fakeResponse([personalNote({ id: "p1", title: "p1" })]));
        if (url === "/api/groups") return Promise.resolve(fakeResponse([]));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <SidebarTabProvider>
            <SelectionProbe />
            <div data-testid="footer">
              <SidebarFooter phone={props.phone} searching={props.searching ?? false} onCreateNote={() => {}} newNotePending={false} />
            </div>
          </SidebarTabProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("my notes while selecting: no New note, action bar shown; ending selection brings New note back", async () => {
    renderSelectFooter();
    expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "probe-start" }));
    expect(await screen.findByRole("button", { name: "Copy to" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "probe-end" }));
    expect(await screen.findByRole("button", { name: "New note" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy to" })).toBeNull();
  });

  it("searching while selecting: New note, no action bar", async () => {
    renderSelectFooter({ searching: true });
    fireEvent.click(screen.getByRole("button", { name: "probe-start" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy to" })).toBeNull();
  });

  // On wide screens the action bar is in the header (SelectHeader), not the footer.
  it("wide + normal tab while selecting: footer renders nothing; New note when not selecting and after ending selection", async () => {
    mockWidePointer(true);
    renderSelectFooter();
    expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "probe-start" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByTestId("footer")).toBeEmptyDOMElement();
    fireEvent.click(screen.getByRole("button", { name: "probe-end" }));
    expect(await screen.findByRole("button", { name: "New note" })).toBeInTheDocument();
  });

  it("narrow + normal tab while selecting: the action bar is mounted as before", async () => {
    mockWidePointer(false);
    renderSelectFooter();
    fireEvent.click(screen.getByRole("button", { name: "probe-start" }));
    expect(await screen.findByRole("button", { name: "Copy to" })).toBeInTheDocument();
    expect(screen.getByTestId("footer").querySelector("[data-select-action-bar]")).not.toBeNull();
  });

  it("phone list (flush with the screen bottom): action bar keeps the bottom safe area", async () => {
    mockWidePointer(false);
    renderSelectFooter({ phone: true });
    fireEvent.click(screen.getByRole("button", { name: "probe-start" }));
    await screen.findByRole("button", { name: "Copy to" });
    const bar = screen.getByTestId("footer").querySelector("[data-select-action-bar]");
    expect(bar).toHaveClass("pb-[calc(0.375rem+env(safe-area-inset-bottom))]");
    // Same frame classes as the bottom search bar and the same 44 px control row, so both bars have equal height and the list does not jump when entering or leaving select mode.
    for (const token of PHONE_BAR_FRAME.split(" ")) expect(bar).toHaveClass(token);
    expect(bar?.querySelector(":scope > div")).toHaveClass(PHONE_BAR_CONTROL_HEIGHT);
  });

  it("classic sidebar: action bar adds no safe area (the outer frame already provides the bottom edge)", async () => {
    mockWidePointer(false);
    renderSelectFooter();
    fireEvent.click(screen.getByRole("button", { name: "probe-start" }));
    await screen.findByRole("button", { name: "Copy to" });
    expect(screen.getByTestId("footer").querySelector("[data-select-action-bar]")?.className).not.toContain("safe-area-inset");
  });
});

const USER: UserDto = {
  id: "u1",
  email: "tester@example.com",
  handle: TRASH_ME.handle,
  displayName: TRASH_ME.displayName,
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
  avatar: null,
};
const RD = { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "R&D" };
const AMY = { handle: "amy", displayName: "Amy" };
const P1 = trashItem({ id: "p1", title: "p1" }, { deletedDaysAgo: 0 });
const P2 = trashItem({ id: "p2", title: "p2" }, { deletedDaysAgo: 1 });
const W1 = trashItem({ id: "w1", title: "w1", group: RD, deletedBy: AMY }, { deletedDaysAgo: 2 });
const W2 = trashItem({ id: "w2", title: "w2", group: RD, deletedBy: AMY }, { deletedDaysAgo: 3 });

function restoredNote(item: TrashItemDto): NoteDto {
  return {
    id: item.id,
    title: item.title,
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slug: item.id,
    slugIsCustom: false,
    prevSlug: null,
    ownerHandle: "tester",
    lastEdited: null,
    group: null,
    groupId: null,
    permissions: OWNER_PERMS,
    folderId: null,
  };
}

/**
 * By default restore/purge succeed for every note in the list; `restoreStatus`/`purgeFail` make them return errors instead;
 * with `hold`, restore/purge reply only after it resolves (to test the in-flight state).
 */
function stubTrashServer(
  initial: TrashItemDto[],
  opts: { restoreStatus?: number; purgeFail?: boolean; hold?: Promise<void> } = {},
) {
  let items = [...initial];
  const posts: { url: string; body: unknown }[] = [];
  const take = (ids: string[]) => {
    const hit = items.filter((item) => ids.includes(item.id));
    items = items.filter((item) => !ids.includes(item.id));
    return hit;
  };
  const after = (make: () => Response) => (opts.hold ? opts.hold.then(make) : Promise.resolve(make()));
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url === "/api/auth/me" && method === "GET") return Promise.resolve(fakeResponse(USER));
      if (url === "/api/trash" && method === "GET") return Promise.resolve(fakeResponse(trashList(items)));
      if (method === "POST") posts.push({ url, body });
      if (url === "/api/trash/restore" && method === "POST") {
        if (opts.restoreStatus) return Promise.resolve(fakeResponse({ error: { code: "internal", message: "x" } }, opts.restoreStatus));
        return after(() => fakeResponse({ restored: take((body as { ids: string[] }).ids).map(restoredNote), skipped: [] }));
      }
      if (url === "/api/trash/purge" && method === "POST") {
        if (opts.purgeFail) return Promise.resolve(fakeResponse({ error: { code: "server_busy", message: "x" } }, 409));
        return after(() => fakeResponse({ purged: take((body as { ids: string[] }).ids).map((item) => item.id), skipped: [] }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return {
    posts: (url: string) => posts.filter((post) => post.url === url).map((post) => post.body),
    /** Takes effect on the next GET. */
    setItems: (next: TrashItemDto[]) => {
      items = [...next];
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * Two shells mirror AppShell's static card and drawer (each with its own `data-sidebar-instance`, holding a TrashPanel and SidebarFooter) sharing one selection.
 * Focus must return to the shell that started the action, which is always the second one (`shell(1)`); a lookup in the wrong shell lands on the first.
 */
function renderShells() {
  localStorage.setItem("sidebar.tab", "trash");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(SESSION_QUERY_KEY, USER);
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ActiveNoteProvider>
          <SidebarTabProvider>
            {[0, 1].map((index) => (
              <div key={index} data-sidebar-instance="" data-testid={`shell-${index}`}>
                <div role="tabpanel">
                  <TrashPanel />
                </div>
                <SidebarFooter searching={false} onCreateNote={() => {}} newNotePending={false} />
              </div>
            ))}
            <input aria-label="outside" />
          </SidebarTabProvider>
          <Toaster />
        </ActiveNoteProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { queryClient };
}

const shell = (index: number) => screen.getByTestId(`shell-${index}`);
const shellHeader = (index: number) => shell(index).querySelector("[data-sidebar-header]") as HTMLElement;
const shellBox = (index: number, id: string) =>
  shell(index).querySelector(`li[data-node-id="${id}"] input[type="checkbox"]`) as HTMLInputElement;
/** Action-bar button (while the confirm dialog is open the background is aria-hidden, hence always hidden: true). */
const barButton = (index: number, name: string) => within(shell(index)).getByRole("button", { name, hidden: true });
const selectButton = (index: number) => within(shellHeader(index)).queryByRole("button", { name: "Select", hidden: true });

async function enterSelecting() {
  await waitFor(() => expect(shell(1).querySelector('li[data-node-id="w2"]')).not.toBeNull());
  fireEvent.click(selectButton(1) as HTMLElement);
}

describe("SidebarFooter - trash select-mode action bar", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());
  });

  it("0 selected: both buttons disabled; ticking w1 then p1 out of order -> Restore sends list order, toasts, leaves select mode, focus returns to the same shell's Select", async () => {
    const server = stubTrashServer([P1, P2, W1, W2]);
    renderShells();
    await enterSelecting();
    expect(barButton(1, "Restore")).toBeDisabled();
    expect(barButton(1, "Delete permanently")).toBeDisabled();
    expect(within(shell(1)).queryByTestId("trash-footer")).toBeNull();

    fireEvent.click(shellBox(1, "w1"));
    fireEvent.click(shellBox(1, "p1"));
    expect(barButton(1, "Restore")).toBeEnabled();
    expect(barButton(1, "Delete permanently")).toBeEnabled();
    expect(barButton(1, "Restore").querySelector('svg[data-icon="restore"]')).not.toBeNull();
    // variant="brand" (see button.tsx)
    expect(barButton(1, "Restore")).toHaveClass("bg-brand-soft", "text-brand-on-soft");
    fireEvent.click(barButton(1, "Restore"));

    expect(await screen.findByText("Restored 2 notes", { exact: true })).toBeInTheDocument();
    expect(server.posts("/api/trash/restore")).toEqual([{ ids: ["p1", "w1"] }]);
    expect(await within(shell(1)).findByTestId("trash-footer")).toBeInTheDocument();
    expect(within(shell(1)).queryByRole("button", { name: "Restore" })).toBeNull();
    expect(selectButton(1)).toHaveFocus();
  });

  it("permanent delete: confirm dialog shows the count, confirming sends both ids, toasts, leaves select mode, focus returns to the same shell's Select", async () => {
    const server = stubTrashServer([P1, P2, W1, W2]);
    renderShells();
    await enterSelecting();
    fireEvent.click(shellBox(1, "w2"));
    fireEvent.click(shellBox(1, "p2"));
    expect(barButton(1, "Delete permanently").querySelector('svg[data-icon="trash"]')).not.toBeNull();
    // narrow form is icon-only: the name comes from aria-label
    expect(barButton(1, "Delete permanently")).toHaveAttribute("aria-label", "Delete permanently");
    expect(barButton(1, "Delete permanently")).toHaveTextContent("");
    expect(barButton(1, "Restore")).toHaveAttribute("aria-label", "Restore");
    expect(barButton(1, "Restore")).toHaveTextContent("");
    fireEvent.click(barButton(1, "Delete permanently"));
    const dialog = await screen.findByRole("dialog", { name: "Permanently delete 2 notes?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));

    expect(await screen.findByText("Permanently deleted 2 notes", { exact: true })).toBeInTheDocument();
    expect(server.posts("/api/trash/purge")).toEqual([{ ids: ["p2", "w2"] }]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await within(shell(1)).findByTestId("trash-footer")).toBeInTheDocument();
    expect(selectButton(1)).toHaveFocus();
    // Still on Select after Radix's close-focus (setTimeout) has run.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(selectButton(1)).toHaveFocus();
  });

  it("cancel: nothing sent, still in select mode, selection unchanged, focus returns to the opener button", async () => {
    const server = stubTrashServer([P1, P2, W1, W2]);
    renderShells();
    await enterSelecting();
    fireEvent.click(shellBox(1, "w2"));
    fireEvent.click(shellBox(1, "p2"));
    fireEvent.click(barButton(1, "Delete permanently"));
    const dialog = await screen.findByRole("dialog", { name: "Permanently delete 2 notes?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.posts("/api/trash/purge")).toEqual([]);
    expect(within(shellHeader(1)).getByText("2 selected", { exact: true })).toBeInTheDocument();
    expect(shellBox(1, "p2")).toBeChecked();
    expect(shellBox(1, "w2")).toBeChecked();
    await waitFor(() => expect(barButton(1, "Delete permanently")).toHaveFocus());
  });

  it("narrow: Esc inside the confirm dialog only closes it, stays in select mode, focus returns to the opener button", async () => {
    const server = stubTrashServer([P1, P2, W1, W2]);
    renderShells();
    await enterSelecting();
    fireEvent.click(shellBox(1, "w1"));
    fireEvent.click(barButton(1, "Delete permanently"));
    const dialog = await screen.findByRole("dialog", { name: "Permanently delete 1 note?" });
    fireEvent.keyDown(within(dialog).getByRole("button", { name: "Cancel" }), { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.posts("/api/trash/purge")).toEqual([]);
    expect(within(shellHeader(1)).getByText("1 selected", { exact: true })).toBeInTheDocument();
    expect(shellBox(1, "w1")).toBeChecked();
    await waitFor(() => expect(barButton(1, "Delete permanently")).toHaveFocus());
  });

  it("restore failure (500): error toast, still in select mode, selection unchanged", async () => {
    const server = stubTrashServer([P1, P2, W1, W2], { restoreStatus: 500 });
    renderShells();
    await enterSelecting();
    fireEvent.click(shellBox(1, "p1"));
    fireEvent.click(shellBox(1, "w1"));
    fireEvent.click(barButton(1, "Restore"));

    const title = await screen.findByText("Something went wrong. Please try again.", { exact: true });
    expect(title.closest("li")).toHaveClass("bg-destructive");
    expect(server.posts("/api/trash/restore")).toEqual([{ ids: ["p1", "w1"] }]);
    await act(async () => {});
    expect(barButton(1, "Restore")).toBeEnabled();
    expect(within(shellHeader(1)).getByText("2 selected", { exact: true })).toBeInTheDocument();
    expect(within(shell(1)).queryByTestId("trash-footer")).toBeNull();
  });

  it("permanent delete failure (409): dialog closes, error toast, still in select mode, focus returns to the opener button", async () => {
    stubTrashServer([P1, P2, W1, W2], { purgeFail: true });
    renderShells();
    await enterSelecting();
    fireEvent.click(shellBox(1, "w1"));
    fireEvent.click(barButton(1, "Delete permanently"));
    const dialog = await screen.findByRole("dialog", { name: "Permanently delete 1 note?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));

    expect(await screen.findByText("The server is busy. Please try again shortly.", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(shellHeader(1)).getByText("1 selected", { exact: true })).toBeInTheDocument();
    expect(within(shell(1)).queryByTestId("trash-footer")).toBeNull();
    await waitFor(() => expect(barButton(1, "Delete permanently")).toHaveFocus());
  });

  it("Esc with focus on the footer Restore: leaves select mode, focus returns to the same shell's Select", async () => {
    stubTrashServer([P1, P2, W1, W2]);
    renderShells();
    await enterSelecting();
    fireEvent.click(shellBox(1, "p1"));
    const restore = barButton(1, "Restore");
    restore.focus();
    // This Esc only ends select mode: preventDefault is called (fireEvent returns false), and the search-clear Esc listener yields when it sees defaultPrevented.
    expect(fireEvent.keyDown(restore, { key: "Escape" })).toBe(false);

    expect(within(shell(1)).queryByRole("button", { name: "Restore" })).toBeNull();
    expect(within(shell(1)).getByTestId("trash-footer")).toBeInTheDocument();
    expect(shell(1).querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(selectButton(1)).toHaveFocus();
  });

  it("while in flight both buttons are disabled; if focus moved elsewhere during the wait it is not stolen on completion (select mode still ends)", async () => {
    const hold = deferred();
    stubTrashServer([P1, P2, W1, W2], { hold: hold.promise });
    renderShells();
    await enterSelecting();
    fireEvent.click(shellBox(1, "p1"));
    fireEvent.click(barButton(1, "Restore"));
    await waitFor(() => expect(barButton(1, "Restore")).toBeDisabled());
    expect(barButton(1, "Delete permanently")).toBeDisabled();
    const outside = screen.getByRole("textbox", { name: "outside" });
    outside.focus();

    await act(async () => {
      hold.resolve();
    });
    expect(await screen.findByText("Restored 1 note", { exact: true })).toBeInTheDocument();
    expect(await within(shell(1)).findByTestId("trash-footer")).toBeInTheDocument();
    expect(outside).toHaveFocus();
  });

  it("Done pressed before the response and select re-entered: a late success does not end the new round", async () => {
    const hold = deferred();
    stubTrashServer([P1, P2, W1, W2], { hold: hold.promise });
    renderShells();
    await enterSelecting();
    fireEvent.click(shellBox(1, "p1"));
    fireEvent.click(barButton(1, "Restore"));
    fireEvent.click(within(shellHeader(1)).getByRole("button", { name: "Done" }));
    fireEvent.click(selectButton(1) as HTMLElement);
    fireEvent.click(shellBox(1, "w2"));

    await act(async () => {
      hold.resolve();
    });
    expect(await screen.findByText("Restored 1 note", { exact: true })).toBeInTheDocument();
    await act(async () => {});
    expect(within(shellHeader(1)).getByText("1 selected", { exact: true })).toBeInTheDocument();
    expect(shellBox(1, "w2")).toBeChecked();
    expect(within(shell(1)).queryByTestId("trash-footer")).toBeNull();
  });

  it("double-clicking Restore sends one request", async () => {
    const server = stubTrashServer([P1, P2, W1, W2]);
    renderShells();
    await enterSelecting();
    fireEvent.click(shellBox(1, "p1"));
    const restore = barButton(1, "Restore");
    fireEvent.click(restore);
    fireEvent.click(restore);
    expect(await screen.findByText("Restored 1 note", { exact: true })).toBeInTheDocument();
    expect(server.posts("/api/trash/restore")).toEqual([{ ids: ["p1"] }]);
  });

  it("while in flight the confirm button is disabled; cancelling before the response keeps the action bar disabled (cannot reopen), and the response still leaves select mode", async () => {
    const hold = deferred();
    stubTrashServer([P1, P2, W1, W2], { hold: hold.promise });
    renderShells();
    await enterSelecting();
    fireEvent.click(shellBox(1, "p1"));
    fireEvent.click(shellBox(1, "p2"));
    fireEvent.click(barButton(1, "Delete permanently"));
    const dialog = await screen.findByRole("dialog", { name: "Permanently delete 2 notes?" });
    const confirm = within(dialog).getByRole("button", { name: "Delete permanently" });
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm).toBeDisabled());

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(barButton(1, "Delete permanently")).toBeDisabled();

    await act(async () => {
      hold.resolve();
    });
    expect(await screen.findByText("Permanently deleted 2 notes", { exact: true })).toBeInTheDocument();
    expect(await within(shell(1)).findByTestId("trash-footer")).toBeInTheDocument();
  });

  it("list refetched while the confirm dialog is open and every selected note is gone: confirming sends nothing, no toast, dialog closes, still in select mode", async () => {
    const server = stubTrashServer([P1, P2, W1, W2]);
    const { queryClient } = renderShells();
    await enterSelecting();
    fireEvent.click(shellBox(1, "p1"));
    fireEvent.click(barButton(1, "Delete permanently"));
    const dialog = await screen.findByRole("dialog", { name: "Permanently delete 1 note?" });

    server.setItems([P2, W1, W2]);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["trash"] });
    });
    expect(await screen.findByRole("dialog", { name: "Permanently delete 0 notes?" })).toBe(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => {});
    expect(server.posts("/api/trash/purge")).toEqual([]);
    expect(screen.queryByText(/^Permanently deleted/)).toBeNull();
    expect(within(shellHeader(1)).getByText("0 selected", { exact: true })).toBeInTheDocument();
  });

  it("permanent delete button: red text, border, red hover background, not outline's brand-deep", async () => {
    stubTrashServer([P1, P2, W1, W2]);
    renderShells();
    await enterSelecting();
    const purge = barButton(1, "Delete permanently");
    expect(purge).toHaveClass("text-destructive", "hover:bg-destructive/10", "hover:text-destructive", "border");
    expect(purge).not.toHaveClass("hover:bg-brand-deep");
    // With outline, twMerge lets hover:bg-destructive/10 override hover:bg-brand-deep, but the pressed state (active:...brand-deep...) and
    // hover:border-transparent would remain; the previous assertion alone would not catch that.
    expect(purge.className).not.toMatch(/brand-deep|hover:border-transparent/);
  });
});

describe("SidebarFooter - trash wide-screen select toolbar", () => {
  let pointer: ReturnType<typeof mockWidePointer>;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    pointer = mockWidePointer(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());
  });

  const exitButton = (index: number) => within(shellHeader(index)).queryByRole("button", { name: "Exit selection", hidden: true });
  const selectAllBox = (index: number) => within(shellHeader(index)).getByRole("checkbox", { name: "Select all", hidden: true }) as HTMLInputElement;
  const headerButton = (index: number, name: string) => within(shellHeader(index)).getByRole("button", { name, hidden: true });

  async function enterWide(lastId: string) {
    await waitFor(() => expect(shell(1).querySelector(`li[data-node-id="${lastId}"]`)).not.toBeNull());
    fireEvent.click(selectButton(1) as HTMLElement);
  }

  it("wide: entering shows header close button (focused), Select all box, 0 selected, Restore / Delete permanently icon buttons (disabled at 0); footer has no note or action bar", async () => {
    stubTrashServer([P1, P2, W1, W2]);
    renderShells();
    await waitFor(() => expect(within(shell(1)).getByTestId("trash-footer")).toBeInTheDocument());
    await enterWide("w2");

    const exit = exitButton(1) as HTMLElement;
    expect(exit).toHaveAttribute("title", "Exit selection");
    expect(exit).toHaveFocus();
    expect(within(shellHeader(1)).queryByRole("button", { name: "Done", hidden: true })).toBeNull();
    const box = selectAllBox(1);
    expect(box).not.toBeChecked();
    expect(box.indeterminate).toBe(false);
    expect(within(shellHeader(1)).getByText("0 selected", { exact: true })).toBeInTheDocument();

    const restore = headerButton(1, "Restore");
    const purge = headerButton(1, "Delete permanently");
    expect(restore).toHaveAttribute("title", "Restore");
    expect(purge).toHaveAttribute("title", "Delete permanently");
    expect(restore).toBeDisabled();
    expect(purge).toBeDisabled();
    expect(restore.querySelector('svg[data-icon="restore"]')).not.toBeNull();
    expect(purge.querySelector('svg[data-icon="trash"]')).not.toBeNull();
    expect(restore).toHaveClass("h-6", "w-6");
    expect(restore).not.toHaveClass("bg-brand-soft");
    expect(purge).toHaveClass("h-6", "w-6", "text-destructive");
    expect([...shellHeader(1).querySelectorAll("button, input")]).toEqual([exit, box, restore, purge]);

    for (const index of [0, 1]) {
      const bars = shell(index).querySelectorAll("[data-select-action-bar]");
      expect(bars).toHaveLength(1);
      expect(shellHeader(index).contains(bars[0] as Node)).toBe(true);
      expect(within(shell(index)).getAllByRole("button", { name: "Restore", hidden: true })).toHaveLength(1);
      expect(within(shell(index)).queryByTestId("trash-footer")).toBeNull();
    }

    fireEvent.click(shellBox(1, "p1"));
    expect(headerButton(1, "Restore")).toBeEnabled();
    expect(headerButton(1, "Delete permanently")).toBeEnabled();
  });

  it("wide: ticking one of two -> select-all box is indeterminate; clicking it ticks both and checks the box; clicking again clears all", async () => {
    stubTrashServer([P1, P2]);
    renderShells();
    await enterWide("p2");
    fireEvent.click(shellBox(1, "p1"));
    expect(selectAllBox(1).indeterminate).toBe(true);
    expect(selectAllBox(1)).not.toBeChecked();
    expect(selectAllBox(1)).toHaveAttribute("title", "Select all");

    fireEvent.click(selectAllBox(1));
    expect(shellBox(1, "p1")).toBeChecked();
    expect(shellBox(1, "p2")).toBeChecked();
    expect(selectAllBox(1)).toBeChecked();
    expect(selectAllBox(1).indeterminate).toBe(false);
    expect(selectAllBox(1)).toHaveAttribute("title", "Deselect all");
    expect(within(shellHeader(1)).getByText("2 selected", { exact: true })).toBeInTheDocument();

    fireEvent.click(selectAllBox(1));
    expect(shellBox(1, "p1")).not.toBeChecked();
    expect(shellBox(1, "p2")).not.toBeChecked();
    expect(selectAllBox(1)).not.toBeChecked();
    expect(selectAllBox(1).indeterminate).toBe(false);
    expect(within(shellHeader(1)).getByText("0 selected", { exact: true })).toBeInTheDocument();
  });

  it("wide: list refetched to 0 notes while selecting -> select-all box disabled", async () => {
    const server = stubTrashServer([P1, P2]);
    const { queryClient } = renderShells();
    await enterWide("p2");
    expect(selectAllBox(1)).toBeEnabled();
    server.setItems([]);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["trash"] });
    });
    expect(await within(shell(1)).findByText("The trash is empty.", { exact: true })).toBeInTheDocument();
    expect(selectAllBox(1)).toBeDisabled();
  });

  it("wide: tick two, Restore -> sends list order, toasts, leaves select mode, focus returns to the same shell's Select", async () => {
    const server = stubTrashServer([P1, P2, W1, W2]);
    renderShells();
    await enterWide("w2");
    fireEvent.click(shellBox(1, "w1"));
    fireEvent.click(shellBox(1, "p1"));
    fireEvent.click(headerButton(1, "Restore"));

    expect(await screen.findByText("Restored 2 notes", { exact: true })).toBeInTheDocument();
    expect(server.posts("/api/trash/restore")).toEqual([{ ids: ["p1", "w1"] }]);
    expect(await within(shell(1)).findByTestId("trash-footer")).toBeInTheDocument();
    expect(exitButton(1)).toBeNull();
    expect(selectButton(1)).toHaveFocus();
  });

  it("wide: Esc in the confirm dialog (once on an inner element, once on document) only closes it, stays in select mode, focus returns to the icon button; reopening and confirming purges and leaves select mode", async () => {
    const server = stubTrashServer([P1, P2, W1, W2]);
    renderShells();
    await enterWide("w2");
    fireEvent.click(shellBox(1, "w1"));

    for (const target of ["inside", "document"] as const) {
      fireEvent.click(headerButton(1, "Delete permanently"));
      const dialog = await screen.findByRole("dialog", { name: "Permanently delete 1 note?" });
      fireEvent.keyDown(target === "inside" ? within(dialog).getByRole("button", { name: "Cancel" }) : document, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(within(shellHeader(1)).getByText("1 selected", { exact: true })).toBeInTheDocument();
      expect(shellBox(1, "w1")).toBeChecked();
      await waitFor(() => expect(headerButton(1, "Delete permanently")).toHaveFocus());
    }
    expect(server.posts("/api/trash/purge")).toEqual([]);

    fireEvent.click(headerButton(1, "Delete permanently"));
    const dialog = await screen.findByRole("dialog", { name: "Permanently delete 1 note?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    expect(await screen.findByText("Permanently deleted 1 note", { exact: true })).toBeInTheDocument();
    expect(server.posts("/api/trash/purge")).toEqual([{ ids: ["w1"] }]);
    expect(await within(shell(1)).findByTestId("trash-footer")).toBeInTheDocument();
    expect(selectButton(1)).toHaveFocus();
  });

  it("wide: close button leaves select mode and focus returns to the same shell's Select; Esc inside the static card does the same", async () => {
    stubTrashServer([P1, P2, W1, W2]);
    renderShells();
    await enterWide("w2");
    fireEvent.click(shellBox(1, "p1"));
    fireEvent.click(exitButton(1) as HTMLElement);
    expect(exitButton(1)).toBeNull();
    expect(shell(1).querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(selectButton(1)).toHaveFocus();
    expect(within(shell(1)).getByTestId("trash-footer")).toBeInTheDocument();

    fireEvent.click(selectButton(1) as HTMLElement);
    expect(exitButton(1)).toHaveFocus();
    fireEvent.click(shellBox(1, "p1"));
    fireEvent.keyDown(shellBox(1, "p1"), { key: "Escape" });
    expect(exitButton(1)).toBeNull();
    expect(shell(1).querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(selectButton(1)).toHaveFocus();
  });

  it("narrow: unchanged (retention note when not selecting; while selecting Done, a brand-colored Restore icon button in the footer, no icon buttons in the header)", async () => {
    mockWidePointer(false);
    stubTrashServer([P1, P2, W1, W2]);
    renderShells();
    expect(await within(shell(1)).findByTestId("trash-footer")).toBeInTheDocument();
    await enterWide("w2");
    expect(within(shellHeader(1)).getByRole("button", { name: "Done" })).toHaveFocus();
    expect(exitButton(1)).toBeNull();
    expect(within(shellHeader(1)).getByRole("button", { name: "Select all" })).toBeInTheDocument();
    expect(within(shellHeader(1)).queryByRole("button", { name: "Restore" })).toBeNull();
    expect(shell(1).querySelectorAll("[data-select-action-bar]")).toHaveLength(0);
    const restore = barButton(1, "Restore");
    expect(restore).toHaveAttribute("aria-label", "Restore");
    expect(restore).toHaveTextContent("");
    expect(restore).toHaveClass("bg-brand-soft", "text-brand-on-soft");
    expect(within(shell(1)).queryByTestId("trash-footer")).toBeNull();
  });

  it("wide: close pressed while restore is in flight, then Select pressed right away -> after release still in the new round (0 selected), focus is not moved to Select", async () => {
    const hold = deferred();
    stubTrashServer([P1, P2, W1, W2], { hold: hold.promise });
    renderShells();
    await enterWide("w2");
    fireEvent.click(shellBox(1, "p1"));
    fireEvent.click(headerButton(1, "Restore"));
    await waitFor(() => {
      expect(shellHeader(1).querySelector("[data-select-action-bar]")).toHaveAttribute("aria-busy", "true");
    });
    fireEvent.click(exitButton(1) as HTMLElement);
    fireEvent.click(selectButton(1) as HTMLElement);
    expect(within(shellHeader(1)).getByText("0 selected", { exact: true })).toBeInTheDocument();
    expect(exitButton(1)).toHaveFocus();

    await act(async () => {
      hold.resolve();
    });
    expect(await screen.findByText("Restored 1 note", { exact: true })).toBeInTheDocument();
    await act(async () => {});
    expect(within(shellHeader(1)).getByText("0 selected", { exact: true })).toBeInTheDocument();
    expect(within(shell(1)).queryByTestId("trash-footer")).toBeNull();
    expect(selectButton(1)).toBeNull();
    expect(exitButton(1)).toHaveFocus();
  });

  it("crossing the wide/narrow breakpoint while selecting: selection and ticked notes are kept and the toolbar changes shape; focus on close -> moves to Done -> back to close; an open confirm dialog closes with the wide toolbar", async () => {
    stubTrashServer([P1, P2, W1, W2]);
    renderShells();
    await enterWide("w2");
    fireEvent.click(shellBox(1, "p1"));
    (exitButton(1) as HTMLElement).focus();

    act(() => pointer.setWide(false));
    expect(within(shellHeader(1)).getByText("1 selected", { exact: true })).toBeInTheDocument();
    expect(shellBox(1, "p1")).toBeChecked();
    expect(exitButton(1)).toBeNull();
    expect(within(shellHeader(1)).getByRole("button", { name: "Done" })).toHaveFocus();
    expect(within(shellHeader(1)).queryByRole("button", { name: "Restore" })).toBeNull();
    expect(await within(shell(1)).findByRole("button", { name: "Restore" })).toHaveAttribute("aria-label", "Restore");

    act(() => pointer.setWide(true));
    expect(exitButton(1)).toHaveFocus();
    expect(within(shell(1)).getAllByRole("button", { name: "Restore" })).toHaveLength(1);
    expect(shellHeader(1).contains(within(shell(1)).getByRole("button", { name: "Restore" }))).toBe(true);

    fireEvent.click(headerButton(1, "Delete permanently"));
    await screen.findByRole("dialog", { name: "Permanently delete 1 note?" });
    act(() => pointer.setWide(false));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(shellHeader(1)).getByText("1 selected", { exact: true })).toBeInTheDocument();
  });

  it("focus already on body (not in the header) before the flip: crossing the breakpoint does not steal focus", async () => {
    stubTrashServer([P1, P2, W1, W2]);
    renderShells();
    await enterWide("w2");
    (exitButton(1) as HTMLElement).blur();
    expect(document.body).toHaveFocus();
    act(() => pointer.setWide(false));
    expect(document.body).toHaveFocus();
    act(() => pointer.setWide(true));
    expect(document.body).toHaveFocus();
  });
});

describe("SidebarFooter phone layout", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderPhoneFooter(tab: SidebarTab, props: { searching?: boolean } = {}) {
    localStorage.setItem("sidebar.tab", tab);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <SidebarTabProvider>
          <SidebarFooter phone searching={props.searching ?? false} onCreateNote={vi.fn()} newNotePending={false} />
        </SidebarTabProvider>
      </QueryClientProvider>,
    );
  }

  it.each(["myNotes", "recent", "workspace"] as const)("%s tab: does not render New note (the bottom bar has it)", (tab) => {
    stubTrash();
    renderPhoneFooter(tab);
    expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
  });

  it("while searching: does not render New note", () => {
    stubTrash();
    renderPhoneFooter("myNotes", { searching: true });
    expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
  });

  it("trash tab: retention note still shown", async () => {
    stubTrash(7);
    renderPhoneFooter("trash");
    expect(await screen.findByTestId("trash-footer")).toHaveTextContent(/^Permanently deleted 7 days after deletion$/);
  });
});

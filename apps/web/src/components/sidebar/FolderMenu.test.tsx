import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import type { FolderDto, GroupDto, NoteDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { SidebarTabProvider, type SidebarTab } from "@/lib/sidebar-tab";
import { ThemeProvider } from "@/theme";
import { AppShell } from "@/components/AppShell";
import { NoteList, type NoteListProps } from "@/components/NoteList";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { adminRole, customRole, groupDto } from "@/test/fixtures";
import { folderChain, folderDto, groupFolder, sharedFolder } from "@/test/folder-fixtures";
import { groupNote, personalNote } from "@/test/select-fixtures";
import { stubLayoutTier } from "@/test/layout-tier";
import { __resetCollapseForTests, isCollapsed, setCollapsed } from "./collapse";
import { liveNotesUnder } from "./folder-index";
import { __resetFolderSortForTests, setFolderSort } from "./folder-sort";
import { pressTrigger } from "@/test/menu-trigger";

// Counts `liveNotesUnder` calls (the menu does not scan notes while closed); behaviour unchanged (wraps the real function).
vi.mock("@/components/sidebar/folder-index", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/sidebar/folder-index")>();
  return { ...actual, liveNotesUnder: vi.fn(actual.liveNotesUnder) };
});

// The folder row's kebab: rendered inside NoteList as in production.
afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
  __resetFolderSortForTests();
});

const ME = { id: "u1", email: "a@example.com", handle: "tester", displayName: "Ann", isAdmin: false, mustChangePassword: false, hasPassword: true, autoVersions: true, avatar: null } satisfies UserDto;
const G: GroupDto = groupDto({ id: "G", name: "G" }, adminRole());
const R: GroupDto = groupDto({ id: "R", name: "R" }, customRole());

function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface Server {
  notes?: NoteDto[];
  folders?: FolderDto[];
  groups?: GroupDto[];
  post?: () => Response | Promise<Response>;
}

function stubServer(opts: Server = {}) {
  const calls: Array<{ key: string; body: unknown }> = [];
  // Stateful: after DELETE the refetched folder list no longer contains the deleted one (so the case where the kebab is unmounted can be reached).
  let folders = opts.folders ?? [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (method === "GET") {
        if (url === "/api/notes") return Promise.resolve(json(opts.notes ?? []));
        if (url === "/api/folders") return Promise.resolve(json({ folders }));
        if (url === "/api/groups") return Promise.resolve(json(opts.groups ?? []));
        if (url === "/api/trash") return Promise.resolve(json({ retentionDays: 7, items: [], truncated: false }));
        if (url === "/api/auth/me") return Promise.resolve(json(ME));
        return Promise.resolve(json({ error: { code: "not_found", message: "x" } }, 404));
      }
      calls.push({ key: `${method} ${url}`, body });
      if (url === "/api/notes" && method === "POST") return Promise.resolve(opts.post ? opts.post() : json(personalNote({ id: "created", title: "Untitled" }), 201));
      if (url === "/api/folders" && method === "POST") return Promise.resolve(json(folderDto({ id: "X", name: "X" }), 201));
      if (url.startsWith("/api/folders/") && method === "PATCH") return Promise.resolve(json(folderDto({ id: "A", name: "B" })));
      if (url.startsWith("/api/folders/") && method === "DELETE") {
        const id = decodeURIComponent(url.split("/")[3] ?? "");
        folders = folders.filter((folder) => folder.id !== id);
        return Promise.resolve(json({ trashedNoteIds: [], deletedFolderIds: [id] }));
      }
      return Promise.resolve(json({ error: { code: "not_found", message: "x" } }, 404));
    }),
  );
  return calls;
}

function renderList(props: Partial<NoteListProps> = {}, opts: { tab?: SidebarTab; queryClient?: QueryClient } = {}) {
  if (opts.tab) localStorage.setItem("sidebar.tab", opts.tab);
  const queryClient = opts.queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ActiveNoteProvider>
          <SidebarTabProvider>
            <div role="tabpanel">
              <NoteList {...props} />
            </div>
          </SidebarTabProvider>
        </ActiveNoteProvider>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
  return { view, queryClient };
}

const trigger = (name: string) => screen.findByRole("button", { name: `Folder menu for ${name}` });
async function openMenu(name: string): Promise<HTMLElement> {
  // Radix DropdownMenu's trigger only listens to pointerdown.
  pressTrigger(await trigger(name));
  return screen.findByRole("menu");
}
/** Skeleton of the menu content: menuitem/menuitemradio by name, separator `—`, subheading `[label]`. */
function skeleton(menu: HTMLElement): string[] {
  return Array.from(menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="separator"], [role="group"] > [id], div[id]:not([role])'))
    .filter((el) => el.closest('[role="menu"]') === menu)
    .map((el) => {
      const role = el.getAttribute("role");
      if (role === "separator") return "—";
      if (role === "menuitem" || role === "menuitemradio") return el.getAttribute("aria-labelledby") ? (document.getElementById(el.getAttribute("aria-labelledby")!)?.textContent ?? "") : (el.textContent ?? "");
      return `[${el.textContent}]`;
    });
}

const A = folderDto({ id: "A", name: "A" });

describe("FolderMenu", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());
    await i18n.changeLanguage("en");
  });

  it("personal folder: item order, sort subheading and three items (Last modified selected), every menuitem has an icon, delete is red", async () => {
    stubServer({ folders: [A] });
    renderList();
    const menu = await openMenu("A");
    expect(skeleton(menu)).toEqual(["New note", "New subfolder", "Rename", "—", "[Sort by]", "Name", "Last modified", "Size", "—", "Delete folder"]);
    expect(within(menu).getByRole("menuitemradio", { name: "Last modified" })).toHaveAttribute("aria-checked", "true");
    for (const item of within(menu).getAllByRole("menuitem")) expect(item.querySelector("svg")).not.toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Delete folder" })).toHaveClass("text-destructive");
    expect(within(menu).getByRole("group")).toHaveAttribute("aria-labelledby");
  });

  it("shared private: no New note; the delete item is called Remove folder", async () => {
    stubServer({ folders: [sharedFolder({ id: "SF", name: "SF" })] });
    renderList({}, { tab: "shared" });
    const menu = await openMenu("SF");
    expect(within(menu).queryByRole("menuitem", { name: "New note" })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Remove folder" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Delete folder" })).toBeNull();
  });

  it("group folder with a custom role that can delete but not edit (manage false, deleteNotes true): only the sort subheading and three items (no orphaned separator)", async () => {
    stubServer({ groups: [R], folders: [groupFolder({ id: "RF", name: "RF", groupId: "R", edit: false, create: false, delete: true })] });
    renderList({}, { tab: "workspace" });
    const menu = await openMenu("RF");
    expect(skeleton(menu)).toEqual(["[Sort by]", "Name", "Last modified", "Size"]);
  });

  it("level 5: New subfolder is not actionable (aria-disabled, the name is just the item name, the explanation is in the description, no data-disabled, clicking opens no dialog); level 4 is pressable", async () => {
    stubServer({ folders: folderChain("L", 5) });
    renderList();
    let menu = await openMenu("L5");
    const item = within(menu).getByRole("menuitem", { name: "New subfolder" });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveAccessibleName("New subfolder");
    expect(item).toHaveAccessibleDescription("Folders can be nested up to 5 levels");
    expect(item).not.toHaveAttribute("data-disabled");
    fireEvent.click(item);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    menu = await openMenu("L4");
    const ok = within(menu).getByRole("menuitem", { name: "New subfolder" });
    expect(ok).not.toHaveAttribute("aria-disabled");
    expect(ok).not.toHaveAttribute("aria-describedby");
    expect(within(ok).queryByText("Folders can be nested up to 5 levels")).toBeNull();
  });

  it("group folder with manage but no right to delete notes and live notes in the subtree: Delete folder is not actionable; with no live notes in the subtree it is pressable", async () => {
    const GF = groupFolder({ id: "GF", name: "GF", groupId: "G", delete: false });
    const GE = groupFolder({ id: "GE", name: "GE", groupId: "G", delete: false });
    stubServer({ groups: [G], folders: [GF, GE], notes: [groupNote({ id: "g1", title: "g1", group: G, folderId: "GF" })] });
    renderList({}, { tab: "workspace" });
    let menu = await openMenu("GF");
    const blocked = within(menu).getByRole("menuitem", { name: "Delete folder" });
    expect(blocked).toHaveAttribute("aria-disabled", "true");
    expect(blocked).toHaveAccessibleName("Delete folder");
    expect(blocked).toHaveAccessibleDescription("This folder has notes you can't delete");
    fireEvent.click(blocked);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    menu = await openMenu("GE");
    const ok = within(menu).getByRole("menuitem", { name: "Delete folder" });
    expect(ok).not.toHaveAttribute("aria-disabled");
    fireEvent.click(ok);
    expect(await screen.findByRole("dialog", { name: "Delete folder “GE”?" })).toBeInTheDocument();
  });

  it("sort: choosing Name saves to localStorage, the menu stays open, Name is selected, list order changes; unmount and remount is still Name", async () => {
    const older = personalNote({ id: "pa", title: "Alpha", folderId: "A", updatedAt: "2026-01-01T00:00:00.000Z" });
    const newer = personalNote({ id: "pb", title: "Beta", folderId: "A", updatedAt: "2026-03-01T00:00:00.000Z" });
    stubServer({ folders: [A], notes: [older, newer] });
    const { view, queryClient } = renderList();
    const order = () => Array.from(document.querySelectorAll('[data-node-kind="folder"][data-node-id="A"] [data-node-kind="note"]')).map((li) => li.getAttribute("data-node-id"));
    await waitFor(() => expect(order()).toEqual(["pb", "pa"]));
    const menu = await openMenu("A");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Name" }));
    expect(localStorage.getItem("sidebar.sort.folder:A")).toBe("name");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(within(screen.getByRole("menu")).getByRole("menuitemradio", { name: "Name" })).toHaveAttribute("aria-checked", "true");
    expect(order()).toEqual(["pa", "pb"]);
    view.unmount();
    renderList({}, { queryClient });
    await waitFor(() => expect(order()).toEqual(["pa", "pb"]));
    const again = await openMenu("A");
    expect(within(again).getByRole("menuitemradio", { name: "Name" })).toHaveAttribute("aria-checked", "true");
  });

  it("New note calls onCreateNote(undefined, A); New subfolder opens the create dialog with body {name: X, parentId: A}; Rename prefills; Delete folder opens the confirm dialog", async () => {
    const calls = stubServer({ folders: [A] });
    const onCreateNote = vi.fn();
    renderList({ onCreateNote });
    fireEvent.click(within(await openMenu("A")).getByRole("menuitem", { name: "New note" }));
    expect(onCreateNote).toHaveBeenCalledWith(undefined, "A");

    fireEvent.click(within(await openMenu("A")).getByRole("menuitem", { name: "New subfolder" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Folder name" }), { target: { value: "X" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(calls).toEqual([{ key: "POST /api/folders", body: { name: "X", parentId: "A" } }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(within(await openMenu("A")).getByRole("menuitem", { name: "Rename" }));
    expect(await screen.findByRole("textbox", { name: "Folder name" })).toHaveValue("A");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(within(await openMenu("A")).getByRole("menuitem", { name: "Delete folder" }));
    expect(await screen.findByRole("dialog", { name: "Delete folder “A”?" })).toBeInTheDocument();
  });

  it("after the dialog closes focus returns to the kebab (still there after yielding two event-loop turns); after a successful delete the kebab is unmounted and nothing throws", async () => {
    stubServer({ folders: [A] });
    renderList();
    fireEvent.click(within(await openMenu("A")).getByRole("menuitem", { name: "Rename" }));
    await screen.findByRole("textbox", { name: "Folder name" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const menuButton = await trigger("A");
    await waitFor(() => expect(menuButton).toHaveFocus());
    // Yield two turns (the 0 ms timer only lets Radix's post-unmount focus handling finish; it is not waiting for time)
    for (let i = 0; i < 2; i++) await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    expect(menuButton).toHaveFocus();

    fireEvent.click(within(await openMenu("A")).getByRole("menuitem", { name: "Delete folder" }));
    const confirm = await screen.findByRole("dialog", { name: "Delete folder “A”?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Folder deleted", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // After the refetch A is gone: the kebab is unmounted (the isConnected path that does not steal focus), so focus does not stay on a detached node
    await waitFor(() => expect(screen.queryByRole("button", { name: "Folder menu for A" })).toBeNull());
    expect(menuButton.isConnected).toBe(false);
    expect(document.activeElement?.isConnected).toBe(true);
  });

  it("the delete-block check is computed only while the menu content is mounted: liveNotesUnder 0 times while closed, at least once after opening", async () => {
    const GF = groupFolder({ id: "GF", name: "GF", groupId: "G", delete: false });
    stubServer({ groups: [G], folders: [GF], notes: [groupNote({ id: "g1", title: "g1", group: G, folderId: "GF" })] });
    renderList({}, { tab: "workspace" });
    await trigger("GF");
    await screen.findByRole("link", { name: "g1" });
    const calls = vi.mocked(liveNotesUnder);
    calls.mockClear();
    // Writes the sort store: each FolderMenu subscribes to it itself (useFolderSort) and re-renders, and NoteList also recomposes nodes because useFolderSortOf returns a new function; the menu stays closed throughout
    act(() => {
      setFolderSort("GF", "name");
    });
    expect(screen.getByRole("link", { name: "g1" })).toBeInTheDocument();
    expect(calls).not.toHaveBeenCalled();
    const menu = await openMenu("GF");
    expect(within(menu).getByRole("menuitem", { name: "Delete folder" })).toHaveAttribute("aria-disabled", "true");
    expect(calls.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("while creating: the kebab's New note is temporarily unpressable (Radix disabled, same as the \"+\" on the row)", async () => {
    stubServer({ folders: [A] });
    renderList({ createNotePending: true });
    const menu = await openMenu("A");
    const item = within(menu).getByRole("menuitem", { name: "New note" });
    expect(item).toHaveAttribute("data-disabled");
    // Screen readers must also know it is unpressable (aria-disabled set by Radix on disabled must not be overwritten)
    expect(item).toHaveAttribute("aria-disabled", "true");
  });

  it("opening a dialog from the kebab (including from the second time on when the chunk is cached): the input gets focus, and closing the menu does not take focus back to the kebab", async () => {
    stubServer({ folders: [A] });
    renderList();
    for (const item of ["Rename", "New subfolder", "Rename"]) {
      fireEvent.click(within(await openMenu("A")).getByRole("menuitem", { name: item }));
      const input = await screen.findByRole("textbox", { name: "Folder name" });
      await waitFor(() => expect(input).toHaveFocus());
      // Yield two more turns: if Radix's focus return after the menu unmounts would steal focus, it shows here
      for (let i = 0; i < 2; i++) await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
      expect(input).toHaveFocus();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(screen.getByRole("button", { name: "Folder menu for A" })).toHaveFocus());
    }
  });

  it("after a dialog has been opened, Esc closing the menu still returns focus to the kebab (the \"no focus return\" applies to the dialog open only)", async () => {
    stubServer({ folders: [A] });
    renderList();
    fireEvent.click(within(await openMenu("A")).getByRole("menuitem", { name: "Rename" }));
    await screen.findByRole("textbox", { name: "Folder name" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const menuButton = await trigger("A");
    await waitFor(() => expect(menuButton).toHaveFocus());
    const menu = await openMenu("A");
    await waitFor(() => expect(menuButton).not.toHaveFocus());
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(menuButton).toHaveFocus());
  });

  it("zh: the kebab's accessible name, the three sort labels and the max-levels text", async () => {
    await i18n.changeLanguage("zh-TW");
    stubServer({ folders: folderChain("L", 5) });
    renderList();
    pressTrigger(await screen.findByRole("button", { name: "L5 的資料夾選單" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitemradio").map((el) => el.textContent)).toEqual(["名稱", "最近修改", "文件大小"]);
    expect(within(menu).getByRole("menuitem", { name: "新增子資料夾" })).toHaveAccessibleDescription("已達最多 5 層");
  });
});

// The kebab's "New note" creating in A1 writes both A1 and its ancestor A as expanded (AppShell.handleNewNote's ancestor expansion).
describe("FolderMenu x AppShell: kebab New note expands ancestors", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function NoteRoute() {
    const { handle, slug } = useParams();
    return <div data-testid="note-route">{`${handle}/${slug}`}</div>;
  }

  it("A1's kebab -> New note; before the POST returns A and A1 are both collapsed -> after success both are expanded and it navigates to the new note", async () => {
    let release: () => void = () => {};
    const held = new Promise<Response>((resolve) => (release = () => resolve(json(personalNote({ id: "created", title: "Untitled" }), 201))));
    const calls = stubServer({ folders: [A, folderDto({ id: "A1", name: "A1", parentId: "A" })], post: () => held });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <ActiveNoteProvider>
              <Routes>
                <Route path="/" element={<AppShell>home</AppShell>} />
                <Route path="/n/:handle/:slug" element={<NoteRoute />} />
              </Routes>
            </ActiveNoteProvider>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(within(await openMenu("A1")).getByRole("menuitem", { name: "New note" }));
    await waitFor(() => expect(calls.map((c) => c.key)).toEqual(["POST /api/notes"]));
    expect(calls[0]!.body).toEqual({ folderId: "A1" });
    act(() => {
      setCollapsed("folder:A", true);
      setCollapsed("folder:A1", true);
    });
    release();
    await waitFor(() => expect(screen.getByTestId("note-route")).toHaveTextContent("tester/note-created"));
    expect(isCollapsed("folder:A")).toBe(false);
    expect(isCollapsed("folder:A1")).toBe(false);
  });
});

describe("FolderMenu phone sheet", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());
  });

  it("phone: bottom sheet with the folder name on top; action rows and sort rows are 48px; at 640 and above there is no title and the rows are as before", async () => {
    stubLayoutTier("phone");
    stubServer({ folders: [A] });
    const { view } = renderList();
    const menu = await openMenu("A");
    expect(menu).toHaveAttribute("data-menu-sheet");
    expect(menu.firstElementChild).toHaveTextContent("A");
    for (const item of within(menu).getAllByRole("menuitem")) expect(item).toHaveClass("min-h-12", "text-base");
    for (const item of within(menu).getAllByRole("menuitemradio")) expect(item).toHaveClass("min-h-12", "text-base");
    view.unmount();
    vi.unstubAllGlobals();

    stubLayoutTier("docked");
    stubServer({ folders: [A] });
    renderList();
    const popover = await openMenu("A");
    expect(popover).not.toHaveAttribute("data-menu-sheet");
    expect(skeleton(popover)[0]).toBe("New note");
    expect(within(popover).getByRole("menuitemradio", { name: "Name" })).not.toHaveClass("min-h-12");
  });
});

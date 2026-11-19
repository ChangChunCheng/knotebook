import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memo, type ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import type { NoteDto, TrashItemDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { OVERLAY_QUERY } from "@/lib/layout-tiers";
import { useSidebarTabActions, useSidebarTabState, type SidebarTabActions } from "@/lib/sidebar-tab";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts } from "@/components/ui/toast";
import { AppShell, SidebarDrawerButton } from "./AppShell";
import { OWNER_PERMS } from "@/test/fixtures";
import { trashItem, trashList } from "@/test/trash-fixtures";
import { personalNote } from "@/test/select-fixtures";
import { __resetCollapseForTests } from "@/components/sidebar/collapse";
import { clickOutside } from "@/test/outside-click";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";


// `sidebar.tab` leaks into later cases in this file, so it is cleared at file top level.
afterEach(() => {
  localStorage.clear();
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

const NOTE: NoteDto = {
  id: "66666666-6666-6666-6666-666666666666",
  title: "Tab Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "tab-note",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
  group: null,
  groupId: null,
  folderId: null,
  permissions: OWNER_PERMS,
};

const CREATED: NoteDto = {
  ...NOTE,
  id: "33333333-3333-3333-3333-333333333333",
  title: "Untitled",
  slug: "untitled-33333333",
};

function stubFetchWithNotes(notes: NoteDto[], trash: TrashItemDto[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse([]));
      if (url === "/api/auth/me") return Promise.resolve(fakeResponse(USER));
      if (url === "/api/notes" && method === "POST") return Promise.resolve(fakeResponse(CREATED, 201));
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse(notes));
      if (url === "/api/trash" && method === "GET") return Promise.resolve(fakeResponse(trashList(trash)));
      // #93: with search text of 2+ characters the sidebar content area calls /api/search (returns empty).
      if (url.startsWith("/api/search?")) return Promise.resolve(new Response(JSON.stringify({ hits: [], nextCursor: null }), { status: 200, headers: { "Content-Type": "application/json" } }));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

/** Controllable matchMedia stub (as in AppShell.test.tsx): only `OVERLAY_QUERY` returns `initialMatches`; every other query (e.g. `WIDE_POINTER_QUERY`) doesn't match. */
function stubControllableMatchMedia(initialMatches: boolean) {
  const mql = {
    matches: initialMatches,
    media: OVERLAY_QUERY,
    addEventListener: () => {},
    removeEventListener: () => {},
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => (query === OVERLAY_QUERY ? mql : { ...mql, matches: false })),
  );
}

function NoteRouteProbe() {
  const { handle, slug } = useParams<{ handle: string; slug: string }>();
  return <div data-testid="note-route">{`${handle}/${slug}`}</div>;
}

function renderShell(children: ReactNode = <SidebarDrawerButton />) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/"]}>
          <ActiveNoteProvider>
            <Routes>
              <Route path="/" element={<AppShell>{children}</AppShell>} />
              <Route path="/n/:handle/:slug" element={<NoteRouteProbe />} />
            </Routes>
          </ActiveNoteProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

const aside = () => document.querySelector("aside") as HTMLElement;

describe("AppShell - sidebar tab wiring", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("tabpanel aria-labelledby points to the selected tab and follows it after switching tabs", async () => {
    stubFetchWithNotes([NOTE]);
    renderShell();
    await screen.findByRole("tab", { name: "My notes" });

    const panel = within(aside()).getByRole("tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", within(aside()).getByRole("tab", { name: "My notes" }).id);

    fireEvent.click(within(aside()).getByRole("tab", { name: "Groups" }));
    expect(within(aside()).getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      within(aside()).getByRole("tab", { name: "Groups" }).id,
    );
  });

  it("two copies share state: switching tab in the drawer updates the static card, and it persists after closing the drawer", async () => {
    stubFetchWithNotes([NOTE]);
    renderShell();

    fireEvent.click(await screen.findByRole("button", { name: "Open sidebar" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    fireEvent.click(within(drawer).getByRole("tab", { name: "Groups" }));

    expect(within(drawer).getByRole("tab", { name: "Groups" })).toHaveAttribute("aria-selected", "true");
    // With the drawer open Radix marks the background aria-hidden, so the static card needs hidden:true to be found.
    expect(within(aside()).getByRole("tab", { name: "Groups", hidden: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument());
    expect(within(aside()).getByRole("tab", { name: "Groups" })).toHaveAttribute("aria-selected", "true");
  });

  it("useId doesn't collide: the two instances have different aria-controls, each pointing into its own container, and ids are unique across the DOM", async () => {
    stubFetchWithNotes([NOTE]);
    renderShell();

    fireEvent.click(await screen.findByRole("button", { name: "Open sidebar" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });

    const staticControls = within(aside())
      .getByRole("tab", { name: "My notes", hidden: true })
      .getAttribute("aria-controls")!;
    const drawerControls = within(drawer).getByRole("tab", { name: "My notes" }).getAttribute("aria-controls")!;
    expect(staticControls).not.toBe(drawerControls);
    expect(aside().contains(document.getElementById(staticControls))).toBe(true);
    expect(drawer.contains(document.getElementById(drawerControls))).toBe(true);

    const ids = [...document.querySelectorAll("[role=tab], [role=tabpanel]")].map((el) => el.id);
    // Static card and drawer copies x (six tabs + one tabpanel)
    expect(ids).toHaveLength(14);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("children aren't re-rendered: switching tab and typing in the search box don't re-run a subtree that only consumes actions", async () => {
    stubFetchWithNotes([NOTE]);
    let renders = 0;
    const seen: SidebarTabActions[] = [];
    const Counter = memo(function Counter() {
      renders += 1;
      seen.push(useSidebarTabActions());
      return <div>counter</div>;
    });
    renderShell(<Counter />);
    await screen.findAllByRole("link", { name: "Tab Note" });
    const baseline = renders;
    expect(baseline).toBeGreaterThan(0);

    for (const name of ["Groups", "Shared with me", "Recent"]) {
      fireEvent.click(within(aside()).getByRole("tab", { name }));
    }
    // The search-input lines catch `showTab` depending on drawer: the drawer context is a new object on every render, so depending on it would change `actions` identity and re-run Counter.
    const input = within(aside()).getByRole("textbox", { name: "Search notes" });
    fireEvent.change(input, { target: { value: "tab" } });
    fireEvent.change(input, { target: { value: "" } });

    expect(renders).toBe(baseline);
    for (const actions of seen) expect(actions).toBe(seen[0]);
  });

  it("showTab opens the drawer on a narrow screen and not on a wide one", async () => {
    function ShowShared() {
      const { showTab } = useSidebarTabActions();
      return (
        <button type="button" onClick={() => showTab("shared")}>
          go shared
        </button>
      );
    }

    stubControllableMatchMedia(true);
    stubFetchWithNotes([NOTE]);
    const narrow = renderShell(<ShowShared />);
    fireEvent.click(await screen.findByRole("button", { name: "go shared" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    expect(within(drawer).getByRole("tab", { name: "Shared with me" })).toHaveAttribute("aria-selected", "true");
    narrow.unmount();
    localStorage.clear();

    stubControllableMatchMedia(false);
    renderShell(<ShowShared />);
    fireEvent.click(await screen.findByRole("button", { name: "go shared" }));
    expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument();
    expect(within(aside()).getByRole("tab", { name: "Shared with me" })).toHaveAttribute("aria-selected", "true");
  });

  it("remount restores: the same tab is selected after AppShell unmounts and remounts", async () => {
    stubFetchWithNotes([NOTE]);
    const first = renderShell();
    fireEvent.click(await screen.findByRole("tab", { name: "Shared with me" }));
    first.unmount();

    renderShell();
    expect(await screen.findByRole("tab", { name: "Shared with me" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "My notes" })).toHaveAttribute("aria-selected", "false");
  });

  it("creating a note doesn't switch tab", async () => {
    stubFetchWithNotes([NOTE]);
    renderShell();
    fireEvent.click(await screen.findByRole("tab", { name: "Recent" }));
    expect(localStorage.getItem("sidebar.tab")).toBe("recent");

    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    await waitFor(() => expect(screen.getByTestId("note-route")).toBeInTheDocument());
    await act(async () => {});
    expect(localStorage.getItem("sidebar.tab")).toBe("recent");
  });

  it("zero notes and zero groups: tablist is still there, My notes selected, the panel shows the two-sentence EmptyState", async () => {
    stubFetchWithNotes([]);
    renderShell();
    const tablist = await within(aside()).findByRole("tablist");
    expect(tablist).toBeInTheDocument();
    expect(within(aside()).getByRole("tab", { name: "My notes" })).toHaveAttribute("aria-selected", "true");
    const panel = within(aside()).getByRole("tabpanel");
    expect(await within(panel).findByText("No notes yet.")).toBeInTheDocument();
    expect(within(panel).getByText("Create your first note to get started.")).toBeInTheDocument();
  });

  it("tabpanel is focusable (tabindex=0 + focus-visible ring): Tab can stop on a panel without focusable content (empty Recent)", async () => {
    stubFetchWithNotes([]);
    renderShell();
    fireEvent.click(await within(aside()).findByRole("tab", { name: "Recent" }));
    const panel = within(aside()).getByRole("tabpanel");
    expect(await within(panel).findByText("No notes yet.")).toBeInTheDocument();
    // No focusable element inside the panel (the header has "Select", disabled and unfocusable with 0 notes).
    expect(panel.querySelector("a, button:not(:disabled), input, [tabindex]")).toBeNull();
    expect(within(panel).getByRole("button", { name: "Select" })).toBeDisabled();
    expect(panel).toHaveAttribute("tabindex", "0");
    expect(panel).toHaveClass("focus-visible:ring-2", "focus-visible:ring-ring");
    panel.focus();
    expect(panel).toHaveFocus();

    // After switching tab the new tabpanel keeps the attributes (the same element updates with the tab).
    fireEvent.click(within(aside()).getByRole("tab", { name: "My notes" }));
    expect(within(aside()).getByRole("tabpanel")).toHaveAttribute("tabindex", "0");
  });

  it("starting a search ends selection: typing in the static search box ends selection; clearing the search doesn't return to selection", async () => {
    stubFetchWithNotes([NOTE]);
    renderShell(<SelectionProbe />);
    fireEvent.click(await screen.findByTestId("start-select"));
    expect(screen.getByTestId("selecting")).toHaveTextContent("true");
    // The My notes tab really swaps to the lazy selection header and checkbox tree: wait for it, or Suspense would resolve after the assertion.
    await within(aside()).findByText("0 selected");

    const input = within(aside()).getByRole("textbox", { name: "Search notes" });
    fireEvent.change(input, { target: { value: "tab" } });
    expect(screen.getByTestId("selecting")).toHaveTextContent("false");
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByTestId("selecting")).toHaveTextContent("false");
  });

  it("drawer Esc ends selection first: first Esc keeps the drawer and ends selection; the second Esc closes the drawer", async () => {
    stubControllableMatchMedia(true);
    stubFetchWithNotes([NOTE]);
    renderShell(
      <>
        <SidebarDrawerButton />
        <SelectionProbe />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open sidebar" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    fireEvent.click(screen.getByTestId("start-select"));
    expect(screen.getByTestId("selecting")).toHaveTextContent("true");
    // The static <aside> copy is also in the DOM, so the wait is scoped to the drawer.
    await within(drawer).findByText("0 selected");

    // This case goes through both the drawer's Radix Esc (document capture, flushSync ends selection and preventDefault) and the `SelectHeader` document bubble listener:
    // the latter sees defaultPrevented (and has already unmounted with selection) and does nothing; the static card's copy also does nothing on a narrow screen because it isn't visible.
    fireEvent.keyDown(document.activeElement ?? drawer, { key: "Escape" });
    await act(async () => {});
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBe(drawer);
    expect(screen.getByTestId("selecting")).toHaveTextContent("false");

    fireEvent.keyDown(document.activeElement ?? drawer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument());
  });

  it("drawer Esc closes the drawer as usual when nothing is selected", async () => {
    stubControllableMatchMedia(true);
    stubFetchWithNotes([NOTE]);
    renderShell(
      <>
        <SidebarDrawerButton />
        <SelectionProbe />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open sidebar" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    expect(screen.getByTestId("selecting")).toHaveTextContent("false");
    fireEvent.keyDown(document.activeElement ?? drawer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument());
  });

  it("trash tab: tabpanel becomes TrashPanel and the bottom becomes the retention note; switching back to My notes brings New note back", async () => {
    stubFetchWithNotes([NOTE]);
    renderShell();
    fireEvent.click(await within(aside()).findByRole("tab", { name: "Trash" }));
    const panel = within(aside()).getByRole("tabpanel");
    expect(await within(panel).findByText("The trash is empty.", { exact: true })).toBeInTheDocument();
    expect(panel.querySelector("[data-sidebar-header]")).toHaveTextContent("Trash · 0 notes");
    expect(within(panel).queryByRole("button", { name: "New personal note" })).toBeNull();
    expect(within(aside()).queryByRole("button", { name: "New note" })).toBeNull();
    expect(await within(aside()).findByTestId("trash-footer")).toBeInTheDocument();

    fireEvent.click(within(aside()).getByRole("tab", { name: "My notes" }));
    expect(within(aside()).getByRole("button", { name: "New note" })).toBeInTheDocument();
    expect(within(aside()).queryByTestId("trash-footer")).toBeNull();
    expect(within(within(aside()).getByRole("tabpanel")).getByRole("button", { name: "New personal note" })).toBeInTheDocument();
  });

  it("selection shared by both copies: entering selection in the drawer and ticking p1 also ticks it on the static card, header 1 selected", async () => {
    stubControllableMatchMedia(true);
    stubFetchWithNotes([NOTE], TRASH);
    renderShell();
    fireEvent.click(await screen.findByRole("button", { name: "Open sidebar" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    fireEvent.click(within(drawer).getByRole("tab", { name: "Trash" }));
    await waitFor(() => expect(drawer.querySelector('li[data-node-id="p1"]')).not.toBeNull());
    fireEvent.click(within(trashHeader(drawer)).getByRole("button", { name: "Select" }));
    fireEvent.click(trashBox(drawer, "p1")!);

    expect(trashBox(drawer, "p1")).toBeChecked();
    expect(trashBox(aside(), "p1")).toBeChecked();
    expect(trashBox(aside(), "p2")).not.toBeChecked();
    expect(within(trashHeader(aside())).getByText("1 selected", { exact: true })).toBeInTheDocument();
  });

  it("ticking doesn't re-render children: enter trash, Select, tick three, Done; a subtree that only consumes actions doesn't re-run", async () => {
    stubFetchWithNotes([NOTE], TRASH);
    let renders = 0;
    const seen: SidebarTabActions[] = [];
    const Counter = memo(function Counter() {
      renders += 1;
      seen.push(useSidebarTabActions());
      return <div>counter</div>;
    });
    renderShell(<Counter />);
    await screen.findAllByRole("link", { name: "Tab Note" });
    const baseline = renders;
    expect(baseline).toBeGreaterThan(0);

    fireEvent.click(within(aside()).getByRole("tab", { name: "Trash" }));
    await waitFor(() => expect(aside().querySelector('li[data-node-id="w1"]')).not.toBeNull());
    fireEvent.click(within(trashHeader(aside())).getByRole("button", { name: "Select" }));
    for (const id of ["p1", "p2", "w1"]) fireEvent.click(trashBox(aside(), id)!);
    expect(within(trashHeader(aside())).getByText("3 selected", { exact: true })).toBeInTheDocument();
    fireEvent.click(within(trashHeader(aside())).getByRole("button", { name: "Done" }));
    expect(within(trashHeader(aside())).getByRole("button", { name: "Select" })).toBeInTheDocument();

    expect(renders).toBe(baseline);
    for (const actions of seen) expect(actions).toBe(seen[0]);
  });

  it("switching tab away during selection: clicking My notes then Trash -> ordinary header", async () => {
    stubFetchWithNotes([NOTE], TRASH);
    renderShell();
    fireEvent.click(await within(aside()).findByRole("tab", { name: "Trash" }));
    await waitFor(() => expect(aside().querySelector('li[data-node-id="p1"]')).not.toBeNull());
    fireEvent.click(within(trashHeader(aside())).getByRole("button", { name: "Select" }));
    fireEvent.click(trashBox(aside(), "p1")!);
    expect(within(trashHeader(aside())).getByRole("button", { name: "Done" })).toBeInTheDocument();

    fireEvent.click(within(aside()).getByRole("tab", { name: "My notes" }));
    fireEvent.click(within(aside()).getByRole("tab", { name: "Trash" }));
    await waitFor(() => expect(aside().querySelector('li[data-node-id="p1"]')).not.toBeNull());
    expect(within(trashHeader(aside())).getByRole("button", { name: "Select" })).toBeInTheDocument();
    expect(within(trashHeader(aside())).queryByRole("button", { name: "Done" })).toBeNull();
    expect(trashBox(aside(), "p1")).toBeNull();
  });

  it("focus stays on the copy that started it: Select in the drawer -> the drawer's Done; Done in the drawer -> the drawer's Select", async () => {
    stubControllableMatchMedia(true);
    stubFetchWithNotes([NOTE], TRASH);
    renderShell();
    fireEvent.click(await screen.findByRole("button", { name: "Open sidebar" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    fireEvent.click(within(drawer).getByRole("tab", { name: "Trash" }));
    await waitFor(() => expect(drawer.querySelector('li[data-node-id="p1"]')).not.toBeNull());

    fireEvent.click(within(trashHeader(drawer)).getByRole("button", { name: "Select" }));
    const drawerDone = within(trashHeader(drawer)).getByRole("button", { name: "Done" });
    expect(drawerDone).toHaveFocus();
    expect(within(trashHeader(aside())).getByRole("button", { name: "Done", hidden: true })).not.toHaveFocus();

    fireEvent.click(drawerDone);
    expect(within(trashHeader(drawer)).getByRole("button", { name: "Select" })).toHaveFocus();
  });

  it("shell handle (data-sidebar-instance): after Esc in the bottom action bar focus returns to Select of the same copy - once for the static card and once for the drawer", async () => {
    stubControllableMatchMedia(true);
    stubFetchWithNotes([NOTE], TRASH);
    renderShell();
    fireEvent.click(await within(aside()).findByRole("tab", { name: "Trash" }));
    await waitFor(() => expect(aside().querySelector('li[data-node-id="p1"]')).not.toBeNull());
    // showTab opens the drawer on a narrow screen; close it first and do the first round on the static card.
    const opened = await screen.findByRole("dialog", { name: "Navigation" });
    fireEvent.keyDown(opened, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument());

    fireEvent.click(within(trashHeader(aside())).getByRole("button", { name: "Select" }));
    fireEvent.click(trashBox(aside(), "p1")!);
    const asideRestore = within(aside()).getByRole("button", { name: "Restore" });
    asideRestore.focus();
    fireEvent.keyDown(asideRestore, { key: "Escape" });
    expect(within(trashHeader(aside())).getByRole("button", { name: "Select" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    fireEvent.click(within(trashHeader(drawer)).getByRole("button", { name: "Select" }));
    fireEvent.click(trashBox(drawer, "p1")!);
    const drawerRestore = within(drawer).getByRole("button", { name: "Restore" });
    drawerRestore.focus();
    fireEvent.keyDown(drawerRestore, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBe(drawer);
    expect(within(trashHeader(drawer)).getByRole("button", { name: "Select" })).toHaveFocus();
  });

  it("drawer Esc via Radix only (dispatched on document, reproducing a real browser where React onKeyDown isn't reached): selection ends, drawer stays, focus is on the drawer's Select", async () => {
    stubControllableMatchMedia(true);
    stubFetchWithNotes([NOTE], TRASH);
    renderShell();
    fireEvent.click(await screen.findByRole("button", { name: "Open sidebar" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    fireEvent.click(within(drawer).getByRole("tab", { name: "Trash" }));
    await waitFor(() => expect(drawer.querySelector('li[data-node-id="p1"]')).not.toBeNull());
    fireEvent.click(within(trashHeader(drawer)).getByRole("button", { name: "Select" }));
    fireEvent.click(trashBox(drawer, "p1")!);
    trashBox(drawer, "p1")!.focus();

    // Dispatched on document: only Radix's capture listener receives it; TrashPanel and the action bar's React onKeyDown don't take part.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBe(drawer);
    expect(drawer.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(within(trashHeader(drawer)).getByRole("button", { name: "Select" })).toHaveFocus();
  });

  it("wide screen (no drawer): Select on the static card -> Done on the static card", async () => {
    stubControllableMatchMedia(false);
    stubFetchWithNotes([NOTE], TRASH);
    renderShell();
    fireEvent.click(await within(aside()).findByRole("tab", { name: "Trash" }));
    await waitFor(() => expect(aside().querySelector('li[data-node-id="p1"]')).not.toBeNull());
    fireEvent.click(within(trashHeader(aside())).getByRole("button", { name: "Select" }));
    expect(within(trashHeader(aside())).getByRole("button", { name: "Done" })).toHaveFocus();
  });
});

const TRASH = [
  trashItem({ id: "p1", title: "p1" }, { deletedDaysAgo: 0 }),
  trashItem({ id: "p2", title: "p2" }, { deletedDaysAgo: 1 }),
  trashItem({ id: "w1", title: "w1", group: { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "R&D" } }, { deletedDaysAgo: 2 }),
];
const trashHeader = (container: HTMLElement) => container.querySelector("[data-sidebar-header]") as HTMLElement;
const trashBox = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLInputElement>(`li[data-node-id="${id}"] input[type="checkbox"]`);

/** Selection probe: reads `selection.active` from the state context; the button enters selection mode. With the drawer open the background is aria-hidden, so always query by testid. */
function SelectionProbe() {
  const { selection } = useSidebarTabState();
  const { updateSelection } = useSidebarTabActions();
  return (
    <>
      <span data-testid="selecting">{String(selection.active)}</span>
      <button type="button" data-testid="start-select" onClick={() => updateSelection({ type: "start" })}>
        start selecting
      </button>
    </>
  );
}

/**
 * Closing the drawer while a normal-tab batch action is in progress (#181): the drawer's action bar unmounts and the batch keeps running; the selection result is applied from the session (not from mounting); a reopened drawer's new action bar shows the round in progress.
 */
describe("AppShell - closing the drawer during a batch", () => {
  const notes = ["n1", "n2", "n3"].map((id) => ({ ...NOTE, id, title: id, slug: id }));

  function stubBatchServer(opts: { failSecond?: boolean } = {}) {
    let list = [...notes];
    const deletes: string[] = [];
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse([]));
        if (url === "/api/auth/me") return Promise.resolve(fakeResponse(USER));
        if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
        if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse(list));
        if (method === "DELETE") {
          const id = url.split("/").pop() as string;
          deletes.push(id);
          const respond = () => {
            if (opts.failSecond && id === "n2") return fakeResponse({ error: { code: "too_many_requests", message: "x" } }, 429);
            list = list.filter((note) => note.id !== id);
            return fakeResponse(undefined, 204);
          };
          return id === "n1" ? gate.then(respond) : Promise.resolve(respond());
        }
        return Promise.resolve(fakeResponse({ error: { code: "not_found", message: "x" } }, 404));
      }),
    );
    return {
      deletes,
      release: async () => {
        await act(async () => {
          open();
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      },
    };
  }

  const header = (container: HTMLElement) => container.querySelector("[data-sidebar-header]") as HTMLElement;
  const noteBox = (container: HTMLElement, id: string) =>
    container.querySelector<HTMLInputElement>(`input[type="checkbox"][data-selection-key="note:${id}"]`) as HTMLInputElement;
  const drawerNow = () => screen.queryByRole("dialog", { name: "Navigation" });

  /** The first delete request hangs. */
  async function startBatchInDrawer(): Promise<void> {
    fireEvent.click(await screen.findByRole("button", { name: "Open sidebar" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    await waitFor(() => expect(within(header(drawer)).getByRole("button", { name: "Select" })).toBeEnabled());
    fireEvent.click(within(header(drawer)).getByRole("button", { name: "Select" }));
    await within(header(drawer)).findByText("0 selected");
    await waitFor(() => expect(noteBox(drawer, "n3")).not.toBeNull());
    for (const id of ["n1", "n2", "n3"]) fireEvent.click(noteBox(drawer, id));
    fireEvent.click(await within(drawer).findByRole("button", { name: "Delete 3 selected items" }));
  }

  async function closeDrawerByOutsideClick(): Promise<void> {
    await clickOutside();
    await waitFor(() => expect(drawerNow()).toBeNull());
    expect(within(header(aside())).getByText("3 selected")).toBeInTheDocument();
  }

  async function reopenDrawer(): Promise<HTMLElement> {
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar", hidden: true }));
    return screen.findByRole("dialog", { name: "Navigation" });
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());
  });

  it("success: drawer closed mid-batch -> selection still ends when it finishes (reopened drawer shows the ordinary header)", async () => {
    stubControllableMatchMedia(true);
    const server = stubBatchServer();
    renderShell();
    await startBatchInDrawer();
    await waitFor(() => expect(server.deletes).toEqual(["n1"]));
    await closeDrawerByOutsideClick();
    await server.release();
    await waitFor(() => expect(server.deletes).toEqual(["n1", "n2", "n3"]));
    await waitFor(() => expect(within(header(aside())).queryByText("3 selected")).toBeNull());
    const drawer = await reopenDrawer();
    expect(within(header(drawer)).getByRole("button", { name: "Select" })).toBeInTheDocument();
    expect(within(header(drawer)).queryByRole("button", { name: "Done" })).toBeNull();
  });

  it("stopped (second request 429): reopened drawer is still in selection with only the 2 unprocessed notes left", async () => {
    stubControllableMatchMedia(true);
    const server = stubBatchServer({ failSecond: true });
    renderShell();
    await startBatchInDrawer();
    await waitFor(() => expect(server.deletes).toEqual(["n1"]));
    await closeDrawerByOutsideClick();
    await server.release();
    await waitFor(() => expect(within(header(aside())).getByText("2 selected")).toBeInTheDocument());
    expect(server.deletes).toEqual(["n1", "n2"]);
    const drawer = await reopenDrawer();
    expect(await within(header(drawer)).findByText("2 selected")).toBeInTheDocument();
    expect(noteBox(drawer, "n2")).toBeChecked();
    expect(noteBox(drawer, "n3")).toBeChecked();
  });

  it("reopening the drawer while the first request is still hanging -> the new action bar shows progress, three buttons disabled; after release the ordinary header returns", async () => {
    stubControllableMatchMedia(true);
    const server = stubBatchServer();
    renderShell();
    await startBatchInDrawer();
    await waitFor(() => expect(server.deletes).toEqual(["n1"]));
    await closeDrawerByOutsideClick();
    const drawer = await reopenDrawer();
    await waitFor(() => expect(drawer.querySelector("[data-select-action-bar]")).not.toBeNull());
    const bar = drawer.querySelector("[data-select-action-bar]") as HTMLElement;
    expect(within(bar).getByRole("status")).toHaveTextContent("Working… 0 of 3");
    for (const button of within(bar).getAllByRole("button")) expect(button).toBeDisabled();
    expect(within(bar).getAllByRole("button")).toHaveLength(3);
    await server.release();
    await waitFor(() => expect(within(header(drawer)).getByRole("button", { name: "Select" })).toBeInTheDocument());
    expect(server.deletes).toEqual(["n1", "n2", "n3"]);
  });
});

describe("AppShell - normal-tab selection mode", () => {
  const notes = ["p1", "p2", "p3"].map((id) => personalNote({ id, title: id }));
  const header = (container: HTMLElement) => container.querySelector("[data-sidebar-header]") as HTMLElement;
  const noteBox = (container: HTMLElement, id: string) =>
    container.querySelector<HTMLInputElement>(`input[type="checkbox"][data-selection-key="note:${id}"]`);

  async function startSelecting(container: HTMLElement): Promise<void> {
    await waitFor(() => expect(within(header(container)).getByRole("button", { name: "Select" })).toBeEnabled());
    fireEvent.click(within(header(container)).getByRole("button", { name: "Select" }));
    await waitFor(() => expect(noteBox(container, "p1")).not.toBeNull());
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetCollapseForTests();
  });

  it("both copies share state: Select in the narrow-screen drawer and tick p1 -> the static card is ticked too, 1 selected", async () => {
    stubControllableMatchMedia(true);
    stubFetchWithNotes(notes);
    renderShell();
    fireEvent.click(await screen.findByRole("button", { name: "Open sidebar" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    await startSelecting(drawer);
    fireEvent.click(noteBox(drawer, "p1")!);

    expect(noteBox(drawer, "p1")).toBeChecked();
    expect(noteBox(aside(), "p1")).toBeChecked();
    expect(noteBox(aside(), "p2")).not.toBeChecked();
    expect(within(header(aside())).getByText("1 selected", { exact: true })).toBeInTheDocument();
    expect(within(header(drawer)).getByText("1 selected", { exact: true })).toBeInTheDocument();
  });

  it("children aren't re-rendered: Select, tick three, Done; a subtree that only consumes actions doesn't re-run", async () => {
    stubFetchWithNotes(notes);
    let renders = 0;
    const seen: SidebarTabActions[] = [];
    const Counter = memo(function Counter() {
      renders += 1;
      seen.push(useSidebarTabActions());
      return <div>counter</div>;
    });
    renderShell(<Counter />);
    await within(aside()).findByRole("link", { name: "p1" });
    const baseline = renders;
    expect(baseline).toBeGreaterThan(0);

    await startSelecting(aside());
    for (const id of ["p1", "p2", "p3"]) fireEvent.click(noteBox(aside(), id)!);
    expect(within(header(aside())).getByText("3 selected", { exact: true })).toBeInTheDocument();
    fireEvent.click(within(header(aside())).getByRole("button", { name: "Done" }));
    expect(within(header(aside())).getByRole("button", { name: "Select" })).toBeInTheDocument();

    expect(renders).toBe(baseline);
    for (const actions of seen) expect(actions).toBe(seen[0]);
  });

  it("drawer Esc (dispatched on document, same as above): selection ends, drawer stays, focus is on Select in the drawer's My notes header", async () => {
    stubControllableMatchMedia(true);
    stubFetchWithNotes(notes);
    renderShell();
    fireEvent.click(await screen.findByRole("button", { name: "Open sidebar" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    await startSelecting(drawer);
    fireEvent.click(noteBox(drawer, "p1")!);
    noteBox(drawer, "p1")!.focus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBe(drawer);
    expect(drawer.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    const select = header(drawer).querySelector("button[data-sidebar-select]");
    expect(select).toHaveAccessibleName("Select");
    expect(select).toHaveFocus();
  });

  it("switching tab away during selection: clicking Groups -> ordinary header, bottom action bar gone (Groups tab has no New note)", async () => {
    stubFetchWithNotes(notes);
    renderShell();
    await startSelecting(aside());
    fireEvent.click(noteBox(aside(), "p1")!);
    expect(within(aside()).queryByRole("button", { name: "New note" })).toBeNull();

    fireEvent.click(within(aside()).getByRole("tab", { name: "Groups" }));
    expect(within(header(aside())).getByRole("button", { name: "Select" })).toBeInTheDocument();
    expect(within(header(aside())).queryByRole("button", { name: "Done" })).toBeNull();
    expect(within(header(aside())).queryByText(/selected/)).toBeNull();
    expect(within(aside()).queryByRole("button", { name: "New note" })).toBeNull();
    expect(within(aside()).queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("leaving via search: typing in the search box during selection ends it; after clearing, My notes shows ordinary rows and header", async () => {
    stubFetchWithNotes(notes);
    renderShell();
    await startSelecting(aside());
    fireEvent.click(noteBox(aside(), "p1")!);

    const input = within(aside()).getByRole("textbox", { name: "Search notes" });
    fireEvent.change(input, { target: { value: "p" } });
    expect(within(aside()).queryAllByRole("checkbox")).toHaveLength(0);
    fireEvent.change(input, { target: { value: "" } });
    expect(await within(aside()).findByRole("link", { name: "p1" })).toBeInTheDocument();
    expect(within(header(aside())).getByRole("button", { name: "Select" })).toBeInTheDocument();
    expect(within(header(aside())).queryByRole("button", { name: "Done" })).toBeNull();
    expect(within(aside()).queryAllByRole("checkbox")).toHaveLength(0);
    expect(within(aside()).getByRole("button", { name: "New note" })).toBeInTheDocument();
  });

  it("wide-screen focus: Select on the static card -> focus on the static card's Done", async () => {
    stubControllableMatchMedia(false);
    stubFetchWithNotes(notes);
    renderShell();
    await startSelecting(aside());
    const done = await within(header(aside())).findByRole("button", { name: "Done" });
    await waitFor(() => expect(done).toHaveFocus());
  });
});

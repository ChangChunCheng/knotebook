import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { canonicalNotePath, type GroupDto, type NoteDto, type UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { OVERLAY_QUERY } from "@/lib/layout-tiers";
import { stubLayoutTier } from "@/test/layout-tier";
import { NotePageControlsContext } from "@/lib/note-page-controls";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppShell, SidebarDrawerButton } from "./AppShell";
import { getShellControls } from "@/lib/tour-bridge";
import { adminRole, groupDto, OWNER_PERMS } from "@/test/fixtures";
import { FOLDER_LIST_EMPTY, folderDto, groupFolder } from "@/test/folder-fixtures";
import { __resetCollapseForTests, isCollapsed, setCollapsed } from "@/components/sidebar/collapse";
import { __resetFolderSortForTests } from "@/components/sidebar/folder-sort";

// `sidebar.tab` leaks through localStorage: a case that switches tab would make later cases looking for personal notes miss them on the wrong tab.
afterEach(() => localStorage.removeItem("sidebar.tab"));

// Wiring of "new note -> navigate to the new note page": since #122 it navigates to the /n/<handle>/<slug> shape, so the probe is mounted under /n/:handle/:slug (routing of this shape is also exercised in App.resetKey.test.tsx).

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
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

const CREATED: NoteDto = {
  id: "33333333-3333-3333-3333-333333333333",
  title: "Untitled",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "untitled-33333333",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
  group: null,
  groupId: null,
  folderId: null,
  permissions: OWNER_PERMS,
};

function NoteRouteProbe() {
  const { handle, slug } = useParams<{ handle: string; slug: string }>();
  return <div data-testid="note-route">{`${handle}/${slug}`}</div>;
}

function GroupNoteRouteProbe() {
  const { groupId, slug } = useParams<{ groupId: string; slug: string }>();
  return <div data-testid="group-note-route">{`${groupId}/${slug}`}</div>;
}

describe("AppShell - new note", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("navigates to the created note's canonical path after POST /api/notes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/groups" && method === "GET") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
        }
        if (url === "/api/auth/me") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
        }
        if (url === "/api/notes" && method === "POST") {
          return Promise.resolve(fakeResponse({ ok: true, status: 201, json: () => Promise.resolve(CREATED) }));
        }
        if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
        if (url === "/api/notes" && method === "GET") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
        }
        // #93: with search text of 2+ characters the sidebar content area calls /api/search (returns empty).
        if (url.startsWith("/api/search?")) return Promise.resolve(new Response(JSON.stringify({ hits: [], nextCursor: null }), { status: 200, headers: { "Content-Type": "application/json" } }));
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <ActiveNoteProvider>
              <Routes>
                <Route path="/" element={<AppShell>home</AppShell>} />
                <Route path="/n/:handle/:slug" element={<NoteRouteProbe />} />
              </Routes>
            </ActiveNoteProvider>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "New note" }));

    // #122: a new note takes the DB default `untitled-<uuid8>` slug, so canonical is `/n/<ownerHandle>/<slug>`.
    const expectedSegments = canonicalNotePath(CREATED).replace("/n/", ""); // "handle/slug": two segments
    await waitFor(() => expect(screen.getByTestId("note-route")).toHaveTextContent(expectedSegments));
  });

  it("#103/#175: the + in a group section creates the note with groupId and navigates to the new note's /g/ URL", async () => {
    const group: GroupDto = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Workshop A" }, adminRole());
    // Group note (#175): no personal owner, the role is never owner, canonical is `/g/<groupId>/<slug>`.
    const created: NoteDto = {
      ...CREATED,
      id: "77777777-7777-7777-7777-777777777777",
      ownerId: null,
      ownerHandle: null,
      role: "editor",
      slug: "untitled-77777777",
      groupId: group.id,
      group: { id: group.id, name: group.name },
      permissions: { ...OWNER_PERMS, manageShares: false, moveToGroup: false },
    };
    let postBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/groups" && method === "GET") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([group]) }));
        }
        if (url === "/api/auth/me") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
        }
        if (url === "/api/notes" && method === "POST") {
          postBody = JSON.parse(String(init?.body));
          return Promise.resolve(fakeResponse({ ok: true, status: 201, json: () => Promise.resolve(created) }));
        }
        if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
        if (url === "/api/notes" && method === "GET") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([CREATED]) }));
        }
        // #93: with search text of 2+ characters the sidebar content area calls /api/search (returns empty).
        if (url.startsWith("/api/search?")) return Promise.resolve(new Response(JSON.stringify({ hits: [], nextCursor: null }), { status: 200, headers: { "Content-Type": "application/json" } }));
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <ActiveNoteProvider>
              <Routes>
                <Route path="/" element={<AppShell>home</AppShell>} />
                <Route path="/n/:handle/:slug" element={<NoteRouteProbe />} />
                <Route path="/g/:groupId/:slug" element={<GroupNoteRouteProbe />} />
              </Routes>
            </ActiveNoteProvider>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );

    // Groups are listed on the Groups tab (the default tab is My notes).
    fireEvent.click(await screen.findByRole("tab", { name: "Groups" }));
    fireEvent.click(await screen.findByRole("button", { name: "New note in Workshop A" }));

    await waitFor(() => expect(postBody).toEqual({ groupId: group.id }));
    expect(canonicalNotePath(created)).toBe(`/g/${group.id}/untitled-77777777`);
    await waitFor(() =>
      expect(screen.getByTestId("group-note-route")).toHaveTextContent(`${group.id}/untitled-77777777`),
    );
  });

  it("shows an error toast and stays put when POST /api/notes fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/groups") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
        }
        if (url === "/api/notes" && method === "POST") {
          return Promise.resolve(
            fakeResponse({
              ok: false,
              status: 500,
              json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }),
            }),
          );
        }
        if (url === "/api/auth/me") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
        }
        if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }),
    );

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <ActiveNoteProvider>
              <Routes>
                <Route path="/" element={<AppShell>home</AppShell>} />
                <Route path="/n/:handle/:slug" element={<NoteRouteProbe />} />
              </Routes>
            </ActiveNoteProvider>
          </MemoryRouter>
          <Toaster />
        </ThemeProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "New note" }));

    await waitFor(() => expect(screen.getByText("Something went wrong. Please try again.")).toBeInTheDocument());
    expect(screen.queryByTestId("note-route")).not.toBeInTheDocument();
  });
});

// A result row's accessible name is "title location", so rows are fetched with a `^title` regex instead of an exact match (a negative assertion with an exact match would be vacuous).
describe("AppShell - search box & Ctrl/Cmd+K", () => {
  const ALPHA_NOTE: NoteDto = {
    id: "44444444-4444-4444-4444-444444444444",
    title: "Alpha Note",
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slug: "alpha-note",
    slugIsCustom: false,
    prevSlug: null,
    ownerHandle: "tester",
    lastEdited: null,
    group: null,
    groupId: null,
    folderId: null,
    permissions: OWNER_PERMS,
  };

  const BETA_NOTE: NoteDto = {
    id: "55555555-5555-5555-5555-555555555555",
    title: "Beta Note",
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2025-12-01T00:00:00.000Z",
    slug: "beta-note",
    slugIsCustom: false,
    prevSlug: null,
    ownerHandle: "tester",
    lastEdited: null,
    group: null,
    groupId: null,
    folderId: null,
    permissions: OWNER_PERMS,
  };

  function stubFetchWithNotes(notes: NoteDto[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/groups" && method === "GET") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
        }
        if (url === "/api/auth/me") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
        }
        if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
        if (url === "/api/notes" && method === "GET") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(notes) }));
        }
        // #93: with search text of 2+ characters the sidebar content area calls /api/search (returns empty).
        if (url.startsWith("/api/search?")) return Promise.resolve(new Response(JSON.stringify({ hits: [], nextCursor: null }), { status: 200, headers: { "Content-Type": "application/json" } }));
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
  }

  function renderShell(inert?: boolean) {
    return render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <ActiveNoteProvider>
              <AppShell inert={inert}>home</AppShell>
            </ActiveNoteProvider>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Ctrl+K focuses the search box and prevents the browser's default (address-bar search)", async () => {
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    renderShell();

    const input = await screen.findByRole("textbox", { name: "Search notes" });
    expect(input).not.toHaveFocus();

    // `fireEvent` returns the result of `dispatchEvent`: it is `false` when a cancelable event was stopped by `preventDefault()`,
    // which lets the test assert `defaultPrevented` without touching internals.
    const notCanceled = fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(input).toHaveFocus();
    expect(notCanceled).toBe(false);
  });

  it("Cmd+K (metaKey) also focuses the search box", async () => {
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    renderShell();

    const input = await screen.findByRole("textbox", { name: "Search notes" });
    fireEvent.keyDown(window, { key: "k", metaKey: true });

    expect(input).toHaveFocus();
  });

  // BlockNote's create-link tool binds a native keydown listener for Ctrl/Cmd+K on the editor DOM and calls `preventDefault()` without `stopPropagation()`,
  // so the event still bubbles to `window`; if AppShell didn't yield it would grab focus for the search box ahead of the editor.
  // Calling `event.preventDefault()` before dispatch simulates "someone already handled this key" arriving at AppShell's handler, without mounting a NoteEditor.
  it("Ctrl+K is ignored when the event arrives already defaultPrevented (e.g. BlockNote's own create-link shortcut) - no focus", async () => {
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    renderShell();

    const input = await screen.findByRole("textbox", { name: "Search notes" });
    const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
    event.preventDefault();
    window.dispatchEvent(event);

    expect(input).not.toHaveFocus();
  });

  it("Ctrl+K is ignored while a [role=dialog] is open on the page - no focus, no preventDefault", async () => {
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    renderShell();
    // No real Radix Dialog needed: the handler only checks the DOM for this selector.
    render(<div role="dialog">fake dialog</div>);

    const input = await screen.findByRole("textbox", { name: "Search notes" });
    const notCanceled = fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(input).not.toHaveFocus();
    expect(notCanceled).toBe(true);
  });

  // With a dropdown menu open (role="menu", not role="dialog") Ctrl+K still triggers and takes focus:
  // deliberately paired with the role="dialog" case above.
  it("Ctrl+K still triggers while a [role=menu] (dropdown) is open - only [role=dialog] is excluded", async () => {
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    renderShell();
    render(<div role="menu">fake ⋮ menu</div>);

    const input = await screen.findByRole("textbox", { name: "Search notes" });
    const notCanceled = fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(input).toHaveFocus();
    expect(notCanceled).toBe(false);
  });

  it("shortcut badge: Mac platform shows ⌘K, non-Mac shows Ctrl K", async () => {
    // AppShell only reads `navigator.platform`, so a minimal stand-in suffices; `{ ...navigator }` would spread nothing
    // (jsdom's navigator properties live on the prototype chain, not as own properties).
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    vi.stubGlobal("navigator", { platform: "MacIntel" } as Navigator);
    const { unmount } = renderShell();
    expect(await screen.findByText("⌘K")).toBeInTheDocument();
    unmount();

    vi.stubGlobal("navigator", { platform: "Win32" } as Navigator);
    renderShell();
    expect(await screen.findByText("Ctrl K")).toBeInTheDocument();
  });

  it("key semantics are pinned on purpose: Ctrl+Shift+K doesn't trigger (strict event.key === 'k'; Shift makes the browser report uppercase 'K')", async () => {
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    renderShell();

    const input = await screen.findByRole("textbox", { name: "Search notes" });
    const notCanceled = fireEvent.keyDown(window, { key: "K", ctrlKey: true, shiftKey: true });

    expect(input).not.toHaveFocus();
    expect(notCanceled).toBe(true);
  });

  it("Escape clears the search box and blurs it", async () => {
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    renderShell();

    const input = await screen.findByRole("textbox", { name: "Search notes" });
    fireEvent.change(input, { target: { value: "Alpha" } });
    input.focus();
    expect(input).toHaveValue("Alpha");
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(input).toHaveValue("");
    expect(input).not.toHaveFocus();
  });

  it("real path: typing in the search box actually shrinks the sidebar note list (AppShell -> SearchResults query wiring)", async () => {
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    renderShell();

    const input = await screen.findByRole("textbox", { name: "Search notes" });
    await waitFor(() => expect(screen.getAllByRole("link", { name: /^Beta Note/ }).length).toBeGreaterThan(0));

    fireEvent.change(input, { target: { value: "Alpha" } });

    const results = await screen.findByTestId("sidebar-search");
    await within(results).findByRole("link", { name: /^Alpha Note/ });
    expect(screen.queryAllByRole("link", { name: /^Beta Note/ })).toHaveLength(0);
  });

  it("while searching neither the tab row nor the tabpanel renders; after Esc the tablist returns with the original tab still selected", async () => {
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    renderShell();
    const input = await screen.findByRole("textbox", { name: "Search notes" });
    fireEvent.click(await screen.findByRole("tab", { name: "Groups" }));
    expect(screen.getByRole("tab", { name: "Groups" })).toHaveAttribute("aria-selected", "true");

    fireEvent.change(input, { target: { value: "Alpha" } });
    await screen.findByTestId("sidebar-search");
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tabpanel")).toBeNull();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(await screen.findByRole("tablist")).toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-search")).toBeNull();
    expect(screen.getByRole("tab", { name: "Groups" })).toHaveAttribute("aria-selected", "true");
  });

  it("clear button: absent for an empty string (the Ctrl K badge shows); with text it replaces the badge; clicking clears, focus stays in the input, tablist returns", async () => {
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    renderShell();
    const input = await screen.findByRole("textbox", { name: "Search notes" });
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    expect(screen.getByText("Ctrl K")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("tab", { name: "Groups" }));

    fireEvent.change(input, { target: { value: "Alpha" } });
    const clear = await screen.findByRole("button", { name: "Clear search" });
    expect(screen.queryByText("Ctrl K")).toBeNull();

    fireEvent.click(clear);
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(await screen.findByRole("tablist")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Groups" })).toHaveAttribute("aria-selected", "true");
  });

  it("whitespace-only counts as searching (current behaviour): swaps to the search view and shows the clear button", async () => {
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    renderShell();
    const input = await screen.findByRole("textbox", { name: "Search notes" });
    fireEvent.change(input, { target: { value: " " } });
    await screen.findByTestId("sidebar-search");
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("button", { name: "Clear search" })).toBeInTheDocument();
  });

  it("clicking a result to change page keeps the search text and the search view (several results can be opened in a row)", async () => {
    const one: NoteDto = { ...ALPHA_NOTE, id: "77777777-7777-7777-7777-777777777771", title: "Alpha One", slug: "a" };
    const two: NoteDto = { ...ALPHA_NOTE, id: "77777777-7777-7777-7777-777777777772", title: "Alpha Two", slug: "b" };
    stubFetchWithNotes([one, two]);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/n/tester/a"]}>
            <ActiveNoteProvider>
              <Routes>
                <Route
                  path="/n/:handle/:slug"
                  element={
                    <AppShell>
                      <NoteRouteProbe />
                    </AppShell>
                  }
                />
              </Routes>
            </ActiveNoteProvider>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
    const input = await screen.findByRole("textbox", { name: "Search notes" });
    expect(screen.getByTestId("note-route")).toHaveTextContent("tester/a");
    fireEvent.change(input, { target: { value: "alpha" } });
    const results = await screen.findByTestId("sidebar-search");
    fireEvent.click(await within(results).findByRole("link", { name: /^Alpha Two/ }));

    await waitFor(() => expect(screen.getByTestId("note-route")).toHaveTextContent("tester/b"));
    expect(input).toHaveValue("alpha");
    expect(screen.getByTestId("sidebar-search")).toBeInTheDocument();
  });

  it("#229: inert=true -> the AppShell root div has the inert attribute; omitted -> none", async () => {
    stubFetchWithNotes([ALPHA_NOTE]);
    const first = renderShell(true);
    await screen.findByRole("textbox", { name: "Search notes" });
    expect(first.container.querySelector(".h-dvh")).toHaveAttribute("inert");
    first.unmount();
    const second = renderShell();
    await screen.findByRole("textbox", { name: "Search notes" });
    expect(second.container.querySelector(".h-dvh")).not.toHaveAttribute("inert");
  });
});

/**
 * #115: sidebar drawer (navigation entry below 1280). jsdom has no CSS, so `hidden`/`xl:flex` don't affect accessibility queries, and an open drawer puts two SidebarContent copies (static and drawer) in the DOM: queries in this group are scoped with `within(drawer)`, never global byRole.
 *
 * The `test/setup.ts` matchMedia stub always has `matches:false` and a no-op addEventListener, so the "Ctrl+K narrow branch" and "resize across the breakpoint closes" cases stub a controllable MediaQueryList (own listener set + manual dispatch of change); otherwise an implementation that registers a listener that never fires would still pass.
 */
describe("AppShell - #115 sidebar drawer", () => {
  const NOTE: NoteDto = {
    id: "66666666-6666-6666-6666-666666666666",
    title: "Drawer Note",
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slug: "drawer-note",
    slugIsCustom: false,
    prevSlug: null,
    ownerHandle: "tester",
    lastEdited: null,
    group: null,
    groupId: null,
    folderId: null,
    permissions: OWNER_PERMS,
  };

  function stubFetchWithNotes(notes: NoteDto[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/groups" && method === "GET") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
        }
        if (url === "/api/auth/me") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
        }
        if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
        if (url === "/api/notes" && method === "GET") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(notes) }));
        }
        // #93: with search text of 2+ characters the sidebar content area calls /api/search (returns empty).
        if (url.startsWith("/api/search?")) return Promise.resolve(new Response(JSON.stringify({ hits: [], nextCursor: null }), { status: 200, headers: { "Content-Type": "application/json" } }));
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
  }

  /** Controllable matchMedia stub returning a handle that fires `change`; `matches` is only the initial value, afterwards the dispatched value decides (the implementation reads event.matches). */
  function stubControllableMatchMedia(initialMatches: boolean) {
    const listeners = new Set<(e: { matches: boolean }) => void>();
    const mql = {
      matches: initialMatches,
      media: OVERLAY_QUERY,
      addEventListener: (_: "change", fn: (e: { matches: boolean }) => void) => listeners.add(fn),
      removeEventListener: (_: "change", fn: (e: { matches: boolean }) => void) => listeners.delete(fn),
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    };
    // Only OVERLAY_QUERY returns an mql; other queries (e.g. WIDE_POINTER_QUERY) don't match and register no listener.
    vi.stubGlobal("matchMedia", vi.fn((query: string) => (query === OVERLAY_QUERY ? mql : { ...mql, matches: false, addEventListener: () => {}, removeEventListener: () => {} })));
    return {
      dispatchChange(matches: boolean) {
        mql.matches = matches;
        for (const fn of listeners) fn({ matches });
      },
      listenerCount: () => listeners.size,
    };
  }

  // The sidebar button lives at page level (NotePage header / NarrowTopBar), not in AppShell, so the harness acts as that consumer and puts SidebarDrawerButton into children.
  // `wrap`: a provider that must go outside `<AppShell>` (e.g. NotePage's NotePageControlsContext); the children slot is inside AppShell and can't hold it.
  function renderShell(
    children: ReactNode = <SidebarDrawerButton />,
    wrap: (shell: ReactNode) => ReactNode = (shell) => shell,
  ) {
    return render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <ActiveNoteProvider>
              {wrap(<AppShell>{children}</AppShell>)}
            </ActiveNoteProvider>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clicking the sidebar button opens the drawer: dialog has an accessible name, data-sidebar-drawer, bg-card flex flex-col; contains the search box and note rows", async () => {
    stubFetchWithNotes([NOTE]);
    renderShell();

    fireEvent.click(await screen.findByRole("button", { name: "Open sidebar" }));

    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    // Invariants: no background color -> overlay black shows through; no flex context -> a long list pushes the button out;
    // no attribute -> the Ctrl+K yield check can't recognise the drawer.
    expect(drawer).toHaveAttribute("data-sidebar-drawer");
    expect(drawer).toHaveClass("fixed", "inset-y-0", "left-0", "z-50", "flex", "flex-col", "bg-card");
    expect(drawer).not.toHaveClass("w-64");
    // The drawer hugs the left/top/bottom window edges: notch, home indicator and landscape sides must stay clear.
    expect(drawer).toHaveClass("pt-[env(safe-area-inset-top)]", "pb-[env(safe-area-inset-bottom)]", "pl-[env(safe-area-inset-left)]");
    // Opened via the sidebar button, focus lands on the drawer container itself (not the search box, so touch keyboards don't pop up);
    // this step arms Radix's focus trap: an implementation where onOpenAutoFocus only preventDefaults without focusing would leave focus on the sidebar button and let Tab escape into the aria-hidden background.
    expect(drawer).toHaveFocus();

    expect(within(drawer).getByRole("textbox", { name: "Search notes" })).toBeInTheDocument();
    // The default tab is My notes: personal notes are listed in that one panel only (singular query).
    expect(await within(drawer).findByRole("link", { name: "Drawer Note" })).toBeInTheDocument();
  });

  it("clicking a note in the drawer (route change) closes the drawer", async () => {
    stubFetchWithNotes([NOTE]);
    renderShell();

    fireEvent.click(await screen.findByRole("button", { name: "Open sidebar" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });

    fireEvent.click(await within(drawer).findByRole("link", { name: "Drawer Note" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument());
  });

  it("open drawer -> Esc closes -> Ctrl+K still focuses the static search box (the two instances don't share a ref; a shared ref would be cleared to null when the drawer unmounts)", async () => {
    stubFetchWithNotes([NOTE]);
    renderShell();

    fireEvent.click(await screen.findByRole("button", { name: "Open sidebar" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument());

    // With the drawer closed only the static search box remains, which is why the singular getByRole works.
    const input = screen.getByRole("textbox", { name: "Search notes" });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(input).toHaveFocus();
  });

  it("Ctrl+K narrow branch (matchMedia matches:true): opens the drawer and focuses the search box inside it", async () => {
    stubControllableMatchMedia(true);
    stubFetchWithNotes([NOTE]);
    renderShell();
    await screen.findByRole("button", { name: "Open sidebar" });

    // false means the event was preventDefault-ed (on a narrow window Ctrl+K must not also trigger the browser's address-bar search).
    const notCanceled = fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(notCanceled).toBe(false);

    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    await waitFor(() => expect(within(drawer).getByRole("textbox", { name: "Search notes" })).toHaveFocus());
  });

  it("resize across the breakpoint (change -> matches:false) closes the drawer", async () => {
    const media = stubControllableMatchMedia(true);
    stubFetchWithNotes([NOTE]);
    renderShell();

    fireEvent.click(await screen.findByRole("button", { name: "Open sidebar" }));
    await screen.findByRole("dialog", { name: "Navigation" });
    expect(media.listenerCount()).toBeGreaterThan(0);

    act(() => {
      media.dispatchChange(false);
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument());
  });

  it("AI edit history for the open note from the drawer: calls openEdits and closes the drawer (no navigation, so the pathname effect can't close it)", async () => {
    stubFetchWithNotes([NOTE]);
    const openEdits = vi.fn();
    renderShell(<SidebarDrawerButton />, (shell) => (
      <NotePageControlsContext.Provider
        value={{ noteId: NOTE.id, state: { phase: "connected", role: "owner" }, leavingRef: { current: false }, openEdits }}
      >
        {shell}
      </NotePageControlsContext.Provider>
    ));

    fireEvent.click(await screen.findByRole("button", { name: "Open sidebar" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    const section = await within(drawer).findByRole("tabpanel");
    fireEvent.pointerDown(await within(section).findByRole("button", { name: "Note actions for Drawer Note" }), { button: 0 });
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "AI edit history" }));

    expect(openEdits).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.querySelector("[data-sidebar-drawer]")).toBeNull());
  });

  describe("floating tier (640-1279)", () => {
    afterEach(() => {
      localStorage.removeItem("sidebar.width");
    });

    it("fixed sidebar shows only from xl up; the sidebar button is hidden from xl up and named Open sidebar", async () => {
      stubLayoutTier("overlay");
      stubFetchWithNotes([NOTE]);
      const { container } = renderShell();

      const aside = container.querySelector("aside[data-sidebar-instance]");
      expect(aside).toHaveClass("hidden", "xl:flex", "xl:flex-col");
      expect(aside).not.toHaveClass("md:flex");
      const button = await screen.findByRole("button", { name: "Open sidebar" });
      expect(button).toHaveClass("xl:hidden");
      expect(button).not.toHaveClass("md:hidden");
      expect(button.querySelector("svg")).toHaveAttribute("data-icon", "panel-left");
    });

    it("sidebar button opens the drawer: focus on the drawer container, not the search box; after Esc focus returns to the sidebar button", async () => {
      stubLayoutTier("overlay");
      stubFetchWithNotes([NOTE]);
      renderShell();

      const button = await screen.findByRole("button", { name: "Open sidebar" });
      button.focus(); // a real click focuses the button first, fireEvent.click doesn't; Radix returns focus to it on close
      fireEvent.click(button);
      const drawer = await screen.findByRole("dialog", { name: "Navigation" });
      expect(drawer).toHaveFocus();
      expect(within(drawer).getByRole("textbox", { name: "Search notes" })).not.toHaveFocus();

      const focusSpy = vi.spyOn(button, "focus");
      fireEvent.keyDown(drawer, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument());
      await waitFor(() => expect(button).toHaveFocus());
      // Return focus without scrolling: if the opener is the editor, focus() by default scrolls to the caret.
      expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    });

    it("Ctrl+K opens the drawer with focus on its search box, and preventDefault", async () => {
      stubLayoutTier("overlay");
      stubFetchWithNotes([NOTE]);
      renderShell();
      await screen.findByRole("button", { name: "Open sidebar" });

      expect(fireEvent.keyDown(window, { key: "k", ctrlKey: true })).toBe(false);
      const drawer = await screen.findByRole("dialog", { name: "Navigation" });
      await waitFor(() => expect(within(drawer).getByRole("textbox", { name: "Search notes" })).toHaveFocus());
    });

    it("clicking the overlay (note area) closes the drawer", async () => {
      stubLayoutTier("overlay");
      stubFetchWithNotes([NOTE]);
      renderShell();

      fireEvent.click(await screen.findByRole("button", { name: "Open sidebar" }));
      await screen.findByRole("dialog", { name: "Navigation" });
      const overlay = document.querySelector("[data-sidebar-drawer]")?.previousElementSibling;
      expect(overlay).toHaveClass("fixed", "inset-0");
      fireEvent.pointerDown(overlay as Element);
      fireEvent.pointerUp(overlay as Element);
      fireEvent.click(overlay as Element);

      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument());
    });

    it("drawer width follows the stored sidebar width, leaving at least 4rem on the right; no drag handle in the drawer", async () => {
      localStorage.setItem("sidebar.width", "400");
      stubLayoutTier("overlay");
      stubFetchWithNotes([NOTE]);
      renderShell();

      fireEvent.click(await screen.findByRole("button", { name: "Open sidebar" }));
      const drawer = await screen.findByRole("dialog", { name: "Navigation" });
      // jsdom's cssstyle pads both sides of the comma in min() with `*`, so the two components are matched separately.
      const widthStyle = drawer.getAttribute("style") ?? "";
      expect(widthStyle).toContain("min(400px");
      expect(widthStyle).toContain("calc(100vw - 4rem)");
      expect(within(drawer).queryByRole("separator")).toBeNull();
    });

    it("crossing 1280 into the fixed layout closes an open drawer", async () => {
      const tier = stubLayoutTier("overlay");
      stubFetchWithNotes([NOTE]);
      renderShell();

      fireEvent.click(await screen.findByRole("button", { name: "Open sidebar" }));
      await screen.findByRole("dialog", { name: "Navigation" });

      act(() => tier.setLayoutTier("docked"));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument());
    });

    it("in the fixed layout Ctrl+K focuses the fixed sidebar's search box and doesn't open a drawer", async () => {
      stubLayoutTier("docked");
      stubFetchWithNotes([NOTE]);
      renderShell();
      const input = await screen.findByRole("textbox", { name: "Search notes" });

      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      expect(input).toHaveFocus();
      expect(document.querySelector("[data-sidebar-drawer]")).toBeNull();
    });
  });
});

describe("AppShell - creating a note in a folder", () => {
  const G: GroupDto = groupDto({ id: "G", name: "G" }, adminRole());
  const FOLDERS = [folderDto({ id: "A", name: "A" }), groupFolder({ id: "GF", name: "GF", groupId: "G" })];

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    __resetCollapseForTests();
    __resetFolderSortForTests();
  });

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  function stubCreate(post: () => Response) {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/notes" && method === "POST") {
          bodies.push(JSON.parse(String(init?.body)));
          return Promise.resolve(post());
        }
        if (url === "/api/folders") return Promise.resolve(json({ folders: FOLDERS }));
        if (url === "/api/notes" && method === "GET") return Promise.resolve(json([]));
        if (url === "/api/groups" && method === "GET") return Promise.resolve(json([G]));
        if (url === "/api/auth/me") return Promise.resolve(json(USER));
        // #93: with search text of 2+ characters the sidebar content area calls /api/search (returns empty).
        if (url.startsWith("/api/search?")) return Promise.resolve(new Response(JSON.stringify({ hits: [], nextCursor: null }), { status: 200, headers: { "Content-Type": "application/json" } }));
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
    return bodies;
  }

  function renderShell() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <ActiveNoteProvider>
              <Routes>
                <Route path="/" element={<AppShell>home</AppShell>} />
                <Route path="/n/:handle/:slug" element={<NoteRouteProbe />} />
                <Route path="/g/:groupId/:slug" element={<GroupNoteRouteProbe />} />
              </Routes>
            </ActiveNoteProvider>
          </MemoryRouter>
          <Toaster />
        </ThemeProvider>
      </QueryClientProvider>,
    );
    return queryClient;
  }

  const fail = (status: number, code: string) => () => json({ error: { code, message: "x" } }, status);

  it("personal folder plus -> body {folderId}, navigates to the new note, folder written as expanded", async () => {
    setCollapsed("folder:A", true);
    const bodies = stubCreate(() => json(CREATED, 201));
    renderShell();
    fireEvent.click(await screen.findByRole("button", { name: "New note in A" }));
    await waitFor(() => expect(screen.getByTestId("note-route")).toHaveTextContent("tester/untitled-33333333"));
    expect(bodies).toEqual([{ folderId: "A" }]);
    expect(isCollapsed("folder:A")).toBe(false);
  });

  it("group folder plus -> body {groupId, folderId}", async () => {
    const created: NoteDto = { ...CREATED, ownerId: null, ownerHandle: null, role: "editor", groupId: "G", group: { id: "G", name: "G" } };
    const bodies = stubCreate(() => json(created, 201));
    renderShell();
    fireEvent.click(await screen.findByRole("tab", { name: "Groups" }));
    fireEvent.click(await screen.findByRole("button", { name: "New note in GF" }));
    await waitFor(() => expect(bodies).toEqual([{ groupId: "G", folderId: "GF" }]));
    await waitFor(() => expect(screen.getByTestId("group-note-route")).toHaveTextContent(`G/${CREATED.slug}`));
  });

  it("404 folder_not_found -> toast 'Folder not found.', ['folders'] invalidated, no navigation", async () => {
    stubCreate(fail(404, "folder_not_found"));
    const queryClient = renderShell();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    fireEvent.click(await screen.findByRole("button", { name: "New note in A" }));
    await waitFor(() => expect(screen.getByText("Folder not found.")).toBeInTheDocument());
    expect(spy).toHaveBeenCalledWith({ queryKey: ["folders"] });
    expect(screen.getByText("home")).toBeInTheDocument();
  });

  it("409 folder_too_deep -> toast shows the limit, without {{max}}", async () => {
    stubCreate(fail(409, "folder_too_deep"));
    renderShell();
    fireEvent.click(await screen.findByRole("button", { name: "New note in A" }));
    await waitFor(() => expect(screen.getByText("Folders can be at most 5 levels deep.")).toBeInTheDocument());
    expect(screen.queryByText(/\{\{max\}\}/)).toBeNull();
  });
});

describe("AppShell - feature tour registry", () => {
  const NOTE: NoteDto = { ...CREATED, id: "77777777-7777-7777-7777-777777777777", title: "Tour Note", slug: "tour-note" };

  function stubFetchForTour() {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
        if (url === "/api/auth/me") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
        if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
        if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([NOTE]) }));
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
  }

  function renderShell() {
    return render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <ActiveNoteProvider>
              <AppShell>
                <SidebarDrawerButton />
              </AppShell>
            </ActiveNoteProvider>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("wide window: getTab reads the current tab; showTab switches tab without opening the drawer; the registration is removed on unmount", async () => {
    localStorage.setItem("sidebar.tab", "recent");
    stubFetchForTour();
    const { unmount } = renderShell();
    await screen.findByRole("tab", { name: "Recent" });
    const controls = getShellControls();
    expect(controls).not.toBeNull();
    expect(controls!.getTab()).toBe("recent");

    act(() => controls!.showTab("myNotes"));
    expect(controls!.getTab()).toBe("myNotes");
    expect(screen.getByRole("tab", { name: "My notes" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument();

    unmount();
    expect(getShellControls()).toBeNull();
  });

  it("closeDrawer closes an open drawer", async () => {
    stubFetchForTour();
    renderShell();
    fireEvent.click(await screen.findByRole("button", { name: "Open sidebar" }));
    await screen.findByRole("dialog", { name: "Navigation" });

    act(() => getShellControls()!.closeDrawer());
    await waitFor(() => expect(document.querySelector("[data-sidebar-drawer]")).toBeNull());
  });

  it("endSelectionIfActive: ends selection and returns true in selection mode; returns false when not in selection mode", async () => {
    stubFetchForTour();
    renderShell();
    const controls = getShellControls()!;
    expect(controls.endSelectionIfActive()).toBe(false);

    // "Select" is disabled before the note list loads.
    await waitFor(() => expect(screen.getByRole("button", { name: "Select" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    await screen.findByRole("button", { name: "Done" });
    let ended = false;
    act(() => {
      ended = controls.endSelectionIfActive();
    });
    expect(ended).toBe(true);
    expect(screen.queryByRole("button", { name: "Done" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select" })).toBeInTheDocument();
  });
});

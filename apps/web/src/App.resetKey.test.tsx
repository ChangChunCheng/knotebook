import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { NoteDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { ThemeProvider } from "@/theme";
import { Toaster } from "@/components/ui/toast";
import { AppRoutes } from "./App";
import { OWNER_PERMS } from "@/test/fixtures";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

/**
 * Integration guard for NoteRouteErrorBoundary's resetKey choice (`useParams().ref`, not `location.key`): opening and closing the settings modal on a /notes/:ref error screen must not trigger a reload (#68).
 *
 * Mechanism:
 * - Initial /notes/my-note: location.key=`default`, params.ref=`my-note`
 * - Opening the settings modal: the main tree's `<Routes location={backgroundLocation}>` overrides the context, so NoteRoute reads the saved background location: key stays `default`, ref unchanged, the boundary instance isn't remounted and keeps its error state
 * - Closing the modal: SettingsModal calls `navigate(backgroundLocation)`, and react-router 8 generates a new key for navigation to a Location object; ref is still `my-note`. If resetKey were `useLocation().key`, componentDidUpdate would reload at this step: the main case fails with reload=1 while the control stays green.
 *
 * Separate file: SettingsModal.test.tsx's multi-case assertions depend on a real NotePage stand-in (note-editor testid), which a file-level NotePage mock would break; App.errorBoundary.test.tsx is the minimal-wiring check, whereas this file needs the whole Toaster + settings tree + UserMenu harness.
 */

// vi.mock is hoisted, so the factory can't reference header consts (TDZ): the message is inlined. Always throws: main/control paths diverge by the seeded flag, not the mock, so case order doesn't matter in this file (unlike the chunk-error case in App.errorBoundary.test.tsx).
vi.mock("./pages/NotePage", () => ({
  default: function NotePageMock(): never {
    throw new Error("Failed to fetch dynamically imported module: https://x/assets/NotePage-abc.js");
  },
}));

const FLAG_KEY = "knotebook:chunk-reload:notepage";
const CHUNK_ERROR_TEXT = "Couldn't load this page — check your connection, or a new version may have been deployed.";
const CRASH_TEXT = "Something went wrong on this page.";
const LOADING_TEXT = "Loading…";

const PLAIN_USER: UserDto = {
  id: "u-plain",
  email: "plain@example.com",
  handle: "tester",
  displayName: "Plain",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
  avatar: null,
};

const NOTE: NoteDto = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "My Note",
  ownerId: "u-plain",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "my-note",
  slugIsCustom: true,
  prevSlug: null,
  ownerHandle: "plain",
  lastEdited: null,
  group: null,
  groupId: null,
  folderId: null,
  permissions: OWNER_PERMS,
};

const OTHER_NOTE: NoteDto = {
  id: "22222222-2222-2222-2222-222222222222",
  title: "Other Note",
  ownerId: "u-plain",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "other-note",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "plain",
  lastEdited: null,
  group: null,
  groupId: null,
  folderId: null,
  permissions: OWNER_PERMS,
};

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const GROUP_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const GROUP_NOTE: NoteDto = {
  ...NOTE,
  id: "33333333-3333-3333-3333-333333333333",
  title: "Group Note",
  slug: "group-note",
  ownerId: null,
  ownerHandle: null,
  role: "editor",
  groupId: GROUP_ID,
  group: { id: GROUP_ID, name: "Workshop A" },
  permissions: { ...OWNER_PERMS, manageShares: false, moveToGroup: false },
};
const OTHER_GROUP_NOTE: NoteDto = { ...GROUP_NOTE, id: "44444444-4444-4444-4444-444444444444", title: "Other Group Note", slug: "other-group-note" };

function stubFetch(notes: NoteDto[] = [NOTE, OTHER_NOTE]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === "/api/auth/me" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(PLAIN_USER) }));
      }
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") {
        // Two notes, so a later case can click the other one in the sidebar.
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(notes) }));
      }
      if (url.endsWith("/backlinks") && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ backlinks: [] }) }));
      }
      if (url.startsWith("/api/notes/") && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(NOTE) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

/** App.tsx wiring passes no reload prop, so the boundary uses the default `location.reload()`: it can only be intercepted via the global (same technique as App.errorBoundary.test.tsx; MemoryRouter doesn't read the global location, so the two stubGlobal calls don't interfere). */
function stubLocationReload() {
  const reload = vi.fn();
  vi.stubGlobal("location", { ...window.location, reload });
  return reload;
}

function renderNoteRoute(initialEntry = "/notes/my-note") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <ActiveNoteProvider>
            <AppRoutes />
          </ActiveNoteProvider>
        </MemoryRouter>
      </ThemeProvider>
      <Toaster />
    </QueryClientProvider>,
  );
}

/** DropdownMenuTrigger (UserMenu) only has onPointerDown, so a plain fireEvent.click can't open it (see SettingsModal.test.tsx). The error screen sits inside the layout route's full AppShell, so UserMenu is interactive. */
function openUserMenu(userDisplayName: string): void {
  fireEvent.pointerDown(screen.getByRole("button", { name: userDisplayName }), { button: 0 });
}

beforeEach(async () => {
  sessionStorage.clear(); // Each case sets its own flag: the main case seeds it (reaching the stable error screen), controls don't
  await i18n.changeLanguage("en");
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.removeItem("sidebar.tab");
});

describe("resetKey choice: opening/closing the settings modal on the error screen does not reload (#68)", () => {
  it("main: open settings on the error screen, then close (navigate(backgroundLocation) yields a new location key) -> zero reloads, error screen stays", async () => {
    sessionStorage.setItem(FLAG_KEY, "1"); // short-circuits the auto reload, reaching the stable error screen
    const reload = stubLocationReload();

    renderNoteRoute();

    await waitFor(() => expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument());
    expect(reload).not.toHaveBeenCalled();

    openUserMenu("Plain");
    fireEvent.click(screen.getByText("Settings"));

    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Account info" })).toBeInTheDocument());
    // While the modal is open the background location (key included) is preserved and ref is unchanged, so no reload; the background error screen stays in the DOM (Radix aria-hidden doesn't affect getByText).
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // Closing navigates with navigate(backgroundLocation): new location key, same ref, so resetKey (=ref) is unchanged and there is no reload. If resetKey reverted to location.key, this fails.
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  // Positive control: proves the spy path the main case watches is live. With no flag seeded, componentDidCatch takes the first-error path and auto-reloads through the real App.tsx wiring's default seam (location.reload()) once, ending on the loading screen. If the seam or stubGlobal ever breaks, this fails first, so the main case's "spy=0" can't become a vacuous negative assertion.
  // Relies on jsdom's default navigator.onLine === true (this case's reload and the main case's ability to fail both depend on it); if jsdom changes that, the offline branch would falsely pass/fail both cases: check this first.
  it("positive control: no flag seeded -> default seam of the real wiring auto-reloads once and shows the loading screen", async () => {
    const reload = stubLocationReload();

    renderNoteRoute();

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    // Loading screen (reloading state), not the error screen: a discriminating assertion (the sidebar is present in both)
    expect(screen.getAllByText(LOADING_TEXT).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(CHUNK_ERROR_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByText(CRASH_TEXT)).not.toBeInTheDocument();
    expect(sessionStorage.getItem(FLAG_KEY)).not.toBeNull();
    // Re-pin the count outside waitFor: the check inside only proves it reached 1 at some point.
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // Second control: the one above shows componentDidCatch -> default seam is live, but the main case guards componentDidUpdate -> default seam (the unit-level case injects a prop instead). If componentDidUpdate were changed to call window.location.reload() directly (bypassing doReload), the main case would silently degrade to vacuously true while the control above stays green. This case covers that intersection: clicking another note in the sidebar on the error screen (ref really changes) makes componentDidUpdate reload once via the default seam.
  it("control 2: navigating to another note from the error screen -> componentDidUpdate reloads once via the default seam", async () => {
    sessionStorage.setItem(FLAG_KEY, "1");
    const reload = stubLocationReload();

    renderNoteRoute();

    await waitFor(() => expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument());
    expect(reload).not.toHaveBeenCalled();

    // getAllByRole takes the first match; the default tab lists "Other Note" once.
    await waitFor(() => expect(screen.getAllByRole("link", { name: /Other Note/ }).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole("link", { name: /Other Note/ })[0]);

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(reload).toHaveBeenCalledTimes(1);
    // The flag is not cleared (a navigation-triggered reload doesn't clear it; if the landing fails again it goes straight to the error screen)
    expect(sessionStorage.getItem(FLAG_KEY)).not.toBeNull();
    // #122: sidebar links now use the /n/ form, so this case also covers resetKey across route patterns (ref -> handle/slug changes the key -> reload once).
  });

  it("control 3 (#122 /n/ form): /n/ page is handled by NotePage (not the /* catch-all); switching notes /n/ -> /n/ changes resetKey -> reload once", async () => {
    sessionStorage.setItem(FLAG_KEY, "1");
    const reload = stubLocationReload();

    // Opening via the /n/ form shows the NotePage subtree's error screen (the mock always throws), proving the route is handled; if /n/a/b were swallowed by `/*`, HomePage would render and CHUNK_ERROR_TEXT would be absent.
    renderNoteRoute("/n/plain/my-note");
    await waitFor(() => expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument());
    expect(reload).not.toHaveBeenCalled();

    await waitFor(() => expect(screen.getAllByRole("link", { name: /Other Note/ }).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole("link", { name: /Other Note/ })[0]);

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    // The check inside waitFor only proves 1 was reached at some point; re-pin outside it to catch a late second reload (same convention as above)
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("control 4 (#175 /g/ form): /g/ page is handled by NotePage (not the /* catch-all); switching notes within a group changes resetKey (`g:${groupId}/${slug}`) -> reload once", async () => {
    sessionStorage.setItem(FLAG_KEY, "1");
    const reload = stubLocationReload();
    stubFetch([GROUP_NOTE, OTHER_GROUP_NOTE]);
    // Falls back to "Shared with me" (`/api/groups` returns []), so select that tab first; the default "My notes" tab doesn't list these two notes.
    localStorage.setItem("sidebar.tab", "shared");

    renderNoteRoute(`/g/${GROUP_ID}/group-note`);
    await waitFor(() => expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument());
    expect(reload).not.toHaveBeenCalled();

    // Switching to another note in the same group: sidebar links are the canonical `/g/<groupId>/<slug>` (the group isn't in useGroups, so notes fall back to "Shared with me"; the link form doesn't depend on the section). If resetKey lacked the third form (falling to `ref` = undefined), both pages would share a key and not reload.
    await waitFor(() => expect(screen.getAllByRole("link", { name: /Other Group Note/ }).length).toBeGreaterThan(0));
    const link = screen.getAllByRole("link", { name: /Other Group Note/ })[0];
    expect(link).toHaveAttribute("href", `/g/${GROUP_ID}/other-group-note`);
    fireEvent.click(link);

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

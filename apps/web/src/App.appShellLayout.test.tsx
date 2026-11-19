import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import type { NoteDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { ActiveNoteProvider } from "@/lib/active-note";
import { SidebarQueryProvider } from "@/lib/sidebar-query";
import { useAppShellInert } from "@/lib/app-shell-inert";
import { AppRoutes } from "./App";
import { OWNER_PERMS } from "@/test/fixtures";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

/**
 * The sidebar (AppShell) is a layout route: the `<aside>` is the same DOM node across home <-> note navigation, so list scroll position, selection mode and the sidebar shown while the NotePage chunk loads survive instead of being remounted.
 * NotePage is replaced by a stub that resolves only when the test releases it (it doesn't include AppShell itself).
 */
const notePageGate = vi.hoisted(() => ({ pending: null as Promise<void> | null, release: () => {} }));
vi.mock("./pages/NotePage", async () => {
  if (notePageGate.pending) await notePageGate.pending;
  return {
    default: function NotePageStub() {
      const location = useLocation();
      // As the real NotePage does: marks the whole sidebar inert under ?present and clears it on leaving.
      useAppShellInert(new URLSearchParams(location.search).has("present"));
      return <p>notepage-stub</p>;
    },
  };
});

const USER: UserDto = {
  id: "u1",
  email: "alice@example.com",
  handle: "alice",
  displayName: "Alice",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
  avatar: null,
};

const NOTE: NoteDto = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "Wired Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "wired-note",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "alice",
  lastEdited: null,
  group: null,
  groupId: null,
  folderId: null,
  permissions: OWNER_PERMS,
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <div data-testid="loc">{`${location.pathname}${location.search}`}</div>
      <button type="button" onClick={() => void navigate("/")}>
        go-home
      </button>
      <button type="button" onClick={() => void navigate("/n/alice/wired-note")}>
        go-note
      </button>
    </>
  );
}

function renderApp(initial: string) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[initial]}>
          <ActiveNoteProvider>
            <SidebarQueryProvider>
              <AppRoutes />
              <LocationProbe />
            </SidebarQueryProvider>
          </ActiveNoteProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe("App route tree: AppShell is a layout route", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    notePageGate.pending = null;
    notePageGate.release = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/auth/me") return Promise.resolve(json(USER));
        if (url === "/api/groups") return Promise.resolve(json([]));
        if (url === "/api/folders") return Promise.resolve(json(FOLDER_LIST_EMPTY));
        if (url === "/api/notes") return Promise.resolve(json([NOTE]));
        return Promise.resolve(new Response("{}", { status: 404 }));
      }),
    );
  });

  afterEach(() => {
    notePageGate.release();
    vi.unstubAllGlobals();
  });

  it("clicking a note on home keeps the same <aside> node, including while the chunk loads", async () => {
    notePageGate.pending = new Promise<void>((resolve) => {
      notePageGate.release = resolve;
    });
    renderApp("/");
    const asideBefore = await screen.findByRole("complementary");
    fireEvent.click(await within(asideBefore).findByRole("link", { name: /Wired Note/ }));
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/n/alice/wired-note"));

    expect(screen.getAllByText("Loading…").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("complementary")).toBe(asideBefore);

    notePageGate.release();
    expect(await screen.findByText("notepage-stub")).toBeInTheDocument();
    expect(screen.getByRole("complementary")).toBe(asideBefore);
  });

  it("home -> note page keeps list scroll position and selection mode", async () => {
    renderApp("/");
    const aside = await screen.findByRole("complementary");
    const link = await within(aside).findByRole("link", { name: /Wired Note/ });

    let scroller: HTMLElement | null = link.parentElement;
    while (scroller !== null && !scroller.className.includes("overflow-y-auto")) scroller = scroller.parentElement;
    expect(scroller).not.toBeNull();
    scroller!.scrollTop = 37;

    fireEvent.click(within(aside).getAllByRole("button", { name: "Select" })[0]!);
    expect(await within(aside).findByRole("button", { name: "Done" })).toBeInTheDocument();

    // Rows in selection mode are not links, so navigate programmatically.
    fireEvent.click(screen.getByRole("button", { name: "go-note" }));
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/n/alice/wired-note"));
    expect(await screen.findByText("notepage-stub")).toBeInTheDocument();

    const asideAfter = screen.getByRole("complementary");
    expect(asideAfter).toBe(aside);
    expect(scroller!.scrollTop).toBe(37);
    expect(within(asideAfter).getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("presentation mode: whole AppShell is inert, cleared on leaving presentation", async () => {
    renderApp("/n/alice/wired-note?present");
    const aside = await screen.findByRole("complementary");
    await screen.findByText("notepage-stub");
    expect(aside.closest("[inert]")).not.toBeNull();
  });

  it("without ?present AppShell is not inert; presentation -> normal mode clears inert", async () => {
    renderApp("/n/alice/wired-note?present");
    const aside = await screen.findByRole("complementary");
    await screen.findByText("notepage-stub");
    expect(aside.closest("[inert]")).not.toBeNull();

    const probeNote = within(aside).getByRole("link", { name: /Wired Note/ });
    fireEvent.click(probeNote);
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent(/^\/n\/alice\/wired-note$/));
    await waitFor(() => expect(aside.closest("[inert]")).toBeNull());
  });

  it("leaving the note page (back to home) clears inert via unmount cleanup", async () => {
    renderApp("/n/alice/wired-note?present");
    const aside = await screen.findByRole("complementary");
    await screen.findByText("notepage-stub");
    expect(aside.closest("[inert]")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "go-home" }));
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent(/^\/$/));
    expect(screen.queryByText("notepage-stub")).not.toBeInTheDocument();
    expect(screen.getByRole("complementary")).toBe(aside);
    expect(aside.closest("[inert]")).toBeNull();
  });
});

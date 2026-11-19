import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import type { NoteDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, toast, Toaster } from "@/components/ui/toast";
import { AppShell, SidebarDrawerButton } from "./AppShell";
import { OWNER_PERMS } from "@/test/fixtures";

/**
 * Toast while the narrow-screen drawer is open: the drawer is a modal Radix Dialog, so `hideOthers` marks everything outside it (including the Toaster in `#root`) aria-hidden and FocusScope traps focus in the drawer; a toast left in place would be unreachable by screen reader and keyboard (its "Undo"). Fix: while the drawer is open ToastViewport moves into the drawer content and returns on close.
 *
 * Mounted as in `App.tsx`: `<Toaster />` is a sibling of the Router (not inside AppShell), both under the render container (= `#root`); Radix portals the drawer content to body, so hideOthers marks the render container aria-hidden, same shape as the real app.
 */

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

function stubFetch() {
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
      if (url === "/api/notes" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([NOTE]) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

function renderApp() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/"]}>
          <ActiveNoteProvider>
            <Routes>
              <Route path="*" element={<AppShell><SidebarDrawerButton /></AppShell>} />
            </Routes>
          </ActiveNoteProvider>
        </MemoryRouter>
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

/** Notifications region reachable by role only (= not inside an aria-hidden subtree). */
function notificationsRegion(): HTMLElement {
  return screen.getByRole("region", { name: /^Notifications/ });
}

function hasAriaHiddenAncestor(el: HTMLElement): boolean {
  return el.closest('[aria-hidden="true"]') !== null;
}

async function openDrawer(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: "Open sidebar" }));
  return screen.findByRole("dialog", { name: "Navigation" });
}

function raiseUndoToast(onUndo: () => void = () => {}) {
  act(() => {
    toast({ title: "Moved to the trash", durationMs: 60_000, action: { label: "Undo", onClick: onUndo } });
  });
}

describe("AppShell - toast while the drawer is open (reachable by keyboard and screen reader)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubFetch();
  });

  afterEach(() => {
    act(() => dismissAllToasts());
    vi.unstubAllGlobals();
  });

  it("drawer open: the Notifications region is inside the drawer content and has no aria-hidden ancestor", async () => {
    renderApp();
    const drawer = await openDrawer();

    const region = notificationsRegion();
    expect(drawer).toContainElement(region);
    expect(hasAriaHiddenAncestor(region)).toBe(false);
  });

  it("toast raised while the drawer is open: found by role, Undo is focusable and focus stays within the drawer's focus scope", async () => {
    renderApp();
    const drawer = await openDrawer();
    raiseUndoToast();

    const item = await within(notificationsRegion()).findByRole("listitem");
    expect(within(item).getByText("Moved to the trash")).toBeInTheDocument();
    const undo = screen.getByRole("button", { name: "Undo" });
    expect(drawer).toContainElement(undo);

    act(() => undo.focus());
    expect(undo).toHaveFocus();
  });

  it("F8 moves focus to the toast region and the drawer's focus trap doesn't pull it back", async () => {
    renderApp();
    await openDrawer();
    raiseUndoToast();
    await screen.findByRole("button", { name: "Undo" });

    fireEvent.keyDown(document, { key: "F8", code: "F8" });
    const viewportList = within(notificationsRegion()).getByRole("list");
    expect(viewportList).toHaveFocus();
  });

  it("a toast present before opening the drawer moves into it (state kept, still a single toast)", async () => {
    renderApp();
    raiseUndoToast();
    await screen.findByRole("button", { name: "Undo" });

    const drawer = await openDrawer();
    const region = notificationsRegion();
    expect(drawer).toContainElement(region);
    expect(within(region).getAllByRole("listitem")).toHaveLength(1);
    expect(within(region).getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("clicking the toast and Undo doesn't close the drawer; Undo is still called and closes the toast", async () => {
    const onUndo = vi.fn();
    renderApp();
    await openDrawer();
    raiseUndoToast(onUndo);

    const item = await within(notificationsRegion()).findByRole("listitem");
    fireEvent.pointerDown(item, { button: 0 });
    fireEvent.click(item);
    const undo = within(item).getByRole("button", { name: "Undo" });
    fireEvent.pointerDown(undo, { button: 0 });
    fireEvent.click(undo);

    expect(onUndo).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText("Moved to the trash")).toBeNull());
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBeInTheDocument();
  });

  it("drawer closes (navigating via a note in the drawer) -> the Notifications region returns to its original place, the toast remains and is found by role", async () => {
    renderApp();
    const drawer = await openDrawer();
    raiseUndoToast();
    await within(drawer).findByRole("button", { name: "Undo" });

    fireEvent.click(await within(drawer).findByRole("link", { name: "Drawer Note" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument());

    const region = notificationsRegion();
    expect(region.closest("[data-sidebar-drawer]")).toBeNull();
    expect(hasAriaHiddenAncestor(region)).toBe(false);
    expect(within(region).getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });
});

describe("AppShell - drawer container draws no focus ring", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opening the drawer with the sidebar button focuses Content itself, which has outline-none", async () => {
    renderApp();
    const drawer = await openDrawer();
    expect(drawer).toHaveClass("outline-none");
    expect(document.activeElement).toBe(drawer);
  });
});

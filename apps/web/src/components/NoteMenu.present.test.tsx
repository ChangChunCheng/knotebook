import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import type { CollabState } from "@/collab/connection";
import type { NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { NotePageControlsContext } from "@/lib/note-page-controls";
import { SidebarDrawerContext } from "@/lib/sidebar-drawer";
import { OWNER_PERMS, VIEWER_PERMS } from "@/test/fixtures";
import { installFakeFullscreen, type FakeFullscreen } from "@/test/fake-fullscreen";
import { NoteMenu, SidebarNoteMenu } from "./NoteMenu";

const nav = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("react-router", async (importOriginal) => {
  const mod = await importOriginal<typeof import("react-router")>();
  return {
    ...mod,
    useNavigate: () => {
      const real = mod.useNavigate();
      return ((...args: Parameters<typeof real>) => {
        nav.fn(...args);
        return real(...args);
      }) as typeof real;
    },
  };
});

const NOTE: NoteDto = {
  id: "11111111-1111-1111-1111-111111111111", title: "My Note", ownerId: "u1", role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", slug: "my-note", slugIsCustom: true,
  prevSlug: null, ownerHandle: "tester", lastEdited: null, group: null, groupId: null, folderId: null, permissions: OWNER_PERMS,
};
/** Another note in the sidebar with viewer permission: this also covers the sidebar more menu for a viewer. */
const OTHER: NoteDto = { ...NOTE, id: "22222222-2222-2222-2222-222222222222", title: "Other", slug: "other", role: "viewer", permissions: VIEWER_PERMS };
const VIEWER_NOTE: NoteDto = { ...NOTE, role: "viewer", permissions: VIEWER_PERMS };
const CONNECTED: CollabState = { phase: "connected", role: "owner" };

function Probe() {
  const location = useLocation();
  return <div data-testid="loc">{`${location.pathname}${location.search}${location.hash}|${JSON.stringify(location.state ?? null)}`}</div>;
}

function renderWith(element: ReactNode, entry = "/notes/my-note#/old") {
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("unexpected fetch"))));
  const setOpen = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SidebarDrawerContext.Provider value={{ setOpen }}>
        <MemoryRouter initialEntries={[{ pathname: entry.split("#")[0], hash: entry.includes("#") ? `#${entry.split("#")[1]}` : "", state: { openEdits: false } }]}>
          <Probe />
          <Routes>
            <Route path="/notes/:ref" element={element} />
            <Route path="/n/:handle/:slug" element={<div>other page</div>} />
          </Routes>
        </MemoryRouter>
      </SidebarDrawerContext.Provider>
    </QueryClientProvider>,
  );
  return { setOpen };
}

async function choosePresent(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0 });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Present" }));
}

describe("more menu - Presentation mode", () => {
  let fake: FakeFullscreen | null = null;
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    nav.fn.mockClear();
    fake = installFakeFullscreen();
  });
  afterEach(async () => {
    await fake?.uninstall();
    fake = null;
    vi.unstubAllGlobals();
  });

  it("header: current pathname + ?present, hash cleared, push, state has only the flag; requestFullscreen happens before navigate", async () => {
    renderWith(<NoteMenu note={NOTE} state={CONNECTED} leavingRef={{ current: false }} onOpenEdits={() => {}} />);
    await choosePresent(screen.getByRole("button", { name: "More" }));
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe('/notes/my-note?present|{"knotebookPresentPushed":true}'));
    expect(nav.fn).toHaveBeenCalledWith({ pathname: "/notes/my-note", search: "?present", hash: "" }, { state: { knotebookPresentPushed: true } });
    expect(fake!.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(fake!.requestFullscreen.mock.invocationCallOrder[0]).toBeLessThan(nav.fn.mock.invocationCallOrder[0]);
  });

  it("the menu item comes after Copy link (default position) and has a Presentation icon", async () => {
    renderWith(<NoteMenu note={NOTE} state={CONNECTED} leavingRef={{ current: false }} onOpenEdits={() => {}} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "More" }), { button: 0 });
    const items = (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
    expect(items.indexOf("Present")).toBe(items.indexOf("Copy link") + 1);
    expect(screen.getByRole("menuitem", { name: "Present" }).querySelector('[data-icon="presentation"]')).not.toBeNull();
  });

  it("viewer role also has Presentation mode and can enter it", async () => {
    renderWith(<NoteMenu note={VIEWER_NOTE} state={{ phase: "connected", role: "viewer" }} leavingRef={{ current: false }} onOpenEdits={() => {}} />);
    await choosePresent(screen.getByRole("button", { name: "More" }));
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toMatch(/^\/notes\/my-note\?present\|/));
  });

  it("sidebar, the open note: same as the header (flag), the drawer is closed first", async () => {
    const leavingRef = { current: false };
    const { setOpen } = renderWith(
      <NotePageControlsContext.Provider value={{ noteId: NOTE.id, state: CONNECTED, leavingRef, openEdits: () => {} }}>
        <SidebarNoteMenu note={NOTE} />
      </NotePageControlsContext.Provider>,
    );
    await choosePresent(screen.getByRole("button", { name: "Note actions for My Note" }));
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe('/notes/my-note?present|{"knotebookPresentPushed":true}'));
    expect(setOpen).toHaveBeenCalledWith(false);
  });

  it("sidebar, another note (viewer): that note's canonical + ?present, push, no flag; the drawer is closed first", async () => {
    const { setOpen } = renderWith(
      <NotePageControlsContext.Provider value={{ noteId: NOTE.id, state: CONNECTED, leavingRef: { current: false }, openEdits: () => {} }}>
        <SidebarNoteMenu note={OTHER} />
      </NotePageControlsContext.Provider>,
    );
    await choosePresent(screen.getByRole("button", { name: "Note actions for Other" }));
    await waitFor(() => expect(screen.getByText("other page")).toBeInTheDocument());
    expect(nav.fn).toHaveBeenCalledWith({ pathname: "/n/tester/other", search: "?present" });
    expect(setOpen).toHaveBeenCalledWith(false);
    expect(within(document.body).getByTestId("loc").textContent).toBe("/n/tester/other?present|null");
    // Close the drawer -> request fullscreen -> navigate (all three in the synchronous part of one gesture, in a fixed order)
    const closeDrawerAt = setOpen.mock.invocationCallOrder[0];
    const fullscreenAt = fake!.requestFullscreen.mock.invocationCallOrder[0];
    const navigateAt = nav.fn.mock.invocationCallOrder[0];
    expect(fake!.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(closeDrawerAt).toBeLessThan(fullscreenAt);
    expect(fullscreenAt).toBeLessThan(navigateAt);
  });

  it("ordinary menu close (Esc, Presentation mode not chosen): focus returns to the more menu trigger as usual (onCloseAutoFocus is only blocked on the path into presentation)", async () => {
    renderWith(<NoteMenu note={NOTE} state={CONNECTED} leavingRef={{ current: false }} onOpenEdits={() => {}} />);
    const trigger = screen.getByRole("button", { name: "More" });
    fireEvent.pointerDown(trigger, { button: 0 });
    const menu = await screen.findByRole("menu");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

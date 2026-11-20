import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { FolderDto, GroupDto, NoteDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { SidebarTabProvider, type SidebarTab } from "@/lib/sidebar-tab";
import { SidebarTabList } from "@/components/sidebar/SidebarTabList";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { __resetCollapseForTests, setCollapsed } from "@/components/sidebar/collapse";
import { __resetFolderSortForTests } from "@/components/sidebar/folder-sort";
import { __resetDragSessionForTests, getDragSource, useDragView } from "@/components/sidebar/drag-session";
import { DRAG_HOVER_DELAY_MS, DRAG_NOTE_MIME } from "@/components/sidebar/drag-zone";
import { DROP_SCOPE_CLASS } from "@/components/sidebar/useSidebarDrag";
import { groupDto, memberRole } from "@/test/fixtures";
import { folderChain, folderDto, groupFolder } from "@/test/folder-fixtures";
import { groupNote, personalNote, sharedNote } from "@/test/select-fixtures";
import { createFakeDataTransfer, mockFinePointer, type FakeDataTransfer } from "@/test/drag-fixtures";
import { NoteList } from "./NoteList";

/**
 * Fixture (a subset of `sidebar/drag-zone.test.ts`): personal F contains F1; root A; N1, N2 inside F; group G has GF, root g1, g2 inside GF, read-only gr; group H has HF, h1.
 * Timing: rendering and waiting for the tree use real timers; setTimeout/clearTimeout are faked only for the dwell segment.
 */

afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
  __resetFolderSortForTests();
  __resetDragSessionForTests();
  vi.useRealTimers();
});

const G: GroupDto = groupDto({ id: "G", name: "G" }, memberRole());
const H: GroupDto = groupDto({ id: "H", name: "H" }, memberRole());

const FOLDERS: FolderDto[] = [
  folderDto({ id: "F", name: "F" }),
  folderDto({ id: "F1", name: "F1", parentId: "F" }),
  groupFolder({ id: "GF", name: "GF", groupId: "G" }),
  groupFolder({ id: "HF", name: "HF", groupId: "H" }),
];

const NOTES: NoteDto[] = [
  personalNote({ id: "A", title: "A" }),
  personalNote({ id: "N1", title: "N1", folderId: "F" }),
  personalNote({ id: "N2", title: "N2", folderId: "F" }),
  groupNote({ id: "g1", title: "g1", group: G }),
  groupNote({ id: "g2", title: "g2", group: G, folderId: "GF" }),
  groupNote({ id: "gr", title: "gr", group: G, edit: false }),
  groupNote({ id: "h1", title: "h1", group: H }),
];

const ME: UserDto = { id: "u1", email: "me@example.com", handle: "tester", displayName: "Me", isAdmin: false, mustChangePassword: false, hasPassword: true, autoVersions: true, avatar: null };

type Reply = { status: number; body: unknown };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Fake server: GET answers as usual; writes (`PUT /api/notes/:id/folder`, `POST /api/folders`, `PATCH /api/folders/:id`) are held and answered in order by `respond()`
 * (default success = update the server-side data then return it, so the following refetch sees the new position; a folder created by POST always has id "NEW").
 * `extra` adds notes and folders for individual cases.
 */
function stubServer(extra: { notes?: NoteDto[]; folders?: FolderDto[] } = {}) {
  const notes = [...NOTES, ...(extra.notes ?? [])].map((note) => ({ ...note }));
  const folders = [...FOLDERS, ...(extra.folders ?? [])].map((folder) => ({ ...folder }));
  const puts: { url: string; body: unknown }[] = [];
  const writes: { method: string; url: string; body: unknown }[] = [];
  const pending: ((reply?: Reply) => void)[] = [];
  const hold = (succeed: () => Response) =>
    new Promise<Response>((resolve) => {
      pending.push((reply) => resolve(reply !== undefined ? json(reply.body, reply.status) : succeed()));
    });
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/folders" && method === "GET") return Promise.resolve(json({ folders }));
    if (url === "/api/notes" && method === "GET") return Promise.resolve(json(notes));
    if (url === "/api/groups" && method === "GET") return Promise.resolve(json([G, H]));
    if (url === "/api/auth/me" && method === "GET") return Promise.resolve(json(ME));
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (method !== "GET") writes.push({ method, url, body });
    const match = /^\/api\/notes\/([^/]+)\/folder$/.exec(url);
    if (match !== null && method === "PUT") {
      const { folderId } = body as { folderId: string | null };
      puts.push({ url, body });
      return hold(() => {
        const index = notes.findIndex((note) => note.id === match[1]);
        notes[index] = { ...notes[index]!, folderId };
        return json(notes[index]);
      });
    }
    if (url === "/api/folders" && method === "POST") {
      const input = body as { name: string; parentId?: string; space?: FolderDto["space"] };
      return hold(() => {
        const parent = input.parentId === undefined ? undefined : folders.find((folder) => folder.id === input.parentId);
        const created = folderDto({ id: "NEW", name: input.name, parentId: input.parentId ?? null, space: parent?.space ?? input.space });
        folders.push(created);
        return json(created, 201);
      });
    }
    const folderMatch = /^\/api\/folders\/([^/]+)$/.exec(url);
    if (folderMatch !== null && method === "PATCH") {
      return hold(() => {
        const index = folders.findIndex((folder) => folder.id === folderMatch[1]);
        folders[index] = { ...folders[index]!, name: (body as { name: string }).name };
        return json(folders[index]);
      });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    puts,
    writes,
    /** Server-side notes and folders (a case can change them directly; the next refetch sees it). */
    notes,
    folders,
    respond: async (reply?: Reply) => {
      await waitFor(() => expect(pending.length).toBeGreaterThan(0));
      const next = pending.shift()!;
      await act(async () => {
        next(reply);
      });
    },
  };
}

function DragProbe() {
  const { active } = useDragView();
  return <span data-testid="drag-active">{String(active)}</span>;
}

/** Render skeleton = `renderNoteList` of `NoteList.test.tsx`, plus `<Toaster />` and a probe reading the drag state. */
function renderNoteList(opts: { tab?: SidebarTab } = {}) {
  if (opts.tab) localStorage.setItem("sidebar.tab", opts.tab);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ActiveNoteProvider>
          <SidebarTabProvider>
            <SidebarTabList idBase="t" />
            <div role="tabpanel">
              <NoteList />
            </div>
            <DragProbe />
          </SidebarTabProvider>
        </ActiveNoteProvider>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
  return { queryClient, unmount: view.unmount };
}

const panel = () => screen.getByRole("tabpanel");
const list = () => panel().querySelector("[data-sidebar-list]") as HTMLElement;
const nodeOf = (kind: "note" | "folder" | "group", id: string) =>
  panel().querySelector(`[data-node-kind="${kind}"][data-node-id="${id}"]`) as HTMLElement | null;
const noteLink = (id: string) => nodeOf("note", id)!.querySelector("a") as HTMLElement;
const rowOf = (kind: "folder" | "group", id: string) => nodeOf(kind, id)!.firstElementChild as HTMLElement;
const childIds = (kind: "folder" | "group", id: string) =>
  Array.from(nodeOf(kind, id)?.querySelector(":scope > div > ul")?.children ?? []).map((li) => li.getAttribute("data-node-id"));
const topIds = () => Array.from(list().firstElementChild?.querySelector(":scope > ul")?.children ?? []).map((li) => li.getAttribute("data-node-id"));
const scoped = () => Array.from(panel().querySelectorAll("[data-drop-scope]"));
const dropScopeTokens = DROP_SCOPE_CLASS.split(" ");

async function waitForTree(id = "F") {
  await waitFor(() => expect(nodeOf(id === "G" ? "group" : "folder", id)).not.toBeNull());
}

function startDrag(id: string, el: HTMLElement = noteLink(id)): FakeDataTransfer {
  const dt = createFakeDataTransfer(["text/uri-list", "text/plain"]);
  fireEvent.dragStart(el, { dataTransfer: dt });
  return dt;
}

describe("NoteList drag", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    mockFinePointer(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());
  });

  it("not a fine pointer -> dragStart doesn't take over (no custom type written); a later dragOver on F isn't handled", async () => {
    mockFinePointer(false);
    stubServer();
    renderNoteList();
    await waitForTree();

    const dt = startDrag("A");

    expect(dt.setData).not.toHaveBeenCalledWith(DRAG_NOTE_MIME, expect.anything());
    expect(fireEvent.dragOver(rowOf("folder", "F"), { dataTransfer: dt })).toBe(true);
    expect(scoped()).toHaveLength(0);
  });

  it("takeover: setData(DRAG_NOTE_MIME, 'A') once, no clearData, effectAllowed 'all'", async () => {
    stubServer();
    renderNoteList();
    await waitForTree();

    const dt = startDrag("A");

    expect(dt.setData).toHaveBeenCalledTimes(1);
    expect(dt.setData).toHaveBeenCalledWith(DRAG_NOTE_MIME, "A");
    expect(dt.clearData).not.toHaveBeenCalled();
    expect(dt.effectAllowed).toBe("all");
    expect(dt.types).toEqual(["text/uri-list", "text/plain", DRAG_NOTE_MIME]);
  });

  it("dragOver on the F row -> handled, dropEffect move, F's <li> marked; back to blank root (original place) -> not handled, nothing in the whole tree marked", async () => {
    stubServer();
    renderNoteList();
    await waitForTree();
    const dt = startDrag("A");

    expect(fireEvent.dragOver(rowOf("folder", "F"), { dataTransfer: dt })).toBe(false);
    expect(dt.dropEffect).toBe("move");
    expect(scoped()).toEqual([nodeOf("folder", "F")]);
    expect(nodeOf("folder", "F")).toHaveClass(...dropScopeTokens);

    expect(fireEvent.dragOver(list(), { dataTransfer: dt })).toBe(true);
    expect(scoped()).toHaveLength(0);
  });

  it("drop on F: the mark disappears at once; PUT {folderId:F}; before the response A is already in F (optimistic); after the response the Moved-to-F toast has Undo", async () => {
    const server = stubServer();
    renderNoteList();
    await waitForTree();
    const dt = startDrag("A");
    fireEvent.dragOver(rowOf("folder", "F"), { dataTransfer: dt });

    fireEvent.drop(rowOf("folder", "F"), { dataTransfer: dt });

    expect(scoped()).toHaveLength(0);
    await waitFor(() => expect(server.puts).toEqual([{ url: "/api/notes/A/folder", body: { folderId: "F" } }]));
    await waitFor(() => expect(childIds("folder", "F")).toContain("A"));
    expect(topIds()).not.toContain("A");
    expect(screen.queryByText("Moved to “F”", { exact: true })).toBeNull();

    await server.respond();

    expect(await screen.findByText("Moved to “F”", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("drop on F, PUT 403 forbidden -> A back at root (rolled back), error toast is errors.forbidden", async () => {
    const server = stubServer();
    renderNoteList();
    await waitForTree();
    const dt = startDrag("A");
    fireEvent.dragOver(rowOf("folder", "F"), { dataTransfer: dt });
    fireEvent.drop(rowOf("folder", "F"), { dataTransfer: dt });
    await waitFor(() => expect(childIds("folder", "F")).toContain("A"));

    await server.respond({ status: 403, body: { error: { code: "forbidden", message: "x" } } });

    expect(await screen.findByText("You don't have permission to do that.", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(topIds()).toContain("A"));
    expect(childIds("folder", "F")).not.toContain("A");
  });

  it("N1 (in F) dropped on blank list space -> body {folderId:null}, the Moved-to-Top-level toast; Undo -> put back in F", async () => {
    const server = stubServer();
    renderNoteList();
    await waitForTree();
    const dt = startDrag("N1");
    expect(fireEvent.dragOver(list(), { dataTransfer: dt })).toBe(false);
    expect(scoped()).toEqual([list().firstElementChild]);

    fireEvent.drop(list(), { dataTransfer: dt });
    await waitFor(() => expect(server.puts).toEqual([{ url: "/api/notes/N1/folder", body: { folderId: null } }]));
    await server.respond();

    expect(await screen.findByText("Moved to “Top level”", { exact: true })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(server.puts).toHaveLength(2));
    expect(server.puts[1]).toEqual({ url: "/api/notes/N1/folder", body: { folderId: "F" } });
    await server.respond();
  });

  it("drop at the original place (never accepted) -> drop is preventDefault-ed, no request", async () => {
    const server = stubServer();
    renderNoteList();
    await waitForTree();
    const dt = startDrag("A");
    fireEvent.dragOver(list(), { dataTransfer: dt });
    const calls = server.fetchMock.mock.calls.length;

    expect(fireEvent.drop(list(), { dataTransfer: dt })).toBe(false);
    await act(async () => {});

    expect(server.fetchMock.mock.calls.length).toBe(calls);
    expect(server.puts).toHaveLength(0);
  });

  it("dragEnd after dragOver on F -> no mark; another round dropped without dragEnd -> no mark, drag state ended", async () => {
    const server = stubServer();
    renderNoteList();
    await waitForTree();
    const first = startDrag("A");
    fireEvent.dragOver(rowOf("folder", "F"), { dataTransfer: first });
    expect(scoped()).toHaveLength(1);
    fireEvent.dragEnd(noteLink("A"), { dataTransfer: first });
    expect(scoped()).toHaveLength(0);
    expect(screen.getByTestId("drag-active")).toHaveTextContent("false");

    const second = startDrag("A");
    expect(screen.getByTestId("drag-active")).toHaveTextContent("true");
    fireEvent.dragOver(rowOf("folder", "F"), { dataTransfer: second });
    fireEvent.drop(rowOf("folder", "F"), { dataTransfer: second });

    expect(scoped()).toHaveLength(0);
    expect(screen.getByTestId("drag-active")).toHaveTextContent("false");
    await waitFor(() => expect(server.puts).toHaveLength(1));
    await server.respond();
  });

  it("spring: dwelling 0.5 s on a collapsed F -> expands (F1 appears); stays expanded after dragEnd, localStorage has no collapse key", async () => {
    setCollapsed("folder:F", true);
    stubServer();
    renderNoteList();
    await waitForTree();
    expect(nodeOf("folder", "F1")).toBeNull();
    const dt = startDrag("A");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.dragOver(rowOf("folder", "F"), { dataTransfer: dt });
    act(() => vi.advanceTimersByTime(DRAG_HOVER_DELAY_MS));
    expect(nodeOf("folder", "F1")).not.toBeNull();
    vi.useRealTimers();

    fireEvent.dragEnd(noteLink("A"), { dataTransfer: dt });
    expect(nodeOf("folder", "F1")).not.toBeNull();
    expect(localStorage.getItem("sidebar.collapsed.folder:F")).toBeNull();
  });

  it("selection mode -> dragStart doesn't take over", async () => {
    stubServer();
    renderNoteList();
    await waitForTree();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    await screen.findByRole("button", { name: "Done" });

    const dt = startDrag("A", nodeOf("note", "A")!);

    expect(dt.setData).not.toHaveBeenCalledWith(DRAG_NOTE_MIME, expect.anything());
    expect(screen.getByTestId("drag-active")).toHaveTextContent("false");
  });

  it("Recent tab -> dragStart doesn't take over", async () => {
    stubServer();
    renderNoteList({ tab: "recent" });
    await waitFor(() => expect(nodeOf("note", "A")).not.toBeNull());

    const dt = startDrag("A");

    expect(dt.setData).not.toHaveBeenCalledWith(DRAG_NOTE_MIME, expect.anything());
    expect(screen.getByTestId("drag-active")).toHaveTextContent("false");
  });

  it("Groups tab: g2 dragged onto the H group row -> not handled, H not marked; dragged to blank space at the bottom of the list -> G marked; drop -> body {folderId:null}", async () => {
    const server = stubServer();
    renderNoteList({ tab: "workspace" });
    await waitForTree("G");
    const dt = startDrag("g2");

    expect(fireEvent.dragOver(rowOf("group", "H"), { dataTransfer: dt })).toBe(true);
    expect(scoped()).toHaveLength(0);

    expect(fireEvent.dragOver(list(), { dataTransfer: dt })).toBe(false);
    expect(scoped()).toEqual([nodeOf("group", "G")]);
    expect(nodeOf("group", "G")).toHaveClass(...dropScopeTokens);

    fireEvent.drop(list(), { dataTransfer: dt });
    await waitFor(() => expect(server.puts).toEqual([{ url: "/api/notes/g2/folder", body: { folderId: null } }]));
    await server.respond();
  });

  it("Groups tab: read-only gr -> dragStart doesn't take over", async () => {
    stubServer();
    renderNoteList({ tab: "workspace" });
    await waitForTree("G");

    const dt = startDrag("gr");

    expect(dt.setData).not.toHaveBeenCalledWith(DRAG_NOTE_MIME, expect.anything());
    expect(screen.getByTestId("drag-active")).toHaveTextContent("false");
  });

  it("after takeover the pointer moves outside the container (dragover on document.body) -> the mark disappears", async () => {
    stubServer();
    renderNoteList();
    await waitForTree();
    const dt = startDrag("A");
    fireEvent.dragOver(rowOf("folder", "F"), { dataTransfer: dt });
    expect(scoped()).toHaveLength(1);

    fireEvent.dragOver(document.body, { dataTransfer: dt });

    expect(scoped()).toHaveLength(0);
  });

  it("with a source already present, another drag without the custom type (Files) dragOver on F -> not handled, F not marked", async () => {
    stubServer();
    renderNoteList();
    await waitForTree();
    startDrag("A");

    const files = createFakeDataTransfer(["Files"]);

    expect(fireEvent.dragOver(rowOf("folder", "F"), { dataTransfer: files })).toBe(true);
    expect(scoped()).toHaveLength(0);
  });

  it("F collapsed, dropping on the F row without dwelling -> before the PUT response F is already expanded and A is visible under it", async () => {
    setCollapsed("folder:F", true);
    const server = stubServer();
    renderNoteList();
    await waitForTree();
    const dt = startDrag("A");
    fireEvent.dragOver(rowOf("folder", "F"), { dataTransfer: dt });

    fireEvent.drop(rowOf("folder", "F"), { dataTransfer: dt });
    await waitFor(() => expect(server.puts).toHaveLength(1));

    await waitFor(() => expect(childIds("folder", "F")).toContain("A"));
    expect(nodeOf("note", "A")).not.toBeNull();
    await server.respond();
  });

  it("the NoteList that started the drag unmounts mid-drag -> drag state ends, the document dragover listener is removed", async () => {
    stubServer();
    const { unmount } = renderNoteList();
    await waitForTree();
    startDrag("A");
    expect(getDragSource()).not.toBeNull();
    const removeSpy = vi.spyOn(document, "removeEventListener");

    unmount();

    expect(getDragSource()).toBeNull();
    expect(removeSpy).toHaveBeenCalledWith("dragover", expect.any(Function), true);
    removeSpy.mockRestore();
  });
});

const previewOf = (root: HTMLElement = panel()) => root.querySelector<HTMLElement>('[data-node-kind="preview"]');

/** dragOver once on B's link and dwell the full 0.5 s (fake setTimeout/clearTimeout only in this segment). */
function holdOver(el: HTMLElement, dt: FakeDataTransfer) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fireEvent.dragOver(el, { dataTransfer: dt });
  act(() => vi.advanceTimersByTime(DRAG_HOVER_DELAY_MS));
  vi.useRealTimers();
}

/**
 * Two NoteLists side by side (static card and drawer, each wrapped in `[data-sidebar-instance]`, as in AppShell) sharing one SidebarTabProvider;
 * `hideDrawer()` unmounts only the second.
 */
function renderTwoInstances() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (drawer: boolean) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ActiveNoteProvider>
          <SidebarTabProvider>
            <div data-sidebar-instance="" data-testid="static">
              <NoteList />
            </div>
            {drawer && (
              <div data-sidebar-instance="" data-testid="drawer">
                <NoteList />
              </div>
            )}
          </SidebarTabProvider>
        </ActiveNoteProvider>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>
  );
  const view = render(ui(true));
  const inst = (name: "static" | "drawer") => screen.getByTestId(name);
  const node = (name: "static" | "drawer", kind: "note" | "folder", id: string) =>
    inst(name).querySelector<HTMLElement>(`[data-node-kind="${kind}"][data-node-id="${id}"]`);
  return { inst, node, hideDrawer: () => view.rerender(ui(false)) };
}

describe("NoteList stack into folder", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    mockFinePointer(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());
  });

  it("A dragged over the N2 row once and dwelling 0.5 s -> the N2 row becomes a preview (New folder, N2, A), with data-drop-scope and no data-node-kind inside", async () => {
    stubServer();
    renderNoteList();
    await waitForTree();
    const dt = startDrag("A");

    holdOver(noteLink("N2"), dt);

    const preview = previewOf();
    expect(preview).not.toBeNull();
    expect(nodeOf("note", "N2")).toBeNull();
    expect(childIds("folder", "F")).toContain(null);
    expect(preview).toHaveAttribute("data-drop-scope", "");
    expect(preview).toHaveClass(...dropScopeTokens);
    expect(preview).not.toHaveAttribute("aria-busy");
    expect(within(preview!).getByText("New folder", { exact: true })).toBeInTheDocument();
    expect(within(preview!).getByText("N2", { exact: true })).toBeInTheDocument();
    expect(within(preview!).getByText("A", { exact: true })).toBeInTheDocument();
    expect(preview!.querySelectorAll("[data-node-kind]")).toHaveLength(0);
  });

  it("after the preview appears, dragOver on the R row twice -> preview gone, N2 row back; no POST /api/folders throughout", async () => {
    const server = stubServer({ notes: [personalNote({ id: "R", title: "R" })] });
    renderNoteList();
    await waitForTree();
    const dt = startDrag("A");
    holdOver(noteLink("N2"), dt);
    expect(previewOf()).not.toBeNull();

    fireEvent.dragOver(noteLink("R"), { dataTransfer: dt });
    fireEvent.dragOver(noteLink("R"), { dataTransfer: dt });
    await act(async () => {});

    expect(previewOf()).toBeNull();
    expect(nodeOf("note", "N2")).not.toBeNull();
    expect(server.writes).toEqual([]);
  });

  it("dragOver on N2 then drop before the dwell completes -> placed into F by the zone (PUT A {folderId:F}), no POST /api/folders", async () => {
    const server = stubServer();
    renderNoteList();
    await waitForTree();
    const dt = startDrag("A");
    fireEvent.dragOver(noteLink("N2"), { dataTransfer: dt });

    fireEvent.drop(noteLink("N2"), { dataTransfer: dt });

    await waitFor(() => expect(server.writes).toEqual([{ method: "PUT", url: "/api/notes/A/folder", body: { folderId: "F" } }]));
    expect(previewOf()).toBeNull();
    await server.respond();
  });

  it("drop on the preview -> while creating (aria-busy) neither instance takes over dragStart; after three requests complete -> rename box (New folder fully selected), no success toast; Save -> the Created-New-folder-with-2-notes toast, focus back to the new folder row", async () => {
    const server = stubServer();
    const { inst, node } = renderTwoInstances();
    await waitFor(() => expect(node("static", "folder", "F")).not.toBeNull());
    const link = (name: "static" | "drawer", id: string) => node(name, "note", id)!.querySelector("a") as HTMLElement;
    const dt = createFakeDataTransfer(["text/uri-list", "text/plain"]);
    fireEvent.dragStart(link("static", "A"), { dataTransfer: dt });
    holdOver(link("static", "N2"), dt);
    const preview = previewOf(inst("static"))!;
    expect(preview).not.toBeNull();

    fireEvent.dragOver(preview, { dataTransfer: dt });
    fireEvent.drop(preview, { dataTransfer: dt });

    expect(previewOf(inst("static"))).toHaveAttribute("aria-busy", "true");
    expect(previewOf(inst("static"))).not.toHaveAttribute("data-drop-scope");
    await waitFor(() => expect(server.writes).toEqual([{ method: "POST", url: "/api/folders", body: { name: "New folder", parentId: "F" } }]));
    for (const name of ["static", "drawer"] as const) {
      const other = createFakeDataTransfer(["text/uri-list", "text/plain"]);
      fireEvent.dragStart(link(name, "N1"), { dataTransfer: other });
      expect(other.setData, name).not.toHaveBeenCalledWith(DRAG_NOTE_MIME, expect.anything());
      expect(getDragSource(), name).toBeNull();
    }

    await server.respond();
    await server.respond();
    await server.respond();
    expect(server.writes.slice(1)).toEqual([
      { method: "PUT", url: "/api/notes/N2/folder", body: { folderId: "NEW" } },
      { method: "PUT", url: "/api/notes/A/folder", body: { folderId: "NEW" } },
    ]);

    const dialog = await screen.findByRole("dialog", { name: "Rename folder" });
    const field = within(dialog).getByRole("textbox", { name: "Folder name" }) as HTMLInputElement;
    expect(field).toHaveValue("New folder");
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, "New folder".length]);
    expect(previewOf(inst("static"))).toBeNull();
    expect(screen.queryByText(/Created/)).toBeNull();

    // Press Save with the default name: no PATCH is sent, the success toast still appears after the box closes.
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Created “New folder” with 2 notes", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(server.writes.map((write) => write.method)).toEqual(["POST", "PUT", "PUT"]);
    await waitFor(() => expect(node("static", "folder", "NEW")!.querySelector("button[aria-expanded]")).toHaveFocus());
  });

  it("stacking started from the drawer copy and the drawer is closed (unmounted) before the POST returns -> after three requests complete there is no rename box, the Created-New-folder-with-2-notes toast appears directly, with Undo", async () => {
    const server = stubServer();
    const { inst, node, hideDrawer } = renderTwoInstances();
    await waitFor(() => expect(node("drawer", "folder", "F")).not.toBeNull());
    const link = (id: string) => node("drawer", "note", id)!.querySelector("a") as HTMLElement;
    const dt = createFakeDataTransfer(["text/uri-list", "text/plain"]);
    fireEvent.dragStart(link("A"), { dataTransfer: dt });
    holdOver(link("N2"), dt);
    const preview = previewOf(inst("drawer"))!;
    fireEvent.dragOver(preview, { dataTransfer: dt });
    fireEvent.drop(preview, { dataTransfer: dt });
    await waitFor(() => expect(server.writes).toEqual([{ method: "POST", url: "/api/folders", body: { name: "New folder", parentId: "F" } }]));

    hideDrawer();
    await server.respond();
    await server.respond();
    await server.respond();

    expect(await screen.findByText("Created “New folder” with 2 notes", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(previewOf(inst("static"))).toBeNull();
  });

  it("two instances: unmounting the drawer copy while the static card started the drag -> the drag continues as usual", async () => {
    stubServer();
    const { node, hideDrawer } = renderTwoInstances();
    await waitFor(() => expect(node("drawer", "folder", "F")).not.toBeNull());
    const dt = createFakeDataTransfer(["text/uri-list", "text/plain"]);
    fireEvent.dragStart(node("static", "note", "A")!.querySelector("a")!, { dataTransfer: dt });
    const source = getDragSource();
    expect(source).not.toBeNull();

    hideDrawer();

    expect(getDragSource()).toBe(source);
    expect(fireEvent.dragOver(node("static", "folder", "F")!.firstElementChild!, { dataTransfer: dt })).toBe(false);
  });

  /**
   * After the dwell timer has started (fake setTimeout), refetch `keys`, advance only to just before 0.5 s and wait until `landed()` holds (react-query notifications go through the faked setTimeout),
   * then push past 0.5 s so the old timer fires. Call after a dragOver on B.
   */
  async function refetchDuringHold(queryClient: QueryClient, keys: string[][], landed: () => boolean) {
    await act(async () => {
      for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
    });
    for (let i = 0; i < 40 && !landed(); i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
    }
    expect(landed()).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAG_HOVER_DELAY_MS);
    });
    vi.useRealTimers();
  }

  it("refetch during the dwell, B is no longer at its original level (N2 moved to root) -> when the timer fires it re-decides with the current tree, no preview", async () => {
    const server = stubServer();
    const { queryClient } = renderNoteList();
    await waitForTree();
    const dt = startDrag("A");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.dragOver(noteLink("N2"), { dataTransfer: dt });

    const index = server.notes.findIndex((note) => note.id === "N2");
    server.notes[index] = { ...server.notes[index]!, folderId: null };
    await refetchDuringHold(queryClient, [["notes"]], () => topIds().includes("N2"));

    expect(previewOf()).toBeNull();
    expect(nodeOf("note", "N2")).not.toBeNull();
  });

  it("refetch during the dwell, B became read-only (group g2 lost edit rights) -> no preview", async () => {
    const server = stubServer();
    const { queryClient } = renderNoteList({ tab: "workspace" });
    await waitForTree("G");
    const dt = startDrag("g1");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.dragOver(noteLink("g2"), { dataTransfer: dt });

    const index = server.notes.findIndex((note) => note.id === "g2");
    server.notes[index] = groupNote({ id: "g2", title: "g2", group: G, folderId: "GF", edit: false });
    await refetchDuringHold(queryClient, [["notes"]], () =>
      queryClient.getQueryData<NoteDto[]>(["notes"])?.find((note) => note.id === "g2")?.permissions.edit === false,
    );

    expect(previewOf()).toBeNull();
    expect(nodeOf("note", "g2")).not.toBeNull();
  });

  it("refetch during the dwell, B's F was moved under level 4 (F becomes level 5) -> no preview", async () => {
    const server = stubServer({ folders: folderChain("D", 4) });
    const { queryClient } = renderNoteList();
    await waitForTree();
    const dt = startDrag("A");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.dragOver(noteLink("N2"), { dataTransfer: dt });

    const index = server.folders.findIndex((folder) => folder.id === "F");
    server.folders[index] = { ...server.folders[index]!, parentId: "D4" };
    await refetchDuringHold(queryClient, [["folders"]], () => nodeOf("folder", "D4")?.contains(nodeOf("folder", "F")) === true);

    expect(previewOf()).toBeNull();
    expect(nodeOf("note", "N2")).not.toBeNull();
  });

  it("N2 in a level-5 folder -> no preview after the dwell", async () => {
    const server = stubServer({ folders: folderChain("D", 5), notes: [personalNote({ id: "deep", title: "deep", folderId: "D5" })] });
    renderNoteList();
    await waitFor(() => expect(nodeOf("note", "deep")).not.toBeNull());
    const dt = startDrag("A");

    holdOver(noteLink("deep"), dt);

    expect(previewOf()).toBeNull();
    expect(nodeOf("note", "deep")).not.toBeNull();
    expect(server.writes).toEqual([]);
  });

  it("F already has a 'New folder' under it -> the preview shows 'New folder 2'", async () => {
    stubServer({ folders: [folderDto({ id: "FN", name: "New folder", parentId: "F" })] });
    renderNoteList();
    await waitFor(() => expect(nodeOf("folder", "FN")).not.toBeNull());
    const dt = startDrag("A");

    holdOver(noteLink("N2"), dt);

    expect(within(previewOf()!).getByText("New folder 2", { exact: true })).toBeInTheDocument();
  });

  it("B can't be dropped on -> no preview after the dwell, releasing follows the zone rule (original place, no request): group g1 -> read-only gr", async () => {
    const server = stubServer();
    renderNoteList({ tab: "workspace" });
    await waitForTree("G");
    const dt = startDrag("g1");

    holdOver(noteLink("gr"), dt);
    expect(previewOf()).toBeNull();
    fireEvent.drop(noteLink("gr"), { dataTransfer: dt });
    await act(async () => {});

    expect(server.writes).toEqual([]);
  });

  it("B can't be dropped on: shared-with-me tab s1 -> fallback group note sg (group K isn't one of my groups)", async () => {
    const K = groupDto({ id: "K", name: "K" }, memberRole());
    const server = stubServer({ notes: [sharedNote({ id: "s1", title: "s1", role: "viewer" }), groupNote({ id: "sg", title: "sg", group: K })] });
    renderNoteList({ tab: "shared" });
    await waitFor(() => expect(nodeOf("note", "sg")).not.toBeNull());
    const dt = startDrag("s1");
    expect(dt.setData).toHaveBeenCalledWith(DRAG_NOTE_MIME, "s1");

    holdOver(noteLink("sg"), dt);
    expect(previewOf()).toBeNull();
    fireEvent.drop(noteLink("sg"), { dataTransfer: dt });
    await act(async () => {});

    expect(server.writes).toEqual([]);
  });

  it("dragEnd during the preview -> preview gone, N2 back, no requests", async () => {
    const server = stubServer();
    renderNoteList();
    await waitForTree();
    const dt = startDrag("A");
    holdOver(noteLink("N2"), dt);
    expect(previewOf()).not.toBeNull();

    fireEvent.dragEnd(noteLink("A"), { dataTransfer: dt });
    await act(async () => {});

    expect(previewOf()).toBeNull();
    expect(nodeOf("note", "N2")).not.toBeNull();
    expect(server.writes).toEqual([]);
  });
});

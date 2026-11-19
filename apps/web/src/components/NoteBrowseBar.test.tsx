import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FolderDto, GroupDto, NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { PhoneBrowseContext } from "@/lib/phone-list";
import { adminRole, customRole, groupDto, memberRole, OWNER_PERMS } from "@/test/fixtures";
import { folderDto, groupFolder } from "@/test/folder-fixtures";
import { NoteBrowseBar } from "./NoteBrowseBar";

const data = vi.hoisted(() => ({ folders: [] as unknown[], groups: [] as unknown[] }));
vi.mock("@/api/folders", () => ({ useFolders: () => ({ data: data.folders }) }));
vi.mock("@/api/groups", () => ({ useGroups: () => ({ data: data.groups }) }));

function note(over: Partial<NoteDto> = {}): NoteDto {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Plan",
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slug: "plan",
    slugIsCustom: false,
    prevSlug: null,
    ownerHandle: "alice",
    lastEdited: null,
    group: null,
    groupId: null,
    folderId: null,
    permissions: OWNER_PERMS,
    ...over,
  };
}

function groupNote(groupId: string, over: Partial<NoteDto> = {}): NoteDto {
  return note({ ownerId: null, ownerHandle: null, role: "editor", groupId, group: { id: groupId, name: "Team" }, ...over });
}

describe("NoteBrowseBar", () => {
  const openSearch = vi.fn();
  const createNote = vi.fn<(groupId?: string, folderId?: string) => Promise<void>>(() => Promise.resolve());

  function renderBar(n: NoteDto) {
    return render(
      <PhoneBrowseContext.Provider value={{ openSearch, createNote }}>
        <NoteBrowseBar note={n} />
      </PhoneBrowseContext.Provider>,
    );
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    openSearch.mockClear();
    createNote.mockClear();
    data.folders = [];
    data.groups = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("bottom-left is a 56px round Search button (same as the list screen's), pressing it opens the search layer", () => {
    renderBar(note());
    const search = screen.getByRole("button", { name: "Search notes" });
    expect(search).toHaveClass("h-14", "w-14", "rounded-full", "fixed", "left-[calc(1rem+env(safe-area-inset-left))]", "supports-[backdrop-filter]:backdrop-blur-xs");
    fireEvent.click(search);
    expect(openSearch).toHaveBeenCalledTimes(1);
  });

  it("the two floating buttons take no layout space: outer display: contents, the Home indicator clearance comes from each button's own safe area", () => {
    renderBar(note());
    const bar = screen.getByTestId("note-browse-bar");
    expect(bar).toHaveClass("contents");
    expect(screen.getByRole("button", { name: "New note" })).toHaveClass("right-[calc(1rem+env(safe-area-inset-right))]", "bottom-[calc(1rem+env(safe-area-inset-bottom))]");
  });

  it("search layer open: the whole group isn't rendered; it returns when closed", () => {
    const view = render(
      <PhoneBrowseContext.Provider value={{ openSearch, createNote, searchOpen: true }}>
        <NoteBrowseBar note={note()} />
      </PhoneBrowseContext.Provider>,
    );
    expect(screen.queryByTestId("note-browse-bar")).toBeNull();
    view.rerender(
      <PhoneBrowseContext.Provider value={{ openSearch, createNote, searchOpen: false }}>
        <NoteBrowseBar note={note()} />
      </PhoneBrowseContext.Provider>,
    );
    expect(screen.getByTestId("note-browse-bar")).toBeInTheDocument();
  });

  it("personal root: 'New note' -> createNote() with no arguments", () => {
    renderBar(note());
    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    expect(createNote).toHaveBeenCalledWith(undefined, undefined);
  });

  it("personal folder: createNote(undefined, folderId)", () => {
    data.folders = [folderDto({ id: "f1", name: "Projects" })] as FolderDto[];
    renderBar(note({ folderId: "f1" }));
    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    expect(createNote).toHaveBeenCalledWith(undefined, "f1");
  });

  it("group member: createNote(groupId, folderId)", () => {
    data.groups = [groupDto({ id: "g1", name: "Team" }, memberRole())] as GroupDto[];
    data.folders = [groupFolder({ id: "gf1", name: "Specs", groupId: "g1" })];
    renderBar(groupNote("g1", { folderId: "gf1" }));
    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    expect(createNote).toHaveBeenCalledWith("g1", "gf1");
  });

  it("admin has it too; viewer, a custom role that can create but not edit, and shared-with-me have no 'New note' (Search remains)", () => {
    data.groups = [groupDto({ id: "g1", name: "Team" }, adminRole())] as GroupDto[];
    const { unmount } = renderBar(groupNote("g1"));
    expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
    unmount();

    data.groups = [groupDto({ id: "g1", name: "Readers" }, customRole())] as GroupDto[];
    const second = renderBar(groupNote("g1"));
    expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
    expect(screen.getByRole("button", { name: "Search notes" })).toBeInTheDocument();
    second.unmount();

    data.groups = [];
    renderBar(note({ role: "viewer", ownerId: "u2", ownerHandle: "bob" }));
    expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
    expect(screen.getByRole("button", { name: "Search notes" })).toBeInTheDocument();
  });

  it("while creating: 'New note' is disabled, so a double click can't create two notes", async () => {
    let resolve: () => void = () => {};
    createNote.mockImplementationOnce(() => new Promise<void>((done) => (resolve = done)));
    renderBar(note());
    const button = screen.getByRole("button", { name: "New note" });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(createNote).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
    await waitFor(() => expect(button).not.toBeDisabled());
  });

  describe("on-screen keyboard", () => {
    let viewport: EventTarget & { height: number; offsetTop: number; scale: number };
    let frames: Array<() => void>;

    function setKeyboard(inset: number) {
      viewport.height = 800 - inset;
      act(() => {
        viewport.dispatchEvent(new Event("resize"));
        frames.splice(0).forEach((run) => run());
      });
    }

    beforeEach(() => {
      viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
      vi.stubGlobal("innerHeight", 800);
      frames = [];
      vi.stubGlobal("requestAnimationFrame", (cb: () => void) => frames.push(cb));
      Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true, writable: true });
    });
    afterEach(() => {
      Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true, writable: true });
    });

    it("keyboard open (e.g. while editing the title): this bar is absent; it returns when dismissed", () => {
      renderBar(note());
      expect(screen.getByTestId("note-browse-bar")).toBeInTheDocument();
      setKeyboard(300);
      expect(screen.queryByTestId("note-browse-bar")).toBeNull();
      setKeyboard(0);
      expect(screen.getByTestId("note-browse-bar")).toBeInTheDocument();
    });
  });
});

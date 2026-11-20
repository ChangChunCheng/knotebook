import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { FolderDto, GroupDto, NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { SidebarTabActionsContext, type SidebarTabActions } from "@/lib/sidebar-tab";
import { adminRole, groupDto, OWNER_PERMS } from "@/test/fixtures";
import { folderDto, groupFolder } from "@/test/folder-fixtures";
import { __resetCollapseForTests, isCollapsed } from "@/components/sidebar/collapse";
import { fitSegments, NoteLocation } from "./NoteLocation";

const data = vi.hoisted(() => ({ folders: [] as unknown[], groups: [] as unknown[], width: 0 }));
vi.mock("@/api/folders", () => ({ useFolders: () => ({ data: data.folders }) }));
vi.mock("@/api/groups", () => ({ useGroups: () => ({ data: data.groups }) }));
vi.mock("@/lib/use-container-width", () => ({ useContainerWidth: () => data.width }));

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

describe("fitSegments", () => {
  const segs = ["My notes", "A", "B", "C", "D"];
  const widths = [60, 30, 30, 30, 30];

  it("all fit -> unchanged, no truncation", () => {
    expect(fitSegments(segs, widths, 200, 20)).toEqual({ shown: segs, truncateLast: false });
  });

  it("doesn't fit -> the middle is replaced from the center outward by a single ellipsis, first and last kept", () => {
    // After removing B, 170 still exceeds 150; removing A as well gives 140.
    expect(fitSegments(segs, widths, 150, 20)).toEqual({ shown: ["My notes", "…", "C", "D"], truncateLast: false });
    expect(fitSegments(segs, widths, 170, 20)).toEqual({ shown: ["My notes", "A", "…", "C", "D"], truncateLast: false });
  });

  it("down to only first and last and still doesn't fit -> keep first and last and truncate the tail of the last segment", () => {
    expect(fitSegments(segs, widths, 90, 20)).toEqual({ shown: ["My notes", "…", "D"], truncateLast: true });
  });

  it("no middle segment to drop (one or two segments) and doesn't fit -> only truncate the last segment", () => {
    expect(fitSegments(["a", "b"], [60, 30], 50, 20)).toEqual({ shown: ["a", "b"], truncateLast: true });
    expect(fitSegments(["a"], [60], 50, 20)).toEqual({ shown: ["a"], truncateLast: true });
  });

  it("boundary where it exactly fits (including the ellipsis width)", () => {
    expect(fitSegments(["a", "b", "c"], [10, 10, 10], 25, 5)).toEqual({ shown: ["a", "…", "c"], truncateLast: false });
    expect(fitSegments(["a", "b", "c"], [10, 10, 10], 30, 5)).toEqual({ shown: ["a", "b", "c"], truncateLast: false });
  });
});

describe("NoteLocation", () => {
  const showTab = vi.fn();
  const actions: SidebarTabActions = { showTab, updateSelection: vi.fn(), endSelectionIfActive: vi.fn(() => false), getSelectionSession: vi.fn(() => null), getTab: vi.fn(() => "myNotes" as const) };

  function renderLocation(n: NoteDto) {
    return render(
      <SidebarTabActionsContext.Provider value={actions}>
        <NoteLocation note={n} />
      </SidebarTabActionsContext.Provider>,
    );
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    __resetCollapseForTests();
    showTab.mockClear();
    data.width = 0;
    const folders: FolderDto[] = [folderDto({ id: "pA", name: "Projects" }), folderDto({ id: "pB", name: "Sprint", parentId: "pA" })];
    data.folders = folders;
    data.groups = [] as GroupDto[];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("one button, aria-label is the full path", () => {
    renderLocation(note({ folderId: "pB" }));
    const button = screen.getByRole("button", { name: "Show in list: My notes › Projects › Sprint" });
    expect(button).toBeInTheDocument();
  });

  it("shared: the path is followed by @owner account", () => {
    renderLocation(note({ role: "viewer", ownerHandle: "bob" }));
    expect(screen.getByRole("button", { name: "Show in list: Shared with me · @bob" })).toBeInTheDocument();
  });

  it("zh-TW aria-label", async () => {
    await i18n.changeLanguage("zh-TW");
    try {
      renderLocation(note());
      expect(screen.getByRole("button", { name: "在清單中顯示：我的筆記" })).toBeInTheDocument();
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("click: switches to that tab and expands the folder chain", () => {
    __resetCollapseForTests();
    // First written as collapsed, to verify the click expands it.
    localStorage.setItem("sidebar.collapsed.folder:pA", "1");
    localStorage.setItem("sidebar.collapsed.folder:pB", "1");
    __resetCollapseForTests();
    expect(isCollapsed("folder:pA")).toBe(true);
    renderLocation(note({ folderId: "pB" }));
    fireEvent.click(screen.getByRole("button", { name: /^Show in list/ }));
    expect(showTab).toHaveBeenCalledWith("myNotes");
    expect(isCollapsed("folder:pA")).toBe(false);
    expect(isCollapsed("folder:pB")).toBe(false);
  });

  it("root-level note: only switches tab, doesn't touch expand state", () => {
    renderLocation(note());
    fireEvent.click(screen.getByRole("button", { name: /^Show in list/ }));
    expect(showTab).toHaveBeenCalledWith("myNotes");
  });

  const NOTE_ID = "11111111-1111-4111-8111-111111111111";
  function makeRow(visible: boolean) {
    const row = document.createElement("li");
    row.setAttribute("data-node-id", NOTE_ID);
    const link = document.createElement("a");
    link.href = "/n/alice/plan";
    row.appendChild(link);
    const scroll = vi.fn();
    row.scrollIntoView = scroll;
    row.getClientRects = () => (visible ? ([{}] as unknown as DOMRectList) : ([] as unknown as DOMRectList));
    document.body.appendChild(row);
    return { row, link, scroll };
  }

  it("after the list appears, scrolls that row to the center and puts focus on its link (no further scrolling)", () => {
    vi.useFakeTimers();
    const hidden = makeRow(false); // another, invisible copy comes first
    const shown = makeRow(true);
    const focus = vi.spyOn(shown.link, "focus");
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
    renderLocation(note());
    fireEvent.click(screen.getByRole("button", { name: /^Show in list/ }));
    vi.runAllTimers();
    expect(shown.scroll).toHaveBeenCalledWith({ block: "center" });
    expect(hidden.scroll).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    hidden.row.remove();
    shown.row.remove();
  });

  it("can't find a visible row: polls at most 30 frames then stops", () => {
    vi.useFakeTimers();
    const hidden = makeRow(false);
    const raf = vi.fn((cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
    vi.stubGlobal("requestAnimationFrame", raf);
    renderLocation(note());
    fireEvent.click(screen.getByRole("button", { name: /^Show in list/ }));
    vi.runAllTimers();
    expect(raf).toHaveBeenCalledTimes(30);
    expect(hidden.scroll).not.toHaveBeenCalled();
    hidden.row.remove();
  });

  it("group note: clicking expands a collapsed group block", () => {
    const groupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    data.groups = [groupDto({ id: groupId, name: "Workshop A" }, adminRole())];
    localStorage.setItem(`sidebar.collapsed.group:${groupId}`, "1");
    __resetCollapseForTests();
    expect(isCollapsed(`group:${groupId}`)).toBe(true);
    renderLocation(note({ role: "editor", group: { id: groupId, name: "Workshop A" }, groupId }));
    fireEvent.click(screen.getByRole("button", { name: "Show in list: Workshop A" }));
    expect(showTab).toHaveBeenCalledWith("workspace");
    expect(isCollapsed(`group:${groupId}`)).toBe(false);
  });

  it("separators keep their whitespace, the button clips overflow, the measuring copy is hidden from assistive technology", () => {
    renderLocation(note({ folderId: "pB" }));
    const button = screen.getByRole("button", { name: /^Show in list/ });
    expect(button).toHaveClass("overflow-hidden");
    const separators = Array.from(button.querySelectorAll("[aria-hidden='true']"));
    expect(separators.length).toBeGreaterThanOrEqual(2);
    for (const sep of separators) expect(sep).toHaveClass("whitespace-pre");
    const measured = document.querySelector("[data-measure-seg]") as HTMLElement;
    expect(measured.closest("[aria-hidden='true']")).not.toBeNull();
    expect(button.contains(measured)).toBe(false);
  });

  describe("when width is measured", () => {
    beforeEach(() => {
      // Each character 10px, separator 5px, ellipsis 10px.
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        let width = 0;
        if (this.hasAttribute("data-measure-sep")) width = 5;
        else if (this.hasAttribute("data-measure-ellipsis")) width = 10;
        else if (this.hasAttribute("data-measure-seg") || this.hasAttribute("data-measure-suffix")) width = (this.textContent ?? "").length * 10;
        return { width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0, toJSON: () => ({}) };
      });
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("doesn't fit: the middle becomes an ellipsis, the component really applies fitSegments", () => {
      data.width = 200; // full length 80 + 85 + 65 = 230
      renderLocation(note({ folderId: "pB" }));
      const button = screen.getByRole("button", { name: /^Show in list/ });
      expect(within(button).getByText("…")).toBeInTheDocument();
      expect(within(button).queryByText("Projects")).toBeNull();
      expect(within(button).getByText("Sprint")).toBeInTheDocument();
      expect(button).toHaveAccessibleName("Show in list: My notes › Projects › Sprint");
    });

    it("fits: the full path, no ellipsis", () => {
      data.width = 400;
      renderLocation(note({ folderId: "pB" }));
      const button = screen.getByRole("button", { name: /^Show in list/ });
      expect(within(button).queryByText("…")).toBeNull();
      expect(within(button).getByText("Projects")).toBeInTheDocument();
    });

    it("first segment very long, first and last don't fit: the first segment takes at most half and truncates its tail, the last segment takes the remaining width", () => {
      const groupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      data.groups = [groupDto({ id: groupId, name: "A very long group name" }, adminRole())];
      data.folders = [groupFolder({ id: "gf", name: "Sub", groupId })];
      data.width = 100;
      renderLocation(note({ role: "editor", group: { id: groupId, name: "A very long group name" }, groupId, folderId: "gf" }));
      const button = screen.getByRole("button", { name: /^Show in list/ });
      const first = within(button).getByText("A very long group name");
      expect(first).toHaveClass("max-w-[50%]", "truncate");
      const last = within(button).getByText("Sub");
      expect(last).toHaveClass("min-w-0", "truncate");
    });
  });
});

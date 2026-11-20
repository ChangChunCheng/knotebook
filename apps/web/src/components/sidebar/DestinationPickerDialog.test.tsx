import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { FolderDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ApiFail } from "@/api/client";
import { folderDto } from "@/test/folder-fixtures";
import { buildDestinationLevel, type DestItem, type DestPathStep, type DestSource, type DestSpace } from "./destination-level";
import { DestinationPickerDialog } from "./DestinationPickerDialog";
import { EMPTY_FOLDER_INDEX, indexFolders } from "./folder-index";

// Destination picker (#181; one level at a time).
// Level content is always produced by `buildDestinationLevel` (the same one as SelectActionBar).

type Props = Parameters<typeof DestinationPickerDialog>[0];

const t = i18n.t.bind(i18n) as (key: string, options?: Record<string, unknown>) => string;

const PERSONAL: DestSpace = { kind: "personal" };
const TEAM: DestSpace = { kind: "group", groupId: "ga", name: "Team" };
/** Personal folders: A contains A1, B. */
const FA = folderDto({ id: "A", name: "A" });
const FA1 = folderDto({ id: "A1", name: "A1", parentId: "A" });
const FB = folderDto({ id: "B", name: "B" });
const INDEX = indexFolders([FA, FA1, FB]);

/** Batch source of the My notes tab (selection at the root level); non-empty movingFolders = folders were selected. */
function mine(mode: "move" | "copy", movingFolders: FolderDto[] = []): DestSource {
  return { mode, current: PERSONAL, makeCopy: mode === "copy", others: [TEAM], locations: [null], movingFolders };
}

/** Shape (no upper half, no folders): the same shape as SelectActionBar's transitional wiring. */
function flat(mode: "move" | "copy"): DestSource {
  return { mode, current: null, makeCopy: false, others: mode === "move" ? [TEAM] : [PERSONAL, TEAM], locations: [], movingFolders: [] };
}

function level(source: DestSource, path: DestPathStep[] = [], index = INDEX): DestItem[] {
  return buildDestinationLevel({ source, path, index, t });
}

function props(over: Partial<Props> = {}): Props {
  return {
    mode: "move",
    count: 3,
    hasFolders: false,
    level: level(flat("move"), [], EMPTY_FOLDER_INDEX),
    levelKey: "[]",
    error: null,
    open: true,
    onDrill: vi.fn(),
    onBack: vi.fn(),
    onPick: vi.fn(),
    onOpenChange: vi.fn(),
    ...over,
  };
}

function renderPicker(over: Partial<Props> = {}) {
  const base = props(over);
  const view = render(<DestinationPickerDialog {...base} />);
  return { ...base, rerender: (next: Partial<Props>) => view.rerender(<DestinationPickerDialog {...base} {...next} />) };
}

const dialog = () => screen.getByRole("dialog");
const list = () => dialog().querySelector("ul") as HTMLUListElement;
/** Each row: a separator = "---", otherwise the button's accessible name (aria-label). */
const rows = () =>
  Array.from(list().children).map((li) => (li.getAttribute("role") === "separator" ? "---" : (li.querySelector("button")?.getAttribute("aria-label") ?? "?")));
const item = (name: string) => within(dialog()).getByRole("button", { name });
const CROSS_SPACE = "Folders can only move within the same space";

describe("DestinationPickerDialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("copy: My notes then Team in order, no \"Groups\" subheading; icons user/users; pressing Team calls onPick with the group root level", () => {
    const { onPick } = renderPicker({ mode: "copy", level: level(flat("copy"), [], EMPTY_FOLDER_INDEX) });
    expect(within(dialog()).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["My notes", "Team"]);
    expect(within(dialog()).queryByText("Groups")).toBeNull();
    expect(item("My notes").querySelector('svg[data-icon="user"]')).not.toBeNull();
    expect(item("Team").querySelector('svg[data-icon="users"]')).not.toBeNull();
    fireEvent.click(item("Team"));
    expect(onPick).toHaveBeenCalledWith({ kind: "place", space: TEAM, folder: null });
  });

  it("copy: pressing My notes calls onPick with the My notes root level", () => {
    const { onPick } = renderPicker({ mode: "copy", level: level(flat("copy"), [], EMPTY_FOLDER_INDEX) });
    fireEvent.click(item("My notes"));
    expect(onPick).toHaveBeenCalledWith({ kind: "place", space: PERSONAL, folder: null });
  });

  it("move: no My notes, only Team; no \"Groups\" subheading", () => {
    renderPicker({ mode: "move" });
    expect(within(dialog()).queryByRole("button", { name: "My notes" })).toBeNull();
    expect(within(dialog()).queryByText("Groups")).toBeNull();
    expect(rows()).toEqual(["Team"]);
  });

  it("level null: Loading... and no list", () => {
    renderPicker({ level: null });
    expect(within(dialog()).getByText("Loading…")).toBeInTheDocument();
    expect(list()).toBeNull();
  });

  it("error: role=alert (errors.<code>)", () => {
    renderPicker({ level: null, error: new ApiFail(500, "internal", "x") });
    expect(within(dialog()).getByRole("alert")).toHaveTextContent("Something went wrong. Please try again.");
  });

  it("title and description: Move to, Choose where the 3 notes go.", () => {
    renderPicker({ mode: "move" });
    expect(screen.getByRole("dialog", { name: "Move to" })).toHaveAccessibleDescription("Choose where the 3 notes go.");
  });

  it("copy title Copy to; singular description", () => {
    renderPicker({ mode: "copy", count: 1, level: level(flat("copy"), [], EMPTY_FOLDER_INDEX) });
    expect(screen.getByRole("dialog", { name: "Copy to" })).toHaveAccessibleDescription("Choose where the note goes.");
  });

  it("zh-TW: the copy-to title, the my-notes root; no groups subheading", async () => {
    await i18n.changeLanguage("zh-TW");
    try {
      renderPicker({ mode: "copy", level: level(flat("copy"), [], EMPTY_FOLDER_INDEX) });
      const zh = screen.getByRole("dialog", { name: "複製到" });
      expect(within(zh).getByRole("button", { name: "我的筆記" })).toBeInTheDocument();
      expect(within(zh).queryByText("群組")).toBeNull();
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("zh-TW: the move title is the move-to text", async () => {
    await i18n.changeLanguage("zh-TW");
    try {
      renderPicker({ mode: "move" });
      expect(screen.getByRole("dialog", { name: "移動到" })).toBeInTheDocument();
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("Cancel calls onOpenChange(false) and no onPick", () => {
    const { onPick, onOpenChange } = renderPicker();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onPick).not.toHaveBeenCalled();
  });

  // One level at a time
  it("first level: A (\", open\"), B, separator, Team in order; the separator is li[role=separator]; clicking \"A, open\" calls onDrill, clicking B calls onPick", () => {
    const { onDrill, onPick } = renderPicker({ level: level(mine("move")) });
    expect(rows()).toEqual(["A, open", "B", "---", "Team"]);
    expect(within(dialog()).getByRole("separator").tagName).toBe("LI");
    expect(item("A, open")).toHaveTextContent(/^A$/);
    expect(item("A, open").querySelector('svg[data-icon="folder"]')).not.toBeNull();
    expect(item("A, open").querySelector('svg[data-icon="chevron-right"]')).toHaveAttribute("aria-hidden", "true");
    expect(item("B").querySelector('svg[data-icon="chevron-right"]')).toBeNull();
    expect(item("Team").querySelector('svg[data-icon="users"]')).not.toBeNull();

    fireEvent.click(item("A, open"));
    expect(onDrill).toHaveBeenCalledWith({ kind: "folder", folderId: "A" });
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(item("B"));
    expect(onPick).toHaveBeenCalledWith({ kind: "place", space: PERSONAL, folder: FB });
    expect(onDrill).toHaveBeenCalledTimes(1);
  });

  it("copy first level: \"Make a copy\" with the copy icon, Top level with the house icon; the shared-space item with the share icon", () => {
    const source: DestSource = { mode: "copy", current: PERSONAL, makeCopy: true, others: [{ kind: "shared" }], locations: ["A"], movingFolders: [] };
    renderPicker({ mode: "copy", level: level(source) });
    expect(rows()).toEqual(["Make a copy", "Top level", "A, open", "B", "---", "Shared with me"]);
    expect(item("Make a copy").querySelector('svg[data-icon="copy"]')).not.toBeNull();
    expect(item("Top level").querySelector('svg[data-icon="house"]')).not.toBeNull();
    expect(item("Shared with me").querySelector('svg[data-icon="share"]')).not.toBeNull();
  });

  it("rendering a second level with a new levelKey: the first item is Back (chevron-left aria-hidden) and gets focus, the list scrolls back to the top; clicking Back calls onBack", () => {
    const view = renderPicker({ level: level(mine("move")) });
    list().scrollTop = 80;
    const path: DestPathStep[] = [{ kind: "folder", folderId: "A" }];
    view.rerender({ level: level(mine("move"), path), levelKey: JSON.stringify(path) });
    expect(rows()).toEqual(["Back", "Move here", "A1"]);
    const back = item("Back");
    expect(back.textContent).toBe("Back");
    expect(back.querySelector('svg[data-icon="chevron-left"][aria-hidden="true"]')).not.toBeNull();
    expect(item("Move here").querySelector('svg[data-icon="corner-down-right"][aria-hidden="true"]')).not.toBeNull();
    expect(back).toHaveFocus();
    expect(list().scrollTop).toBe(0);
    fireEvent.click(back);
    expect(view.onBack).toHaveBeenCalledTimes(1);
    expect(view.onPick).not.toHaveBeenCalled();
  });

  it("same levelKey, level redrawn with a new array (folders refetch): focus does not move and nothing scrolls", () => {
    const path: DestPathStep[] = [{ kind: "folder", folderId: "A" }];
    const view = renderPicker({ level: level(mine("move")) });
    view.rerender({ level: level(mine("move"), path), levelKey: JSON.stringify(path) });
    expect(item("Back")).toHaveFocus();
    item("A1").focus();
    list().scrollTop = 40;
    const refetched = level(mine("move"), path, indexFolders([FA, FA1, FB]));
    view.rerender({ level: refetched, levelKey: JSON.stringify(path) });
    expect(item("A1")).toHaveFocus();
    expect(list().scrollTop).toBe(40);
  });

  it("a level whose first item is disabled: focus goes to the first enabled item", () => {
    const path: DestPathStep[] = [{ kind: "folder", folderId: "A" }];
    const view = renderPicker({ level: level(mine("move", [FA]), path), levelKey: JSON.stringify(path), hasFolders: true });
    // Back to the first level: after choosing A, A itself is greyed (self) and first, B is pressable.
    view.rerender({ level: level(mine("move", [FA])), levelKey: "[]" });
    expect(rows()).toEqual(["A", "B", "---", "Team"]);
    expect(item("A")).toBeDisabled();
    expect(item("B")).toHaveFocus();
  });

  it("after switching level everything is greyed (A and B chosen: two self, Team crossSpace): focus goes to the footer's Cancel", () => {
    const path: DestPathStep[] = [{ kind: "folder", folderId: "A" }];
    const view = renderPicker({ level: level(mine("move", [FA, FB]), path), levelKey: JSON.stringify(path), hasFolders: true });
    expect(item("Back")).toBeEnabled();
    view.rerender({ level: level(mine("move", [FA, FB])), levelKey: "[]" });
    expect(rows()).toEqual(["A", "B", "---", "Team"]);
    for (const name of ["A", "B", "Team"]) expect(item(name)).toBeDisabled();
    expect(within(dialog()).getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("a crossSpace item is disabled + title, with the same text on one more line under the description; a level without crossSpace has no such line", () => {
    const view = renderPicker({ level: level(mine("move", [FB])), hasFolders: true });
    const team = item("Team");
    expect(team).toBeDisabled();
    expect(team).toHaveAttribute("title", CROSS_SPACE);
    // A self-greyed item has no title.
    expect(item("B")).toBeDisabled();
    expect(item("B")).not.toHaveAttribute("title");
    const line = within(dialog()).getByText(CROSS_SPACE);
    expect(line.tagName).toBe("P");
    expect(list()).not.toContainElement(line);
    // The explanation line is part of the dialog's accessible description.
    expect(dialog()).toHaveAccessibleDescription(`Choose where the 3 items go. ${CROSS_SPACE}`);

    view.rerender({ level: level(mine("move")), hasFolders: false });
    expect(within(dialog()).queryByText(CROSS_SPACE)).toBeNull();
    expect(dialog()).toHaveAccessibleDescription("Choose where the 3 notes go.");
    expect(item("Team")).toBeEnabled();
    expect(item("Team")).not.toHaveAttribute("title");
  });

  it("hasFolders: description \"Choose where the 2 items go.\"; without it: \"Choose where the 2 notes go.\"", () => {
    // Only the upper half (group / shared-with-me tab): no crossSpace item, the description is just that one sentence.
    const view = renderPicker({ count: 2, hasFolders: true, level: level({ ...mine("move", [FB]), others: [] }) });
    expect(screen.getByRole("dialog", { name: "Move to" })).toHaveAccessibleDescription("Choose where the 2 items go.");
    view.rerender({ count: 2, hasFolders: false, level: level(mine("move")) });
    expect(screen.getByRole("dialog", { name: "Move to" })).toHaveAccessibleDescription("Choose where the 2 notes go.");
  });

  it("zh-TW: the description and the cross-space explanation line; the second level's back button (leading chevron-left) gets focus, followed by the move-here item", async () => {
    await i18n.changeLanguage("zh-TW");
    try {
      const path: DestPathStep[] = [{ kind: "folder", folderId: "A" }];
      const view = renderPicker({ count: 2, hasFolders: true, level: level(mine("move", [FB])) });
      const zh = screen.getByRole("dialog", { name: "移動到" });
      expect(zh).toHaveAccessibleDescription("選擇 2 項要放到哪裡。 資料夾只能在同一個空間內移動");
      expect(within(zh).getByText("資料夾只能在同一個空間內移動")).toBeInTheDocument();
      expect(within(zh).getByRole("button", { name: "Team" })).toHaveAttribute("title", "資料夾只能在同一個空間內移動");
      expect(within(zh).getByRole("button", { name: "A，開啟下一層" })).toBeEnabled();
      view.rerender({ level: level(mine("move", [FB]), path), levelKey: JSON.stringify(path) });
      expect(rows()).toEqual(["返回", "移動到這裡", "A1"]);
      const zhBack = within(zh).getByRole("button", { name: "返回" });
      expect(zhBack.textContent).toBe("返回");
      expect(zhBack.querySelector('svg[data-icon="chevron-left"][aria-hidden="true"]')).not.toBeNull();
      expect(within(zh).getByRole("button", { name: "返回" })).toHaveFocus();
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});

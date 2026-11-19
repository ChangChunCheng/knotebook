import { beforeEach, describe, expect, it } from "vitest";
import type { GroupDto, NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { groupDto, memberRole } from "@/test/fixtures";
import { folderChain, folderDto, groupFolder, sharedFolder } from "@/test/folder-fixtures";
import { groupNote, personalNote, sharedNote } from "@/test/select-fixtures";
import {
  buildDropLookup,
  canDragNote,
  dropScopeKey,
  evaluateDragOver,
  isDragEnabled,
  readDragTarget,
  stackFolderName,
  type DragOverResult,
  type DragSource,
  type DragTab,
  type DragTarget,
  type DropLookup,
  type HoldAction,
} from "./drag-zone";
import { indexFolders } from "./folder-index";
import { buildTabNodes } from "./tree";

/**
 * Fixture: personal F > F1, X > Z, empty folder E, chain C1 > ... > C5; root notes A, R, O (folderId points to a missing folder); N1, N2 in F; Z1 in Z;
 * B4 in C4, B5 in C5; group G (edit) with GF, root g1, g2 in GF, read-only gr; group H with HF, h1; shared SF, shared note s1, fallback group note sg (group K is not in groupIds).
 * Trees are built with buildTabNodes then buildDropLookup rather than a hand-written lookup. Assertion shape: `[zone kind, drop folderId, scope key, row, hold]`.
 */

const t = i18n.t.bind(i18n) as (key: string, options?: Record<string, unknown>) => string;

const G: GroupDto = groupDto({ id: "G", name: "G" }, memberRole());
const H: GroupDto = groupDto({ id: "H", name: "H" }, memberRole());
const K: GroupDto = groupDto({ id: "K", name: "K" }, memberRole());
const GROUPS: GroupDto[] = [G, H];
const GROUP_IDS: ReadonlySet<string> = new Set(GROUPS.map((group) => group.id));

const INDEX = indexFolders([
  folderDto({ id: "F", name: "F" }),
  folderDto({ id: "F1", name: "F1", parentId: "F" }),
  folderDto({ id: "X", name: "X" }),
  folderDto({ id: "Z", name: "Z", parentId: "X" }),
  folderDto({ id: "E", name: "E" }),
  ...folderChain("C", 5),
  groupFolder({ id: "GF", name: "GF", groupId: "G" }),
  groupFolder({ id: "HF", name: "HF", groupId: "H" }),
  sharedFolder({ id: "SF", name: "SF" }),
]);

const NOTES: NoteDto[] = [
  personalNote({ id: "A", title: "A" }),
  personalNote({ id: "R", title: "R" }),
  personalNote({ id: "O", title: "O", folderId: "ghost" }),
  personalNote({ id: "N1", title: "N1", folderId: "F" }),
  personalNote({ id: "N2", title: "N2", folderId: "F" }),
  personalNote({ id: "Z1", title: "Z1", folderId: "Z" }),
  personalNote({ id: "B4", title: "B4", folderId: "C4" }),
  personalNote({ id: "B5", title: "B5", folderId: "C5" }),
  groupNote({ id: "g1", title: "g1", group: G }),
  groupNote({ id: "g2", title: "g2", group: G, folderId: "GF" }),
  groupNote({ id: "gr", title: "gr", group: G, edit: false }),
  groupNote({ id: "h1", title: "h1", group: H }),
  sharedNote({ id: "s1", title: "s1", role: "viewer" }),
  sharedNote({ id: "s2", title: "s2", folderId: "SF" }),
  groupNote({ id: "sg", title: "sg", group: K }),
];

function lookupOf(tab: DragTab): DropLookup {
  return buildDropLookup(buildTabNodes(tab, NOTES, GROUPS, INDEX), tab, GROUP_IDS);
}

const LOOKUP: Record<DragTab, DropLookup> = { myNotes: lookupOf("myNotes"), workspace: lookupOf("workspace"), shared: lookupOf("shared") };

function sourceOf(tab: DragTab, noteId: string): DragSource {
  const entry = LOOKUP[tab].notes.get(noteId);
  if (entry === undefined) throw new Error(`no ${noteId} in ${tab}`);
  return { noteId, space: entry.space, folderId: entry.folderId, title: entry.title };
}

type Shape = [string | null, string | null | undefined, string | null, string | null, HoldAction | null];

function shape(result: DragOverResult): Shape {
  const { zone } = result;
  return [zone?.kind ?? null, zone?.kind === "place" ? zone.folderId : undefined, zone === null ? null : dropScopeKey(zone.scope), result.row, result.hold];
}

function over(tab: DragTab, sourceId: string, target: DragTarget, o: { collapsed?: readonly string[]; previewAnchor?: string | null } = {}): Shape {
  const collapsed = new Set(o.collapsed ?? []);
  return shape(
    evaluateDragOver({
      source: sourceOf(tab, sourceId),
      target,
      lookup: LOOKUP[tab],
      tab,
      isCollapsed: (folderId) => collapsed.has(folderId),
      previewAnchor: o.previewAnchor ?? null,
    }),
  );
}

const note = (id: string): DragTarget => ({ kind: "note", id });
const folder = (id: string): DragTarget => ({ kind: "folder", id });
const group = (id: string): DragTarget => ({ kind: "group", id });
const BLANK: DragTarget = { kind: "blank" };
const OUTSIDE: DragTarget = { kind: "outside" };
const PREVIEW: DragTarget = { kind: "preview" };
const stack = (anchorNoteId: string, parentFolderId: string | null): HoldAction => ({ kind: "stack", anchorNoteId, parentFolderId });
const NONE: Shape = [null, undefined, null, null, null];

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

describe("evaluateDragOver: my notes", () => {
  it("root note A dragged onto the expanded folder row F -> drop target F, F's scope highlighted, no timer", () => {
    expect(over("myNotes", "A", folder("F"))).toEqual(["place", "F", "folder:F", "folder:F", null]);
  });

  it("A dragged onto N1 inside F -> drop target F; hovering can stack (parent F)", () => {
    expect(over("myNotes", "A", note("N1"))).toEqual(["place", "F", "folder:F", "note:N1", stack("N1", "F")]);
  });

  it("N1 from F dragged onto root note R -> drop target is the root (whole list); hovering can stack (parent is root)", () => {
    expect(over("myNotes", "N1", note("R"))).toEqual(["place", null, "list", "note:R", stack("R", null)]);
  });

  it("blank area: N1 -> root; A already at root -> not a drop target; leaving the tree container -> everything empty", () => {
    expect(over("myNotes", "N1", BLANK)).toEqual(["place", null, "list", null, null]);
    expect(over("myNotes", "A", BLANK)).toEqual(NONE);
    expect(over("myNotes", "N1", OUTSIDE)).toEqual(NONE);
  });

  it("staying in place is not a drop target: N1 onto N2 in the same folder can still stack; N1 onto row F, and A onto itself, give nothing", () => {
    expect(over("myNotes", "N1", note("N2"))).toEqual([null, undefined, null, "note:N2", stack("N2", "F")]);
    expect(over("myNotes", "N1", folder("F"))).toEqual([null, undefined, null, "folder:F", null]);
    expect(over("myNotes", "A", note("A"))).toEqual([null, undefined, null, "note:A", null]);
  });

  it("nested picks the nearest: A onto a note in Z, and A onto row Z -> drop target is Z in both", () => {
    expect(over("myNotes", "A", note("Z1"))).toEqual(["place", "Z", "folder:Z", "note:Z1", stack("Z1", "Z")]);
    expect(over("myNotes", "A", folder("Z"))).toEqual(["place", "Z", "folder:Z", "folder:Z", null]);
  });

  it("the \"no notes\" line of empty folder E -> readDragTarget reads folder E -> drop target E", () => {
    const container = document.createElement("div");
    container.innerHTML = '<ul><li data-node-kind="folder" data-node-id="E"><button type="button">E</button><ul><li><p>No notes</p></li></ul></li></ul>';
    const empty = container.querySelector("p");
    const target = readDragTarget(empty, container);
    expect(target).toEqual({ kind: "folder", id: "E" });
    expect(over("myNotes", "A", target)).toEqual(["place", "E", "folder:E", "folder:E", null]);
  });

  it("preview block -> creates a new folder; the previewAnchor row (the same dragover round still points at the old row) counts as the preview", () => {
    const preview: Shape = ["stack", undefined, "preview", "preview", null];
    expect(over("myNotes", "A", PREVIEW)).toEqual(preview);
    expect(over("myNotes", "A", note("N2"), { previewAnchor: "N2" })).toEqual(preview);
    expect(over("myNotes", "A", note("N1"), { previewAnchor: "N2" })).toEqual(["place", "F", "folder:F", "note:N1", stack("N1", "F")]);
  });

  it("B's folder depth = FOLDER_DEPTH_MAX -> no stacking, zone only; depth 4 -> can stack", () => {
    expect(over("myNotes", "A", note("B5"))).toEqual(["place", "C5", "folder:C5", "note:B5", null]);
    expect(over("myNotes", "A", note("B4"))).toEqual(["place", "C4", "folder:C4", "note:B4", stack("B4", "C4")]);
  });

  it("spring: a collapsed folder in the same space -> spring; expanded -> no timer", () => {
    expect(over("myNotes", "A", folder("F"), { collapsed: ["F"] })).toEqual(["place", "F", "folder:F", "folder:F", { kind: "spring", folderId: "F" }]);
    expect(over("myNotes", "A", folder("F"))).toEqual(["place", "F", "folder:F", "folder:F", null]);
  });
});

describe("evaluateDragOver: group", () => {
  it("own-group row / root note / blank area -> group root; any row of another group -> not a drop target", () => {
    expect(over("workspace", "g2", group("G"))).toEqual(["place", null, "group:G", null, null]);
    expect(over("workspace", "g1", group("G"))).toEqual(NONE);
    expect(over("workspace", "g2", group("H"))).toEqual(NONE);
    expect(over("workspace", "g2", note("h1"))).toEqual([null, undefined, null, "note:h1", null]);
    expect(over("workspace", "g2", folder("HF"), { collapsed: ["HF"] })).toEqual(NONE);
    expect(over("workspace", "g2", BLANK)).toEqual(["place", null, "group:G", null, null]);
    expect(over("workspace", "g2", note("g1"))).toEqual(["place", null, "group:G", "note:g1", stack("g1", null)]);
  });

  it("a collapsed folder of another group does not spring open", () => {
    expect(over("workspace", "g1", folder("HF"), { collapsed: ["HF"] })).toEqual(NONE);
    expect(over("workspace", "g1", folder("GF"), { collapsed: ["GF"] })).toEqual(["place", "GF", "folder:GF", "folder:GF", { kind: "spring", folderId: "GF" }]);
  });

  it("B is not droppable (read-only in the same group) -> no stacking", () => {
    expect(over("workspace", "g1", note("gr"))).toEqual([null, undefined, null, "note:gr", null]);
  });
});

describe("evaluateDragOver: shared with me", () => {
  it("B is a fallback group note -> no stacking; a shared folder row is still a drop target", () => {
    expect(over("shared", "s1", note("sg"))).toEqual([null, undefined, null, "note:sg", null]);
    expect(over("shared", "s1", folder("SF"))).toEqual(["place", "SF", "folder:SF", "folder:SF", null]);
  });

  it("s2 in shared folder SF dragged to a blank area -> root (whole list)", () => {
    expect(over("shared", "s2", BLANK)).toEqual(["place", null, "list", null, null]);
  });
});

describe("canDragNote", () => {
  it("personal: allowed; group: depends on permissions.edit; shared editor/viewer: allowed; fallback group note: not allowed", () => {
    expect(canDragNote(personalNote({ id: "p", title: "p" }), "personal")).toBe(true);
    expect(canDragNote(groupNote({ id: "ge", title: "ge", group: G }), "group:G")).toBe(true);
    expect(canDragNote(groupNote({ id: "gv", title: "gv", group: G, edit: false }), "group:G")).toBe(false);
    expect(canDragNote(sharedNote({ id: "sv", title: "sv", role: "viewer" }), "shared")).toBe(true);
    expect(canDragNote(sharedNote({ id: "se", title: "se", role: "editor" }), "shared")).toBe(true);
    expect(canDragNote(groupNote({ id: "sg", title: "sg", group: K }), "shared")).toBe(false);
  });
});

describe("readDragTarget", () => {
  function tree(): { container: HTMLElement; outside: HTMLElement } {
    const root = document.createElement("div");
    root.innerHTML =
      '<div data-sidebar-header=""><span>header</span></div>' +
      '<div data-sidebar-list="">' +
      '<ul><li data-node-kind="note" data-node-id="N1"><a href="/n/n1"><span>N1 title</span></a></li>' +
      '<li data-node-kind="preview"><div><span>New folder</span></div>' +
      '<ul><li data-node-kind="note" data-node-id="N2"><a href="/n/n2"><span>N2</span></a></li></ul></li></ul>' +
      "</div>";
    const container = root.querySelector<HTMLElement>("[data-sidebar-list]");
    const outside = root.querySelector<HTMLElement>("[data-sidebar-header] span");
    if (container === null || outside === null) throw new Error("fixture");
    return { container, outside };
  }

  it("elements and text nodes inside <a> -> note; the container itself -> blank; outside it and null -> outside; anywhere inside the preview block -> preview", () => {
    const { container, outside } = tree();
    const span = container.querySelector('[data-node-id="N1"] span');
    expect(readDragTarget(span, container)).toEqual({ kind: "note", id: "N1" });
    expect(readDragTarget(span?.firstChild ?? null, container)).toEqual({ kind: "note", id: "N1" });
    expect(readDragTarget(container, container)).toEqual({ kind: "blank" });
    expect(readDragTarget(outside, container)).toEqual({ kind: "outside" });
    expect(readDragTarget(null, container)).toEqual({ kind: "outside" });
    expect(readDragTarget(container.querySelector('[data-node-kind="preview"] > div > span'), container)).toEqual({ kind: "preview" });
    expect(readDragTarget(container.querySelector('[data-node-id="N2"] span'), container)).toEqual({ kind: "preview" });
  });

  it("unrecognized data-node-kind or missing data-node-id -> outside (not a drop target)", () => {
    const container = document.createElement("div");
    container.innerHTML = '<ul><li data-node-kind="weird" data-node-id="W"><span>w</span></li><li data-node-kind="note"><span>no id</span></li></ul>';
    const [weird, noId] = Array.from(container.querySelectorAll("span"));
    expect(readDragTarget(weird ?? null, container)).toEqual({ kind: "outside" });
    expect(readDragTarget(noId ?? null, container)).toEqual({ kind: "outside" });
  });
});

describe("stackFolderName", () => {
  it("names already used at the same level are compared case-insensitively and the first unused one is picked; skip advances one more", () => {
    expect(stackFolderName([], t)).toBe("New folder");
    expect(stackFolderName(["New folder"], t)).toBe("New folder 2");
    expect(stackFolderName(["new folder", "New Folder 2"], t)).toBe("New folder 3");
    expect(stackFolderName(["new folder", "New Folder 2"], t, new Set(["New folder 3"]))).toBe("New folder 4");
    expect(stackFolderName(["new folder", "New Folder 2"], t, new Set(["NEW FOLDER 3"]))).toBe("New folder 4");
  });

  it("broken name source (returns the same string every time) -> stops after at most taken.size + 1 tries and returns the last candidate", () => {
    let calls = 0;
    const stuck = (): string => {
      calls += 1;
      if (calls > 50) throw new Error("runaway loop");
      return "Same";
    };
    expect(stackFolderName(["same"], stuck)).toBe("Same");
    expect(calls).toBe(2);
  });

  it("zh-TW", async () => {
    await i18n.changeLanguage("zh-TW");
    expect(stackFolderName([], t)).toBe("新資料夾");
    expect(stackFolderName(["新資料夾"], t)).toBe("新資料夾 2");
  });
});

describe("buildDropLookup", () => {
  it("position is taken from the tree (after fallback): a missing folder -> root, depth 0; a note in GF -> depth 1, space group:G", () => {
    expect(LOOKUP.myNotes.notes.get("O")).toEqual({ space: "personal", folderId: null, folderDepth: 0, placeable: true, title: "O" });
    expect(LOOKUP.workspace.notes.get("g2")).toEqual({ space: "group:G", folderId: "GF", folderDepth: 1, placeable: true, title: "g2" });
    expect(LOOKUP.workspace.folders.get("GF")).toEqual({ space: "group:G", depth: 1 });
    expect(LOOKUP.myNotes.folders.get("Z")).toEqual({ space: "personal", depth: 2 });
  });

  it("the group tab accepts only groups in groupIds", () => {
    const lookup = buildDropLookup(buildTabNodes("workspace", NOTES, GROUPS, INDEX), "workspace", new Set(["G"]));
    expect(lookup.notes.has("g1")).toBe(true);
    expect(lookup.notes.has("h1")).toBe(false);
    expect(lookup.folders.has("HF")).toBe(false);
  });
});

describe("isDragEnabled", () => {
  const ok = { finePointer: true, tab: "myNotes", selectionActive: false, creating: false, nodesReady: true } as const;

  it("all five items allowed -> true; any one not allowed -> false; groups and shared-with-me also work", () => {
    expect(isDragEnabled(ok)).toBe(true);
    expect(isDragEnabled({ ...ok, tab: "workspace" })).toBe(true);
    expect(isDragEnabled({ ...ok, tab: "shared" })).toBe(true);
    expect(isDragEnabled({ ...ok, finePointer: false })).toBe(false);
    expect(isDragEnabled({ ...ok, tab: "recent" })).toBe(false);
    expect(isDragEnabled({ ...ok, tab: "trash" })).toBe(false);
    expect(isDragEnabled({ ...ok, selectionActive: true })).toBe(false);
    expect(isDragEnabled({ ...ok, creating: true })).toBe(false);
    expect(isDragEnabled({ ...ok, nodesReady: false })).toBe(false);
  });
});

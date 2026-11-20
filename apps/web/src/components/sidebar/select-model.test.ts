import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FolderDto, GroupDto, NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { customRole, groupDto, memberRole } from "@/test/fixtures";
import { groupNote, personalNote, sharedNote } from "@/test/select-fixtures";
import { folderDto, groupFolder, sharedFolder } from "@/test/folder-fixtures";
import { __resetCollapseForTests, setCollapsed } from "./collapse";
import { isEmptyDestination, isSameSpace, type DestSource, type DestTarget } from "./destination-level";
import { EMPTY_FOLDER_INDEX, indexFolders } from "./folder-index";
import { __resetFolderSortForTests } from "./folder-sort";
import {
  batchDestSource,
  dedupeByAncestor,
  partitionTargets,
  SELECT_ACTIONS,
  selectedTargets,
  selectionResultTitle,
  visibleSelectionKeys,
  type ResultTally,
  type SelectionTarget,
} from "./select-model";
import { buildTabNodes } from "./tree";

const t = i18n.t.bind(i18n) as (key: string, options?: Record<string, unknown>) => string;

const G1: GroupDto = groupDto({ id: "g1", name: "Group 1" }, memberRole());
const G2: GroupDto = groupDto({ id: "g2", name: "Group 2" }, memberRole());
const G1A = groupNote({ id: "g1a", title: "G1 A", group: G1 });
const G1B = groupNote({ id: "g1b", title: "G1 B", group: G1 });
const G2A = groupNote({ id: "g2a", title: "G2 A", group: G2 });
const G2B = groupNote({ id: "g2b", title: "G2 B", group: G2 });
const WORKSPACE = buildTabNodes("workspace", [G1A, G1B, G2A, G2B], [G1, G2], EMPTY_FOLDER_INDEX);

const A = personalNote({ id: "a", title: "A" });

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
  __resetFolderSortForTests();
});

describe("SELECT_ACTIONS (folders: groups and shared-with-me add move)", () => {
  it("five tabs", () => {
    expect(SELECT_ACTIONS).toEqual({
      recent: ["copy", "delete"],
      favorites: ["unfavorite", "copy", "delete"],
      myNotes: ["move", "copy", "delete"],
      workspace: ["move", "copy", "delete"],
      shared: ["move", "copy", "delete"],
    });
  });
});

function tally(o: Partial<ResultTally> & Pick<ResultTally, "action">): ResultTally {
  return {
    tab: "myNotes",
    notesDone: 0,
    foldersDone: 0,
    trashedViaFolders: 0,
    notesSkipped: 0,
    foldersSkipped: 0,
    foldersBlocked: 0,
    foldersGone: 0,
    destinationName: null,
    sameSpace: false,
    destination: null,
    copySource: null,
    ...o,
  };
}

const PERSONAL_ROOT: DestTarget = { kind: "place", space: { kind: "personal" }, folder: null };
const groupRoot = (groupId: string, name: string): DestTarget => ({ kind: "place", space: { kind: "group", groupId, name }, folder: null });

describe("selectionResultTitle", () => {
  const GROUP_A = groupRoot("ga", "A");

  it("delete (3, 0)", () => {
    expect(selectionResultTitle(tally({ action: "delete", notesDone: 3 }), t)).toBe("Moved 3 notes to the trash");
  });

  it("delete (1, 2): appends the skipped suffix", () => {
    expect(selectionResultTitle(tally({ action: "delete", notesDone: 1, notesSkipped: 2 }), t)).toBe(
      "Moved 1 note to the trash, 2 skipped (no permission, or they no longer exist)",
    );
  });

  it("delete (0, 2): no notes processed", () => {
    expect(selectionResultTitle(tally({ action: "delete", notesSkipped: 2 }), t)).toBe(
      "Nothing was done; 2 skipped (no permission, or they no longer exist)",
    );
  });

  it("move (2, 0, A)", () => {
    expect(selectionResultTitle(tally({ action: "move", notesDone: 2, destination: GROUP_A, destinationName: "A" }), t)).toBe('Moved 2 notes into "A"');
  });

  it("copy personal (1, 0)", () => {
    expect(selectionResultTitle(tally({ action: "copy", notesDone: 1, destination: PERSONAL_ROOT, destinationName: "My notes" }), t)).toBe(
      "Copied 1 note to My notes",
    );
  });

  it("copy group (2, 0, A)", () => {
    expect(selectionResultTitle(tally({ action: "copy", notesDone: 2, destination: GROUP_A, destinationName: "A" }), t)).toBe('Copied 2 notes into "A"');
  });

  it("move (0, 1, A): no notes processed (not only for delete)", () => {
    expect(selectionResultTitle(tally({ action: "move", notesSkipped: 1, destination: GROUP_A, destinationName: "A" }), t)).toBe(
      "Nothing was done; 1 skipped (no permission, or it no longer exists)",
    );
  });

  it("move/copy without a destination -> throws (contract error, never an empty group name)", () => {
    for (const action of ["move", "copy"] as const) {
      expect(() => selectionResultTitle(tally({ action, notesDone: 1 }), t)).toThrow(`${action} needs a destination`);
    }
  });

  it("destination is makeCopy and copySource is null -> throws", () => {
    expect(() => selectionResultTitle(tally({ action: "copy", notesDone: 1, destination: { kind: "makeCopy" } }), t)).toThrow(
      "makeCopy needs a copySource",
    );
  });

  it("zh-TW delete (2, 1)", async () => {
    await i18n.changeLanguage("zh-TW");
    try {
      expect(selectionResultTitle(tally({ action: "delete", notesDone: 2, notesSkipped: 1 }), t)).toBe("已移到垃圾桶 2 篇，1 篇略過（沒有權限或已不存在）");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});


/** My notes: A > A1; p1 is in A, p2 in A1, p3 at root. Tree order: A, A1, p2, p1, p3. */
const FA = folderDto({ id: "A", name: "A" });
const FA1 = folderDto({ id: "A1", name: "A1", parentId: "A" });
const P1 = personalNote({ id: "p1", title: "P1", folderId: "A" });
const P2 = personalNote({ id: "p2", title: "P2", folderId: "A1" });
const P3 = personalNote({ id: "p3", title: "P3" });
const MY_INDEX = indexFolders([FA, FA1]);
const MY_TREE = buildTabNodes("myNotes", [P1, P2, P3], [], MY_INDEX);

const noteT = (note: NoteDto): SelectionTarget => ({ kind: "note", note });
const folderT = (folder: FolderDto): SelectionTarget => ({ kind: "folder", folder });
const keysOf = (targets: readonly SelectionTarget[]): string[] =>
  targets.map((target) => (target.kind === "note" ? `note:${target.note.id}` : `folder:${target.folder.id}`));

/** Fails the test outright if batchDestSource returns "mixedGroups". */
function asSource(value: DestSource | "mixedGroups"): DestSource {
  if (value === "mixedGroups") throw new Error("unexpected mixedGroups");
  return value;
}

describe("visibleSelectionKeys", () => {
  it("nothing collapsed: a folder row comes before its children (tree order)", () => {
    expect(visibleSelectionKeys(MY_TREE, () => false)).toEqual(["folder:A", "folder:A1", "note:p2", "note:p1", "note:p3"]);
  });

  it("collapsing folder:A keeps A itself and skips its whole subtree", () => {
    expect(visibleSelectionKeys(MY_TREE, (key) => key === "folder:A")).toEqual(["folder:A", "note:p3"]);
  });

  it("collapsing folder:A1 keeps A1, skips A1's children and lists the rest of A as usual", () => {
    expect(visibleSelectionKeys(MY_TREE, (key) => key === "folder:A1")).toEqual(["folder:A", "folder:A1", "note:p1", "note:p3"]);
  });

  it("collapsing a group works as before (the group row itself is not selectable)", () => {
    expect(visibleSelectionKeys(WORKSPACE, (key) => key === "group:g1")).toEqual(["note:g2a", "note:g2b"]);
    expect(visibleSelectionKeys(WORKSPACE, () => false)).toEqual(["note:g1a", "note:g1b", "note:g2a", "note:g2b"]);
  });
});

describe("selectedTargets", () => {
  it("ticking p1 in A then collapsing A keeps it (collapse is ignored); tree order, keys not in the tree do not count", () => {
    const keys = new Set(["note:p1", "folder:A1", "note:zzz"]);
    expect(keysOf(selectedTargets(MY_TREE, keys))).toEqual(["folder:A1", "note:p1"]);
    setCollapsed("folder:A", true);
    expect(keysOf(selectedTargets(MY_TREE, keys))).toEqual(["folder:A1", "note:p1"]);
  });
});

describe("dedupeByAncestor", () => {
  it("selecting A, p1 in A and A1 leaves only A", () => {
    expect(keysOf(dedupeByAncestor([folderT(FA), noteT(P1), folderT(FA1)], MY_INDEX))).toEqual(["folder:A"]);
  });

  it("A1 and root-level p3 -> both", () => {
    expect(keysOf(dedupeByAncestor([folderT(FA1), noteT(P3)], MY_INDEX))).toEqual(["folder:A1", "note:p3"]);
  });

  it("A1, p2 in A1 and p1 in A -> A1 and p1 (p1 is not in A1's subtree)", () => {
    expect(keysOf(dedupeByAncestor([folderT(FA1), noteT(P2), noteT(P1)], MY_INDEX))).toEqual(["folder:A1", "note:p1"]);
  });

  it("deduplicated children do not count as skipped: partitionTargets receives the deduplicated result, so the skipped count is 0", () => {
    const deduped = dedupeByAncestor([folderT(FA), noteT(P1), folderT(FA1)], MY_INDEX);
    const out = partitionTargets("move", deduped, { tab: "myNotes", index: MY_INDEX, notes: [P1, P2, P3], groupIds: new Set() });
    expect(out).toEqual({ eligible: [folderT(FA)], notesSkipped: 0, foldersSkipped: 0, foldersBlocked: 0 });
  });
});

describe("partitionTargets (favorites tab)", () => {
  const ctx = { tab: "favorites" as const, index: EMPTY_FOLDER_INDEX, notes: [], groupIds: new Set(["g1"]) };
  const cannotDelete = groupNote({ id: "nd", title: "No delete", group: G1, delete: false, edit: false });

  it("removing from favorites is always eligible: delete and edit permissions are ignored, nothing counts as skipped", () => {
    const out = partitionTargets("unfavorite", [noteT(G1A), noteT(cannotDelete), noteT(A)], ctx);
    expect(out).toEqual({ eligible: [noteT(G1A), noteT(cannotDelete), noteT(A)], notesSkipped: 0, foldersSkipped: 0, foldersBlocked: 0 });
  });

  it("delete still depends on permissions.delete", () => {
    const out = partitionTargets("delete", [noteT(G1A), noteT(cannotDelete)], ctx);
    expect(out).toEqual({ eligible: [noteT(G1A)], notesSkipped: 1, foldersSkipped: 0, foldersBlocked: 0 });
  });
});

describe("partitionTargets(delete)", () => {
  const GG1 = new Set(["g1"]);

  it("subtree has live notes and deleteNotes:false -> foldersBlocked 1", () => {
    const gf = groupFolder({ id: "GF", name: "GF", groupId: "g1", delete: false });
    const inside = groupNote({ id: "gn", title: "GN", group: G1, folderId: "GF" });
    const out = partitionTargets("delete", [folderT(gf)], { tab: "workspace", index: indexFolders([gf]), notes: [inside], groupIds: GG1 });
    expect(out).toEqual({ eligible: [], notesSkipped: 0, foldersSkipped: 0, foldersBlocked: 1 });
  });

  it("subtree has live notes, deleteNotes:true -> deleted (not always blocked)", () => {
    const out = partitionTargets("delete", [folderT(FA)], { tab: "myNotes", index: MY_INDEX, notes: [P1, P2, P3], groupIds: new Set() });
    expect(out).toEqual({ eligible: [folderT(FA)], notesSkipped: 0, foldersSkipped: 0, foldersBlocked: 0 });
  });

  it("subtree has no live notes, deleteNotes:false -> deleted", () => {
    const gf = groupFolder({ id: "GF", name: "GF", groupId: "g1", delete: false });
    const out = partitionTargets("delete", [folderT(gf)], { tab: "workspace", index: indexFolders([gf]), notes: [G1A], groupIds: GG1 });
    expect(out).toEqual({ eligible: [folderT(gf)], notesSkipped: 0, foldersSkipped: 0, foldersBlocked: 0 });
  });

  it("manage:false -> foldersSkipped 1", () => {
    const gf = groupFolder({ id: "GF", name: "GF", groupId: "g1", edit: false });
    const out = partitionTargets("delete", [folderT(gf)], { tab: "workspace", index: indexFolders([gf]), notes: [], groupIds: GG1 });
    expect(out).toEqual({ eligible: [], notesSkipped: 0, foldersSkipped: 1, foldersBlocked: 0 });
  });

  it("notes depend on permissions.delete", () => {
    const cannot = groupNote({ id: "nd", title: "No delete", group: G1, delete: false });
    const out = partitionTargets("delete", [noteT(G1A), noteT(cannot)], { tab: "workspace", index: EMPTY_FOLDER_INDEX, notes: [], groupIds: GG1 });
    expect(out).toEqual({ eligible: [noteT(G1A)], notesSkipped: 1, foldersSkipped: 0, foldersBlocked: 0 });
  });

  it("shared tab with notes mixed in -> all notes count as notesSkipped (including those with permissions.delete true), folders are judged as usual", () => {
    const sf = sharedFolder({ id: "SF", name: "SF" });
    const s1 = sharedNote({ id: "s1", title: "S1" });
    const s2 = sharedNote({ id: "s2", title: "S2", permissions: { ...s1.permissions, delete: true } });
    const out = partitionTargets("delete", [folderT(sf), noteT(s1), noteT(s2)], {
      tab: "shared",
      index: indexFolders([sf]),
      notes: [s1, s2],
      groupIds: new Set(),
    });
    expect(out).toEqual({ eligible: [folderT(sf)], notesSkipped: 2, foldersSkipped: 0, foldersBlocked: 0 });
  });
});

describe("partitionTargets(move)", () => {
  it("workspace depends on permissions.edit (not moveToGroup)", () => {
    const viewer = groupNote({ id: "gv", title: "GV", group: G1, edit: false });
    expect(G1A.permissions.moveToGroup).toBe(false);
    const out = partitionTargets("move", [noteT(G1A), noteT(viewer)], { tab: "workspace", index: EMPTY_FOLDER_INDEX, notes: [], groupIds: new Set(["g1"]) });
    expect(out).toEqual({ eligible: [noteT(G1A)], notesSkipped: 1, foldersSkipped: 0, foldersBlocked: 0 });
  });

  it("shared notes are always allowed (viewer too)", () => {
    const viewer = sharedNote({ id: "sv", title: "SV", role: "viewer" });
    const out = partitionTargets("move", [noteT(viewer)], { tab: "shared", index: EMPTY_FOLDER_INDEX, notes: [], groupIds: new Set() });
    expect(out).toEqual({ eligible: [noteT(viewer)], notesSkipped: 0, foldersSkipped: 0, foldersBlocked: 0 });
  });

  it("myNotes: moveToGroup and groupId === null", () => {
    const noMove = personalNote({ id: "nm", title: "NM", permissions: { ...A.permissions, moveToGroup: false } });
    const out = partitionTargets("move", [noteT(A), noteT(noMove)], { tab: "myNotes", index: EMPTY_FOLDER_INDEX, notes: [], groupIds: new Set() });
    expect(out).toEqual({ eligible: [noteT(A)], notesSkipped: 1, foldersSkipped: 0, foldersBlocked: 0 });
  });

  it("folders depend on manage", () => {
    const can = groupFolder({ id: "GF1", name: "GF1", groupId: "g1" });
    const cannot = groupFolder({ id: "GF2", name: "GF2", groupId: "g1", edit: false });
    const out = partitionTargets("move", [folderT(can), folderT(cannot)], {
      tab: "workspace",
      index: indexFolders([can, cannot]),
      notes: [],
      groupIds: new Set(["g1"]),
    });
    expect(out).toEqual({ eligible: [folderT(can)], notesSkipped: 0, foldersSkipped: 1, foldersBlocked: 0 });
  });
});

describe("batchDestSource", () => {
  const GR: GroupDto = groupDto({ id: "gr", name: "Readers" }, customRole());
  const GROUPS = [G1, G2, GR];
  const IDS = new Set(["g1", "g2", "gr"]);
  const PERSONAL = { kind: "personal" } as const;
  const G1S = { kind: "group", groupId: "g1", name: "Group 1" } as const;
  const G2S = { kind: "group", groupId: "g2", name: "Group 2" } as const;

  it("workspace with two groups, move -> mixedGroups", () => {
    expect(batchDestSource({ tab: "workspace", mode: "move", eligible: [noteT(G1A), noteT(G2A)], groups: GROUPS, groupIds: IDS })).toBe("mixedGroups");
  });

  it("workspace with two groups, copy -> current null, others [personal, ...candidates]", () => {
    const src = asSource(batchDestSource({ tab: "workspace", mode: "copy", eligible: [noteT(G1A), noteT(G2A)], groups: GROUPS, groupIds: IDS }));
    expect(src).toMatchObject({ current: null, makeCopy: false, others: [PERSONAL, G1S, G2S] });
  });

  it("single group G (candidate), copy -> current G, makeCopy true, others [personal, H]", () => {
    const src = asSource(batchDestSource({ tab: "workspace", mode: "copy", eligible: [noteT(G1A), noteT(G1B)], groups: GROUPS, groupIds: IDS }));
    expect(src).toMatchObject({ current: G1S, makeCopy: true, others: [PERSONAL, G2S] });
  });

  it("single group G is not a candidate -> current null, makeCopy false", () => {
    const readerNote = groupNote({ id: "rn", title: "RN", group: GR, edit: false });
    const src = asSource(batchDestSource({ tab: "workspace", mode: "copy", eligible: [noteT(readerNote)], groups: GROUPS, groupIds: IDS }));
    expect(src).toMatchObject({ current: null, makeCopy: false, others: [PERSONAL, G1S, G2S] });
  });

  it("workspace with a single group, move (including that group's folders) -> current G, no lower section", () => {
    const gf = groupFolder({ id: "GF", name: "GF", groupId: "g1", parentId: null });
    const src = asSource(batchDestSource({ tab: "workspace", mode: "move", eligible: [noteT(G1A), folderT(gf)], groups: GROUPS, groupIds: IDS }));
    expect(src).toEqual({ mode: "move", current: G1S, makeCopy: false, others: [], locations: [null, null], movingFolders: [gf] });
  });

  it("workspace with a single group that is not in groups (all folders, no note to borrow a name from) -> no upper section and never an empty group name", () => {
    const orphan = groupFolder({ id: "OF", name: "OF", groupId: "g9" });
    const ids = new Set([...IDS, "g9"]);
    const move = asSource(batchDestSource({ tab: "workspace", mode: "move", eligible: [folderT(orphan)], groups: GROUPS, groupIds: ids }));
    expect(move).toMatchObject({ current: null, makeCopy: false, others: [] });
    const copy = asSource(batchDestSource({ tab: "workspace", mode: "copy", eligible: [folderT(orphan)], groups: GROUPS, groupIds: ids }));
    expect(copy).toMatchObject({ current: null, makeCopy: false, others: [PERSONAL, G1S, G2S] });
  });

  it("favorites copy behaves like recent: no upper section", () => {
    const src = asSource(batchDestSource({ tab: "favorites", mode: "copy", eligible: [noteT(A), noteT(G1A)], groups: GROUPS, groupIds: IDS }));
    expect(src).toMatchObject({ current: null, makeCopy: false, others: [PERSONAL, G1S, G2S] });
  });

  it("recent copy -> current null", () => {
    const src = asSource(batchDestSource({ tab: "recent", mode: "copy", eligible: [noteT(A), noteT(G1A)], groups: GROUPS, groupIds: IDS }));
    expect(src).toMatchObject({ current: null, makeCopy: false, others: [PERSONAL, G1S, G2S] });
  });

  it("myNotes: current is personal; move's lower section is the candidate groups, copy adds makeCopy; locations follow each note's own place", () => {
    const move = asSource(batchDestSource({ tab: "myNotes", mode: "move", eligible: [noteT(P1), noteT(P3)], groups: GROUPS, groupIds: IDS }));
    expect(move).toEqual({ mode: "move", current: PERSONAL, makeCopy: false, others: [G1S, G2S], locations: ["A", null], movingFolders: [] });
    const copy = asSource(batchDestSource({ tab: "myNotes", mode: "copy", eligible: [noteT(P1)], groups: GROUPS, groupIds: IDS }));
    expect(copy).toMatchObject({ current: PERSONAL, makeCopy: true, others: [G1S, G2S] });
  });

  it("shared: move has current kind shared and no lower section; copy has no upper section", () => {
    const s = sharedNote({ id: "s", title: "S" });
    const move = asSource(batchDestSource({ tab: "shared", mode: "move", eligible: [noteT(s)], groups: GROUPS, groupIds: IDS }));
    expect(move).toMatchObject({ current: { kind: "shared" }, makeCopy: false, others: [] });
    const copy = asSource(batchDestSource({ tab: "shared", mode: "copy", eligible: [noteT(s)], groups: GROUPS, groupIds: IDS }));
    expect(copy).toMatchObject({ current: null, makeCopy: false, others: [PERSONAL, G1S, G2S] });
  });
});

describe("movingFolders and an empty first level", () => {
  it("myNotes move with folders selected -> movingFolders is non-empty (move only; locations use parentId)", () => {
    const move = asSource(batchDestSource({ tab: "myNotes", mode: "move", eligible: [folderT(FA1), noteT(P3)], groups: [G1], groupIds: new Set(["g1"]) }));
    expect(move.movingFolders).toEqual([FA1]);
    expect(move.locations).toEqual(["A", null]);
    const copy = asSource(batchDestSource({ tab: "myNotes", mode: "copy", eligible: [folderT(FA1)], groups: [G1], groupIds: new Set(["g1"]) }));
    expect(copy.movingFolders).toEqual([]);
  });

  it("shared move, all at root, no shared folders -> isEmptyDestination is true; with shared folders -> false", () => {
    const s = sharedNote({ id: "s", title: "S" });
    const src = asSource(batchDestSource({ tab: "shared", mode: "move", eligible: [noteT(s)], groups: [], groupIds: new Set() }));
    expect(isEmptyDestination(src, EMPTY_FOLDER_INDEX, t)).toBe(true);
    expect(isEmptyDestination(src, indexFolders([sharedFolder({ id: "SF", name: "SF" })]), t)).toBe(false);
  });
});

describe("isSameSpace", () => {
  const personalSource = asSource(batchDestSource({ tab: "myNotes", mode: "move", eligible: [noteT(P3)], groups: [G1], groupIds: new Set(["g1"]) }));
  const groupSource = asSource(batchDestSource({ tab: "workspace", mode: "move", eligible: [noteT(G1A)], groups: [G1], groupIds: new Set(["g1"]) }));
  const recentSource = asSource(batchDestSource({ tab: "recent", mode: "copy", eligible: [noteT(P3)], groups: [G1], groupIds: new Set(["g1"]) }));

  it("personal folder / personal root vs personal current -> true", () => {
    expect(isSameSpace({ kind: "place", space: { kind: "personal" }, folder: FA }, personalSource)).toBe(true);
    expect(isSameSpace(PERSONAL_ROOT, personalSource)).toBe(true);
  });

  it("group root vs personal current -> false (cross-space)", () => {
    expect(isSameSpace(groupRoot("g1", "Group 1"), personalSource)).toBe(false);
  });

  it("same group -> true; another group -> false", () => {
    expect(isSameSpace(groupRoot("g1", "Group 1"), groupSource)).toBe(true);
    expect(isSameSpace(groupRoot("g2", "Group 2"), groupSource)).toBe(false);
  });

  it("makeCopy, or no upper section -> false", () => {
    expect(isSameSpace({ kind: "makeCopy" }, personalSource)).toBe(false);
    expect(isSameSpace(PERSONAL_ROOT, recentSource)).toBe(false);
  });
});

describe("selectionResultTitle (folders)", () => {
  const GF = groupFolder({ id: "GF", name: "GF", groupId: "g", parentId: null });
  const INTO_A: DestTarget = { kind: "place", space: { kind: "personal" }, folder: FA };

  it("move within one space (notes 1, folders 1, A) -> Moved 2 items", () => {
    expect(
      selectionResultTitle(tally({ action: "move", notesDone: 1, foldersDone: 1, sameSpace: true, destination: INTO_A, destinationName: "A" }), t),
    ).toBe("Moved 2 items to “A”");
  });

  it("delete (folders 2, via 3)", () => {
    expect(selectionResultTitle(tally({ action: "delete", foldersDone: 2, trashedViaFolders: 3 }), t)).toBe("2 folders deleted; 3 notes moved to the trash");
  });

  it("delete a folder plus separately selected notes: the suffix count is the cascaded plus the separately selected", () => {
    expect(selectionResultTitle(tally({ action: "delete", foldersDone: 1, trashedViaFolders: 1, notesDone: 1 }), t)).toBe(
      "1 folder deleted; 2 notes moved to the trash",
    );
  });

  it("delete an empty folder -> no notes suffix", () => {
    expect(selectionResultTitle(tally({ action: "delete", foldersDone: 1 }), t)).toBe("1 folder deleted");
  });

  it("shared delete -> foldersRemoved", () => {
    expect(selectionResultTitle(tally({ action: "delete", tab: "shared", foldersDone: 1 }), t)).toBe(
      "1 folder removed; its shared notes moved back to the top level",
    );
  });

  it("blocked 1 and gone 1 -> both suffixes in order (blocked first, gone second)", () => {
    expect(selectionResultTitle(tally({ action: "delete", foldersDone: 1, foldersBlocked: 1, foldersGone: 1 }), t)).toBe(
      "1 folder deleted, 1 folder wasn't deleted (it holds notes you can't delete), 1 folder no longer exists",
    );
  });

  it("notes skipped comes before folders skipped", () => {
    expect(selectionResultTitle(tally({ action: "delete", notesDone: 1, notesSkipped: 1, foldersSkipped: 2 }), t)).toBe(
      "Moved 1 note to the trash, 1 skipped (no permission, or it no longer exists), 2 folders skipped (no permission, or they no longer exist)",
    );
  });

  it("all zero with only blocked -> Nothing was done plus the blocked suffix", () => {
    expect(selectionResultTitle(tally({ action: "delete", foldersBlocked: 1 }), t)).toBe(
      "Nothing was done, 1 folder wasn't deleted (it holds notes you can't delete)",
    );
  });

  it("all zero, notes skipped 1, folders skipped 1 -> noneDone plus the folders suffix", () => {
    expect(selectionResultTitle(tally({ action: "delete", notesSkipped: 1, foldersSkipped: 1 }), t)).toBe(
      "Nothing was done; 1 skipped (no permission, or it no longer exists), 1 folder skipped (no permission, or it no longer exists)",
    );
  });

  it("delete with foldersDone 0, notesDone 1 -> trashed", () => {
    expect(selectionResultTitle(tally({ action: "delete", notesDone: 1 }), t)).toBe("Moved 1 note to the trash");
  });

  describe("copy (reuses existing keys)", () => {
    it("1 note into personal root -> copiedToPersonal", () => {
      expect(selectionResultTitle(tally({ action: "copy", notesDone: 1, destination: PERSONAL_ROOT, destinationName: "My notes" }), t)).toBe(
        "Copied 1 note to My notes",
      );
    });

    it("2 notes into personal folder A -> copiedToGroup (full path)", () => {
      expect(selectionResultTitle(tally({ action: "copy", notesDone: 2, destination: INTO_A, destinationName: "My notes › A" }), t)).toBe(
        'Copied 2 notes into "My notes › A"',
      );
    });

    it("group root -> copiedToGroup", () => {
      expect(selectionResultTitle(tally({ action: "copy", notesDone: 2, destination: groupRoot("g", "G"), destinationName: "G" }), t)).toBe(
        'Copied 2 notes into "G"',
      );
    });

    it("group folder -> copiedToGroup (full path)", () => {
      const destination: DestTarget = { kind: "place", space: { kind: "group", groupId: "g", name: "G" }, folder: GF };
      expect(selectionResultTitle(tally({ action: "copy", notesDone: 1, destination, destinationName: "G › GF" }), t)).toBe('Copied 1 note into "G › GF"');
    });

    it("makeCopy, personal source -> copiedToPersonal", () => {
      expect(
        selectionResultTitle(tally({ action: "copy", notesDone: 1, destination: { kind: "makeCopy" }, copySource: { kind: "personal" } }), t),
      ).toBe("Copied 1 note to My notes");
    });

    it("makeCopy, group G source -> copiedToGroup (group name)", () => {
      expect(
        selectionResultTitle(
          tally({ action: "copy", notesDone: 2, destination: { kind: "makeCopy" }, copySource: { kind: "group", groupId: "g", name: "G" } }),
          t,
        ),
      ).toBe('Copied 2 notes into "G"');
    });
  });

  it("zh-TW, two cases: move within one space, delete a folder", async () => {
    await i18n.changeLanguage("zh-TW");
    try {
      expect(
        selectionResultTitle(tally({ action: "move", notesDone: 1, foldersDone: 1, sameSpace: true, destination: INTO_A, destinationName: "A" }), t),
      ).toBe("已移 2 項到「A」");
      expect(selectionResultTitle(tally({ action: "delete", foldersDone: 2, trashedViaFolders: 3, foldersBlocked: 1 }), t)).toBe(
        "已刪除 2 個資料夾，3 篇筆記已移到垃圾桶，1 個資料夾沒有刪除（裡面有你不能刪除的筆記）",
      );
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});

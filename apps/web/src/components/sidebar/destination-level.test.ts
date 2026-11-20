import { beforeEach, describe, expect, it } from "vitest";
import type { FolderDto, GroupDto, NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import en from "@/i18n/en.json";
import zhTW from "@/i18n/zh-TW.json";
import { customRole, groupDto, memberRole } from "@/test/fixtures";
import { folderChain, folderDto, groupFolder, sharedFolder } from "@/test/folder-fixtures";
import { groupNote, personalNote, sharedNote } from "@/test/select-fixtures";
import {
  buildDestinationLevel,
  destinationPathLabel,
  destinationShortLabel,
  isEmptyDestination,
  noteDestSource,
  spaceKey,
  type DestItem,
  type DestMode,
  type DestPathStep,
  type DestSource,
  type DestSpace,
} from "./destination-level";
import { EMPTY_FOLDER_INDEX, indexFolders, type FolderIndex } from "./folder-index";

/**
 * Per-level destination list. Fixture: personal folder A > A1, B; group G (member: create + edit) with GF > GF1; group H (member) without folders;
 * group R (read-only); shared folder SF. Assertions compare `[kind, label, has drill, disabled]`.
 */

const t = i18n.t.bind(i18n) as (key: string, options?: Record<string, unknown>) => string;

const G: GroupDto = groupDto({ id: "g", name: "G" }, memberRole());
const H: GroupDto = groupDto({ id: "h", name: "H" }, memberRole());
const R: GroupDto = groupDto({ id: "r", name: "R" }, customRole());
const GROUPS: readonly GroupDto[] = [G, H, R];

const A = folderDto({ id: "A", name: "A" });
const A1 = folderDto({ id: "A1", name: "A1", parentId: "A" });
const B = folderDto({ id: "B", name: "B" });
const GF = groupFolder({ id: "GF", name: "GF", groupId: "g" });
const GF1 = groupFolder({ id: "GF1", name: "GF1", groupId: "g", parentId: "GF" });
const SF = sharedFolder({ id: "SF", name: "SF" });
const INDEX = indexFolders([A, A1, B, GF, GF1, SF]);

const PERSONAL: DestSpace = { kind: "personal" };
const SHARED: DestSpace = { kind: "shared" };
const G_SPACE: DestSpace = { kind: "group", groupId: "g", name: "G" };
const H_SPACE: DestSpace = { kind: "group", groupId: "h", name: "H" };

type Shape = [DestItem["kind"], string, boolean, string | null];

function shape(items: readonly DestItem[]): Shape[] {
  return items.map((item): Shape => {
    if (item.kind === "separator") return ["separator", "", false, null];
    if (item.kind === "back") return ["back", item.label, false, null];
    const drill = "drill" in item && item.drill !== null;
    return [item.kind, item.label, drill, item.disabled];
  });
}

function level(source: DestSource, path: readonly DestPathStep[] = [], index: FolderIndex = INDEX): DestItem[] {
  return buildDestinationLevel({ source, path, index, t });
}

function noteLevel(note: NoteDto, mode: DestMode, path: readonly DestPathStep[] = [], index: FolderIndex = INDEX): Shape[] {
  return shape(level(noteDestSource(note, mode, GROUPS), path, index));
}

function batch(o: Partial<DestSource> & { movingFolders?: readonly FolderDto[] }): DestSource {
  return { mode: "move", current: PERSONAL, makeCopy: false, others: [G_SPACE, H_SPACE], locations: [null], movingFolders: [], ...o };
}

const SEP: Shape = ["separator", "", false, null];
const BACK: Shape = ["back", "Back", false, null];

const mine = (folderId: string | null = null) => personalNote({ id: "n1", title: "N", folderId });
const inG = (folderId: string | null = null, edit = true) => groupNote({ id: "g1", title: "GN", group: G, edit, folderId });
const shared = (folderId: string | null = null) => sharedNote({ id: "s1", title: "SN", folderId });

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

describe("personal note at root, move, first level", () => {
  it("[folder A >, folder B, sep, space G >, space H]: no root entry, no R", () => {
    expect(noteLevel(mine(), "move")).toEqual([
      ["folder", "A", true, null],
      ["folder", "B", false, null],
      SEP,
      ["space", "G", true, null],
      ["space", "H", false, null],
    ]);
  });

  it("target and drill: a folder means put into it, a space means its root; drill points to the next level", () => {
    const items = level(noteDestSource(mine(), "move", GROUPS));
    const a = items[0]!;
    const b = items[1]!;
    const g = items[3]!;
    const h = items[4]!;
    expect(a).toMatchObject({ kind: "folder", target: { kind: "place", space: PERSONAL, folder: A }, drill: { kind: "folder", folderId: "A" } });
    expect(b).toMatchObject({ kind: "folder", target: { kind: "place", space: PERSONAL, folder: B }, drill: null });
    expect(g).toMatchObject({ kind: "space", target: { kind: "place", space: G_SPACE, folder: null }, drill: { kind: "space", space: G_SPACE } });
    expect(h).toMatchObject({ kind: "space", target: { kind: "place", space: H_SPACE, folder: null }, drill: null });
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
  });
});

describe("same note in A1, move", () => {
  it("first level gets a root entry at the front", () => {
    expect(noteLevel(mine("A1"), "move")).toEqual([
      ["root", "Top level", false, null],
      ["folder", "A", true, null],
      ["folder", "B", false, null],
      SEP,
      ["space", "G", true, null],
      ["space", "H", false, null],
    ]);
    expect(level(noteDestSource(mine("A1"), "move", GROUPS))[0]).toMatchObject({ target: { kind: "place", space: PERSONAL, folder: null } });
  });
});

describe("drilled into A", () => {
  const PATH: DestPathStep[] = [{ kind: "folder", folderId: "A" }];

  it("note in A1: [back, here, folder A1], no separator, here not greyed out; A1 is the current location with no subfolders -> current", () => {
    expect(noteLevel(mine("A1"), "move", PATH)).toEqual([BACK, ["here", "Move here", false, null], ["folder", "A1", false, "current"]]);
    expect(level(noteDestSource(mine("A1"), "move", GROUPS), PATH)[1]).toMatchObject({ target: { kind: "place", space: PERSONAL, folder: A } });
  });

  it("note in A: here -> current", () => {
    expect(noteLevel(mine("A"), "move", PATH)).toEqual([BACK, ["here", "Move here", false, "current"], ["folder", "A1", false, null]]);
  });
});

describe("drilled into G", () => {
  it("[back, root, folder GF >]: the root entry is always shown and points at G's root", () => {
    const path: DestPathStep[] = [{ kind: "space", space: G_SPACE }];
    expect(noteLevel(mine(), "move", path)).toEqual([BACK, ["root", "Top level", false, null], ["folder", "GF", true, null]]);
    const items = level(noteDestSource(mine(), "move", GROUPS), path);
    expect(items[1]).toMatchObject({ target: { kind: "place", space: G_SPACE, folder: null } });
    expect(items[2]).toMatchObject({ target: { kind: "place", space: G_SPACE, folder: GF }, drill: { kind: "folder", folderId: "GF" } });
  });

  it("drilling further into GF: [back, here, folder GF1]", () => {
    const path: DestPathStep[] = [{ kind: "space", space: G_SPACE }, { kind: "folder", folderId: "GF" }];
    expect(noteLevel(mine(), "move", path)).toEqual([BACK, ["here", "Move here", false, null], ["folder", "GF1", false, null]]);
  });
});

describe("folder entry that is the current location and has no subfolders", () => {
  it("note in B -> B is current, A is not greyed out", () => {
    expect(noteLevel(mine("B"), "move")).toEqual([
      ["root", "Top level", false, null],
      ["folder", "A", true, null],
      ["folder", "B", false, "current"],
      SEP,
      ["space", "G", true, null],
      ["space", "H", false, null],
    ]);
  });
});

describe("group note move", () => {
  it("edit: at root -> [folder GF >] with no lower section; in GF1 -> [root, folder GF >]", () => {
    expect(noteLevel(inG(), "move")).toEqual([["folder", "GF", true, null]]);
    expect(noteLevel(inG("GF1"), "move")).toEqual([
      ["root", "Top level", false, null],
      ["folder", "GF", true, null],
    ]);
    expect(noteDestSource(inG(), "move", GROUPS)).toMatchObject({ current: G_SPACE, others: [], locations: [null] });
  });

  it("edit: false -> isEmptyDestination is true", () => {
    expect(isEmptyDestination(noteDestSource(inG(null, false), "move", GROUPS), INDEX, t)).toBe(true);
    expect(isEmptyDestination(noteDestSource(inG(), "move", GROUPS), INDEX, t)).toBe(false);
  });
});

describe("shared note move", () => {
  it("not placed -> [folder SF]; placed in SF -> [root, folder SF current]", () => {
    expect(noteLevel(shared(), "move")).toEqual([["folder", "SF", false, null]]);
    expect(noteLevel(shared("SF"), "move")).toEqual([
      ["root", "Top level", false, null],
      ["folder", "SF", false, "current"],
    ]);
    expect(level(noteDestSource(shared(), "move", GROUPS))[0]).toMatchObject({ target: { kind: "place", space: SHARED, folder: SF } });
  });

  it("no shared folder and no placement -> empty; with a shared folder -> not empty", () => {
    const noShared = indexFolders([A, A1, B, GF, GF1]);
    expect(isEmptyDestination(noteDestSource(shared(), "move", GROUPS), noShared, t)).toBe(true);
    expect(isEmptyDestination(noteDestSource(shared(), "move", GROUPS), INDEX, t)).toBe(false);
  });
});

describe("copy, three shapes", () => {
  it("personal note -> [makeCopy, folder A >, folder B, sep, space G >, space H] (lower section excludes My notes)", () => {
    expect(noteLevel(mine(), "copy")).toEqual([
      ["makeCopy", "Make a copy", false, null],
      ["folder", "A", true, null],
      ["folder", "B", false, null],
      SEP,
      ["space", "G", true, null],
      ["space", "H", false, null],
    ]);
    expect(level(noteDestSource(mine(), "copy", GROUPS))[0]).toMatchObject({ target: { kind: "makeCopy" } });
  });

  it("group note (G is a candidate) -> [makeCopy, folder GF >, sep, space My notes >, space H]", () => {
    expect(noteLevel(inG(), "copy")).toEqual([
      ["makeCopy", "Make a copy", false, null],
      ["folder", "GF", true, null],
      SEP,
      ["space", "My notes", true, null],
      ["space", "H", false, null],
    ]);
  });

  it("shared note -> [space My notes >, space G >, space H] (no upper section, no separator)", () => {
    expect(noteLevel(shared("SF"), "copy")).toEqual([
      ["space", "My notes", true, null],
      ["space", "G", true, null],
      ["space", "H", false, null],
    ]);
  });

  it("copy of R's read-only note -> [space My notes >, space G >, space H]", () => {
    const readOnly = groupNote({ id: "r1", title: "RN", group: R, edit: false });
    expect(noteLevel(readOnly, "copy")).toEqual([
      ["space", "My notes", true, null],
      ["space", "G", true, null],
      ["space", "H", false, null],
    ]);
  });

  it("for copy, here and folder entries at the source location are not greyed out", () => {
    expect(noteLevel(mine("B"), "copy")).toEqual([
      ["makeCopy", "Make a copy", false, null],
      ["root", "Top level", false, null],
      ["folder", "A", true, null],
      ["folder", "B", false, null],
      SEP,
      ["space", "G", true, null],
      ["space", "H", false, null],
    ]);
    expect(noteLevel(mine("A"), "copy", [{ kind: "folder", folderId: "A" }])).toEqual([
      BACK,
      ["here", "Copy here", false, null],
      ["folder", "A1", false, null],
    ]);
  });
});

describe("batch move including folders", () => {
  it("movingFolders=[A] -> A is self without drill; lower-section G and H are crossSpace without drill", () => {
    expect(shape(level(batch({ movingFolders: [A] })))).toEqual([
      ["folder", "A", false, "self"],
      ["folder", "B", false, null],
      SEP,
      ["space", "G", false, "crossSpace"],
      ["space", "H", false, "crossSpace"],
    ]);
  });

  it("here inside B is enabled", () => {
    expect(shape(level(batch({ movingFolders: [A] }), [{ kind: "folder", folderId: "B" }]))).toEqual([
      BACK,
      ["here", "Move here", false, null],
    ]);
  });

  it("descendants are self too (the path is already inside A, e.g. drilled before the cache refreshed)", () => {
    expect(shape(level(batch({ movingFolders: [A] }), [{ kind: "folder", folderId: "A" }]))).toEqual([
      BACK,
      ["here", "Move here", false, "self"],
      ["folder", "A1", false, "self"],
    ]);
  });
});

describe("depth limit (server: parentDepth + height > FOLDER_DEPTH_MAX)", () => {
  const D = folderChain("D", 4);
  const DEEP = indexFolders([A, A1, B, ...D]);
  const source = batch({ movingFolders: [A] }); // A has height 2

  it("drilled into D1 > D2 > D3: here (3 + 2 = 5) is enabled, D4 (4 + 2 = 6) is tooDeep", () => {
    const path: DestPathStep[] = ["D1", "D2", "D3"].map((folderId) => ({ kind: "folder", folderId }));
    expect(shape(level(source, path, DEEP))).toEqual([BACK, ["here", "Move here", false, null], ["folder", "D4", false, "tooDeep"]]);
  });

  it("drilled into D1 > D2: D3 is enabled and has drill", () => {
    const path: DestPathStep[] = ["D1", "D2"].map((folderId) => ({ kind: "folder", folderId }));
    expect(shape(level(source, path, DEEP))).toEqual([BACK, ["here", "Move here", false, null], ["folder", "D3", true, null]]);
  });

  it("a tooDeep folder has no drill even with subfolders; its here is tooDeep too", () => {
    const D5 = folderChain("D", 5);
    const deeper = indexFolders([A, A1, B, ...D5]);
    const path: DestPathStep[] = ["D1", "D2", "D3"].map((folderId) => ({ kind: "folder", folderId }));
    expect(shape(level(source, path, deeper))).toEqual([BACK, ["here", "Move here", false, null], ["folder", "D4", false, "tooDeep"]]);
    const inD4: DestPathStep[] = ["D1", "D2", "D3", "D4"].map((folderId) => ({ kind: "folder", folderId }));
    expect(shape(level(source, inD4, deeper))[1]).toEqual(["here", "Move here", false, "tooDeep"]);
  });
});

describe("greyed out only when all are already there (batch)", () => {
  const FLAT = indexFolders([A, B]); // variant where A has no subfolders

  it("one in A, one at root -> A is not greyed out", () => {
    expect(shape(level(batch({ locations: ["A", null] }), [], FLAT))).toEqual([
      ["root", "Top level", false, null],
      ["folder", "A", false, null],
      ["folder", "B", false, null],
      SEP,
      ["space", "G", false, null],
      ["space", "H", false, null],
    ]);
  });

  it("both in A -> A is current", () => {
    expect(shape(level(batch({ locations: ["A", "A"] }), [], FLAT))[1]).toEqual(["folder", "A", false, "current"]);
  });
});

describe("folders not loaded (EMPTY_FOLDER_INDEX)", () => {
  it("only root and space entries, none with drill", () => {
    expect(noteLevel(mine("A1"), "move", [], EMPTY_FOLDER_INDEX)).toEqual([
      ["root", "Top level", false, null],
      SEP,
      ["space", "G", false, null],
      ["space", "H", false, null],
    ]);
    expect(noteLevel(shared(), "copy", [], EMPTY_FOLDER_INDEX)).toEqual([
      ["space", "My notes", false, null],
      ["space", "G", false, null],
      ["space", "H", false, null],
    ]);
  });
});

describe("path points at a missing folder", () => {
  it("A1 is gone -> falls back to A's level", () => {
    const noA1 = indexFolders([A, B, GF, GF1, SF]);
    const path: DestPathStep[] = [{ kind: "folder", folderId: "A" }, { kind: "folder", folderId: "A1" }];
    expect(noteLevel(mine(), "move", path, noA1)).toEqual([BACK, ["here", "Move here", false, null]]);
  });

  it("first step is gone -> falls back to the first level (later steps that still exist are dropped too)", () => {
    const path: DestPathStep[] = [{ kind: "folder", folderId: "gone" }, { kind: "folder", folderId: "A1" }];
    expect(noteLevel(mine(), "move", path)).toEqual(noteLevel(mine(), "move"));
  });

  it("the drilled space is no longer in source (vanished after the group list refetch) -> falls back to the first level", () => {
    const path: DestPathStep[] = [{ kind: "space", space: { kind: "group", groupId: "x", name: "X" } }];
    expect(noteLevel(mine(), "move", path)).toEqual(noteLevel(mine(), "move"));
  });
});

describe("accessible names and path strings", () => {
  it("en: drill item 'A, open', back 'Back', everything else equals label", () => {
    const items = level(noteDestSource(mine(), "move", GROUPS));
    expect(items[0]).toMatchObject({ label: "A", accessibleName: "A, open" });
    expect(items[1]).toMatchObject({ label: "B", accessibleName: "B" });
    expect(items[3]).toMatchObject({ label: "G", accessibleName: "G, open" });
    const inner = level(noteDestSource(mine(), "move", GROUPS), [{ kind: "folder", folderId: "A" }]);
    expect(inner[0]).toMatchObject({ kind: "back", label: "Back", accessibleName: "Back" });
    expect(inner[1]).toMatchObject({ accessibleName: "Move here" });
  });

  it("zh-TW: drill item 'A, open next level' and the zh-TW Back label", async () => {
    await i18n.changeLanguage("zh-TW");
    const items = level(noteDestSource(mine(), "move", GROUPS));
    expect(items[0]).toMatchObject({ accessibleName: "A，開啟下一層" });
    const inner = level(noteDestSource(mine(), "move", GROUPS), [{ kind: "folder", folderId: "A" }]);
    expect(inner[0]).toMatchObject({ label: "返回", accessibleName: "返回" });
  });

  it("destinationPathLabel: personal A1, group root, shared SF", () => {
    expect(destinationPathLabel(PERSONAL, A1, INDEX, t)).toBe("My notes › A › A1");
    expect(destinationPathLabel(G_SPACE, null, INDEX, t)).toBe("G");
    expect(destinationPathLabel(SHARED, SF, INDEX, t)).toBe("Shared with me › SF");
    expect(destinationPathLabel(PERSONAL, null, INDEX, t)).toBe("My notes");
  });

  it("destinationShortLabel: folder name; root level is the Top level label (en) / the root label (zh-TW)", async () => {
    expect(destinationShortLabel(A1, t)).toBe("A1");
    expect(destinationShortLabel(null, t)).toBe("Top level");
    await i18n.changeLanguage("zh-TW");
    expect(destinationShortLabel(null, t)).toBe("根目錄");
  });
});

describe("noteDestSource and spaceKey", () => {
  it("spaceKey, three shapes", () => {
    expect(spaceKey(PERSONAL)).toBe("personal");
    expect(spaceKey(SHARED)).toBe("shared");
    expect(spaceKey(G_SPACE)).toBe("group:g");
  });

  it("locations = [note.folderId] and movingFolders is empty; the group name comes from groups", () => {
    expect(noteDestSource(mine("A1"), "copy", GROUPS)).toEqual({
      mode: "copy",
      current: PERSONAL,
      makeCopy: true,
      others: [G_SPACE, H_SPACE],
      locations: ["A1"],
      movingFolders: [],
    });
    expect(noteDestSource(inG(), "copy", GROUPS)).toEqual({
      mode: "copy",
      current: G_SPACE,
      makeCopy: true,
      others: [PERSONAL, H_SPACE],
      locations: [null],
      movingFolders: [],
    });
    expect(noteDestSource(shared("SF"), "move", GROUPS)).toMatchObject({ current: SHARED, makeCopy: false, others: [], locations: ["SF"] });
  });

  it("group renamed but the note cache still has the old name -> the space name follows groups; note.group.name is used only when groups lacks it", () => {
    const stale = groupNote({ id: "g2", title: "GN", group: { ...G, name: "Old G" } });
    expect(noteDestSource(stale, "move", GROUPS).current).toEqual(G_SPACE);
    expect(noteDestSource(stale, "move", []).current).toEqual({ kind: "group", groupId: "g", name: "Old G" });
  });

  it("read-only group note move -> current null, others empty (so the first level is empty)", () => {
    const readOnly = groupNote({ id: "r1", title: "RN", group: R, edit: false });
    expect(noteDestSource(readOnly, "move", GROUPS)).toMatchObject({ current: null, others: [] });
    expect(isEmptyDestination(noteDestSource(readOnly, "move", GROUPS), INDEX, t)).toBe(true);
  });

  it("groups not loaded ([]): personal move keeps only its own space; group note copy loses the upper section", () => {
    expect(noteDestSource(mine(), "move", [])).toMatchObject({ current: PERSONAL, others: [] });
    expect(noteDestSource(inG(), "copy", [])).toMatchObject({ current: null, makeCopy: false, others: [PERSONAL] });
  });
});

describe("strings", () => {
  const get = (obj: unknown, path: string): unknown =>
    path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);

  it.each([
    ["folders.dest.topLevel", "根目錄", "Top level"],
    ["folders.dest.back", "返回", "Back"],
    ["folders.dest.moveHere", "移動到這裡", "Move here"],
    ["folders.dest.copyHere", "複製到這裡", "Copy here"],
    ["folders.dest.openLevel", "{{name}}，開啟下一層", "{{name}}, open"],
  ])("%s", (key, zh, enText) => {
    expect(get(zhTW, key)).toBe(zh);
    expect(get(en, key)).toBe(enText);
  });
});

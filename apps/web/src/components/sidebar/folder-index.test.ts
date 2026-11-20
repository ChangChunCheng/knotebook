import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { FOLDERS_QUERY_KEY } from "@/api/folders";
import { toast } from "@/components/ui/toast";
import { folderChain, folderDto, groupFolder, sharedFolder } from "@/test/folder-fixtures";
import { baseNote } from "@/test/select-fixtures";
import { __resetCollapseForTests, isCollapsed, setCollapsed } from "./collapse";
import { __resetFolderSortForTests } from "./folder-sort";
import type { NoteDto } from "@knotebook/shared";
import {
  EMPTY_FOLDER_INDEX,
  expandAfterRestore,
  expandFolderChain,
  folderDepth,
  folderPath,
  indexFolders,
  isInSubtree,
  liveNotesUnder,
  subtreeFolderIds,
  subtreeHeight,
  type FolderSpaceKey,
} from "./folder-index";

afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
  __resetFolderSortForTests();
});

const ids = (list: readonly { id: string }[]) => list.map((item) => item.id);
/** Test note space: group notes -> group:<id>, everything else -> personal (product code: noteSpaceKey in tree.ts). */
const spaceOf = (note: NoteDto): FolderSpaceKey => (note.groupId === null ? "personal" : `group:${note.groupId}`);

describe("indexFolders", () => {
  it("three spaces with two levels each, shuffled input -> children ordered by name (numeric: chapter 2 before chapter 10; sensitivity base: a and A compare equal and keep input order)", () => {
    const index = indexFolders([
      folderDto({ id: "p10", name: "第 10 章" }),
      sharedFolder({ id: "sZ", name: "Zed" }),
      folderDto({ id: "pUpper", name: "A" }),
      groupFolder({ id: "gChildB", name: "Beta", groupId: "g1", parentId: "gZ" }),
      folderDto({ id: "p2", name: "第 2 章" }),
      groupFolder({ id: "gZ", name: "Zed", groupId: "g1" }),
      folderDto({ id: "pLower", name: "a" }),
      sharedFolder({ id: "sChildB", name: "Beta", parentId: "sA" }),
      folderDto({ id: "c2", name: "Beta", parentId: "p2" }),
      groupFolder({ id: "gA", name: "Ann", groupId: "g1" }),
      sharedFolder({ id: "sA", name: "Ann" }),
      folderDto({ id: "c1", name: "Alpha", parentId: "p2" }),
      groupFolder({ id: "gChildA", name: "Alpha", groupId: "g1", parentId: "gZ" }),
      sharedFolder({ id: "sChildA", name: "Alpha", parentId: "sA" }),
    ]);
    // zh-Hant collator: Han characters sort before Latin letters.
    expect(ids(index.children("personal", null))).toEqual(["p2", "p10", "pUpper", "pLower"]);
    expect(ids(index.children("personal", "p2"))).toEqual(["c1", "c2"]);
    expect(ids(index.children("group:g1", null))).toEqual(["gA", "gZ"]);
    expect(ids(index.children("group:g1", "gZ"))).toEqual(["gChildA", "gChildB"]);
    expect(ids(index.children("shared", null))).toEqual(["sA", "sZ"]);
    expect(ids(index.children("shared", "sA"))).toEqual(["sChildA", "sChildB"]);
    expect(index.byId.get("c1")?.name).toBe("Alpha");
  });

  it("parentId pointing at a missing id -> appears at that space's root", () => {
    const index = indexFolders([folderDto({ id: "root", name: "Root" }), folderDto({ id: "lost", name: "Lost", parentId: "missing" })]);
    expect(ids(index.children("personal", null))).toEqual(["lost", "root"]);
  });

  it("parentId pointing at a folder in another space -> root (not attached under the other space's parent)", () => {
    const index = indexFolders([groupFolder({ id: "gf", name: "Group folder", groupId: "g1" }), folderDto({ id: "mine", name: "Mine", parentId: "gf" })]);
    expect(ids(index.children("personal", null))).toEqual(["mine"]);
    expect(ids(index.children("group:g1", "gf"))).toEqual([]);
    expect(ids(index.children("personal", "gf"))).toEqual([]);
  });

  it("cycle (A.parent=B, B.parent=A): not attached; folderPath names are unique, subtreeFolderIds ids are unique, and lengths are at most the folder count", () => {
    const folders = [folderDto({ id: "cA", name: "Cyc A", parentId: "cB" }), folderDto({ id: "cB", name: "Cyc B", parentId: "cA" })];
    const index = indexFolders(folders);
    const path = folderPath(index, "cA");
    expect(path).not.toBeNull();
    expect(new Set(path).size).toBe(path!.length);
    expect(path!.length).toBeLessThanOrEqual(folders.length);
    expect(path!.at(-1)).toBe("Cyc A");
    const subtree = subtreeFolderIds(index, "cA");
    expect(new Set(subtree).size).toBe(subtree.length);
    expect(subtree.length).toBeLessThanOrEqual(folders.length);
    expect(subtree[0]).toBe("cA");
  });

  it("EMPTY_FOLDER_INDEX: no folders, every children lookup is []", () => {
    expect(EMPTY_FOLDER_INDEX.byId.size).toBe(0);
    expect(EMPTY_FOLDER_INDEX.children("personal", null)).toEqual([]);
  });
});

describe("folderPath / subtreeFolderIds / liveNotesUnder", () => {
  it("three levels -> [A, B, C]; missing -> null", () => {
    const index = indexFolders(folderChain("L", 3).map((folder, i) => ({ ...folder, name: ["A", "B", "C"][i]! })));
    expect(folderPath(index, "L3")).toEqual(["A", "B", "C"]);
    expect(folderPath(index, "L1")).toEqual(["A"]);
    expect(folderPath(index, "nope")).toBeNull();
  });

  it("subtreeFolderIds: includes itself and grandchildren, excludes siblings", () => {
    const index = indexFolders([
      folderDto({ id: "A", name: "A" }),
      folderDto({ id: "B", name: "B", parentId: "A" }),
      folderDto({ id: "C", name: "C", parentId: "B" }),
      folderDto({ id: "B2", name: "B2", parentId: "A" }),
      folderDto({ id: "S", name: "S" }),
    ]);
    const subtree = subtreeFolderIds(index, "A");
    expect([...subtree].sort()).toEqual(["A", "B", "B2", "C"]);
    expect(subtree).not.toContain("S");
    expect(subtreeFolderIds(index, "B")).toEqual(["B", "C"]);
  });

  it("liveNotesUnder: two in the subtree plus one in a grandchild folder -> three; notes outside the subtree and at the root do not count", () => {
    const index = indexFolders([
      folderDto({ id: "A", name: "A" }),
      folderDto({ id: "B", name: "B", parentId: "A" }),
      folderDto({ id: "C", name: "C", parentId: "B" }),
      folderDto({ id: "S", name: "S" }),
    ]);
    const notes = [
      baseNote({ id: "inA", title: "in A", folderId: "A" }),
      baseNote({ id: "outS", title: "out S", folderId: "S" }),
      baseNote({ id: "inB", title: "in B", folderId: "B" }),
      baseNote({ id: "root", title: "root", folderId: null }),
      baseNote({ id: "inC", title: "in C", folderId: "C" }),
    ];
    expect(ids(liveNotesUnder(index, "A", notes, spaceOf))).toEqual(["inA", "inB", "inC"]);
  });

  it("liveNotesUnder compares spaces: a note space that differs from the folder space (inconsistent cache) does not count (consistent with the tree's fallback)", () => {
    const index = indexFolders([groupFolder({ id: "gf", name: "Group folder", groupId: "g1" })]);
    const notes = [
      baseNote({ id: "groupIn", title: "group in", groupId: "g1", group: { id: "g1", name: "G1" }, folderId: "gf" }),
      baseNote({ id: "personalCross", title: "personal cross", folderId: "gf" }),
    ];
    expect(ids(liveNotesUnder(index, "gf", notes, spaceOf))).toEqual(["groupIn"]);
  });

  it("cycles and self-reference: after breaking the cycle parentOf, folderPath and expandFolderChain agree (the cycle entry is treated as root, the rest keep their parents)", () => {
    // D appears first: walking up from D, the first repeat is cA, so the cycle is cut at cA and D stays under cA.
    const index = indexFolders([
      folderDto({ id: "D", name: "D", parentId: "cA" }),
      folderDto({ id: "cA", name: "Cyc A", parentId: "cB" }),
      folderDto({ id: "cB", name: "Cyc B", parentId: "cA" }),
      folderDto({ id: "self", name: "Self", parentId: "self" }),
    ]);
    expect(index.parentOf("cA")).toBeNull();
    expect(index.parentOf("cB")).toBe("cA");
    expect(index.parentOf("D")).toBe("cA");
    expect(index.parentOf("self")).toBeNull();
    expect(ids(index.children("personal", null))).toEqual(["cA", "self"]);
    expect(folderPath(index, "cA")).toEqual(["Cyc A"]);
    expect(folderPath(index, "cB")).toEqual(["Cyc A", "Cyc B"]);
    expect(folderPath(index, "self")).toEqual(["Self"]);
    for (const id of ["cA", "cB", "D"]) setCollapsed(`folder:${id}`, true);
    expandFolderChain(index, "cA");
    expect(isCollapsed("folder:cA")).toBe(false);
    expect(isCollapsed("folder:cB")).toBe(true);
    expandFolderChain(index, "D");
    expect(isCollapsed("folder:D")).toBe(false);
    expect(isCollapsed("folder:cB")).toBe(true);
  });
});

describe("expandFolderChain", () => {
  it("all three levels collapsed -> all expanded after the call, siblings unaffected; id not in the index -> writes only its own key, no throw", () => {
    const index = indexFolders([...folderChain("L", 3), folderDto({ id: "sib", name: "Sibling", parentId: "L1" })]);
    for (const id of ["L1", "L2", "L3", "sib"]) setCollapsed(`folder:${id}`, true);
    expandFolderChain(index, "L3");
    expect(isCollapsed("folder:L1")).toBe(false);
    expect(isCollapsed("folder:L2")).toBe(false);
    expect(isCollapsed("folder:L3")).toBe(false);
    expect(isCollapsed("folder:sib")).toBe(true);

    setCollapsed("folder:ghost", true);
    expect(() => expandFolderChain(index, "ghost")).not.toThrow();
    expect(isCollapsed("folder:ghost")).toBe(false);
    expect(isCollapsed("folder:sib")).toBe(true);
  });
});

// expandAfterRestore must not touch toast; wrapped only to count calls, behavior unchanged.
vi.mock("@/components/ui/toast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/toast")>();
  return { ...actual, toast: vi.fn(actual.toast) };
});

describe("expandAfterRestore (expand after folder restore)", () => {
  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  function stubFolders(reply: () => Response) {
    const gets: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/folders" && method === "GET") {
          gets.push(url);
          return Promise.resolve(reply());
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
    return gets;
  }

  const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const note = (id: string, folderId: string | null) => baseNote({ id, title: id, folderId });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(toast).mockClear();
  });

  it("['folders'] has no observer and its cache is stale (missing the rebuilt folder and ancestors) -> issues GET /api/folders and expands the new folder and its ancestors", async () => {
    const chain = folderChain("R", 3); // R1 > R2 > R3 (restore rebuilds the original path)
    const gets = stubFolders(() => json({ folders: [folderDto({ id: "old", name: "Old" }), ...chain] }));
    const qc = client();
    qc.setQueryData(FOLDERS_QUERY_KEY, [folderDto({ id: "old", name: "Old" })]);
    for (const id of ["R1", "R2", "R3", "old"]) setCollapsed(`folder:${id}`, true);

    await expandAfterRestore(qc, [note("n1", "R3"), note("n2", null)]);

    expect(gets).toHaveLength(1);
    expect(isCollapsed("folder:R1")).toBe(false);
    expect(isCollapsed("folder:R2")).toBe(false);
    expect(isCollapsed("folder:R3")).toBe(false);
    expect(isCollapsed("folder:old")).toBe(true);
  });

  it("restored all folderId: null (or an empty array) -> no GET /api/folders", async () => {
    const gets = stubFolders(() => json({ folders: [] }));
    const qc = client();
    await expandAfterRestore(qc, [note("n1", null), note("n2", null)]);
    await expandAfterRestore(qc, []);
    expect(gets).toHaveLength(0);
  });

  it("GET /api/folders returns 500 -> the promise resolves normally, no unhandled rejection, no toast", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const gets = stubFolders(() => json({ error: { code: "internal", message: "x" } }, 500));
      const qc = client();
      setCollapsed("folder:R1", true);
      await expect(expandAfterRestore(qc, [note("n1", "R1")])).resolves.toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(gets).toHaveLength(1);
      expect(unhandled).not.toHaveBeenCalled();
      expect(toast).not.toHaveBeenCalled();
      expect(isCollapsed("folder:R1")).toBe(true);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("depth and subtree", () => {
  it("folderDepth: root level 1, third level 3, missing 0", () => {
    const index = indexFolders(folderChain("A", 3));
    expect(folderDepth(index, "A1")).toBe(1);
    expect(folderDepth(index, "A3")).toBe(3);
    expect(folderDepth(index, "nope")).toBe(0);
  });

  it("subtreeHeight: leaf 1, root of a 3-level chain 3, a shallower sibling does not affect it", () => {
    const index = indexFolders([...folderChain("A", 3), folderDto({ id: "S", name: "S", parentId: "A1" })]);
    expect(subtreeHeight(index, "A3")).toBe(1);
    expect(subtreeHeight(index, "S")).toBe(1);
    expect(subtreeHeight(index, "A1")).toBe(3);
  });

  it("subtreeHeight: id not in the index = 1 (treated as a leaf)", () => {
    expect(subtreeHeight(indexFolders(folderChain("A", 2)), "nope")).toBe(1);
  });

  it("isInSubtree: itself and grandchildren true; siblings and ancestors false", () => {
    const index = indexFolders([...folderChain("A", 3), folderDto({ id: "S", name: "S", parentId: "A1" })]);
    expect(isInSubtree(index, "A2", "A2")).toBe(true);
    expect(isInSubtree(index, "A1", "A3")).toBe(true);
    expect(isInSubtree(index, "A2", "S")).toBe(false);
    expect(isInSubtree(index, "A2", "A1")).toBe(false);
  });
});

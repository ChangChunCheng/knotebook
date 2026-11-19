import { describe, it, expect } from "vitest";
import {
  buildLayout,
  casefoldKey,
  sanitizeSegment,
  sanitizeTitle,
  SEGMENT_MAX,
  type LayoutFolder,
  type LayoutGroup,
  type LayoutNote,
} from "../../src/transfer/paths.js";
import type { BulkRange } from "../../src/auth/transfer-token.js";

const T0 = new Date("2026-01-01T00:00:00Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000);
let seq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const note = (title: string, extra: Partial<LayoutNote> = {}): LayoutNote => ({
  id: uid(),
  title,
  createdAt: T0,
  space: "personal",
  groupId: null,
  folderId: null,
  ...extra,
});
const folder = (name: string, extra: Partial<LayoutFolder> = {}): LayoutFolder => ({
  id: uid(),
  name,
  parentId: null,
  createdAt: T0,
  space: { kind: "personal" },
  ...extra,
});
const group = (name: string, extra: Partial<LayoutGroup> = {}): LayoutGroup => ({ id: uid(), name, createdAt: T0, ...extra });
const ALL: BulkRange = { kind: "all" };

describe("sanitizeSegment: illegal characters -> _", () => {
  it.each([
    ["a<b", "a_b"],
    ["a>b", "a_b"],
    ["a:b", "a_b"],
    ['a"b', "a_b"],
    ["a/b", "a_b"],
    ["a\\b", "a_b"],
    ["a|b", "a_b"],
    ["a?b", "a_b"],
    ["a*b", "a_b"],
    ["a\u0000b", "a_b"],
    ["a\tb", "a_b"],
    ["a\u001fb", "a_b"],
    ["a\u007fb", "a_b"],
    ["a\u202ab", "a_b"],
    ["a\u202eb", "a_b"],
    ["a\u2066b", "a_b"],
    ["a\u2069b", "a_b"],
    ["a\u200bb", "a_b"],
    ["a\u200fb", "a_b"],
    ["a\ufeffb", "a_b"],
  ])("%j -> %j", (raw, want) => {
    expect(sanitizeSegment(raw)).toBe(want);
  });
  it("`$`, backtick and `!`, which the shell still expands inside double quotes, -> _; for both titles and folder names", () => {
    const shell = ["$", "`", "!"];
    for (const raw of ["$(touch x)", "`id`", "$HOME", "a!b", "${PATH}", "$(echo PWNED>>pwned.txt)"]) {
      for (const out of [sanitizeSegment(raw), sanitizeTitle(raw)]) for (const c of shell) expect(out, `${raw} → ${out}`).not.toContain(c);
    }
    expect(sanitizeTitle("$(touch x)")).toBe("_(touch x)");
    expect(sanitizeTitle("`id`")).toBe("_id_");
    expect(sanitizeTitle("$HOME")).toBe("_HOME");
    expect(sanitizeTitle("a!b")).toBe("a_b");
    // the whole export path (title + folder name) does not contain these three characters either
    const f = folder("$(echo x)");
    const n1 = note("$(touch x)", { folderId: f.id });
    const n2 = note("`id`");
    const n3 = note("a!b $HOME");
    const { files, dirs } = buildLayout({ notes: [n1, n2, n3], folders: [f], groups: [], range: ALL });
    for (const p of [...files.values(), ...dirs.map(d => d.path)]) for (const c of shell) expect(p, p).not.toContain(c);
    expect(files.get(n1.id)).toBe("My notes/_(echo x)/_(touch x).md");
  });
  it("characters just outside the four ranges are not replaced (U+2029, U+202F, U+2065, U+206A, U+200A, U+2010, U+0080)", () => {
    expect(sanitizeSegment("a\u2029b\u202fb\u2065b\u206ab\u200ab\u2010b\u0080b~")).toBe("a\u2029b\u202fb\u2065b\u206ab\u200ab\u2010b\u0080b~");
  });
});

describe("sanitizeSegment: trailing dot/space, reserved names, leading dot, NFC, truncation", () => {
  it("trailing . and whitespace removed; if that empties it -> _", () => {
    expect(sanitizeSegment("a. ")).toBe("a");
    expect(sanitizeSegment("...")).toBe("_");
    expect(sanitizeSegment("   ")).toBe("_");
    expect(sanitizeSegment("a . .")).toBe("a");
  });
  it("reserved names (case-insensitive, including with an extension) get a _ prefix; COM10 is not reserved", () => {
    expect(sanitizeSegment("CON")).toBe("_CON");
    expect(sanitizeSegment("con.md")).toBe("_con.md");
    expect(sanitizeSegment("Lpt9")).toBe("_Lpt9");
    expect(sanitizeSegment("aux.tar.gz")).toBe("_aux.tar.gz");
    expect(sanitizeSegment("COM10")).toBe("COM10");
    expect(sanitizeSegment("CONSOLE")).toBe("CONSOLE");
    // the reserved-name check happens after trailing whitespace is removed (Windows also treats "CON " as reserved)
    expect(sanitizeSegment("CON ")).toBe("_CON");
    expect(sanitizeSegment("aux  ")).toBe("_aux");
    expect(sanitizeSegment("nul.")).toBe("_nul");
  });
  it("leading . -> _ (only the first is replaced)", () => {
    expect(sanitizeSegment(".git")).toBe("_git");
    expect(sanitizeSegment(".")).toBe("_");
    // docs/mcp.md documents these exact shapes: `..` -> `_` (the first dot is replaced, the trailing dot is removed); `.knotebook` -> `_knotebook`;
    // titles `.`, `..`, `...` are left with only `_` after cleaning -> Untitled
    expect(sanitizeSegment("..")).toBe("_");
    expect(sanitizeSegment(".knotebook")).toBe("_knotebook");
    for (const t of [".", "..", "..."]) expect(sanitizeTitle(t), t).toBe("Untitled");
    // the `.` and `..` folders on the same level are both cleaned to `_`; the one created later gets ` (2)`
    const a = folder(".", { createdAt: at(0) });
    const b = folder("..", { createdAt: at(1) });
    const { dirs } = buildLayout({ notes: [], folders: [a, b], groups: [], range: ALL });
    expect(dirs.filter(d => d.id === a.id || d.id === b.id).map(d => d.path)).toEqual(["My notes/_", "My notes/_ (2)"]);
  });
  it("NFC", () => {
    const out = sanitizeSegment("e\u0301");
    expect(out).toBe("\u00e9");
    expect(Array.from(out)).toHaveLength(1);
  });
  it("truncated to 64 code points (a surrogate pair is not cut), trimEnd after truncating", () => {
    const astral = "\u{20BB7}".repeat(65);
    const out = sanitizeSegment(astral);
    expect(Array.from(out)).toHaveLength(SEGMENT_MAX);
    expect(out).toBe("\u{20BB7}".repeat(64));
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    const spaced = "a".repeat(63) + " " + "b".repeat(10);
    expect(sanitizeSegment(spaced)).toBe("a".repeat(63));
    expect(Array.from(sanitizeSegment("x".repeat(64)))).toHaveLength(64);
  });
});

describe("sanitizeTitle", () => {
  it("empty after cleaning or made only of _ -> Untitled; a_ / _a are kept", () => {
    for (const t of ["", "   ", "_", "///", "...", "__"]) expect(sanitizeTitle(t), JSON.stringify(t)).toBe("Untitled");
    expect(sanitizeTitle("a_")).toBe("a_");
    expect(sanitizeTitle("_a")).toBe("_a");
    expect(sanitizeTitle("會議紀錄")).toBe("會議紀錄");
  });
});

describe("casefoldKey", () => {
  it("NFC -> toUpperCase -> toLowerCase (ss-sharp and SS share a key; the two spellings of e-acute share a key)", () => {
    expect(casefoldKey("ß")).toBe(casefoldKey("SS"));
    expect(casefoldKey("e\u0301")).toBe(casefoldKey("\u00c9"));
    expect(casefoldKey("Abc")).toBe("abc");
  });
});

describe("buildLayout duplicate detection", () => {
  it("same directory A / a: the earlier createdAt keeps the original name, the later gets (2)", () => {
    const late = note("A", { createdAt: at(10) });
    const early = note("a", { createdAt: at(1) });
    const L = buildLayout({ notes: [late, early], folders: [], groups: [], range: { kind: "personal" } });
    expect(L.files.get(early.id)).toBe("My notes/a.md");
    expect(L.files.get(late.id)).toBe("My notes/A (2).md");
  });
  it("names colliding after cleaning (a:b / a_b), ss-sharp / SS, the third gets (3)", () => {
    const n1 = note("a:b", { createdAt: at(1) });
    const n2 = note("a_b", { createdAt: at(2) });
    const n3 = note("a|b", { createdAt: at(3) });
    const s1 = note("ß", { createdAt: at(4) });
    const s2 = note("SS", { createdAt: at(5) });
    const L = buildLayout({ notes: [n3, s2, n2, s1, n1], folders: [], groups: [], range: { kind: "personal" } });
    expect([n1, n2, n3, s1, s2].map(n => L.files.get(n.id))).toEqual([
      "My notes/a_b.md",
      "My notes/a_b (2).md",
      "My notes/a_b (3).md",
      "My notes/ß.md",
      "My notes/SS (2).md",
    ]);
  });
  it("equal createdAt: ordered by id", () => {
    const hi = { ...note("x"), id: "ffffffff-0000-4000-8000-000000000000" };
    const lo = { ...note("X"), id: "00000000-ffff-4000-8000-000000000000" };
    const L = buildLayout({ notes: [hi, lo], folders: [], groups: [], range: { kind: "personal" } });
    expect(L.files.get(lo.id)).toBe("My notes/X.md");
    expect(L.files.get(hi.id)).toBe("My notes/x (2).md");
  });
  it("the suffix takes the first free slot: with a title 'a (2)' already present, the second a gets (3)", () => {
    const a1 = note("a", { createdAt: at(1) });
    const a2lit = note("a (2)", { createdAt: at(2) });
    const a3 = note("A", { createdAt: at(3) });
    const L = buildLayout({ notes: [a3, a2lit, a1], folders: [], groups: [], range: { kind: "personal" } });
    expect([a1, a2lit, a3].map(n => L.files.get(n.id))).toEqual(["My notes/a.md", "My notes/a (2).md", "My notes/A (3).md"]);
  });
  it("folder x.md and note x on the same level -> file x.md, folder x.md (2) (even if the folder is older)", () => {
    const f = folder("x.md", { createdAt: at(0) });
    const n = note("x", { createdAt: at(5) });
    const inF = note("inside", { folderId: f.id });
    const L = buildLayout({ notes: [n, inF], folders: [f], groups: [], range: { kind: "personal" } });
    expect(L.files.get(n.id)).toBe("My notes/x.md");
    expect(L.files.get(inF.id)).toBe("My notes/x.md (2)/inside.md");
    expect(L.dirs.map(d => d.path)).toContain("My notes/x.md (2)");
  });
  it("collisions between folders on the same level also get a suffix (after cleaning a/b and a_b)", () => {
    const f1 = folder("a/b", { createdAt: at(1) });
    const f2 = folder("a_b", { createdAt: at(2) });
    const L = buildLayout({ notes: [], folders: [f2, f1], groups: [], range: { kind: "personal" } });
    expect(L.dirs.find(d => d.id === f1.id)!.path).toBe("My notes/a_b");
    expect(L.dirs.find(d => d.id === f2.id)!.path).toBe("My notes/a_b (2)");
  });
});

describe("buildLayout placement", () => {
  function world() {
    seq = 1000;
    const g1 = group("團隊", { createdAt: at(1) });
    const g2 = group("團隊", { createdAt: at(2) });
    const gEmpty = group("沒有筆記", { createdAt: at(3) });
    const gSlash = group("a/b", { createdAt: at(4) });
    const gDots = group("..", { createdAt: at(5) });
    const gCon = group("CON", { createdAt: at(6) });
    // personal: 5 levels of nesting + an empty folder
    const p1 = folder("L1");
    const p2 = folder("L2", { parentId: p1.id });
    const p3 = folder("L3", { parentId: p2.id });
    const p4 = folder("L4", { parentId: p3.id });
    const p5 = folder("L5", { parentId: p4.id });
    const pEmpty = folder("空的");
    const pSlash = folder("x/y");
    // group folder, my shared folder
    const gf = folder("規格", { space: { kind: "group", groupId: g1.id } });
    const sf = folder("別人的", { space: { kind: "shared" } });
    const nPersonal = note("個人");
    const nDeep = note("深", { folderId: p5.id });
    const nG1 = note("g1 頂層", { space: "group", groupId: g1.id });
    const nG1f = note("g1 規格", { space: "group", groupId: g1.id, folderId: gf.id });
    const nG2 = note("g2 頂層", { space: "group", groupId: g2.id });
    const nShTop = note("分享頂層", { space: "shared" });
    const nShF = note("分享放好", { space: "shared", folderId: sf.id });
    const nLost = note("找不到資料夾", { folderId: "deadbeef-0000-4000-8000-000000000000" });
    const nSlashG = note("在 a_b 群組", { space: "group", groupId: gSlash.id });
    return { g1, g2, gEmpty, gSlash, gDots, gCon, p1, p2, p3, p4, p5, pEmpty, pSlash, gf, sf, nPersonal, nDeep, nG1, nG1f, nG2, nShTop, nShF, nLost, nSlashG };
  }

  it("three spaces + nesting + empty folders + shared placement present or not + same-named groups + a group without notes; id/space of dirs", () => {
    const w = world();
    const L = buildLayout({
      notes: [w.nPersonal, w.nDeep, w.nG1, w.nG1f, w.nG2, w.nShTop, w.nShF, w.nLost, w.nSlashG],
      folders: [w.p1, w.p2, w.p3, w.p4, w.p5, w.pEmpty, w.pSlash, w.gf, w.sf],
      groups: [w.g1, w.g2, w.gEmpty, w.gSlash, w.gDots, w.gCon],
      range: ALL,
    });
    expect(Object.fromEntries([...L.files].map(([id, p]) => [id, p]))).toEqual({
      [w.nPersonal.id]: "My notes/個人.md",
      [w.nDeep.id]: "My notes/L1/L2/L3/L4/L5/深.md",
      [w.nG1.id]: "Groups/團隊/g1 頂層.md",
      [w.nG1f.id]: "Groups/團隊/規格/g1 規格.md",
      [w.nG2.id]: "Groups/團隊 (2)/g2 頂層.md",
      [w.nShTop.id]: "Shared with me/分享頂層.md",
      [w.nShF.id]: "Shared with me/別人的/分享放好.md",
      [w.nLost.id]: "My notes/找不到資料夾.md",
      [w.nSlashG.id]: "Groups/a_b/在 a_b 群組.md",
    });
    expect(L.dirs).toEqual([
      { path: "Groups", id: null, space: null },
      { path: "Groups/_", id: null, space: { kind: "group", groupId: w.gDots.id } },
      { path: "Groups/_CON", id: null, space: { kind: "group", groupId: w.gCon.id } },
      { path: "Groups/a_b", id: null, space: { kind: "group", groupId: w.gSlash.id } },
      { path: "Groups/團隊", id: null, space: { kind: "group", groupId: w.g1.id } },
      { path: "Groups/團隊 (2)", id: null, space: { kind: "group", groupId: w.g2.id } },
      { path: "Groups/團隊/規格", id: w.gf.id, space: { kind: "group", groupId: w.g1.id } },
      { path: "Groups/沒有筆記", id: null, space: { kind: "group", groupId: w.gEmpty.id } },
      { path: "My notes", id: null, space: null },
      { path: "My notes/L1", id: w.p1.id, space: { kind: "personal" } },
      { path: "My notes/L1/L2", id: w.p2.id, space: { kind: "personal" } },
      { path: "My notes/L1/L2/L3", id: w.p3.id, space: { kind: "personal" } },
      { path: "My notes/L1/L2/L3/L4", id: w.p4.id, space: { kind: "personal" } },
      { path: "My notes/L1/L2/L3/L4/L5", id: w.p5.id, space: { kind: "personal" } },
      { path: "My notes/x_y", id: w.pSlash.id, space: { kind: "personal" } },
      { path: "My notes/空的", id: w.pEmpty.id, space: { kind: "personal" } },
      { path: "Shared with me", id: null, space: null },
      { path: "Shared with me/別人的", id: w.sf.id, space: { kind: "shared" } },
    ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
  });

  it("dirs are ordered by full path code units (Groups/... < My notes/... < Shared with me/...)", () => {
    const w = world();
    const L = buildLayout({ notes: [], folders: [w.sf, w.pEmpty, w.gf], groups: [w.g1], range: ALL });
    const paths = L.dirs.map(d => d.path);
    expect(paths).toEqual(["Groups", "Groups/團隊", "Groups/團隊/規格", "My notes", "My notes/空的", "Shared with me", "Shared with me/別人的"]);
    expect([...paths].sort()).toEqual(paths);
  });

  it("narrowing the range (personal, folder): the input is the full set, the output has only what is in range, paths verbatim equal to the full range", () => {
    const w = world();
    const input = {
      notes: [w.nPersonal, w.nDeep, w.nG1, w.nShTop],
      folders: [w.p1, w.p2, w.p3, w.p4, w.p5, w.pEmpty, w.gf, w.sf],
      groups: [w.g1],
    };
    const full = buildLayout({ ...input, range: ALL });
    const personal = buildLayout({ ...input, range: { kind: "personal" } });
    expect([...personal.files.keys()].sort()).toEqual([w.nPersonal.id, w.nDeep.id].sort());
    expect(personal.files.get(w.nDeep.id)).toBe(full.files.get(w.nDeep.id));
    expect(personal.dirs).toEqual(full.dirs.filter(d => d.path === "My notes" || d.path.startsWith("My notes/")));
    // folder range: the ancestor chain (including the top level) + the subtree
    const sub = buildLayout({ ...input, range: { kind: "folder", folderId: w.p3.id } });
    expect([...sub.files.values()]).toEqual(["My notes/L1/L2/L3/L4/L5/深.md"]);
    expect(sub.dirs.map(d => d.path)).toEqual(["My notes", "My notes/L1", "My notes/L1/L2", "My notes/L1/L2/L3", "My notes/L1/L2/L3/L4", "My notes/L1/L2/L3/L4/L5"]);
  });

  it("group name cleaning: / does not add a level, .. -> _, CON -> _CON; folder name a/b does not add a level", () => {
    const w = world();
    const L = buildLayout({ notes: [w.nSlashG], folders: [w.pSlash], groups: [w.gSlash, w.gDots, w.gCon], range: ALL });
    expect(L.files.get(w.nSlashG.id)).toBe("Groups/a_b/在 a_b 群組.md");
    for (const d of L.dirs) expect(d.path.split("/").length, d.path).toBeLessThanOrEqual(2);
    expect(L.dirs.map(d => d.path)).toEqual(expect.arrayContaining(["Groups/_", "Groups/_CON", "Groups/a_b", "My notes/x_y"]));
    expect(L.dirs.map(d => d.path)).not.toContain("Groups/..");
  });

  it("title cleaning into file names: empty title -> Untitled.md; two empty titles -> Untitled (2).md", () => {
    const a = note("", { createdAt: at(1) });
    const b = note("///", { createdAt: at(2) });
    const L = buildLayout({ notes: [a, b], folders: [], groups: [], range: { kind: "personal" } });
    expect([L.files.get(a.id), L.files.get(b.id)]).toEqual(["My notes/Untitled.md", "My notes/Untitled (2).md"]);
  });
});

describe("buildLayout range narrowing: names are computed on the full set, then filtered by range", () => {
  /** Three shapes that would give different names if only the same level inside the range were looked at: same-named groups, folders colliding after cleaning, and the case where a note x at an ancestor level collides with a folder x.md. */
  function world() {
    seq = 5000;
    const gA = group("Team", { createdAt: at(1) });
    const gB = group("Team", { createdAt: at(2) });
    const gC = group("Other", { createdAt: at(3) });
    const fAB1 = folder("a:b", { createdAt: at(1) });
    const fAB2 = folder("a_b", { createdAt: at(2) });
    const fXmd = folder("x.md", { createdAt: at(0) });
    const fXmdKid = folder("kid", { parentId: fXmd.id });
    const gAf = folder("spec", { space: { kind: "group", groupId: gA.id } });
    const gBf = folder("spec", { space: { kind: "group", groupId: gB.id } });
    const sf = folder("放這", { space: { kind: "shared" } });
    const notes = [
      note("x", { createdAt: at(5) }),
      note("in a", { folderId: fAB1.id }),
      note("in b", { folderId: fAB2.id }),
      note("inside", { folderId: fXmd.id }),
      note("deep", { folderId: fXmdKid.id }),
      note("A 頂層", { space: "group", groupId: gA.id }),
      note("A spec", { space: "group", groupId: gA.id, folderId: gAf.id }),
      note("B 頂層", { space: "group", groupId: gB.id }),
      note("B spec", { space: "group", groupId: gB.id, folderId: gBf.id }),
      note("C 頂層", { space: "group", groupId: gC.id }),
      note("分享頂層", { space: "shared" }),
      note("分享放好", { space: "shared", folderId: sf.id }),
    ];
    const folders = [fAB1, fAB2, fXmd, fXmdKid, gAf, gBf, sf];
    const groups = [gA, gB, gC];
    return { gA, gB, gC, fAB1, fAB2, fXmd, fXmdKid, gAf, gBf, sf, notes, folders, groups };
  }

  it("for every range: files and dirs are a subset of the full-range set and verbatim equal", () => {
    const w = world();
    const full = buildLayout({ notes: w.notes, folders: w.folders, groups: w.groups, range: ALL });
    expect(full.files.size).toBe(w.notes.length);
    const ranges: BulkRange[] = [
      { kind: "personal" },
      { kind: "shared" },
      ...w.groups.map(g => ({ kind: "group" as const, groupId: g.id })),
      ...w.folders.map(f => ({ kind: "folder" as const, folderId: f.id })),
    ];
    const fullDirs = new Map(full.dirs.map(d => [d.path, d]));
    for (const range of ranges) {
      const L = buildLayout({ notes: w.notes, folders: w.folders, groups: w.groups, range });
      const tag = JSON.stringify(range);
      for (const [id, path] of L.files) expect(path, `${tag} ${id}`).toBe(full.files.get(id));
      for (const d of L.dirs) expect(fullDirs.get(d.path), `${tag} ${d.path}`).toEqual(d);
      expect(L.dirs.length, tag).toBeGreaterThan(0);
    }
  });

  it("same-named groups: exporting only the second Team still gives Groups/Team (2)/... and does not land on the first Team's path; the directories are only Groups and this group", () => {
    const w = world();
    const L = buildLayout({ notes: w.notes, folders: w.folders, groups: w.groups, range: { kind: "group", groupId: w.gB.id } });
    expect([...L.files.values()].sort()).toEqual(["Groups/Team (2)/B 頂層.md", "Groups/Team (2)/spec/B spec.md"]);
    expect(L.dirs.map(d => d.path)).toEqual(["Groups", "Groups/Team (2)", "Groups/Team (2)/spec"]);
  });

  it("folders colliding after cleaning: for the folder range a_b (2) the paths equal the full range; the ancestor chain is only the top-level directory", () => {
    const w = world();
    const L = buildLayout({ notes: w.notes, folders: w.folders, groups: w.groups, range: { kind: "folder", folderId: w.fAB2.id } });
    expect([...L.files.values()]).toEqual(["My notes/a_b (2)/in b.md"]);
    expect(L.dirs.map(d => d.path)).toEqual(["My notes", "My notes/a_b (2)"]);
  });

  it("the collision with a note at an ancestor level: for the folder range kid (under x.md (2)) the paths equal the full range; the ancestor level's note x is not in the output", () => {
    const w = world();
    const L = buildLayout({ notes: w.notes, folders: w.folders, groups: w.groups, range: { kind: "folder", folderId: w.fXmdKid.id } });
    expect([...L.files.values()]).toEqual(["My notes/x.md (2)/kid/deep.md"]);
    expect(L.dirs.map(d => d.path)).toEqual(["My notes", "My notes/x.md (2)", "My notes/x.md (2)/kid"]);
  });

  it("group folder range: the ancestor chain includes Groups and the group directory; the shared folder range takes the notes whose reader placement is inside the subtree", () => {
    const w = world();
    const g = buildLayout({ notes: w.notes, folders: w.folders, groups: w.groups, range: { kind: "folder", folderId: w.gBf.id } });
    expect(g.dirs.map(d => d.path)).toEqual(["Groups", "Groups/Team (2)", "Groups/Team (2)/spec"]);
    expect([...g.files.values()]).toEqual(["Groups/Team (2)/spec/B spec.md"]);
    const s = buildLayout({ notes: w.notes, folders: w.folders, groups: w.groups, range: { kind: "folder", folderId: w.sf.id } });
    expect(s.dirs.map(d => d.path)).toEqual(["Shared with me", "Shared with me/放這"]);
    expect([...s.files.values()]).toEqual(["Shared with me/放這/分享放好.md"]);
  });

  it("personal / shared range: only that top-level directory and what is below it; no group directories are written", () => {
    const w = world();
    const p = buildLayout({ notes: w.notes, folders: w.folders, groups: w.groups, range: { kind: "personal" } });
    expect(p.dirs.every(d => d.path === "My notes" || d.path.startsWith("My notes/"))).toBe(true);
    expect([...p.files.values()].every(v => v.startsWith("My notes/"))).toBe(true);
    expect(p.files.size).toBe(5);
    const s = buildLayout({ notes: w.notes, folders: w.folders, groups: w.groups, range: { kind: "shared" } });
    expect(s.dirs.map(d => d.path)).toEqual(["Shared with me", "Shared with me/放這"]);
    expect(s.files.size).toBe(2);
  });

  it("a group/folder the range points to is not in the input -> throws (the caller checks 403 first)", () => {
    const w = world();
    expect(() => buildLayout({ notes: w.notes, folders: w.folders, groups: w.groups, range: { kind: "group", groupId: uid() } })).toThrow();
    expect(() => buildLayout({ notes: w.notes, folders: w.folders, groups: w.groups, range: { kind: "folder", folderId: uid() } })).toThrow();
  });

  it("the input order of same-named groups does not affect naming (by createdAt, id)", () => {
    const w = world();
    const a = buildLayout({ notes: w.notes, folders: w.folders, groups: [w.gA, w.gB, w.gC], range: ALL });
    const b = buildLayout({ notes: w.notes, folders: w.folders, groups: [w.gC, w.gB, w.gA], range: ALL });
    expect([...b.files].sort()).toEqual([...a.files].sort());
    expect(b.dirs).toEqual(a.dirs);
    expect(a.dirs.find(d => d.space?.kind === "group" && d.space.groupId === w.gA.id && d.id === null)!.path).toBe("Groups/Team");
  });
});

describe("leading whitespace in file names (known-limitations)", () => {
  it("leading whitespace is kept, trailing whitespace is removed", () => {
    expect(sanitizeTitle("  前後空白  ")).toBe("  前後空白");
  });
});

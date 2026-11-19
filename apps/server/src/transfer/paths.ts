/**
 * File names are cosmetic: write-back trusts only the frontmatter `id`. Files are matched
 * before folders when names clash (a folder yields); a clash appends ` (n)`, n from 2. Names
 * clash case-folded per directory, files and folders in one namespace; same kind ordered by
 * `createdAt`, then `id`. Paths may exceed Windows' 260. `dirs` are sorted by full path in
 * code-unit order.
 */
import type { FolderSpaceDto } from "@knotebook/shared";
import type { BulkRange } from "../auth/transfer-token.js";

export const TOP_DIRS = { personal: "My notes", group: "Groups", shared: "Shared with me" } as const;
export type TopDirKey = keyof typeof TOP_DIRS;

/** Code points, before the ` (n)` suffix. */
export const SEGMENT_MAX = 64;

/**
 * Also `$`, backtick and `!`: `next` tells the model to put the path inside double quotes,
 * where the shell still expands them (`$(…)`, backticks run commands, `!` is history expansion).
 */
const ILLEGAL = /[<>:"/\\|?*$`!\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff]/gu;
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

export function sanitizeSegment(raw: string): string {
  let s = raw.normalize("NFC");
  s = s.replace(ILLEGAL, "_");
  if (s.startsWith(".")) s = "_" + s.slice(1);
  const cps = Array.from(s);
  if (cps.length > SEGMENT_MAX) s = cps.slice(0, SEGMENT_MAX).join("").trimEnd();
  s = s.replace(/[\s.]+$/u, "");
  if (s === "") s = "_";
  if (RESERVED.test(s)) s = "_" + s;
  return s;
}

export function sanitizeTitle(raw: string): string {
  const s = sanitizeSegment(raw);
  return /^_+$/.test(s) ? "Untitled" : s;
}

/** `toUpperCase().toLowerCase()` approximates casefolding (ß→ss over-matches, harmless). */
export function casefoldKey(s: string): string {
  return s.normalize("NFC").toUpperCase().toLowerCase();
}

export interface LayoutNote {
  id: string;
  title: string;
  createdAt: Date;
  space: "personal" | "shared" | "group";
  groupId: string | null;
  /** For a shared note: the reader's placement. */
  folderId: string | null;
}
export interface LayoutFolder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: Date;
  space: FolderSpaceDto;
}
export interface LayoutGroup {
  id: string;
  name: string;
  createdAt: Date;
}
export interface Layout {
  dirs: Array<{ path: string; id: string | null; space: FolderSpaceDto | null }>;
  files: Map<string, string>;
}

interface DirNode {
  name: string;
  parent: DirNode | null;
  id: string | null;
  space: FolderSpaceDto | null;
  path: string;
  childFolders: Array<{ folder: LayoutFolder; node: DirNode }>;
  childNotes: LayoutNote[];
  childGroups: Array<{ group: LayoutGroup; node: DirNode }>;
}

const byCreated = <T extends { createdAt: Date; id: string }>(a: T, b: T): number => {
  const d = a.createdAt.getTime() - b.createdAt.getTime();
  if (d !== 0) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

function claim(taken: Set<string>, base: string, ext: string): string {
  let name = base + ext;
  for (let n = 2; taken.has(casefoldKey(name)); n++) name = `${base} (${n})${ext}`;
  taken.add(casefoldKey(name));
  return name;
}

function within(node: DirNode, anc: DirNode): boolean {
  for (let p: DirNode | null = node; p !== null; p = p.parent) if (p === anc) return true;
  return false;
}

/**
 * Naming is computed over the reader's whole visible set and only then filtered by scope, so
 * a path never depends on the scope: otherwise fetching everything and later one group could
 * put two different notes at the same local path and silently overwrite one. A scope object
 * missing from the input throws (callers check "scope gone" → 403 first).
 */
export function buildLayout(input: { notes: LayoutNote[]; folders: LayoutFolder[]; groups: LayoutGroup[]; range: BulkRange }): Layout {
  const mk = (name: string, parent: DirNode | null, id: string | null, space: FolderSpaceDto | null): DirNode => ({
    name,
    parent,
    id,
    space,
    path: "",
    childFolders: [],
    childNotes: [],
    childGroups: [],
  });
  const tops: Record<TopDirKey, DirNode> = {
    personal: mk(TOP_DIRS.personal, null, null, null),
    group: mk(TOP_DIRS.group, null, null, null),
    shared: mk(TOP_DIRS.shared, null, null, null),
  };

  const groupNodes = new Map<string, DirNode>();
  for (const g of input.groups) {
    const node = mk("", tops.group, null, { kind: "group", groupId: g.id });
    groupNodes.set(g.id, node);
    tops.group.childGroups.push({ group: g, node });
  }
  const spaceRoot = (space: FolderSpaceDto): DirNode => {
    if (space.kind === "personal") return tops.personal;
    if (space.kind === "shared") return tops.shared;
    const g = groupNodes.get(space.groupId);
    if (g === undefined) throw new Error("buildLayout: group folder whose group is not in the layout input");
    return g;
  };

  const folderNodes = new Map<string, DirNode>();
  for (const f of input.folders) folderNodes.set(f.id, mk("", null, f.id, f.space));
  for (const f of input.folders) {
    const node = folderNodes.get(f.id)!;
    const parent = (f.parentId !== null ? folderNodes.get(f.parentId) : undefined) ?? spaceRoot(f.space);
    node.parent = parent;
    parent.childFolders.push({ folder: f, node });
  }
  // A DB trigger keeps the folder tree acyclic; this only guards against a bad caller.
  for (const node of folderNodes.values()) {
    let depth = 0;
    for (let p: DirNode | null = node; p !== null; p = p.parent) {
      if (++depth > folderNodes.size + 3) throw new Error("buildLayout: folder parent chain has a cycle");
    }
  }

  const noteDir = new Map<string, DirNode>();
  for (const n of input.notes) {
    const inFolder = n.folderId !== null ? folderNodes.get(n.folderId) : undefined;
    let dir: DirNode;
    if (inFolder !== undefined) dir = inFolder;
    else if (n.space === "group") {
      const g = n.groupId !== null ? groupNodes.get(n.groupId) : undefined;
      if (g === undefined) throw new Error("buildLayout: group note whose group is not in the layout input");
      dir = g;
    } else dir = tops[n.space];
    dir.childNotes.push(n);
    noteDir.set(n.id, dir);
  }

  const notePath = new Map<string, string>();
  const allDirs: DirNode[] = [];
  const visit = (dir: DirNode, path: string): void => {
    dir.path = path;
    allDirs.push(dir);
    const taken = new Set<string>();
    for (const n of [...dir.childNotes].sort(byCreated)) notePath.set(n.id, `${path}/${claim(taken, sanitizeTitle(n.title), ".md")}`);
    const subdirs: DirNode[] = [];
    for (const { group, node } of [...dir.childGroups].sort((a, b) => byCreated(a.group, b.group))) {
      node.name = claim(taken, sanitizeSegment(group.name), "");
      subdirs.push(node);
    }
    for (const { folder, node } of [...dir.childFolders].sort((a, b) => byCreated(a.folder, b.folder))) {
      node.name = claim(taken, sanitizeSegment(folder.name), "");
      subdirs.push(node);
    }
    for (const sub of subdirs) visit(sub, `${path}/${sub.name}`);
  };
  for (const key of ["personal", "group", "shared"] as const) visit(tops[key], tops[key].name);

  const range = input.range;
  let dirIn: (d: DirNode) => boolean;
  let noteIn: (d: DirNode) => boolean;
  if (range.kind === "all") {
    dirIn = () => true;
    noteIn = () => true;
  } else if (range.kind === "personal" || range.kind === "shared") {
    const top = tops[range.kind];
    dirIn = d => within(d, top);
    noteIn = dirIn;
  } else if (range.kind === "group") {
    const g = groupNodes.get(range.groupId);
    if (g === undefined) throw new Error("buildLayout: range group is not in the layout input");
    dirIn = d => d === tops.group || within(d, g);
    noteIn = d => within(d, g);
  } else {
    const f = folderNodes.get(range.folderId);
    if (f === undefined) throw new Error("buildLayout: range folder is not in the layout input");
    dirIn = d => within(f, d) || within(d, f);
    noteIn = d => within(d, f);
  }

  const dirs: Layout["dirs"] = allDirs.filter(dirIn).map(d => ({ path: d.path, id: d.id, space: d.space }));
  dirs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const files = new Map<string, string>();
  for (const n of input.notes) if (noteIn(noteDir.get(n.id)!)) files.set(n.id, notePath.get(n.id)!);
  return { dirs, files };
}

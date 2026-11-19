import { FOLDER_DEPTH_MAX, type FolderDto, type GroupDto, type NoteDto } from "@knotebook/shared";
import { canCreateAndEdit } from "@/lib/group-role";
import { folderDepth, folderPath, isInSubtree, spaceKeyOf, subtreeHeight, type FolderIndex, type FolderSpaceKey } from "./folder-index";

/** First-bundle module: no string-bundle import (strings live in the main file) and no sidebar view imports. */

export type Translate = (key: string, options?: Record<string, unknown>) => string;

export type DestMode = "move" | "copy";
export type DestSpace = { kind: "personal" } | { kind: "shared" } | { kind: "group"; groupId: string; name: string };
/** folder null = the space's root; `makeCopy` = "make a copy", which lands in each source's own folder. */
export type DestTarget = { kind: "makeCopy" } | { kind: "place"; space: DestSpace; folder: FolderDto | null };
export type DestPathStep = { kind: "space"; space: DestSpace } | { kind: "folder"; folderId: string };
export type DestDisabledReason = "current" | "self" | "tooDeep" | "crossSpace";
export type DestItem =
  | { kind: "back"; key: "back"; label: string; accessibleName: string }
  | { kind: "here" | "root" | "makeCopy"; key: string; label: string; accessibleName: string; target: DestTarget; disabled: DestDisabledReason | null }
  | {
      kind: "folder" | "space";
      key: string;
      label: string;
      accessibleName: string;
      target: DestTarget;
      drill: DestPathStep | null;
      disabled: DestDisabledReason | null;
    }
  | { kind: "separator"; key: string };

export interface DestSource {
  mode: DestMode;
  /** Upper-half space; null = no upper half. */
  current: DestSpace | null;
  makeCopy: boolean;
  others: readonly DestSpace[];
  /** Current position of each selected item within `current`'s space (note = folderId, folder = parentId; null = root level). */
  locations: readonly (string | null)[];
  movingFolders: readonly FolderDto[];
}

export function spaceKey(space: DestSpace): FolderSpaceKey {
  return space.kind === "group" ? `group:${space.groupId}` : space.kind;
}

const PERSONAL: DestSpace = { kind: "personal" };
const SHARED: DestSpace = { kind: "shared" };
const NO_FOLDERS: readonly FolderDto[] = [];

function groupSpace(group: GroupDto): DestSpace {
  return { kind: "group", groupId: group.id, name: group.name };
}

/** Always returns a `DestSource` (emptiness needs an index; callers use `isEmptyDestination`). `groups` is `useGroups()` data ([] until loaded); candidates are `canCreateAndEdit`, in `groups` order. */
export function noteDestSource(note: NoteDto, mode: DestMode, groups: readonly GroupDto[]): DestSource {
  const candidates = groups.filter(canCreateAndEdit);
  const base = { mode, locations: [note.folderId], movingFolders: NO_FOLDERS };
  // Own personal note: top half = my notes; bottom = candidate groups (copy omits "my notes", it would duplicate the top half).
  if (note.groupId === null && note.permissions.moveToGroup) {
    return { ...base, current: PERSONAL, makeCopy: mode === "copy", others: candidates.map(groupSpace) };
  }
  if (note.groupId !== null) {
    const groupId = note.groupId;
    const own = groups.find((group) => group.id === groupId);
    const ownSpace: DestSpace = { kind: "group", groupId, name: own?.name ?? note.group?.name ?? "" };
    // A group note can't leave its group; moving within the group is judged by permissions.edit (placement right).
    if (mode === "move") return { ...base, current: note.permissions.edit ? ownSpace : null, makeCopy: false, others: [] };
    const others = [PERSONAL, ...candidates.filter((group) => group.id !== groupId).map(groupSpace)];
    const ownIsCandidate = own !== undefined && canCreateAndEdit(own);
    return { ...base, current: ownIsCandidate ? ownSpace : null, makeCopy: ownIsCandidate, others };
  }
  // Shared note: move = own shared private folder (just a personal category); copy = no top half, "my notes" + candidate groups.
  if (mode === "move") return { ...base, current: SHARED, makeCopy: false, others: [] };
  return { ...base, current: null, makeCopy: false, others: [PERSONAL, ...candidates.map(groupSpace)] };
}

/** Same space = target is a place in the same space as the source's current one (note PUT / folder PATCH, no confirmation); otherwise cross-space. Shared by the ⋮ single-note flow (`GroupTransfer`) and the batch (`SelectActionBar`). */
export function isSameSpace(target: DestTarget, source: DestSource): boolean {
  return target.kind === "place" && source.current !== null && spaceKey(target.space) === spaceKey(source.current);
}

export function isEmptyDestination(source: DestSource, index: FolderIndex, t: Translate): boolean {
  return buildDestinationLevel({ source, path: [], index, t }).length === 0;
}

function spaceLabel(space: DestSpace, t: Translate): string {
  if (space.kind === "personal") return t("sidebar.myNotes");
  if (space.kind === "shared") return t("sidebar.shared");
  return space.name;
}

/** Greyed-out only for move (copy is always clickable). `leafOrHere`: only "put here" and folders without children grey out for being the current place (folders with children must stay clickable to drill in). */
function disabledFor(source: DestSource, index: FolderIndex, folder: FolderDto | null, leafOrHere: boolean): DestDisabledReason | null {
  if (source.mode !== "move") return null;
  if (source.movingFolders.length > 0) {
    if (folder !== null && source.movingFolders.some((moving) => isInSubtree(index, moving.id, folder.id))) return "self";
    const height = Math.max(...source.movingFolders.map((moving) => subtreeHeight(index, moving.id)));
    const depth = folder === null ? 0 : folderDepth(index, folder.id);
    if (depth + height > FOLDER_DEPTH_MAX) return "tooDeep";
  }
  if (folder !== null && leafOrHere && source.locations.length > 0 && source.locations.every((location) => location === folder.id)) {
    return "current";
  }
  return null;
}

function withDrill(
  base: { kind: "folder" | "space"; key: string; label: string; target: DestTarget; disabled: DestDisabledReason | null },
  canDrill: boolean,
  drillTo: DestPathStep,
  t: Translate,
): DestItem {
  const drill = canDrill && base.disabled === null ? drillTo : null;
  const accessibleName = drill === null ? base.label : t("folders.dest.openLevel", { name: base.label });
  return { ...base, accessibleName, drill };
}

function folderItem(source: DestSource, index: FolderIndex, space: DestSpace, folder: FolderDto, t: Translate): DestItem {
  const hasChildren = index.children(spaceKey(space), folder.id).length > 0;
  return withDrill(
    {
      kind: "folder",
      key: `folder:${folder.id}`,
      label: folder.name,
      target: { kind: "place", space, folder },
      disabled: disabledFor(source, index, folder, !hasChildren),
    },
    hasChildren,
    { kind: "folder", folderId: folder.id },
    t,
  );
}

function rootItem(source: DestSource, index: FolderIndex, space: DestSpace, t: Translate): DestItem {
  const label = t("folders.dest.topLevel");
  return {
    kind: "root",
    key: "root",
    label,
    accessibleName: label,
    target: { kind: "place", space, folder: null },
    disabled: disabledFor(source, index, null, false),
  };
}

/** "Back" item (always first from level 2); the phone sheet's first level also uses it as the row back to the main menu (`share/GroupTransfer.tsx`). */
export function backItem(t: Translate): DestItem {
  const label = t("folders.dest.back");
  return { kind: "back", key: "back", label, accessibleName: label };
}

function firstLevel(source: DestSource, index: FolderIndex, t: Translate): DestItem[] {
  const upper: DestItem[] = [];
  if (source.mode === "copy" && source.makeCopy) {
    const label = t("note.menu.makeCopy");
    upper.push({ kind: "makeCopy", key: "makeCopy", label, accessibleName: label, target: { kind: "makeCopy" }, disabled: null });
  }
  const current = source.current;
  if (current !== null) {
    if (!source.locations.every((location) => location === null)) upper.push(rootItem(source, index, current, t));
    for (const folder of index.children(spaceKey(current), null)) upper.push(folderItem(source, index, current, folder, t));
  }
  // Folders move only within one space: when moving folders in a batch the lower-half spaces are greyed out and can't be entered.
  const crossSpace = source.mode === "move" && source.movingFolders.length > 0;
  const lower = source.others.map((space) =>
    withDrill(
      {
        kind: "space",
        key: `space:${spaceKey(space)}`,
        label: spaceLabel(space, t),
        target: { kind: "place", space, folder: null },
        disabled: crossSpace ? "crossSpace" : null,
      },
      index.children(spaceKey(space), null).length > 0,
      { kind: "space", space },
      t,
    ),
  );
  if (upper.length > 0 && lower.length > 0) return [...upper, { kind: "separator", key: "separator" }, ...lower];
  return [...upper, ...lower];
}

type Resolved = { kind: "space"; space: DestSpace } | { kind: "folder"; space: DestSpace; folder: FolderDto };

function resolvePath(source: DestSource, path: readonly DestPathStep[], index: FolderIndex): Resolved | null {
  let last: Resolved | null = null;
  for (const step of path) {
    if (step.kind === "space") {
      const key = spaceKey(step.space);
      const space = source.others.find((other) => spaceKey(other) === key);
      if (space === undefined) break;
      last = { kind: "space", space };
      continue;
    }
    const folder = index.byId.get(step.folderId);
    if (folder === undefined) break;
    const folderKey = spaceKeyOf(folder.space);
    const space =
      [source.current, ...source.others].find((candidate): candidate is DestSpace => candidate !== null && spaceKey(candidate) === folderKey) ??
      null;
    if (space === null) break;
    last = { kind: "folder", space, folder };
  }
  return last;
}

export function buildDestinationLevel(input: {
  source: DestSource;
  path: readonly DestPathStep[];
  index: FolderIndex;
  t: Translate;
}): DestItem[] {
  const { source, path, index, t } = input;
  const at = resolvePath(source, path, index);
  if (at === null) return firstLevel(source, index, t);
  if (at.kind === "space") {
    return [
      backItem(t),
      rootItem(source, index, at.space, t),
      ...index.children(spaceKey(at.space), null).map((folder) => folderItem(source, index, at.space, folder, t)),
    ];
  }
  const label = t(source.mode === "move" ? "folders.dest.moveHere" : "folders.dest.copyHere");
  return [
    backItem(t),
    {
      kind: "here",
      key: "here",
      label,
      accessibleName: label,
      target: { kind: "place", space: at.space, folder: at.folder },
      disabled: disabledFor(source, index, at.folder, true),
    },
    ...index.children(spaceKey(at.space), at.folder.id).map((folder) => folderItem(source, index, at.space, folder, t)),
  ];
}

/**
 * The still-valid prefix of `path`. `buildDestinationLevel` **silently truncates** at a stale step (folder deleted, group gone), so the current depth can't be read from `path.length`: "back" and "drill in" must continue from this prefix so "back" goes up exactly one visible level.
 * Detection: the item after "back" built at level k (space level = root, folder level = move/copy here) is step k itself.
 */
export function livePath(source: DestSource, path: readonly DestPathStep[], index: FolderIndex, t: Translate): readonly DestPathStep[] {
  for (let k = 0; k < path.length; k += 1) {
    const step = path[k];
    const [first, anchor] = buildDestinationLevel({ source, path: path.slice(0, k + 1), index, t });
    const at =
      first?.kind === "back" &&
      anchor !== undefined &&
      (anchor.kind === "root" || anchor.kind === "here") &&
      anchor.target.kind === "place" &&
      (step.kind === "space"
        ? anchor.kind === "root" && spaceKey(anchor.target.space) === spaceKey(step.space)
        : anchor.kind === "here" && anchor.target.folder?.id === step.folderId);
    if (!at) return path.slice(0, k);
  }
  return path;
}

export function destinationPathLabel(space: DestSpace, folder: FolderDto | null, index: FolderIndex, t: Translate): string {
  const head = spaceLabel(space, t);
  if (folder === null) return head;
  const names = folderPath(index, folder.id) ?? [folder.name];
  return [head, ...names].join(" › ");
}

export function destinationShortLabel(folder: FolderDto | null, t: Translate): string {
  return folder === null ? t("folders.dest.topLevel") : folder.name;
}

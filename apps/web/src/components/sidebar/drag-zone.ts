import { FOLDER_DEPTH_MAX, type NoteDto } from "@knotebook/shared";
import type { SidebarTab } from "@/lib/sidebar-tab";
import type { Translate } from "./destination-level";
import type { FolderSpaceKey } from "./folder-index";
import type { SidebarNode } from "./tree";

/** First-bundle module: no string-bundle or view imports. Positions come from the tree (after `tree.ts` fallbacks), not raw `note.folderId`. */

export const DRAG_NOTE_MIME = "application/x-knotebook-note";
export const DRAG_HOVER_DELAY_MS = 500;
export const DRAG_POINTER_QUERY = "(hover: hover) and (pointer: fine)";

export type DragTab = "myNotes" | "workspace" | "shared";

export interface DragSource {
  noteId: string;
  space: FolderSpaceKey;
  folderId: string | null;
  title: string;
}

export interface DropLookup {
  /** `folderDepth` is the depth of the containing folder with root level = 0 (unlike `folders[].depth`, where root-level folders are 1); `placeable` = `canDragNote`. */
  notes: ReadonlyMap<string, { space: FolderSpaceKey; folderId: string | null; folderDepth: number; placeable: boolean; title: string }>;
  folders: ReadonlyMap<string, { space: FolderSpaceKey; depth: number }>;
}

type NoteEntry = DropLookup["notes"] extends ReadonlyMap<string, infer V> ? V : never;
type FolderEntry = DropLookup["folders"] extends ReadonlyMap<string, infer V> ? V : never;

/** personal is always true: the My notes tab has only own notes. */
export function canDragNote(note: NoteDto, space: FolderSpaceKey): boolean {
  if (space === "personal") return true;
  if (space === "shared") return note.groupId === null;
  return note.permissions.edit;
}

export function buildDropLookup(nodes: readonly SidebarNode[], tab: DragTab, groupIds: ReadonlySet<string>): DropLookup {
  const notes = new Map<string, NoteEntry>();
  const folders = new Map<string, FolderEntry>();
  const walk = (children: readonly SidebarNode[], space: FolderSpaceKey, parentFolderId: string | null, parentDepth: number) => {
    for (const node of children) {
      if (node.kind === "folder") {
        folders.set(node.id, { space, depth: node.depth });
        walk(node.children, space, node.id, node.depth);
      } else if (node.kind === "note") {
        notes.set(node.id, { space, folderId: parentFolderId, folderDepth: parentDepth, placeable: canDragNote(node.note, space), title: node.note.title });
      }
    }
  };
  if (tab === "workspace") {
    for (const node of nodes) {
      if (node.kind === "group" && groupIds.has(node.id)) walk(node.children, `group:${node.id}`, null, 0);
    }
  } else {
    walk(nodes, tab === "myNotes" ? "personal" : "shared", null, 0);
  }
  return { notes, folders };
}

export type DragTarget =
  | { kind: "preview" }
  | { kind: "note"; id: string }
  | { kind: "folder"; id: string }
  | { kind: "group"; id: string }
  | { kind: "blank" }
  | { kind: "outside" };

export function readDragTarget(target: EventTarget | null, container: Element): DragTarget {
  if (!(target instanceof Node)) return { kind: "outside" };
  const el = target instanceof Element ? target : target.parentElement;
  if (el === null || !container.contains(el)) return { kind: "outside" };
  // Rows inside the preview block (the B row etc.) must not count as ordinary note rows: look for the preview first.
  const preview = el.closest('[data-node-kind="preview"]');
  if (preview !== null && container.contains(preview)) return { kind: "preview" };
  const node = el.closest("[data-node-kind]");
  if (node === null || !container.contains(node)) return { kind: "blank" };
  const kind = node.getAttribute("data-node-kind");
  const id = node.getAttribute("data-node-id");
  if (id !== null && (kind === "note" || kind === "folder" || kind === "group")) return { kind, id };
  return { kind: "outside" };
}

export type DropScope = { kind: "list" } | { kind: "group"; groupId: string } | { kind: "folder"; folderId: string } | { kind: "preview" };
export type DropZone = { kind: "place"; folderId: string | null; scope: DropScope } | { kind: "stack"; scope: { kind: "preview" } };
export type HoldAction = { kind: "spring"; folderId: string } | { kind: "stack"; anchorNoteId: string; parentFolderId: string | null };

export interface DragOverResult {
  zone: DropZone | null;
  row: string | null;
  hold: HoldAction | null;
}

export function dropScopeKey(scope: DropScope): string {
  if (scope.kind === "group") return `group:${scope.groupId}`;
  if (scope.kind === "folder") return `folder:${scope.folderId}`;
  return scope.kind;
}

const NONE: DragOverResult = { zone: null, row: null, hold: null };

function groupIdOf(space: FolderSpaceKey): string | null {
  return space.startsWith("group:") ? space.slice("group:".length) : null;
}

function placeAt(source: DragSource, folderId: string | null, scope: DropScope): DropZone | null {
  return folderId === source.folderId ? null : { kind: "place", folderId, scope };
}

function rootScope(tab: DragTab, space: FolderSpaceKey): DropScope | null {
  if (tab !== "workspace") return { kind: "list" };
  const groupId = groupIdOf(space);
  return groupId === null ? null : { kind: "group", groupId };
}

function zoneIn(source: DragSource, tab: DragTab, folderId: string | null): DropZone | null {
  if (folderId !== null) return placeAt(source, folderId, { kind: "folder", folderId });
  const scope = rootScope(tab, source.space);
  return scope === null ? null : placeAt(source, null, scope);
}

export function evaluateDragOver(input: {
  source: DragSource;
  target: DragTarget;
  lookup: DropLookup;
  tab: DragTab;
  isCollapsed: (folderId: string) => boolean;
  previewAnchor: string | null;
}): DragOverResult {
  const { source, lookup, tab, isCollapsed, previewAnchor } = input;
  let { target } = input;
  // The preview just appeared and this dragover still points at the old row (the B row).
  if (previewAnchor !== null && target.kind === "note" && target.id === previewAnchor) target = { kind: "preview" };
  if (target.kind === "preview") return { zone: { kind: "stack", scope: { kind: "preview" } }, row: "preview", hold: null };
  if (target.kind === "folder") {
    const folder = lookup.folders.get(target.id);
    if (folder === undefined) return NONE;
    const hold: HoldAction | null = isCollapsed(target.id) ? { kind: "spring", folderId: target.id } : null;
    if (folder.space !== source.space) return NONE;
    return { zone: placeAt(source, target.id, { kind: "folder", folderId: target.id }), row: `folder:${target.id}`, hold };
  }
  if (target.kind === "note") {
    const row = `note:${target.id}`;
    const note = lookup.notes.get(target.id);
    if (note === undefined) return NONE;
    if (note.space !== source.space) return { zone: null, row, hold: null };
    const canStack = target.id !== source.noteId && note.placeable && note.folderDepth < FOLDER_DEPTH_MAX;
    return {
      zone: zoneIn(source, tab, note.folderId),
      row,
      hold: canStack ? { kind: "stack", anchorNoteId: target.id, parentFolderId: note.folderId } : null,
    };
  }
  if (target.kind === "group") {
    if (tab !== "workspace" || `group:${target.id}` !== source.space) return NONE;
    return { zone: placeAt(source, null, { kind: "group", groupId: target.id }), row: null, hold: null };
  }
  if (target.kind === "blank") return { zone: zoneIn(source, tab, null), row: null, hold: null };
  return NONE;
}

/** Names are compared case-insensitively; `taken.size + 1` candidates guarantee a free one (pigeonhole), unless the string is broken (same every time): then the last candidate goes to the server's 409 resend path. */
export function stackFolderName(existing: readonly string[], t: Translate, skip: ReadonlySet<string> = new Set()): string {
  const taken = new Set([...existing, ...skip].map((name) => name.toLowerCase()));
  let name = "";
  for (let n = 1; n <= taken.size + 1; n += 1) {
    name = n === 1 ? t("folders.stackName") : t("folders.stackNameN", { n });
    if (!taken.has(name.toLowerCase())) return name;
  }
  return name;
}

const DRAG_TABS: readonly SidebarTab[] = ["myNotes", "workspace", "shared"];

export function isDragEnabled(input: { finePointer: boolean; tab: SidebarTab; selectionActive: boolean; creating: boolean; nodesReady: boolean }): boolean {
  return input.finePointer && DRAG_TABS.includes(input.tab) && !input.selectionActive && !input.creating && input.nodesReady;
}

import { useEffect, useMemo, useRef, useState, type DragEvent, type HTMLAttributes } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { FOLDER_DEPTH_MAX, type FolderDto, type FolderSpaceDto } from "@knotebook/shared";
import { FOLDERS_QUERY_KEY } from "@/api/folders";
import type { FolderDialogRequest } from "@/components/NoteList";
import { toast } from "@/components/ui/toast";
import { placeNoteWithUndo } from "@/lib/note-place";
import { useSidebarTabState, type SidebarTab } from "@/lib/sidebar-tab";
import { isCollapsed, setCollapsed } from "./collapse";
import { destinationShortLabel } from "./destination-level";
import {
  applyDragOver,
  beginDrag,
  endDrag,
  getDragSource,
  setCreating,
  setPreview,
  takeDropZone,
  useDragView,
  type DragView,
  type StackPreviewState,
} from "./drag-session";
import {
  buildDropLookup,
  DRAG_NOTE_MIME,
  DRAG_POINTER_QUERY,
  evaluateDragOver,
  isDragEnabled,
  readDragTarget,
  stackFolderName,
  type DragSource,
  type DragTab,
  type DropLookup,
  type HoldAction,
} from "./drag-zone";
import { expandFolderChain, indexFolders, type FolderIndex, type FolderSpaceKey } from "./folder-index";
import type { SidebarNode } from "./tree";

/** First-bundle module: no string-bundle import. When it doesn't take over the drag, native link dragging is unchanged. */

/** Drop-scope hint: a fainter brand fill than `bg-brand-soft` plus a brand outline. */
export const DROP_SCOPE_CLASS = "bg-brand/8 ring-1 ring-inset ring-brand";

export function useFinePointer(): boolean {
  const read = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(DRAG_POINTER_QUERY).matches;
  const [fine, setFine] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(DRAG_POINTER_QUERY);
    const onChange = () => setFine(mql.matches);
    mql.addEventListener("change", onChange);
    onChange();
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return fine;
}

function dragTabOf(tab: SidebarTab): DragTab | null {
  return tab === "myNotes" || tab === "workspace" || tab === "shared" ? tab : null;
}

/** Clear only if the drag in progress was started by this instance (the other instance unmounting doesn't affect it). */
function endIfOwner(ownSource: { readonly current: DragSource | null }): void {
  if (ownSource.current !== null && ownSource.current === getDragSource()) endDrag();
}

function spaceDtoOf(space: FolderSpaceKey): FolderSpaceDto {
  if (space === "personal" || space === "shared") return { kind: space };
  return { kind: "group", groupId: space.slice("group:".length) };
}

function siblingNames(index: FolderIndex, space: FolderSpaceKey, parentFolderId: string | null): string[] {
  return index.children(space, parentFolderId).map((folder) => folder.name);
}

export function useSidebarDrag(args: {
  tab: SidebarTab;
  nodes: readonly SidebarNode[] | null;
  groupIds: ReadonlySet<string>;
  folderIndex: FolderIndex;
  openFolderDialog: (request: FolderDialogRequest, opener: HTMLElement | null) => void;
}): {
  enabled: boolean;
  containerProps: Pick<HTMLAttributes<HTMLDivElement>, "onDragStart" | "onDragOver" | "onDrop" | "onDragEnd">;
  view: DragView;
} {
  const { tab, nodes, groupIds, folderIndex, openFolderDialog } = args;
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { selection } = useSidebarTabState();
  const finePointer = useFinePointer();
  const view = useDragView();
  /** Drag source started by this instance: only when it is the same object as `getDragSource()` does it drive dragover (the other of static card and drawer stays idle). */
  const ownSourceRef = useRef<DragSource | null>(null);
  const dragTab = dragTabOf(tab);
  const lookup = useMemo(() => (nodes === null || dragTab === null ? null : buildDropLookup(nodes, dragTab, groupIds)), [nodes, dragTab, groupIds]);
  const enabled = isDragEnabled({ finePointer, tab, selectionActive: selection.active, creating: view.creating !== null, nodesReady: nodes !== null });
  /** Latest lookup/index/t read when the timer fires: the timer captured an old `onHold`, and stack-folder must re-judge against the current tree. */
  const latestRef = useRef<{ lookup: DropLookup | null; folderIndex: FolderIndex; t: typeof t }>({ lookup, folderIndex, t });
  useEffect(() => {
    latestRef.current = { lookup, folderIndex, t };
  });

  /** Whether this instance is still mounted: the drawer can close during the three stack-folder requests, and then its rename dialog can't open. */
  const mountedRef = useRef(true);
  // The instance that started the drag unmounted mid-drag (e.g. drawer closed): `dragend` never reaches React, so clean up on unmount.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      endIfOwner(ownSourceRef);
    };
  }, []);

  /**
   * Timer fires: spring = expand (writes the collapse key; not collapsed again when the drag ends); stack-folder = show the preview.
   * If the same row's hold goes non-null → null the old timer keeps running: before showing the preview, re-judge with the current lookup that B can still be stacked (placeable, same space, same level, depth < 5).
   */
  const onHold = (hold: HoldAction) => {
    if (hold.kind === "spring") {
      setCollapsed(`folder:${hold.folderId}`, false);
      return;
    }
    const source = getDragSource();
    const latest = latestRef.current;
    const anchor = latest.lookup?.notes.get(hold.anchorNoteId);
    if (source === null || source !== ownSourceRef.current || anchor === undefined) return;
    if (!anchor.placeable || anchor.space !== source.space || anchor.folderId !== hold.parentFolderId || anchor.folderDepth >= FOLDER_DEPTH_MAX) return;
    setPreview({
      anchorNoteId: hold.anchorNoteId,
      parentFolderId: hold.parentFolderId,
      name: stackFolderName(siblingNames(latest.folderIndex, source.space, hold.parentFolderId), latest.t),
      sourceTitle: source.title,
    });
  };

  /** `instance`: the `[data-sidebar-instance]` that started the drag; on dialog close focus returns to the new folder row inside it. The success toast waits until the rename dialog closes (`stack.onClosed`). */
  const stackInto = async (source: DragSource, preview: StackPreviewState, instance: Element | null) => {
    setCreating(preview);
    const flow = await import("@/lib/stack-folder").catch(() => null);
    if (flow === null) {
      toast({ title: t("errors.fallback"), variant: "destructive" });
      setCreating(null);
      return;
    }
    const a = { noteId: source.noteId, from: source.folderId };
    const b = { noteId: preview.anchorNoteId, from: preview.parentFolderId };
    let folder: FolderDto | null = null;
    try {
      folder = await flow.runStackFolder({
        a,
        b,
        parent: preview.parentFolderId !== null ? { folderId: preview.parentFolderId } : { space: spaceDtoOf(source.space) },
        firstName: preview.name,
        takenNames: siblingNames(folderIndex, source.space, preview.parentFolderId),
        queryClient,
        t,
      });
    } finally {
      setCreating(null);
    }
    if (folder === null) return;
    const created = folder;
    if (preview.parentFolderId !== null) {
      expandFolderChain(indexFolders(queryClient.getQueryData<FolderDto[]>(FOLDERS_QUERY_KEY) ?? []), preview.parentFolderId);
    }
    // The originating instance unmounted (drawer closed by Esc/outside click/breakpoint during the three requests): no rename dialog, so show the success toast directly (name = the created name) with Undo.
    if (!mountedRef.current) {
      flow.showStackCreatedToast({ folderId: created.id, name: created.name, a, b, queryClient, t });
      return;
    }
    openFolderDialog(
      {
        kind: "rename",
        folder: created,
        stack: {
          onClosed: (name) => flow.showStackCreatedToast({ folderId: created.id, name, a, b, queryClient, t }),
          focusTarget: () => instance?.querySelector<HTMLElement>(`[data-node-kind="folder"][data-node-id="${created.id}"] button[aria-expanded]`) ?? null,
        },
      },
      null,
    );
  };

  const onDragStart = (event: DragEvent<HTMLDivElement>) => {
    if (!enabled || lookup === null) return;
    const container = event.currentTarget;
    const row = event.target instanceof Element ? event.target.closest('[data-node-kind="note"]') : null;
    if (row === null || !container.contains(row)) return;
    const noteId = row.getAttribute("data-node-id");
    const entry = noteId === null ? undefined : lookup.notes.get(noteId);
    if (noteId === null || entry === undefined || !entry.placeable) return;
    // Add only the custom type, don't clear native data; keep `effectAllowed` copy/link and add move.
    event.dataTransfer.setData(DRAG_NOTE_MIME, noteId);
    event.dataTransfer.effectAllowed = "all";
    const source: DragSource = { noteId, space: entry.space, folderId: entry.folderId, title: entry.title };
    ownSourceRef.current = source;
    beginDrag(source, container);
    void import("@/lib/stack-folder").catch(() => undefined);
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    const source = getDragSource();
    if (source === null || source !== ownSourceRef.current || lookup === null || dragTab === null) return;
    if (!Array.from(event.dataTransfer.types).includes(DRAG_NOTE_MIME)) return;
    const result = evaluateDragOver({
      source,
      target: readDragTarget(event.target, event.currentTarget),
      lookup,
      tab: dragTab,
      isCollapsed: (folderId) => isCollapsed(`folder:${folderId}`),
      previewAnchor: view.preview?.anchorNoteId ?? null,
    });
    if (!applyDragOver(result, onHold)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  // Drop always preventDefaults (rows are <a>; Firefox would navigate otherwise); clear state and hint here (an optimistic update unmounts the source row, so a later dragend isn't guaranteed).
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const source = getDragSource();
    // The current preview comes from this render's view, read before takeDropZone clears it.
    const preview = view.preview;
    const instance = event.currentTarget.closest("[data-sidebar-instance]");
    ownSourceRef.current = null;
    const zone = takeDropZone();
    if (source === null || zone === null) return;
    if (zone.kind === "stack") {
      if (preview !== null) void stackInto(source, preview, instance);
      return;
    }
    // The drop zone comes from a tree built from the same index; if the index was refetched mid-drag the server returns 404 (rollback + error toast) and the name isn't used.
    const folder = zone.folderId === null ? null : (folderIndex.byId.get(zone.folderId) ?? null);
    void placeNoteWithUndo({
      noteId: source.noteId,
      from: source.folderId,
      to: { folderId: zone.folderId, name: destinationShortLabel(folder, t) },
      index: folderIndex,
      queryClient,
      t,
      optimistic: true,
    });
  };

  const onDragEnd = () => {
    ownSourceRef.current = null;
    endDrag();
  };

  return { enabled, containerProps: { onDragStart, onDragOver, onDrop, onDragEnd }, view };
}

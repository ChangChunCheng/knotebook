import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FolderDto, GroupDto, NoteDto } from "@knotebook/shared";
import { useFolders } from "@/api/folders";
import { useGroups } from "@/api/groups";
import {
  backItem,
  buildDestinationLevel,
  destinationPathLabel,
  isEmptyDestination,
  isSameSpace,
  livePath,
  noteDestSource,
  type DestItem,
  type DestPathStep,
  type DestSource,
  type DestTarget,
  type Translate,
} from "@/components/sidebar/destination-level";
import { useWidePointer } from "@/lib/wide-pointer";
import { destinationItemIcon } from "@/components/sidebar/destination-icon";
import { indexFolders, type FolderIndex } from "@/components/sidebar/folder-index";
import { ChevronDown, ChevronRight, Copy, FolderInput } from "@/components/ui/icons";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  useMenuSheet,
} from "@/components/ui/dropdown-menu";

export type GroupTransferKind = "move" | "copy";

/** `path` is the full `destinationPathLabel` path ("My notes > A", "R&D > A > B"), shown in the confirm dialog. */
export type FolderRef = { id: string; path: string };

/**
 * - `group`: move or copy into a group; no `folder` = group root.
 * - `inPlace`: duplicate a group note (lands in the source's folder).
 * - `duplicate`: duplicate your own personal note (lands in the source's folder).
 * - `personal`: copy to my notes; no `folder` = root (a shared note's own share placement doesn't carry over).
 */
export type TransferTarget =
  | { type: "group"; group: GroupDto; folder?: FolderRef }
  | { type: "inPlace"; group: GroupDto }
  | { type: "duplicate" }
  | { type: "personal"; folder?: FolderRef };

export interface GroupTransferPick {
  kind: GroupTransferKind;
  target: TransferTarget;
}

/** Groups and index are computed in `GroupTransferMenuItems` (mounted only while the menu is open) so `NoteMenuCore` needn't subscribe to `useGroups`/`useFolders`. */
export interface DestinationPick {
  kind: GroupTransferKind;
  target: DestTarget;
  groups: readonly GroupDto[];
  index: FolderIndex;
}

export type DestPaths = Readonly<Record<GroupTransferKind, readonly DestPathStep[]>>;
const NO_STEPS: readonly DestPathStep[] = [];
export const EMPTY_DEST_PATHS: DestPaths = { move: NO_STEPS, copy: NO_STEPS };

const NO_GROUPS: readonly GroupDto[] = [];
const NO_FOLDERS: readonly FolderDto[] = [];

function folderRef(target: Extract<DestTarget, { kind: "place" }>, index: FolderIndex, t: Translate): FolderRef | undefined {
  return target.folder === null ? undefined : { id: target.folder.id, path: destinationPathLabel(target.space, target.folder, index, t) };
}

/** Callers skip the confirm dialog and PUT directly. */
export function isSameSpaceMove(note: NoteDto, pick: DestinationPick): boolean {
  return pick.kind === "move" && pick.target.kind === "place" && isSameSpace(pick.target, noteDestSource(note, "move", pick.groups));
}

/**
 * `null` = same-space move or an unreachable branch; callers tell them apart with `isSameSpaceMove` and do nothing for the latter.
 * Only your own personal notes can move to another group.
 * Groups and `DestSpace` both come from `pick.groups` (`noteDestSource`), so a missing group is unreachable; return null conservatively.
 */
export function transferTargetOf(note: NoteDto, pick: DestinationPick, t: Translate): TransferTarget | null {
  const { target, groups, index } = pick;
  const findGroup = (groupId: string | null) => groups.find((group) => group.id === groupId);
  if (target.kind === "makeCopy") {
    if (note.groupId === null) return { type: "duplicate" };
    const own = findGroup(note.groupId);
    return own === undefined ? null : { type: "inPlace", group: own };
  }
  const folder = folderRef(target, index, t);
  const { space } = target;
  if (isSameSpaceMove(note, pick)) return null;
  if (space.kind === "personal") return folder === undefined ? { type: "personal" } : { type: "personal", folder };
  if (space.kind !== "group") return null;
  const group = findGroup(space.groupId);
  if (group === undefined) return null;
  return folder === undefined ? { type: "group", group } : { type: "group", group, folder };
}

interface LevelNav {
  items: DestItem[];
  /** Owned by NoteMenuCore; the same object identity means the level didn't change. */
  path: readonly DestPathStep[];
  /** Level 2+ ("back" is always first); not derived from `path.length` (see `livePath`). */
  nested: boolean;
  drill: (step: DestPathStep) => void;
  back: () => void;
  pick: (target: DestTarget) => void;
}

/**
 * Stays mounted while expanded (don't key by `path`); focus moves to the first enabled item when the level changes
 * (from level 2 on, that is "back").
 * `focusOnMount` does the same at mount: in the phone sheet the trigger unmounts, so focus would fall out of the menu.
 */
function DestinationLevelItems({
  level,
  itemClassName,
  onLeft,
  focusOnMount = false,
}: {
  level: LevelNav;
  itemClassName?: string;
  onLeft: () => void;
  focusOnMount?: boolean;
}) {
  const { items, path } = level;
  const firstRef = useRef<HTMLDivElement>(null);
  const prevPath = useRef<readonly DestPathStep[] | null>(focusOnMount ? null : path);
  useLayoutEffect(() => {
    if (prevPath.current === path) return;
    prevPath.current = path;
    firstRef.current?.focus();
  }, [path]);
  const firstEnabled = items.findIndex((item) => item.kind === "back" || (item.kind !== "separator" && item.disabled === null));
  return (
    <>
      {items.map((item, position) => {
        if (item.kind === "separator") return <DropdownMenuSeparator key={item.key} />;
        const drill = item.kind === "folder" || item.kind === "space" ? item.drill : null;
        const Icon = destinationItemIcon(item);
        return (
          <DropdownMenuItem
            key={item.key}
            ref={position === firstEnabled ? firstRef : undefined}
            className={itemClassName}
            disabled={item.kind !== "back" && item.disabled !== null}
            textValue={item.label}
            aria-label={drill === null ? undefined : item.accessibleName}
            onSelect={(event) => {
              if (item.kind === "back") {
                event.preventDefault(); // keep the menu open; go back a level
                level.back();
              } else if (drill !== null) {
                event.preventDefault(); // keep the menu open; switch to the next level
                level.drill(drill);
              } else {
                level.pick(item.target);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" && drill !== null) {
                event.preventDefault();
                level.drill(drill);
              } else if (event.key === "ArrowLeft") {
                event.preventDefault();
                onLeft();
              }
            }}
          >
            {Icon !== null && <Icon aria-hidden="true" className="mr-2 h-4 w-4 shrink-0" />}
            <span className="truncate">{item.label}</span>
            {drill !== null && <ChevronRight aria-hidden="true" className="ml-auto h-4 w-4 shrink-0" />}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

/** Same classes as the other `NoteMenu` items (`mr-2 h-4 w-4`). */
function TransferIcon({ kind }: { kind: GroupTransferKind }) {
  return kind === "move" ? <FolderInput className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />;
}

/**
 * Collapsing (clicking the trigger again, ArrowLeft on level 1) also resets path at the caller; Esc collapse is handled by `NoteMenu`'s
 * `onEscapeKeyDown` (see `GroupTransferMenuItems`).
 */
function GroupInline({
  kind,
  label,
  level,
  open,
  onOpenChange,
  testId,
  triggerRef,
}: {
  kind: GroupTransferKind;
  label: string;
  level: LevelNav;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  testId: string;
  triggerRef: (el: HTMLDivElement | null) => void;
}) {
  return (
    <>
      <DropdownMenuItem
        ref={triggerRef}
        data-testid={testId}
        aria-expanded={open}
        onSelect={(event) => {
          event.preventDefault(); // keep the menu open; only toggle expansion
          onOpenChange(!open);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" && !open) {
            event.preventDefault();
            onOpenChange(true);
          } else if (event.key === "ArrowLeft" && open) {
            event.preventDefault();
            onOpenChange(false);
          }
        }}
      >
        <TransferIcon kind={kind} />
        {label}
        <ChevronDown className={"ml-auto h-4 w-4 transition-transform" + (open ? " rotate-180" : "")} />
      </DropdownMenuItem>
      {open && (
        <DropdownMenuGroup aria-label={label}>
          <DestinationLevelItems
            level={level}
            itemClassName="pl-6"
            onLeft={() => (level.nested ? level.back() : onOpenChange(false))}
          />
        </DropdownMenuGroup>
      )}
    </>
  );
}

/** Esc collapse is handled by `NoteMenu`'s `onEscapeKeyDown`; focus returns to the trigger afterwards (see `GroupTransferMenuItems`). */
function GroupSheet({
  kind,
  label,
  level,
  open,
  hidden,
  onOpenChange,
  testId,
  triggerRef,
}: {
  kind: GroupTransferKind;
  label: string;
  level: LevelNav;
  open: boolean;
  /** The other kind (move/copy) is expanded. */
  hidden: boolean;
  onOpenChange: (open: boolean) => void;
  testId: string;
  triggerRef: (el: HTMLDivElement | null) => void;
}) {
  const { t } = useTranslation();
  if (hidden) return null;
  if (!open) {
    return (
      <DropdownMenuItem
        ref={triggerRef}
        data-testid={testId}
        onSelect={(event) => {
          event.preventDefault(); // keep the menu open; switch to this group
          onOpenChange(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") {
            event.preventDefault();
            onOpenChange(true);
          }
        }}
      >
        <TransferIcon kind={kind} />
        {label}
        <ChevronRight aria-hidden="true" className="ml-auto h-4 w-4 shrink-0" />
      </DropdownMenuItem>
    );
  }
  const sheetLevel: LevelNav = level.nested
    ? level
    : { ...level, items: [backItem(t), ...level.items], nested: true, back: () => onOpenChange(false) };
  return (
    <DropdownMenuGroup aria-label={label}>
      <DestinationLevelItems level={sheetLevel} onLeft={sheetLevel.back} focusOnMount />
    </DropdownMenuGroup>
  );
}

const CASCADE_CONTENT_CLASS =
  "max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height))] max-w-[min(18rem,calc(100vw-2rem))] overflow-y-auto";

interface CascadeProps {
  source: DestSource;
  index: FolderIndex;
  onPick: (target: DestTarget) => void;
}

type DrillItem = Extract<DestItem, { kind: "folder" | "space" }> & { drill: DestPathStep };

/**
 * Radix's SubContent calls the root's onClose on Esc (closing the whole menu), so Esc is handled here: collapse only this level and
 * refocus the trigger (`CascadeSub` does the same). ArrowLeft is left to Radix, which collapses the level on `SubContent` and refocuses the trigger.
 * `SubContent` is portaled (see `ui/dropdown-menu.tsx`), so a parent's `overflow-hidden` can't clip it and Radix flips it near viewport edges.
 */
function CascadeRoot({
  kind,
  label,
  testId,
  source,
  index,
  onPick,
}: CascadeProps & { kind: GroupTransferKind; label: string; testId: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // When the focused item unmounts (late folders turn an item into a SubTrigger; a deleted folder takes its submenu with it) focus falls to
  // body and the keyboard can't get back into the menu: after each render hand it to this level's content (Radix passes it to the first
  // focusable item). Must be useEffect: in a layout effect Radix's collection still holds the unmounted item and focusFirst calls focus on
  // null. `CascadeSub` does the same, and the child's effect runs first.
  useEffect(() => {
    if (open && document.activeElement === document.body) contentRef.current?.focus();
  });
  return (
    <DropdownMenuSub open={open} onOpenChange={setOpen}>
      <DropdownMenuSubTrigger ref={triggerRef} data-testid={testId}>
        <TransferIcon kind={kind} />
        {label}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        ref={contentRef}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          setOpen(false);
          triggerRef.current?.focus();
        }}
        className={CASCADE_CONTENT_CLASS}
      >
        <CascadeItems source={source} path={NO_STEPS} index={index} onPick={onPick} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** `buildDestinationLevel` without "back": the wide form has none, since cascading sideways is itself the way back. */
function CascadeItems({ source, path, index, onPick }: CascadeProps & { path: readonly DestPathStep[] }) {
  const { t } = useTranslation();
  const items = buildDestinationLevel({ source, path, index, t }).filter((item) => item.kind !== "back");
  return (
    <>
      {items.map((item) => {
        if (item.kind === "separator") return <DropdownMenuSeparator key={item.key} />;
        if ((item.kind === "folder" || item.kind === "space") && item.drill !== null) {
          return <CascadeSub key={item.key} item={{ ...item, drill: item.drill }} source={source} path={path} index={index} onPick={onPick} />;
        }
        const Icon = destinationItemIcon(item);
        return (
          <DropdownMenuItem key={item.key} disabled={item.disabled !== null} textValue={item.label} onSelect={() => onPick(item.target)}>
            {Icon !== null && <Icon aria-hidden="true" className="mr-2 h-4 w-4 shrink-0" />}
            <span className="truncate">{item.label}</span>
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

/**
 * No `aria-label` on the trigger: the item text (folder or space name) is the accessible name and Radix's `aria-haspopup`/`aria-expanded`
 * convey the submenu (the narrow form's ", open next level" isn't used here); the right arrow is `DropdownMenuSubTrigger`'s own. Esc as in
 * `CascadeRoot` (collapse only this level, refocus this trigger). Content mounts only when open (Radix `Presence`), so recursion doesn't
 * pre-expand the tree.
 */
function CascadeSub({ item, source, path, index, onPick }: CascadeProps & { item: DrillItem; path: readonly DestPathStep[] }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Same focus recovery as `CascadeRoot` (must be useEffect).
  useEffect(() => {
    if (open && document.activeElement === document.body) contentRef.current?.focus();
  });
  const Icon = destinationItemIcon(item);
  return (
    <DropdownMenuSub open={open} onOpenChange={setOpen}>
      <DropdownMenuSubTrigger ref={triggerRef} textValue={item.label}>
        {Icon !== null && <Icon aria-hidden="true" className="mr-2 h-4 w-4 shrink-0" />}
        <span className="truncate">{item.label}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        ref={contentRef}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          setOpen(false);
          triggerRef.current?.focus();
        }}
        className={CASCADE_CONTENT_CLASS}
      >
        <CascadeItems source={source} path={[...path, item.drill]} index={index} onPick={onPick} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

export function GroupTransferMenuItems({
  note,
  onPick,
  expanded,
  onExpandedChange,
  paths,
  onPathChange,
  onModeChange,
}: {
  note: NoteDto;
  onPick: (pick: DestinationPick) => void;
  /** Expanded state lives in `NoteMenu`: Esc must collapse before closing the menu, and Radix listens for Esc on document so an item's onKeyDown can't stop it. Unused by the cascade form. */
  expanded: GroupTransferKind | null;
  onExpandedChange: (kind: GroupTransferKind | null) => void;
  paths: DestPaths;
  onPathChange: (kind: GroupTransferKind, path: readonly DestPathStep[]) => void;
  onModeChange: () => void;
}) {
  const { t } = useTranslation();
  const groupsQuery = useGroups();
  const foldersQuery = useFolders();
  const groups = groupsQuery.data ?? NO_GROUPS;
  const index = useMemo(() => indexFolders(foldersQuery.data ?? NO_FOLDERS), [foldersQuery.data]);
  const wide = useWidePointer();
  const inline = !wide;
  const sheet = useMenuSheet();
  // A flip after mount (window resize, external mouse, tablet rotation) tells the caller to close the whole menu; never at mount.
  const prevWide = useRef(wide);
  useEffect(() => {
    if (prevWide.current === wide) return;
    prevWide.current = wide;
    onModeChange();
  }, [wide, onModeChange]);
  const triggers = useRef<Partial<Record<GroupTransferKind, HTMLDivElement | null>>>({});
  const prevExpanded = useRef<GroupTransferKind | null>(null);
  // After a collapse (esp. Esc) focus was on the unmounted item; give it back to the trigger.
  useEffect(() => {
    const prev = prevExpanded.current;
    prevExpanded.current = expanded;
    if (prev !== null && expanded === null) {
      const el = triggers.current[prev];
      const active = document.activeElement;
      if (el && !(active && active.closest('[role="menuitem"]'))) el.focus();
    }
  }, [expanded]);
  const kinds = [
    { kind: "move" as const, label: t("note.menu.moveTo"), testId: "note-menu-move-to" },
    { kind: "copy" as const, label: t("note.menu.copyTo"), testId: "note-menu-copy-to" },
  ]
    .map((entry) => ({ ...entry, source: noteDestSource(note, entry.kind, groups) }))
    .filter((entry) => !isEmptyDestination(entry.source, index, t));
  const levelOf = (kind: GroupTransferKind, source: DestSource): LevelNav => {
    const path = paths[kind];
    const items = buildDestinationLevel({ source, path, index, t });
    return {
      items,
      path,
      nested: items[0]?.kind === "back",
      drill: (step) => onPathChange(kind, [...livePath(source, path, index, t), step]),
      back: () => onPathChange(kind, livePath(source, path, index, t).slice(0, -1)),
      pick: (target) => onPick({ kind, target, groups, index }),
    };
  };
  const openChangeOf = (kind: GroupTransferKind) => (open: boolean) => {
    // Collapsing returns to level 1; expanding another group returns the collapsed one to level 1 too (one group expanded at a time).
    if (!open) onPathChange(kind, NO_STEPS);
    else if (expanded !== null && expanded !== kind) onPathChange(expanded, NO_STEPS);
    onExpandedChange(open ? kind : null);
  };
  const triggerRefOf = (kind: GroupTransferKind) => (el: HTMLDivElement | null) => {
    triggers.current[kind] = el;
  };
  return (
    <>
      {kinds.map(({ kind, label, testId, source }) =>
        sheet ? (
          <GroupSheet
            key={kind}
            kind={kind}
            label={label}
            testId={testId}
            level={levelOf(kind, source)}
            open={expanded === kind}
            hidden={expanded !== null && expanded !== kind}
            onOpenChange={openChangeOf(kind)}
            triggerRef={triggerRefOf(kind)}
          />
        ) : inline ? (
          <GroupInline
            key={kind}
            kind={kind}
            label={label}
            testId={testId}
            level={levelOf(kind, source)}
            open={expanded === kind}
            onOpenChange={openChangeOf(kind)}
            triggerRef={triggerRefOf(kind)}
          />
        ) : (
          <CascadeRoot
            key={kind}
            kind={kind}
            label={label}
            testId={testId}
            source={source}
            index={index}
            onPick={(target) => onPick({ kind, target, groups, index })}
          />
        ),
      )}
    </>
  );
}

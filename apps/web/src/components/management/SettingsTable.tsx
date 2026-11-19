import { Fragment, isValidElement, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import "@/i18n/management-strings";

/**
 * Column order is enforced: primary, info (text/url/fixed, in declared order), control, actions, enabled; a declaration
 * that violates it logs console.error in development and is reordered anyway.
 * Track widths go through inline `--kb-table-cols` (Tailwind v4 only emits classes found in source, so arbitrary classes
 * can't be built at runtime). Header and data rows are `grid-column: 1 / -1` subgrids, so `max-content` tracks share one
 * width across the table and columns align with the header. Rows must not set gap, horizontal padding or inline-direction
 * borders (subgrid adds them to edge items); padding lives on cells. Cells stretch to the row's content height and wrap
 * their content in a single `flex-1 min-w-0` child, which carries the column's horizontal alignment.
 * Narrow screens don't reflow: they scroll horizontally with a sticky primary column (opaque background, z-index 1: the
 * switch knob's translate creates a stacking context). The scroll region is focusable only while content overflows.
 * `scroll-padding-inline-start` is the header primary cell's width so Tab-scroll lands right of the sticky column (WCAG 2.4.11);
 * the scroll region's focus handler covers targets already inside the box but under it. Detail and error rows are separate rows
 * after the data row, not subgrids. Nested tables have no scroll region or sticky column (a sticky box can't leave its row,
 * and the wide nested primary track would cover the row's buttons and switches); their header row is sr-only for the
 * switches' `aria-labelledby`.
 * Layout class/style assertions belong only in this component's tests; page tests use semantic queries.
 */

export type SettingsTableColumnKind = "primary" | "text" | "url" | "fixed" | "control" | "actions" | "enabled";

export interface SettingsTableColumn {
  id: string;
  /** Rendered sr-only for `actions`. */
  header: string;
  kind: SettingsTableColumnKind;
  /** `actions` only: the most buttons any row has (sets the fixed track width). */
  buttons?: number;
  /** `primary`/`text`/`url` only (ignored for other kinds): replaces the kind's default fr ratio. */
  grow?: number;
}

export type SettingsTableTone = "default" | "muted" | "danger";

export interface SettingsTableCellSpec {
  content: ReactNode;
  tone?: SettingsTableTone;
  /** Full text for `url` cells; may be omitted when `content` is a string. */
  title?: string;
}

export type SettingsTableCellValue = ReactNode | SettingsTableCellSpec;

/**
 * Names are always bidi-isolated (`dir="ltr"` plus `unicode-bidi:isolate`, as for token names): every name in these
 * tables is supplied by users, admins or OAuth clients. `icon` renders as the name element's previous sibling; tests
 * find it that way. `weight` keeps each table's existing style (the component bolds nothing); default normal.
 */
export interface SettingsTablePrimary {
  name: string;
  weight?: "normal" | "medium" | "semibold";
  icon?: ReactNode;
  badges?: ReactNode;
  subtitles?: ReactNode[];
}

export interface SettingsTableRow {
  /** Stable database id: DOM ids use it, not the name (names can repeat). */
  id: string;
  primary: SettingsTablePrimary;
  /** Keyed by column id. */
  cells?: Record<string, SettingsTableCellValue>;
  /** `RowIconButton`s only: the track width assumes 32px buttons. */
  actions?: ReactNode;
  /** Receives `aria-labelledby` (enabled header id plus name text id) for the `Switch`. */
  enabled?: (labelledBy: string) => ReactNode;
  detail?: ReactNode;
  /** When set, the row is in edit mode: the primary cell stays and the other columns merge into one cell holding this. */
  editing?: ReactNode;
  /** Rendered as an error row (`role="alert"`) after the data row, before any detail row. */
  error?: ReactNode;
}

export interface SettingsTableProps {
  /** Also names a top-level table's scroll region. */
  label: string;
  columns: SettingsTableColumn[];
  rows: SettingsTableRow[];
  /** Column whose text names rows and switches (default: primary). Its content must be plain text. */
  nameColumn?: string;
  /** With zero rows neither table nor scroll region renders; loading and errors are the caller's job. */
  empty?: ReactNode;
  /** Rendered with or without rows; top-level tables usually take their title from `SettingsGroup` instead. */
  title?: ReactNode;
  titleAction?: ReactNode;
  /** Goes in the parent's detail row. */
  nested?: boolean;
}

const KIND_RANK: Record<SettingsTableColumnKind, number> = { primary: 0, text: 1, url: 1, fixed: 1, control: 2, actions: 3, enabled: 4 };

export function orderSettingsTableColumns(columns: SettingsTableColumn[]): SettingsTableColumn[] {
  const ordered = columns
    .map((column, index) => ({ column, index }))
    .sort((a, b) => KIND_RANK[a.column.kind] - KIND_RANK[b.column.kind] || a.index - b.index)
    .map(({ column }) => column);
  if (import.meta.env.DEV) {
    if (ordered.some((column, index) => column !== columns[index])) {
      console.error(
        `SettingsTable：欄位宣告順序不符規定，已改照「主欄→資訊欄→可編輯欄→操作鈕欄→啟用欄」排：${ordered.map((column) => column.id).join(", ")}`,
      );
    }
    const count = (kind: SettingsTableColumnKind): number => columns.filter((column) => column.kind === kind).length;
    if (count("primary") !== 1) console.error(`SettingsTable：一張表恰有一個 primary 欄，實際 ${count("primary")} 個`);
    if (count("actions") > 1) console.error(`SettingsTable：一張表至多一個 actions 欄，實際 ${count("actions")} 個`);
    if (count("enabled") > 1) console.error(`SettingsTable：一張表至多一個 enabled 欄，實際 ${count("enabled")} 個`);
    for (const column of columns) {
      if (column.grow !== undefined && !validGrow(column.grow)) {
        console.error(`SettingsTable：欄「${column.id}」的 grow 必須是有限正數，實際 ${column.grow}，已改用預設`);
      }
      if (column.kind === "actions" && (column.buttons === undefined || column.buttons < 1)) {
        console.error(`SettingsTable：actions 欄「${column.id}」要給 buttons（該表一列最多的按鈕數）`);
      }
    }
  }
  return ordered;
}

/** A non-finite or non-positive `grow` would invalidate the whole grid-template, so it counts as unset. */
function validGrow(grow: number): boolean {
  return Number.isFinite(grow) && grow > 0;
}

function fr(column: SettingsTableColumn, fallback: number): number {
  return column.grow !== undefined && validGrow(column.grow) ? column.grow : fallback;
}

/** 56px in both parent and nested tables, both rightmost, so the switch centers line up. */
const ENABLED_TRACK = "3.5rem";

function settingsTableTrack(column: SettingsTableColumn, isLast: boolean): string {
  switch (column.kind) {
    case "primary":
      return `minmax(14ch,${fr(column, 2)}fr)`;
    case "text":
      return `minmax(14ch,${fr(column, 1)}fr)`;
    case "url":
      return `minmax(14ch,${fr(column, 1.5)}fr)`;
    case "fixed":
    case "control":
      return "max-content";
    case "actions": {
      const buttons = column.buttons ?? 1;
      // 32px buttons × n + gap-1 × (n−1); a last column carries pr-3, which border-box (preflight) takes out of the track, so add 0.75rem.
      return `${buttons * 2 + (buttons - 1) * 0.25 + (isLast ? 0.75 : 0)}rem`;
    }
    case "enabled":
      return ENABLED_TRACK;
  }
}

export function settingsTableTracks(ordered: SettingsTableColumn[]): string {
  return ordered.map((column, index) => settingsTableTrack(column, index === ordered.length - 1)).join(" ");
}

/** Rows must not add gap, horizontal padding or `items-*` (subgrid). */
const ROW_GRID = "col-span-full grid grid-cols-subgrid max-sm:flex max-sm:flex-wrap";
/** Drawn on the row so it doesn't break at column gaps. */
const ROW_BORDER = "border-b border-border";
const CELL = "flex items-center";
const STICKY_CELL =
  "sticky left-0 z-[1] border-border bg-card group-data-[overflowing]/box:border-r max-sm:static max-sm:bg-transparent max-sm:group-data-[overflowing]/box:border-r-0 " +
  // Phone has no sticky column: transparent cells show the card surface (popover), and an editing row's tint overlays the popover.
  "max-sm:[--kb-sticky-surface:var(--popover)]";
/** Overlay on the card color: `--brand-soft` is translucent; inline style, not a `bg-[…]` arbitrary value. */
const EDITING_STICKY_BACKGROUND = "linear-gradient(var(--brand-soft), var(--brand-soft)), var(--kb-sticky-surface, var(--card))";
const SCROLL_BOX = "group/box overflow-x-auto max-sm:overflow-x-visible scroll-ps-(--kb-sticky-w) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
/** No horizontal padding: a nested table must match the parent's width; non-table content brings its own px-3. */
const DETAIL_CELL = "pb-3";
/**
 * Phone touch hit area: `::after` grows outward (as in `ui/hit-area.ts`), only on this table's phone cards so the
 * shared components are unchanged. 32px icon buttons grow 6px per side to 44, with 12px spacing (44 between centers)
 * so they do not overlap; the 26x14 switch grows 10px left/right and 16px up/down.
 */
const TOUCH_ICON_BUTTONS =
  "max-sm:pointer-coarse:gap-3 max-sm:pointer-coarse:[&_button]:relative max-sm:pointer-coarse:[&_button]:after:absolute " +
  "max-sm:pointer-coarse:[&_button]:after:-inset-1.5 max-sm:pointer-coarse:[&_button]:after:content-['']";
const TOUCH_SWITCH =
  "max-sm:pointer-coarse:[&_[role=switch]]:relative max-sm:pointer-coarse:[&_[role=switch]]:after:absolute " +
  "max-sm:pointer-coarse:[&_[role=switch]]:after:-inset-x-2.5 max-sm:pointer-coarse:[&_[role=switch]]:after:-inset-y-4 " +
  "max-sm:pointer-coarse:[&_[role=switch]]:after:content-['']";
const INNER: Record<SettingsTableColumnKind, string> = {
  primary: "wrap-anywhere",
  text: "wrap-anywhere",
  // Phone: no truncation (touch cannot see the title); wrap anywhere.
  url: "truncate max-sm:overflow-visible max-sm:whitespace-normal max-sm:text-clip max-sm:wrap-anywhere",
  fixed: "whitespace-nowrap",
  control: "whitespace-nowrap",
  actions: "flex justify-end gap-1 " + TOUCH_ICON_BUTTONS,
  enabled: "flex justify-center " + TOUCH_SWITCH,
};
/**
 * Phone (< 640px) card layout; DOM and ARIA roles are unchanged. Empty cells go sr-only instead of leaving the layout
 * tree, so screen-reader header mapping does not shift. Labels align with a value's first line (multi-line values aren't
 * vertically centered); control cells hold tall controls and stay centered.
 */
const PHONE_CELL: Record<SettingsTableColumnKind, string> = {
  primary: "max-sm:basis-full",
  text: "max-sm:basis-full max-sm:items-start max-sm:has-[>div:empty]:sr-only",
  url: "max-sm:basis-full max-sm:items-start max-sm:has-[>div:empty]:sr-only",
  fixed: "max-sm:basis-full max-sm:items-start max-sm:has-[>div:empty]:sr-only",
  control: "max-sm:basis-full max-sm:has-[>div:empty]:sr-only",
  actions: "max-sm:flex-1 max-sm:has-[>div:empty]:sr-only",
  // Touch: the switch's hit area grows 16px up and down (46px), so cells are at least 48px high to avoid reaching into the row above.
  enabled: "max-sm:ml-auto max-sm:pointer-coarse:min-h-12 max-sm:has-[>div:empty]:sr-only",
};
const PHONE_LABELLED: ReadonlySet<SettingsTableColumnKind> = new Set(["text", "url", "fixed", "control"]);

const HEADER_INNER: Partial<Record<SettingsTableColumnKind, string>> = { actions: "text-right", enabled: "text-center" };

/** No `pr-3` on a last `enabled` cell: its 56px track already includes the spacing. */
function cellPadding(kind: SettingsTableColumnKind, index: number, count: number, header: boolean): string {
  return cn(header ? "py-2" : "py-2.5", index === 0 && "pl-3", index === count - 1 && kind !== "enabled" && "pr-3");
}

function isCellSpec(value: SettingsTableCellValue): value is SettingsTableCellSpec {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !isValidElement(value) && "content" in value;
}

function present(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false;
}

function PrimaryContent({ primary, nameId }: { primary: SettingsTablePrimary; nameId: string | undefined }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {primary.icon}
        <span
          id={nameId}
          dir="ltr"
          className={cn(
            "min-w-0 [unicode-bidi:isolate]",
            primary.weight === "medium" && "font-medium",
            primary.weight === "semibold" && "font-semibold",
          )}
        >
          {primary.name}
        </span>
        {primary.badges}
      </div>
      {primary.subtitles?.map((subtitle, index) => (
        <p key={index} className="text-xs text-muted-foreground">
          {subtitle}
        </p>
      ))}
    </>
  );
}

/** `stickyKey` is the primary column id: the header cell is keyed by it, so a new id is a new DOM node and the effect must resubscribe. */
function useScrollBox(active: boolean, stickyKey: string | undefined) {
  const boxRef = useRef<HTMLDivElement>(null);
  const headerRowRef = useRef<HTMLDivElement>(null);
  const stickyHeaderRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [focused, setFocused] = useState(false);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const headerRow = headerRowRef.current;
    if (!active || box === null || headerRow === null) return;
    const scroller: HTMLDivElement = box;
    const sticky = stickyKey === undefined ? null : stickyHeaderRef.current;
    function measure(entries: readonly ResizeObserverEntry[]): void {
      // Only the sticky cell's own borderBoxSize, not getBoundingClientRect: that is skewed by the management dialog's
      // opening zoom-in-95 transform, and callbacks for the scroll region or header row would overwrite the correct width
      // with the scaled one. ResizeObserver always delivers the sticky cell's initial entry, so no fallback is needed.
      const width = entries.find((entry) => entry.target === sticky)?.borderBoxSize?.[0]?.inlineSize;
      if (width !== undefined) scroller.style.setProperty("--kb-sticky-w", `${width}px`);
      setOverflowing(scroller.scrollWidth > scroller.clientWidth);
    }
    measure([]);
    // Track overflow does not resize the table box; observe the header row, which spans all tracks. The header primary
    // cell gives the sticky width.
    const observer = new ResizeObserver((entries) => measure(entries));
    observer.observe(scroller);
    observer.observe(headerRow);
    if (sticky !== null) observer.observe(sticky);
    return () => observer.disconnect();
  }, [active, stickyKey]);

  /**
   * The browser scrolls on focus (applying scroll-padding) only when the target is outside the visible area, not when it is
   * inside but partly under the sticky column (Chromium); shift scrollLeft until it shows. Compensate only for non-primary
   * cells of top-level data rows (scroll region > table > row with aria-labelledby): detail, error and nested rows have no
   * sticky cell so their controls are fully visible, and scrolling would move a button from under the cursor on mousedown
   * (focus first) and eat the click. Nor inside the primary (sticky) cell itself.
   */
  function revealPastSticky(target: Element): void {
    const scroller = boxRef.current;
    const sticky = stickyHeaderRef.current;
    // React onFocus bubbles through portals: focus in a dialog opened from a row is not a table control.
    if (scroller === null || sticky === null || !scroller.contains(target)) return;
    const row = target.closest('[role="row"]');
    if (row === null || !row.hasAttribute("aria-labelledby") || row.parentElement?.parentElement !== scroller) return;
    if (row.firstElementChild?.contains(target)) return;
    const covered = sticky.getBoundingClientRect().right - target.getBoundingClientRect().left;
    // Round up: scrollLeft may be rounded, leaving a sub-pixel overlap.
    if (covered > 0) scroller.scrollLeft -= Math.ceil(covered);
  }

  // Focusable only while overflowing; keep tabIndex while it has focus, update after blur.
  return { boxRef, headerRowRef, stickyHeaderRef, overflowing, tabbable: overflowing || focused, setFocused, revealPastSticky };
}

export function SettingsTable({ label, columns, rows, nameColumn, empty, title, titleAction, nested = false }: SettingsTableProps) {
  const { t } = useTranslation();
  const baseId = useId();
  const ordered = orderSettingsTableColumns(columns);
  const tracks = settingsTableTracks(ordered);
  const primaryId = ordered.find((column) => column.kind === "primary")?.id;
  const box = useScrollBox(!nested && rows.length > 0, primaryId);
  const nameColumnId = nameColumn ?? primaryId;
  const enabledColumn = ordered.find((column) => column.kind === "enabled");
  const headerId = (column: SettingsTableColumn): string => `${baseId}-col-${column.id}`;
  const nameId = (row: SettingsTableRow): string => `${baseId}-row-${row.id}-name`;
  const isSticky = (kind: SettingsTableColumnKind): boolean => kind === "primary" && !nested;

  const titleRow =
    title !== undefined || titleAction !== undefined ? (
      <div className={cn("flex items-center justify-between gap-2 py-2 pr-3", nested ? "pl-7" : "pl-3")}>
        <div className="min-w-0 text-xs font-semibold text-muted-foreground">{title}</div>
        {titleAction !== undefined && <div className="shrink-0">{titleAction}</div>}
      </div>
    ) : null;

  if (rows.length === 0) {
    return (
      <div>
        {titleRow}
        {empty !== undefined && <p className={cn("text-sm text-muted-foreground", nested && "pb-2 pl-7 text-xs")}>{empty}</p>}
      </div>
    );
  }

  function rowName(row: SettingsTableRow): string {
    if (nameColumnId === undefined || nameColumnId === primaryId) return row.primary.name;
    const value = row.cells?.[nameColumnId];
    const content = isCellSpec(value) ? value.content : value;
    if (typeof content === "string") return content;
    if (import.meta.env.DEV) console.error(`SettingsTable：nameColumn「${nameColumnId}」那一格要是純文字（列 ${row.id}）`);
    return row.primary.name;
  }

  function renderCell(row: SettingsTableRow, column: SettingsTableColumn, index: number, editing: boolean): ReactNode {
    const isName = column.id === nameColumnId;
    let content: ReactNode;
    let tone: SettingsTableTone = "default";
    let cellTitle: string | undefined;
    if (column.kind === "primary") {
      content = <PrimaryContent primary={row.primary} nameId={isName ? nameId(row) : undefined} />;
    } else if (column.kind === "actions") {
      content = row.actions;
    } else if (column.kind === "enabled") {
      content = enabledColumn !== undefined ? row.enabled?.(`${headerId(enabledColumn)} ${nameId(row)}`) : null;
    } else {
      const value = row.cells?.[column.id];
      if (isCellSpec(value)) {
        content = value.content;
        tone = value.tone ?? "default";
        cellTitle = value.title;
      } else {
        content = value;
      }
      if (column.kind === "url" && cellTitle === undefined && typeof content === "string") cellTitle = content;
    }
    const sticky = isSticky(column.kind);
    return (
      <div
        key={column.id}
        role="cell"
        className={cn(CELL, cellPadding(column.kind, index, ordered.length, false), "max-sm:px-3 max-sm:py-1", PHONE_CELL[column.kind], sticky && STICKY_CELL)}
        style={sticky && editing ? { background: EDITING_STICKY_BACKGROUND } : undefined}
      >
        {PHONE_LABELLED.has(column.kind) && (
          <span aria-hidden="true" className="shrink-0 pr-2 text-xs leading-5 text-muted-foreground sm:hidden">
            {column.header}
          </span>
        )}
        <div
          id={isName && column.kind !== "primary" ? nameId(row) : undefined}
          title={cellTitle}
          className={cn(
            "min-w-0 flex-1",
            INNER[column.kind],
            column.kind === "primary" && nested && "pl-4",
            tone === "muted" && "text-muted-foreground",
            tone === "danger" && "text-destructive",
          )}
        >
          {content}
        </div>
      </div>
    );
  }

  const body = rows.map((row, rowIndex) => {
    const editing = present(row.editing);
    const hasError = present(row.error);
    const hasDetail = present(row.detail);
    // A group is the data row (+ error row) (+ detail row). Bottom border only on its last row; a nested table's last group is drawn by the outer detail row.
    const groupBorder = nested && rowIndex === rows.length - 1 ? undefined : ROW_BORDER;
    const name = rowName(row);
    return (
      <Fragment key={row.id}>
        <div
          role="row"
          aria-labelledby={nameId(row)}
          className={cn(ROW_GRID, "max-sm:py-2", editing && "bg-brand-soft", !hasError && !hasDetail && groupBorder)}
        >
          {editing ? (
            <>
              {renderCell(row, ordered[0]!, 0, true)}
              <div role="cell" aria-colspan={ordered.length - 1} className={cn(CELL, "col-[2/-1] py-2.5 pr-3 max-sm:basis-full max-sm:px-3 max-sm:py-1")}>
                <div className="min-w-0 flex-1">{row.editing}</div>
              </div>
            </>
          ) : (
            ordered.map((column, index) => renderCell(row, column, index, false))
          )}
        </div>
        {hasError && (
          <div role="row" aria-label={t("settings.table.rowError", { name })} className={cn("col-span-full", !hasDetail && groupBorder)}>
            <div role="cell" aria-colspan={ordered.length}>
              <div role="alert" className="px-3 pb-2.5 text-xs text-destructive">
                {row.error}
              </div>
            </div>
          </div>
        )}
        {hasDetail && (
          <div role="row" aria-label={t("settings.table.rowDetails", { name })} className={cn("col-span-full", groupBorder)}>
            <div role="cell" aria-colspan={ordered.length} className={DETAIL_CELL}>
              {row.detail}
            </div>
          </div>
        )}
      </Fragment>
    );
  });

  const table = (
    <div
      role="table"
      aria-label={label}
      className="grid grid-cols-(--kb-table-cols) gap-x-3 text-sm max-sm:grid-cols-1"
      style={{ "--kb-table-cols": tracks } as CSSProperties}
    >
      <div role="row" ref={box.headerRowRef} className={cn(ROW_GRID, ROW_BORDER, "max-sm:sr-only", nested && "sr-only")}>
        {ordered.map((column, index) => (
          <div
            key={column.id}
            id={headerId(column)}
            role="columnheader"
            ref={column.kind === "primary" ? box.stickyHeaderRef : undefined}
            className={cn(
              CELL,
              cellPadding(column.kind, index, ordered.length, true),
              "text-xs text-muted-foreground",
              isSticky(column.kind) && STICKY_CELL,
            )}
          >
            <div className={cn("min-w-0 flex-1 whitespace-nowrap", HEADER_INNER[column.kind])}>
              {column.kind === "actions" ? <span className="sr-only">{column.header}</span> : column.header}
            </div>
          </div>
        ))}
      </div>
      {body}
    </div>
  );

  if (nested) {
    return (
      <div>
        {titleRow}
        {table}
      </div>
    );
  }
  return (
    <div>
      {titleRow}
      <div
        ref={box.boxRef}
        role="region"
        aria-label={label}
        tabIndex={box.tabbable ? 0 : undefined}
        onFocus={(event) => {
          if (event.target === event.currentTarget) box.setFocused(true);
          else box.revealPastSticky(event.target);
        }}
        onBlur={(event) => {
          if (event.target === event.currentTarget) box.setFocused(false);
        }}
        data-overflowing={box.overflowing ? "" : undefined}
        className={SCROLL_BOX}
      >
        {table}
      </div>
    </div>
  );
}

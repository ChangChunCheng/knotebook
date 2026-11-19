import { Fragment, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { NoteDto } from "@knotebook/shared";
import { useFolders } from "@/api/folders";
import { useGroups } from "@/api/groups";
import { setCollapsed } from "@/components/sidebar/collapse";
import { expandFolderChain, indexFolders } from "@/components/sidebar/folder-index";
import { noteLocationParts } from "@/components/sidebar/tree";
import { useContainerWidth } from "@/lib/use-container-width";
import { useSidebarTabActions } from "@/lib/sidebar-tab";

const ELLIPSIS = "…";
const SEPARATOR = " › ";
const SUFFIX_SEPARATOR = " · ";
/** Max frames (about 0.5 s) to wait for the row to appear. */
const SCROLL_MAX_FRAMES = 30;

export interface FitResult {
  shown: string[];
  truncateLast: boolean;
}

export function fitSegments(segments: readonly string[], widths: readonly number[], available: number, ellipsisW: number): FitResult {
  const n = segments.length;
  const total = widths.reduce((sum, w) => sum + w, 0);
  if (total <= available) return { shown: [...segments], truncateLast: false };
  const middle = Array.from({ length: Math.max(0, n - 2) }, (_, i) => i + 1);
  const center = (n - 1) / 2;
  middle.sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b);
  const hidden = new Set<number>();
  let width = total;
  const build = (truncateLast: boolean): FitResult => {
    const shown: string[] = [];
    segments.forEach((segment, i) => {
      if (!hidden.has(i)) shown.push(segment);
      else if (!hidden.has(i - 1)) shown.push(ELLIPSIS);
    });
    return { shown, truncateLast };
  };
  for (const i of middle) {
    hidden.add(i);
    width = width - (widths[i] ?? 0) + (hidden.size === 1 ? ellipsisW : 0);
    if (width <= available) return build(false);
  }
  return build(true);
}

function scrollRowIntoView(noteId: string): void {
  let frames = 0;
  const tick = () => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(`[data-node-id="${noteId}"]`));
    const row = rows.find((el) => el.getClientRects().length > 0);
    if (row !== undefined) {
      row.scrollIntoView({ block: "center" });
      // Move focus with the view, otherwise focus restore on returning to the list lands on the previously opened row.
      row.querySelector<HTMLElement>("a")?.focus({ preventScroll: true });
      return;
    }
    frames += 1;
    if (frames < SCROLL_MAX_FRAMES) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

interface Measure {
  widths: number[];
  ellipsisW: number;
  suffixW: number;
}

export function NoteLocation({ note, trailing }: { note: NoteDto; /** Small widget right after the location text (connection dot); when the path is too long only the path is truncated and this stays attached to the text. */ trailing?: ReactNode }) {
  const { t } = useTranslation();
  const foldersQuery = useFolders();
  const groupsQuery = useGroups();
  const { showTab } = useSidebarTabActions();
  const folderIndex = useMemo(() => indexFolders(foldersQuery.data ?? []), [foldersQuery.data]);
  const parts = noteLocationParts(
    note,
    { groupIds: new Set((groupsQuery.data ?? []).map((group) => group.id)), folders: folderIndex },
    (key, options) => t(key, options),
  );
  const fullPath = parts.segments.join(SEPARATOR) + (parts.suffix === null ? "" : `${SUFFIX_SEPARATOR}${parts.suffix}`);

  const wrapRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const trailingRef = useRef<HTMLSpanElement>(null);
  const trailingWidth = useContainerWidth(trailingRef);
  const wrapWidth = useContainerWidth(wrapRef);
  const available = wrapWidth === 0 ? 0 : Math.max(1, wrapWidth - (trailing ? trailingWidth + 8 : 0));
  const [measure, setMeasure] = useState<Measure | null>(null);
  useLayoutEffect(() => {
    const root = measureRef.current;
    if (root === null) return;
    const widthOf = (selector: string) => root.querySelector<HTMLElement>(selector)?.getBoundingClientRect().width ?? 0;
    const sepW = widthOf("[data-measure-sep]");
    const segW = Array.from(root.querySelectorAll<HTMLElement>("[data-measure-seg]")).map((el) => el.getBoundingClientRect().width);
    const ellipsisW = widthOf("[data-measure-ellipsis]") + sepW;
    const suffixW = widthOf("[data-measure-suffix]");
    setMeasure({ widths: segW.map((w, i) => (i === 0 ? w : w + sepW)), ellipsisW, suffixW });
  }, [fullPath]);

  const fit =
    measure === null || available === 0
      ? { shown: parts.segments, truncateLast: false }
      : fitSegments(parts.segments, measure.widths, available - measure.suffixW, measure.ellipsisW);

  function handleClick() {
    showTab(parts.tab);
    if (parts.groupId !== null) setCollapsed(`group:${parts.groupId}`, false);
    if (parts.folderId !== null) expandFolderChain(folderIndex, parts.folderId);
    scrollRowIntoView(note.id);
  }

  return (
    <div ref={wrapRef} className="relative flex min-w-0 flex-1 items-center gap-2">
      <button
        type="button"
        aria-label={t("note.showInList", { path: fullPath })}
        onClick={handleClick}
        // Title row + this row must total >= 44px tap height: pad with py rather than a negative margin.
        className="flex min-w-0 items-center overflow-hidden whitespace-nowrap rounded py-2 text-left text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {fit.shown.map((segment, i) => {
          const last = i === fit.shown.length - 1;
          const truncated = fit.truncateLast && (last || i === 0);
          const cls = !truncated ? "shrink-0" : last ? "min-w-0 truncate" : "max-w-[50%] shrink-0 truncate";
          return (
            <Fragment key={`${i}:${segment}`}>
              {i > 0 && (
                <span aria-hidden="true" className="shrink-0 whitespace-pre">
                  {SEPARATOR}
                </span>
              )}
              <span className={cls}>{segment}</span>
            </Fragment>
          );
        })}
        {parts.suffix !== null && (
          <>
            <span aria-hidden="true" className="shrink-0 whitespace-pre">
              {SUFFIX_SEPARATOR}
            </span>
            <span className="shrink-0">{parts.suffix}</span>
          </>
        )}
      </button>
      {trailing && (
        <span ref={trailingRef} className="shrink-0">
          {trailing}
        </span>
      )}
      {/* Measuring copy in its own overflow-hidden box so a long path cannot inflate the header scrollWidth. */}
      <span aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <span ref={measureRef} className="invisible absolute start-0 top-0 whitespace-pre text-xs">
          {parts.segments.map((segment, i) => (
            <span key={`${i}:${segment}`} data-measure-seg="">
              {segment}
            </span>
          ))}
          <span data-measure-sep="">{SEPARATOR}</span>
          <span data-measure-ellipsis="">{ELLIPSIS}</span>
          {parts.suffix !== null && <span data-measure-suffix="">{`${SUFFIX_SEPARATOR}${parts.suffix}`}</span>}
        </span>
      </span>
    </div>
  );
}

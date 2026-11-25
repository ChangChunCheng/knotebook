import { TOP_SECTION_ID } from "@knotebook/shared";
import { firstFoldedHit, lowerSearchTerms } from "@/lib/search-match";

// Sections must match sectionize in note-sections.ts: only top-level units (blocks and columnList rows) count, and
// nested or in-column headings don't start sections. Blocks are matched on their own text, so the innermost matching
// block wins. The query is split into keywords as on the server (#399) and the first block containing any of them wins.
// Matching uses foldedIndexOf, like the snippet highlight.
const GROUP = ".bn-editor > .bn-block-group";
const OUTER_SELF = ":scope > .bn-block > .bn-block-content";

function headingLevel(unit: HTMLElement): number | null {
  const content = unit.matches(".bn-block-outer") ? unit.querySelector<HTMLElement>(`${OUTER_SELF}[data-content-type="heading"]`) : null;
  if (!content) return null;
  const level = Number(content.getAttribute("data-level") ?? "1");
  return Number.isFinite(level) ? level : 1;
}

// Table cells are `<td><p>` without .bn-inline-content; mermaid uses data-code, which is what the server indexes.
function ownText(outer: HTMLElement): string {
  const content = outer.querySelector<HTMLElement>(OUTER_SELF);
  if (!content) return "";
  if (content.getAttribute("data-content-type") === "mermaid") return content.getAttribute("data-code") ?? "";
  return Array.from(content.querySelectorAll<HTMLElement>(".bn-inline-content, pre, td, th"))
    .map((el) => el.textContent ?? "")
    .join("\n");
}

export function topUnits(root: HTMLElement): HTMLElement[] | null {
  const group = root.querySelector<HTMLElement>(GROUP);
  if (!group) return null;
  return Array.from(group.querySelectorAll<HTMLElement>(':scope > :is(.bn-block-outer, [data-node-type="columnList"])'));
}

export function sectionUnits(root: HTMLElement, sectionId: string): HTMLElement[] | null {
  const units = topUnits(root);
  if (units === null) return null;
  let curId = TOP_SECTION_ID;
  let curLevel = 0;
  let found = sectionId === TOP_SECTION_ID;
  const picked: HTMLElement[] = [];
  for (const unit of units) {
    const level = headingLevel(unit);
    if (level !== null && (curLevel === 0 || level <= curLevel)) {
      curId = unit.getAttribute("data-id") ?? "";
      curLevel = level;
      // Duplicate ids from copy-paste: the server keeps only the first such section, so stop there too.
      if (curId === sectionId && found && sectionId !== TOP_SECTION_ID) break;
      if (curId === sectionId) found = true;
    }
    if (curId === sectionId) picked.push(unit);
  }
  return found ? picked : null;
}

/** A block's own row holds a collapsed toggle (`data-show-children="false"`); the open/close button is its direct child. */
export const COLLAPSED_TOGGLE = ':scope > .bn-block > :is(.bn-block-content, .react-renderer) .bn-toggle-wrapper[data-show-children="false"]';

/** Collapsed-toggle blocks that contain `outer` (not `outer` itself), outermost first. */
export function collapsedAncestors(root: HTMLElement, outer: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let node = outer.parentElement?.closest<HTMLElement>(".bn-block-outer") ?? null; node && root.contains(node); node = node.parentElement?.closest<HTMLElement>(".bn-block-outer") ?? null) {
    if (node.querySelector(COLLAPSED_TOGGLE) !== null) out.unshift(node);
  }
  return out;
}

// Children of a collapsed toggle are display:none and can't be scrolled to, so use the outermost collapsed toggle.
function visibleTarget(root: HTMLElement, outer: HTMLElement): HTMLElement {
  return collapsedAncestors(root, outer)[0] ?? outer;
}

export function findMatchBlock(root: HTMLElement, sectionId: string, findText: string): HTMLElement | null {
  const lowerTerms = lowerSearchTerms(findText);
  if (lowerTerms.length === 0) return null;
  const units = sectionUnits(root, sectionId);
  if (units === null) return null;
  for (const unit of units) {
    const outers = [
      ...(unit.matches(".bn-block-outer[data-id]") ? [unit] : []),
      ...Array.from(unit.querySelectorAll<HTMLElement>(".bn-block-outer[data-id]")),
    ];
    for (const outer of outers) {
      if (firstFoldedHit(ownText(outer), lowerTerms) !== null) return visibleTarget(root, outer);
    }
  }
  return null;
}

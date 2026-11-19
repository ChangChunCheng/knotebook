/**
 * Pure functions (no DOM, no Y.Doc). Only top-level blocks count; child blocks go with their parent.
 * Relative levels: the smallest level among top-level headings = L1 (chapter, horizontal), the smallest level greater than L1
 * = L2 (section, vertical; may not exist); deeper headings stay inside the slide. A divider starts a new chapter.
 * The cover chapter always exists with ID `_title`. An empty slide (kind not heading/cover and all blocks blank) is skipped;
 * when a chapter's first slide is skipped the chapter ID changes with it.
 */
export const COVER_ID = "_title";

export type SlideKind = "cover" | "heading" | "divider";

export interface SlideBlock {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: readonly unknown[];
}

export interface Slide<B extends SlideBlock = SlideBlock> {
  id: string;
  kind: SlideKind;
  blocks: B[];
}

export interface Section<B extends SlideBlock = SlideBlock> {
  id: string;
  slides: Slide<B>[];
}

function headingLevel(block: SlideBlock): number | null {
  if (block.type !== "heading") return null;
  const level = block.props?.level;
  return typeof level === "number" ? level : null;
}

export function isBlankBlock(block: SlideBlock): boolean {
  if (block.type !== "paragraph") return false;
  if ((block.children?.length ?? 0) > 0) return false;
  const content = block.content;
  if (!Array.isArray(content)) return true;
  return content.every(
    (item: unknown) =>
      typeof item === "object" &&
      item !== null &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string" &&
      (item as { text: string }).text.trim() === "",
  );
}

function isSkippable<B extends SlideBlock>(slide: Slide<B>): boolean {
  return slide.kind === "divider" && slide.blocks.every(isBlankBlock);
}

export function noteToSlides<B extends SlideBlock>(_title: string, blocks: readonly B[]): Section<B>[] {
  const levels = blocks.map(headingLevel).filter((level): level is number => level !== null);
  const l1 = levels.length > 0 ? Math.min(...levels) : null;
  const deeper = l1 === null ? [] : levels.filter((level) => level > l1);
  const l2 = deeper.length > 0 ? Math.min(...deeper) : null;

  const cover: Slide<B> = { id: COVER_ID, kind: "cover", blocks: [] };
  const raw: Slide<B>[][] = [[cover]];
  let section = raw[0];
  let slide = cover;

  for (const block of blocks) {
    const level = headingLevel(block);
    if (level !== null && level === l1) {
      slide = { id: block.id, kind: "heading", blocks: [block] };
      section = [slide];
      raw.push(section);
    } else if (block.type === "divider") {
      slide = { id: block.id, kind: "divider", blocks: [] };
      section = [slide];
      raw.push(section);
    } else if (level !== null && level === l2) {
      slide = { id: block.id, kind: "heading", blocks: [block] };
      section.push(slide);
    } else {
      slide.blocks.push(block);
    }
  }

  const sections: Section<B>[] = [];
  for (const slides of raw) {
    const kept = slides.filter((candidate) => !isSkippable(candidate));
    if (kept.length > 0) sections.push({ id: kept[0].id, slides: kept });
  }
  return sections;
}

/** One entry of the heading outline. An empty `text` means an empty heading; the UI shows a placeholder. */
export interface OutlineHeading {
  id: string;
  level: 1 | 2 | 3;
  text: string;
}

/** The slice of a BlockNote block this module reads, so it can be tested with plain objects. */
export interface OutlineBlockLike {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: readonly OutlineBlockLike[];
}

/** Headings (H1-H3) in document order; a parent comes before its children. */
export function extractHeadings(blocks: readonly OutlineBlockLike[]): OutlineHeading[] {
  const out: OutlineHeading[] = [];
  const walk = (list: readonly OutlineBlockLike[]) => {
    for (const block of list) {
      if (block.type === "heading") {
        const level = block.props?.level;
        if (level === 1 || level === 2 || level === 3) {
          out.push({ id: block.id, level, text: headingPlainText(block.content) });
        }
      }
      // Columns, list items and toggle headings all keep nested blocks in children.
      if (block.children && block.children.length > 0) walk(block.children);
    }
  };
  walk(blocks);
  return out;
}

interface InlineLike {
  type?: unknown;
  text?: unknown;
  content?: unknown;
  props?: Record<string, unknown>;
}

function inlineText(items: readonly unknown[]): string {
  let s = "";
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as InlineLike;
    if (item.type === "text") {
      if (typeof item.text === "string") s += item.text;
    } else if (item.type === "link") {
      if (Array.isArray(item.content)) s += inlineText(item.content);
    } else if (item.type === "wikilink") {
      const label = item.props?.label;
      const title = item.props?.snapshotTitle;
      s += (typeof label === "string" && label) || (typeof title === "string" ? title : "");
    }
    // Other inline kinds carry no readable text for an outline entry.
  }
  return s;
}

/** Plain, single-line text of a heading's inline content. */
export function headingPlainText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return inlineText(content).replace(/\s+/g, " ").trim();
}

export function sameHeadings(a: readonly OutlineHeading[], b: readonly OutlineHeading[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.id !== y.id || x.level !== y.level || x.text !== y.text) return false;
  }
  return true;
}

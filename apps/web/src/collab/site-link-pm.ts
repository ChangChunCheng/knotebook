import { parseSiteNoteHref, wikilinkPropsFromLink, type SiteLinkTarget, type SiteNoteHref } from "@knotebook/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ProseMirror Node/Transaction can't be value-imported in apps/web
type Any = any;

export const SITE_LINK_CONVERT_META = "knotebook:siteLinkConvert";
// Compared as a string: pnpm may install two copies of y-prosemirror.
export const Y_SYNC_META = "y-sync$";

export interface SiteLinkRange {
  from: number;
  to: number;
  href: string;
  text: string;
  parsed: SiteNoteHref;
  blockId: string | null;
}

export function blockIdAt(doc: Any, pos: number): string | null {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  for (let d = $pos.depth; d >= 0; d -= 1) {
    const node = $pos.node(d);
    if (node.type.name === "blockContainer") return String(node.attrs.id);
  }
  return null;
}

export function collectSiteLinks(doc: Any, ranges: ReadonlyArray<{ from: number; to: number }>, siteOrigin: string): SiteLinkRange[] {
  const out = new Map<number, SiteLinkRange>();
  const size = doc.content.size;
  for (const range of ranges) {
    const from = Math.max(0, Math.min(range.from, size));
    const to = Math.max(from, Math.min(range.to, size));
    doc.nodesBetween(from, to === from ? Math.min(size, to + 1) : to, (node: Any, pos: number) => {
      if (!node.isTextblock) return true;
      let offset = pos + 1;
      let group: { from: number; to: number; href: string; text: string } | null = null;
      // A non-empty range must really overlap (adjacent doesn't count, or a link created next to an existing site link would be re-collected and re-queued); an empty range (cursor) includes its endpoints.
      const touches = (g: { from: number; to: number }) => (from === to ? g.from <= to && g.to >= from : g.from < to && g.to > from);
      const flush = () => {
        if (group && touches(group) && !out.has(group.from)) {
          const parsed = parseSiteNoteHref(group.href, siteOrigin);
          if (parsed) out.set(group.from, { ...group, parsed, blockId: blockIdAt(doc, group.from) });
        }
        group = null;
      };
      node.forEach((child: Any) => {
        const mark = child.isText ? child.marks.find((m: Any) => m.type.name === "link") : undefined;
        const href = mark ? String(mark.attrs.href ?? "") : null;
        if (href !== null && group !== null && group.href === href && group.to === offset) {
          group.to += child.nodeSize;
          group.text += child.text;
        } else {
          flush();
          if (href !== null) group = { from: offset, to: offset + child.nodeSize, href, text: String(child.text) };
        }
        offset += child.nodeSize;
      });
      flush();
      return false;
    });
  }
  return [...out.values()].sort((a, b) => a.from - b.from);
}

export function addedLinkRanges(trs: readonly Any[]): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  trs.forEach((tr, ti) => {
    tr.steps.forEach((step: Any, si: number) => {
      const json = step.toJSON();
      if (json?.stepType !== "addMark" || json.mark?.type !== "link") return;
      const rest = tr.mapping.slice(si + 1);
      let from: number = rest.map(json.from, 1);
      let to: number = rest.map(json.to, -1);
      for (const later of trs.slice(ti + 1)) {
        from = later.mapping.map(from, 1);
        to = later.mapping.map(to, -1);
      }
      if (from < to) out.push({ from, to });
    });
  });
  return out;
}

// `links` must come from `tr.doc`.
export function replaceSiteLinks(tr: Any, links: readonly SiteLinkRange[], pick: (link: SiteLinkRange) => SiteLinkTarget | null): SiteLinkRange[] {
  const left: SiteLinkRange[] = [];
  const type = tr.doc.type.schema.nodes.wikilink;
  for (const link of [...links].sort((a, b) => b.from - a.from)) {
    const target = pick(link);
    if (!target) {
      left.push(link);
      continue;
    }
    tr.replaceWith(link.from, link.to, type.create(wikilinkPropsFromLink({ text: link.text, href: link.href, target, anchorBlockId: link.parsed.anchorBlockId })));
  }
  return left.reverse();
}

export function blockRanges(doc: Any, blockIds: ReadonlySet<string>): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  doc.descendants((node: Any, pos: number) => {
    if (node.type.name === "blockContainer" && blockIds.has(String(node.attrs.id))) out.push({ from: pos, to: pos + node.nodeSize });
    return true;
  });
  return out;
}

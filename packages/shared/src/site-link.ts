// The single site-link check for client and server: don't write another "is this a site URL" test elsewhere.
import { extractRefUuid, normalizeHandle, normalizeSlug } from "./slug.js";
import { UUID_RE } from "./note-markdown.js";

/** Same shape as SECTION_ID_RE; invalid values read as "" everywhere. */
export const BLOCK_ANCHOR_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function normalizeAnchor(value: unknown): string {
  return typeof value === "string" && BLOCK_ANCHOR_RE.test(value) ? value : "";
}

export type SiteNotePath =
  | { kind: "n"; handle: string; slug: string }
  | { kind: "g"; groupId: string; slug: string }
  | { kind: "ref"; ref: string };

export interface SiteNoteHref {
  path: SiteNotePath;
  anchorBlockId: string;
}

const ABSOLUTE_HTTP_RE = /^https?:/i;

/** siteOrigin: window.location.origin on web, the origin of PUBLIC_URL on the server. Only the accepted forms below pass; anything else is null. */
export function parseSiteNoteHref(href: string, siteOrigin: string): SiteNoteHref | null {
  if (typeof href !== "string" || href === "" || href.trim() !== href) return null;
  const rootRelative = href.startsWith("/") && href[1] !== "/" && href[1] !== "\\";
  if (!rootRelative && !ABSOLUTE_HTTP_RE.test(href)) return null;
  let u: URL;
  try {
    // No base for non-root-relative input: with one, `https:n/x` or `HTTPS:../n/x` would resolve to this site.
    u = rootRelative ? new URL(href, siteOrigin) : new URL(href);
  } catch {
    return null;
  }
  if (u.origin !== siteOrigin) return null;
  if (u.username !== "" || u.password !== "" || u.search !== "") return null;
  // URL gives search === "" for a trailing `?`; an empty query is still a query.
  if (href.includes("?")) return null;
  let anchorBlockId = "";
  if (u.hash !== "") {
    if (!u.hash.startsWith("#b-")) return null;
    const id = u.hash.slice(3);
    if (!BLOCK_ANCHOR_RE.test(id)) return null;
    anchorBlockId = id;
  }
  if (u.pathname.endsWith("/")) return null;
  let segs: string[];
  try {
    segs = u.pathname.split("/").slice(1).map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
  if (segs.some((s) => s === "")) return null;
  const [head, a, b] = segs;
  if (segs.length === 3 && head === "n") {
    return { path: { kind: "n", handle: normalizeHandle(a!), slug: normalizeSlug(b!) }, anchorBlockId };
  }
  if (segs.length === 3 && head === "g") {
    if (!UUID_RE.test(a!)) return null;
    return { path: { kind: "g", groupId: a!.toLowerCase(), slug: normalizeSlug(b!) }, anchorBlockId };
  }
  if (segs.length === 2 && head === "notes") return { path: { kind: "ref", ref: a! }, anchorBlockId };
  return null;
}

export function wikilinkHref(id: string, anchor: string): string {
  return `/notes/${id}${anchor ? `#b-${anchor}` : ""}`;
}

export interface WikilinkProps {
  targetNoteId: string;
  snapshotTitle: string;
  label: string;
  anchorBlockId: string;
}

export interface SiteLinkTarget {
  id: string;
  title: string;
}

export function wikilinkPropsFromLink(input: { text: string; href: string; target: SiteLinkTarget; anchorBlockId: string }): WikilinkProps {
  const { text, href, target, anchorBlockId } = input;
  const label = text === "" || text === target.title || text === href ? "" : text;
  return { targetNoteId: target.id.toLowerCase(), snapshotTitle: text !== "" ? text : target.title, label, anchorBlockId };
}

export function wikilinkDisplayText(props: Partial<WikilinkProps>, liveTitle?: string): string {
  const label = typeof props.label === "string" ? props.label : "";
  if (label !== "") return label;
  return liveTitle ?? (typeof props.snapshotTitle === "string" ? props.snapshotTitle : "");
}

export function wikilinkVisibleText(props: Partial<WikilinkProps>, liveTitle?: string): string {
  return wikilinkDisplayText(props, liveTitle) || wikilinkHref(String(props.targetNoteId ?? ""), normalizeAnchor(props.anchorBlockId));
}

export interface SiteLinkCandidate {
  id: string;
  title: string;
  slug: string;
  groupId: string | null;
  ownerHandle: string | null;
}

/** Redirects, prev_slug and legacy slugs never match. */
export function resolveFromList<T extends SiteLinkCandidate>(path: SiteNotePath, list: readonly T[]): T | null {
  switch (path.kind) {
    case "n":
      return list.find((n) => (n.groupId ?? null) === null && n.ownerHandle === path.handle && n.slug === path.slug) ?? null;
    case "g":
      return list.find((n) => n.groupId === path.groupId && n.slug === path.slug) ?? null;
    case "ref": {
      const id = extractRefUuid(path.ref);
      return id === null ? null : (list.find((n) => n.id.toLowerCase() === id) ?? null);
    }
  }
}

/** The single implementation: the web cache resolver and the web AI must call it rather than write their own. */
export function targetFromList(path: SiteNotePath, list: readonly SiteLinkCandidate[]): SiteLinkTarget | undefined {
  const hit = resolveFromList(path, list);
  return hit ? { id: hit.id, title: hit.title } : undefined;
}

export function linkText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (typeof c === "string" ? c : typeof (c as { text?: unknown })?.text === "string" ? (c as { text: string }).text : "")).join("");
}

export type InlineArrayMapper = (inline: unknown[]) => unknown[];
type AnyBlock = { type: string; content?: unknown; children?: unknown[] };
type TableCellObject = { type: "tableCell"; content?: unknown };

function mapTableContent(content: { type: "tableContent"; rows?: Array<{ cells?: unknown[] }> }, map: InlineArrayMapper): unknown {
  let changed = false;
  const rows = (content.rows ?? []).map((row) => {
    let rowChanged = false;
    const cells = (row.cells ?? []).map((cell) => {
      if (Array.isArray(cell)) {
        const next = map(cell);
        if (next !== cell) rowChanged = true;
        return next;
      }
      const obj = cell as TableCellObject;
      if (obj && obj.type === "tableCell" && Array.isArray(obj.content)) {
        const next = map(obj.content);
        if (next === obj.content) return cell;
        rowChanged = true;
        return { ...obj, content: next };
      }
      return cell;
    });
    if (!rowChanged) return row;
    changed = true;
    return { ...row, cells };
  });
  return changed ? { ...content, rows } : content;
}

/**
 * isInlineType filters ordinary blocks only; table cells are always walked.
 * Copy-on-write: `map` returns its input unchanged to mean "no change"; an untouched tree returns the same array.
 */
export function mapInlineArrays<B>(blocks: B[], map: InlineArrayMapper, isInlineType?: (type: string) => boolean): B[] {
  let changed = false;
  const out = (blocks as unknown as AnyBlock[]).map((block) => {
    let next: AnyBlock = block;
    const content = block.content;
    if (Array.isArray(content) && (isInlineType === undefined || isInlineType(block.type))) {
      const mapped = map(content);
      if (mapped !== content) next = { ...next, content: mapped };
    } else if (content && typeof content === "object" && (content as { type?: unknown }).type === "tableContent") {
      const mapped = mapTableContent(content as { type: "tableContent" }, map);
      if (mapped !== content) next = { ...next, content: mapped };
    }
    if (Array.isArray(block.children) && block.children.length > 0) {
      const kids = mapInlineArrays(block.children, map, isInlineType);
      if (kids !== block.children) next = { ...next, children: kids };
    }
    if (next !== block) changed = true;
    return next;
  });
  return (changed ? out : blocks) as B[];
}

export type SiteLinkResolve = (href: string, parsed: SiteNoteHref) => SiteLinkTarget | null;

export interface ConvertStats {
  converted: number;
  unresolved: number;
}

function convertInline(inline: unknown[], resolve: SiteLinkResolve, siteOrigin: string, stats: ConvertStats): unknown[] {
  let changed = false;
  const out = inline.map((node) => {
    const n = node as { type?: unknown; href?: unknown; content?: unknown };
    if (n?.type !== "link" || typeof n.href !== "string") return node;
    const parsed = parseSiteNoteHref(n.href, siteOrigin);
    if (!parsed) return node;
    const target = resolve(n.href, parsed);
    if (!target) {
      stats.unresolved += 1;
      return node;
    }
    stats.converted += 1;
    changed = true;
    return { type: "wikilink", props: wikilinkPropsFromLink({ text: linkText(n.content), href: n.href, target, anchorBlockId: parsed.anchorBlockId }) };
  });
  return changed ? out : inline;
}

export function convertSiteLinksInContent(content: unknown, resolve: SiteLinkResolve, siteOrigin: string, stats: ConvertStats): unknown {
  if (Array.isArray(content)) return convertInline(content, resolve, siteOrigin, stats);
  if (content && typeof content === "object" && (content as { type?: unknown }).type === "tableContent") {
    return mapTableContent(content as { type: "tableContent" }, (inline) => convertInline(inline, resolve, siteOrigin, stats));
  }
  return content;
}

export function convertSiteLinks<B>(blocks: B[], resolve: SiteLinkResolve, siteOrigin: string): [B[], ConvertStats] {
  const stats: ConvertStats = { converted: 0, unresolved: 0 };
  const out = mapInlineArrays(blocks, (inline) => convertInline(inline, resolve, siteOrigin, stats));
  return [out, stats];
}

// `&` isn't escaped: the parser keeps character references as text, so an unescaped `&amp;` round-trips.
// Only for text that becomes markdown; raw HTML output must not be escaped.
export function escapeLinkText(text: string): string {
  return text
    .replace(/[\\`*_[\]~]/g, "\\$&")
    .replace(/<(?=(.?))/gs, (m, next: string) => (lessThanOpensMarkup(next === "" ? undefined : next) ? `\\${m}` : m));
}

/** `undefined` (nothing follows) counts: the next node may supply a tag-opening char. */
export function lessThanOpensMarkup(next: string | undefined): boolean {
  return next === undefined || /[A-Za-z/!?]/.test(next);
}

// Display text isn't escaped here: the server may emit this copy as raw HTML (toBlockHTML). The markdown branch
// of note-markdown-read.ts escapes it once; callers must not escape again.
// titleOf must return only titles of targets visible to the reader; for the others the display text falls back to snapshotTitle.
export function wikilinksToLinks<B>(blocks: readonly B[], titleOf: (id: string) => string | undefined): B[] {
  const rewrite: InlineArrayMapper = (inline) => {
    let changed = false;
    const out = inline.map((node) => {
      const n = node as { type?: unknown; props?: Partial<WikilinkProps> };
      if (n?.type !== "wikilink") return node;
      changed = true;
      const props = n.props ?? {};
      const id = String(props.targetNoteId ?? "");
      const href = wikilinkHref(id, normalizeAnchor(props.anchorBlockId));
      return { type: "link", href, content: [{ type: "text", text: wikilinkVisibleText(props, titleOf(id)), styles: {} }] };
    });
    return changed ? out : inline;
  };
  return mapInlineArrays([...blocks], rewrite);
}

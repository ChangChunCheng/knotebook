import { Extension } from "@tiptap/core";
import type { BlockNoteEditor } from "@blocknote/core";
import type { SiteLinkCandidate, SiteLinkTarget, SiteNoteHref } from "@knotebook/shared";
import { FALLBACK_MAX_HREFS, resolveFromCache, resolveViaServer } from "@/lib/site-link-resolve";
import type { EditorRef } from "@/components/wikilink/menu";
import type { PasteConversionHook } from "./paste";
import { createPmPlugin } from "./pm-plugin";
import { addedLinkRanges, blockRanges, collectSiteLinks, replaceSiteLinks, SITE_LINK_CONVERT_META, Y_SYNC_META, type SiteLinkRange } from "./site-link-pm";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote's three generic parameters / PM types can't be value-imported in apps/web (repo convention)
type AnyEditor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
type Any = any;

export interface FallbackRequest {
  blockIds: string[];
  href: string;
  text: string;
  parsed: SiteNoteHref;
}

export interface SiteLinkEnv {
  origin: string;
  notes(): readonly SiteLinkCandidate[] | undefined;
  schedule(requests: FallbackRequest[]): void;
}

export type SiteLinkEnvRef = { current: SiteLinkEnv | null };

function toRequests(links: readonly SiteLinkRange[]): FallbackRequest[] {
  return links.map((l) => ({ blockIds: l.blockId ? [l.blockId] : [], href: l.href, text: l.text, parsed: l.parsed }));
}

// `tr` must be fresh: `links` come from `tr.doc`.
function convertLinks(tr: Any, links: readonly SiteLinkRange[], env: SiteLinkEnv): Any | null {
  tr.setMeta(SITE_LINK_CONVERT_META, true);
  const left = replaceSiteLinks(tr, links, (link) => {
    const r = resolveFromCache(env.notes(), link.parsed);
    return r.kind === "hit" ? r.target : null;
  });
  if (left.length > 0) {
    const requests = toRequests(left);
    queueMicrotask(() => env.schedule(requests)); // no side effects during apply
  }
  return tr.docChanged ? tr : null;
}

/**
 * Not local actions: `y-sync$` (remote, undo/redo), our own conversion, and drops/pastes, which
 * each have one owner (`withSiteLinkDrop`, `createSiteLinkPasteHook`). The link mark from the
 * paste rule (also run on drop) arrives in a separate appended tr; if the plugin took it too, a
 * cache miss would queue the same link twice for the fallback (a late second request could
 * convert it back after an undo).
 */
function isForeign(tr: Any): boolean {
  const ui = tr.getMeta("uiEvent");
  return tr.getMeta(Y_SYNC_META) !== undefined || tr.getMeta(SITE_LINK_CONVERT_META) !== undefined || ui === "drop" || ui === "paste";
}

/**
 * Also checks the root tr (PM `appendedTransaction` meta): BlockNote Link's paste rule/autolink
 * run after this plugin, so their appended link trs reach it alone on the next round and must
 * follow their root's verdict (autolink doesn't skip a remote `y-sync$` root itself).
 */
function excluded(tr: Any): boolean {
  const root = tr.getMeta("appendedTransaction");
  return isForeign(tr) || (root !== undefined && isForeign(root));
}

export function appendSiteLinkConversion(trs: readonly Any[], state: Any, env: SiteLinkEnv | null): Any | null {
  if (!env) return null;
  if (trs.some(excluded)) return null;
  const ranges = addedLinkRanges(trs);
  if (ranges.length === 0) return null;
  const links = collectSiteLinks(state.doc, ranges, env.origin);
  if (links.length === 0) return null;
  return convertLinks(state.tr, links, env);
}

type PmRange = { from: number; to: number };

/**
 * Set while a paste is in progress (paste hook's `before` → `after`): the plugin takes no tr and
 * the hook owns that paste. `uiEvent: "paste"` can't catch a url pasted over a selection (Link's
 * `handlePaste` dispatches `setMark` with no uiEvent). Value = changed range(s), mapped to the
 * current doc. If `after` never runs (exit threw), a microtask clears it (the paste is synchronous).
 */
const pastingRefs = new WeakMap<SiteLinkEnvRef, PmRange[]>();
const mapRange = (mapping: Any, r: PmRange): PmRange => ({ from: mapping.map(r.from, -1), to: mapping.map(r.to, 1) });

/**
 * #353: records the new range of every step of each root tr (no `appendedTransaction` meta) and
 * maps it through later trs; plugin-appended trs are only mapped (a mark step has no StepMap, so
 * its from/to are used).
 * - Not a before/after doc diff: a multi-paragraph paste landing mid-paragraph gives the split
 *   second half a new block id, `findDiffEnd` stops at the paragraph end, and the range would
 *   cover existing content.
 * - Not "selection before + size delta": when the last pasted paragraph is a textblock at
 *   another depth (nested list item), PM's Fitter uses a ReplaceAroundStep that splits the
 *   inserted content in two; the StepMap's two ranges exclude the moved content exactly.
 */
function recordPasteRanges(trs: readonly Any[], envRef: SiteLinkEnvRef): void {
  const recorded = pastingRefs.get(envRef);
  if (!recorded) return;
  let ranges: PmRange[] = recorded;
  for (const tr of trs) {
    const mapping = tr.mapping;
    ranges = ranges.map((r) => mapRange(mapping, r));
    if (tr.getMeta("appendedTransaction") !== undefined) continue;
    (tr.steps as readonly Any[]).forEach((step, i) => {
      const rest = tr.mapping.slice(i + 1);
      const json = step.toJSON();
      if (json?.stepType === "addMark" || json?.stepType === "removeMark") {
        if (json.from < json.to) ranges.push(mapRange(rest, { from: json.from, to: json.to }));
        return;
      }
      (tr.mapping.maps[i] as Any).forEach((_oldStart: number, _oldEnd: number, newStart: number, newEnd: number) => {
        if (newStart < newEnd) ranges.push(mapRange(rest, { from: newStart, to: newEnd }));
      });
    });
  }
  pastingRefs.set(envRef, ranges);
}

/**
 * Drop range while a drop is in progress (null = no drop tr seen). Not plugin state: that has no
 * reset point, so a later drop without a drop tr (media blocked, Files, uri-list only) would
 * read the previous drop's range. `before` resets it to null; `after` and `before`'s catch delete it.
 */
const droppingRefs = new WeakMap<SiteLinkEnvRef, PmRange | null>();

function recordDropRange(trs: readonly Any[], envRef: SiteLinkEnvRef): void {
  if (!droppingRefs.has(envRef)) return;
  let r = droppingRefs.get(envRef) ?? null;
  for (const tr of trs) {
    if (tr.getMeta("uiEvent") === "drop") {
      // Like prosemirror-view handleDrop's `end` (the last step's StepMap); anything but exactly one range is not converted.
      const maps = tr.mapping.maps as readonly Any[];
      const segments: PmRange[] = [];
      maps[maps.length - 1]?.forEach((_oldStart: number, _oldEnd: number, newStart: number, newEnd: number) => segments.push({ from: newStart, to: newEnd }));
      r = segments.length === 1 ? segments[0]! : null;
    } else if (r) {
      r = { from: tr.mapping.map(r.from, -1), to: tr.mapping.map(r.to, 1) };
    }
  }
  droppingRefs.set(envRef, r);
}

export function createSiteLinkConvertExtension({ envRef }: { envRef: SiteLinkEnvRef }): Extension {
  return Extension.create({
    name: "knotebookSiteLinkConvert",
    addProseMirrorPlugins() {
      return [
        createPmPlugin({
          appendTransaction: (trs, _old, state) => {
            recordDropRange(trs, envRef);
            recordPasteRanges(trs, envRef);
            return pastingRefs.has(envRef) ? null : appendSiteLinkConversion(trs, state, envRef.current);
          },
        }) as never,
      ];
    },
  });
}

export function convertSiteLinksInRange(editor: AnyEditor, ranges: ReadonlyArray<PmRange>, env: SiteLinkEnv): void {
  const view = editor._tiptapEditor.view;
  const links = collectSiteLinks(view.state.doc, ranges, env.origin);
  if (links.length === 0) return;
  const tr = convertLinks(view.state.tr, links, env);
  if (tr) view.dispatch(tr);
}

export async function runFallbackConversion(
  editor: AnyEditor | null,
  requests: readonly FallbackRequest[],
  origin: string,
  resolve: (p: SiteNoteHref) => Promise<SiteLinkTarget | null> = resolveViaServer,
): Promise<number> {
  const byHref = new Map<string, FallbackRequest[]>();
  for (const r of requests) byHref.set(r.href, [...(byHref.get(r.href) ?? []), r]);
  const hrefs = [...byHref.keys()].slice(0, FALLBACK_MAX_HREFS);
  const resolved = new Map<string, SiteLinkTarget>();
  await Promise.all(
    hrefs.map(async (href) => {
      const target = await resolve(byHref.get(href)![0]!.parsed);
      if (target) resolved.set(href, target);
    }),
  );
  // After unmount tiptap's `view` is a stub (`isDestroyed` false, dispatch hits a detached state),
  // so check BlockNote's `headless` instead.
  if (resolved.size === 0 || !editor || editor.headless) return 0;
  const view = editor._tiptapEditor.view;
  // Match href and text inside blocks that still exist, so links edited meanwhile aren't converted.
  const wanted =new Set(requests.filter((r) => resolved.has(r.href)).map((r) => `${r.href}\u0000${r.text}`));
  const blockIds = new Set(requests.flatMap((r) => r.blockIds));
  const links = collectSiteLinks(view.state.doc, blockRanges(view.state.doc, blockIds), origin).filter((l) => wanted.has(`${l.href}\u0000${l.text}`));
  if (links.length === 0) return 0;
  const tr = view.state.tr;
  tr.setMeta(SITE_LINK_CONVERT_META, true);
  replaceSiteLinks(tr, links, (l) => resolved.get(l.href) ?? null);
  view.dispatch(tr);
  return links.length;
}

/**
 * Converts the range `recordPasteRanges` recorded rather than block ids, so an inline paste
 * that keeps block ids is caught too. An empty range (pure deletion) is skipped:
 * `collectSiteLinks`' point ranges include endpoints and would pick up an adjacent existing link.
 */
export function createSiteLinkPasteHook(envRef: SiteLinkEnvRef): PasteConversionHook {
  return {
    before: () => {
      pastingRefs.set(envRef, []);
      queueMicrotask(() => pastingRefs.delete(envRef));
      return true; // the snapshot needs no content (the plugin records the range); `undefined` would make paste.ts skip `after`
    },
    after: (editor) => {
      const recorded = pastingRefs.get(envRef) ?? [];
      pastingRefs.delete(envRef);
      const env = envRef.current;
      if (!env) return;
      const ranges = recorded.filter((r) => r.from < r.to);
      if (ranges.length === 0) return;
      convertSiteLinksInRange(editor as AnyEditor, ranges, env);
    },
  };
}

function afterDrop(envRef: SiteLinkEnvRef, editorRef: EditorRef): void {
  let range: PmRange | null | undefined;
  try {
    range = droppingRefs.get(envRef);
  } finally {
    droppingRefs.delete(envRef);
  }
  // An empty range would pick up an adjacent link (`collectSiteLinks` point ranges include endpoints).
  if (!range || range.from >= range.to) return;
  try {
    const env = envRef.current;
    const editor = editorRef.current;
    // `view` is a stub after unmount (see `runFallbackConversion`).
    if (env && editor && !editor.headless) convertSiteLinksInRange(editor, [range], env);
  } catch (err) {
    console.warn("[site-link] drop conversion failed", err);
  }
}

/**
 * Outermost layer of `handleDOMEvents.drop`. PM's drop tr and the plugin-appended trs all run
 * synchronously in this listener, so a microtask reads the recorded range afterwards (relies on
 * a microtask checkpoint after every listener callback). A throw in our own checks never blocks
 * the inner handler.
 */
export function withSiteLinkDrop<T extends { drop: (view: unknown, event: DragEvent) => boolean }>(envRef: SiteLinkEnvRef, editorRef: EditorRef, inner: T): T {
  return {
    ...inner,
    drop: (view: unknown, event: DragEvent) => {
      try {
        const v = view as { editable?: unknown; dragging?: unknown } | null;
        if (v?.editable && envRef.current && v.dragging == null) {
          droppingRefs.set(envRef, null);
          queueMicrotask(() => afterDrop(envRef, editorRef));
        }
      } catch {
        droppingRefs.delete(envRef);
      }
      return inner.drop(view, event);
    },
  };
}

export function createSiteLinkEnv(opts: { origin: string; getNotes(): readonly SiteLinkCandidate[] | undefined; editorRef: { current: AnyEditor | null } }): SiteLinkEnv {
  return {
    origin: opts.origin,
    notes: opts.getNotes,
    // A failed fallback only abandons the conversion; it must not become an unhandled rejection.
    schedule: (requests) =>
      void runFallbackConversion(opts.editorRef.current, requests, opts.origin).catch((err: unknown) => console.warn("[site-link] fallback conversion failed", err)),
  };
}

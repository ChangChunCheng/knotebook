/**
 * Precondition (checked by `NoteWriteService.syncFile`): the note is untouched since
 * download (top level equals the base segment table block by block), else 409 `note_changed`
 * before reaching here; so base blocks exist unchanged. Exception: 0 base blocks and one empty
 * paragraph now (`isLoneEmptyParagraph`), which `applySync` replaces.
 * Delete-region anchor: `P` after, else `N` before; neither → scan current neighbours,
 * excluding blocks being removed; none found → `replaceWithEmpty` if everything goes, else
 * `deferred` (`applySync` finds the neighbour after the inserts).
 */
import * as Y from "yjs";
import { topLevelContainers } from "@knotebook/shared";
import type { TransferSegment } from "../db/schema.js";
import type { Region } from "./regions.js";

export type Mark = "applied" | "same";
export type Anchor = { block_id: string; position: "before" | "after"; placeholder?: boolean };
export type Place = { ref: string; where: "before" | "after" } | { start: true } | { replaceSurvivors: true };

export interface Decision {
  kind: Region["kind"];
  mark: Mark;
  survivors: string[];
  place: Place;
  stripStart: boolean;
  anchor?: Anchor | "deferred" | "replaceWithEmpty";
  P: string | null;
  N: string | null;
}

export function matchesBase(segments: readonly TransferSegment[], cur: { ids: readonly string[]; fps: readonly string[] }): boolean {
  let k = 0;
  for (const s of segments) {
    for (let j = 0; j < s.ids.length; j++, k++) if (cur.ids[k] !== s.ids[j] || cur.fps[k] !== s.fps[j]) return false;
  }
  return k === cur.ids.length;
}

/** A never-opened note (0 base blocks) shows this shape after the browser normalizes it on open: treated as untouched. */
export function isLoneEmptyParagraph(fragment: Y.XmlFragment): boolean {
  const top = topLevelContainers(fragment);
  if (top.length !== 1) return false;
  const c = top[0]!;
  if (c.length !== 1) return false;
  const p = c.get(0);
  if (!(p instanceof Y.XmlElement) || p.nodeName !== "paragraph") return false;
  // `get(i)` on a Y type is O(i), so an index loop is quadratic (a paragraph of `x<br>` × 49 000 has ~100 000 children); walk once with `toArray()`.
  for (const t of p.toArray()) {
    if (!(t instanceof Y.XmlText) || t.length !== 0) return false;
  }
  return true;
}

export function anchors(segments: TransferSegment[], regions: Region[]): Array<{ P: string | null; N: string | null }> {
  const inRegion = new Set<number>(regions.flatMap(r => r.segIdx));
  const usable = (k: number) => !inRegion.has(k) && segments[k]!.count > 0;
  return regions.map(r => {
    const before = r.prevSeg === -1 ? (r.segIdx.length > 0 ? r.segIdx[0]! - 1 : -1) : r.prevSeg;
    const after = r.nextSeg === -1 ? (r.segIdx.length > 0 ? r.segIdx[r.segIdx.length - 1]! + 1 : segments.length) : r.nextSeg;
    let P: string | null = null;
    for (let k = before; k >= 0 && P === null; k--) if (usable(k)) P = segments[k]!.ids[segments[k]!.ids.length - 1]!;
    let N: string | null = null;
    for (let k = after; k < segments.length && N === null; k++) if (usable(k)) N = segments[k]!.ids[0]!;
    return { P, N };
  });
}

/** With several regions after the same `P` (or the document start) a later one follows the earlier; `before` keeps order naturally, so needs no chain. */
export function chainKeyOf(place: Place): string | null {
  if ("ref" in place) return place.where === "after" ? `after:${place.ref}` : null;
  return "start" in place ? "start" : null;
}

export function shouldStripStart(prevType: string | null, firstType: string | undefined): boolean {
  return prevType === "numberedListItem" && firstType === "numberedListItem";
}

export function placeFor(
  r: Region,
  cur: { ids: string[]; types: string[] },
  a: { P: string | null; N: string | null },
  pre: { idx?: Map<string, number> } = {},
): { place: Place; prevType: string | null } {
  const idx = pre.idx ?? new Map(cur.ids.map((id, i) => [id, i]));
  const prevTypeOf = (i: number) => (i > 0 ? cur.types[i - 1]! : null);
  if (r.kind === "rewrite") {
    const first = r.baseIds.length > 0 ? idx.get(r.baseIds[0]!) : undefined;
    if (first !== undefined) return { place: { ref: cur.ids[first]!, where: "before" }, prevType: prevTypeOf(first) };
  }
  if (a.P !== null) return { place: { ref: a.P, where: "after" }, prevType: cur.types[idx.get(a.P)!]! };
  if (a.N !== null) return { place: { ref: a.N, where: "before" }, prevType: prevTypeOf(idx.get(a.N)!) };
  return { place: { start: true }, prevType: null };
}

export function decide(
  segments: TransferSegment[],
  regions: Region[],
  cur: { ids: string[]; types: string[] },
  same: (ri: number, against: string[]) => boolean,
  opts: { firstTypes?: ReadonlyArray<string | undefined>; prevTypes?: ReadonlyArray<string | null> } = {},
): Decision[] {
  const idx = new Map(cur.ids.map((id, i) => [id, i]));
  const anc = anchors(segments, regions);
  const out: Decision[] = regions.map((r, ri) => {
    const survivors = r.baseIds;
    const { P, N } = anc[ri]!;
    const placed = placeFor(r, cur, anc[ri]!, { idx });
    const prevType = opts.prevTypes?.[ri] !== undefined ? opts.prevTypes[ri]! : placed.prevType;
    const stripStart = r.kind !== "delete" && shouldStripStart(prevType, opts.firstTypes?.[ri]);
    const base = { kind: r.kind, survivors, stripStart, P, N };
    if (r.kind === "delete") return { ...base, mark: "applied", place: { replaceSurvivors: true } };
    if (r.kind === "rewrite" && survivors.length > 0 && same(ri, survivors)) return { ...base, mark: "same", place: { replaceSurvivors: true } };
    return { ...base, mark: "applied", place: placed.place };
  });

  const removing = new Set<string>();
  for (const d of out) if (d.mark !== "same" && (d.kind === "rewrite" || d.kind === "delete")) for (const id of d.survivors) removing.add(id);
  // Delete regions don't count, so only whether the total is 0 matters.
  const writing = out.filter(d => d.mark !== "same" && d.kind !== "delete").length;
  const allRemoved = cur.ids.every(id => removing.has(id));
  out.forEach(d => {
    if (d.kind !== "delete") return;
    let anchor: Anchor | null = null;
    if (d.P !== null) anchor = { block_id: d.P, position: "after" };
    else if (d.N !== null) anchor = { block_id: d.N, position: "before" };
    else {
      const first = idx.get(d.survivors[0]!)!;
      const last = idx.get(d.survivors[d.survivors.length - 1]!)!;
      for (let i = first - 1; i >= 0 && anchor === null; i--) if (!removing.has(cur.ids[i]!)) anchor = { block_id: cur.ids[i]!, position: "after" };
      for (let i = last + 1; i < cur.ids.length && anchor === null; i++) if (!removing.has(cur.ids[i]!)) anchor = { block_id: cur.ids[i]!, position: "before" };
    }
    d.anchor = anchor ?? (writing === 0 && allRemoved ? "replaceWithEmpty" : "deferred");
  });
  return out;
}

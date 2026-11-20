// Always computed on the unmounted Yjs structure (mount normalizes an empty doc) with a sync hash so it can be recomputed inside transact. An optimistic-concurrency check, not security; after_fingerprint follows document order, and an id missing or out of order → null → mismatch, which callers treat as 409/stale. On mismatch never fall back to the whole-note fingerprint (a stale section update would pass).
import { createHash } from "node:crypto";
import * as Y from "yjs";
import { canonicalizeElements, canonicalizeSection, sectionize, topLevelBlocks, type SectionInfo } from "@knotebook/shared";

export function fingerprintOf(canonical: string): string {
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
export const EMPTY_SECTION_FINGERPRINT = fingerprintOf("");
export interface OutlineEntry extends SectionInfo {
  fingerprint: string;
}

export function outlineOf(fragment: Y.XmlFragment): { outline: OutlineEntry[]; whole: string } {
  const byId = new Map<string, Y.XmlElement>();
  for (const c of topLevelBlocks(fragment)) {
    const id = c.getAttribute("id");
    if (typeof id !== "string" || id === "") throw new Error("outlineOf：頂層 block 缺 id 屬性（文件不是 BlockNote 結構）");
    byId.set(id, c);
  }
  const outline = sectionize(fragment).map(s => ({ ...s, fingerprint: fingerprintOf(canonicalizeElements(s.blockIds.map(id => byId.get(id)!))) }));
  return { outline, whole: fingerprintOf(outline.map(o => o.fingerprint).join("")) };
}

/** One pass over the top level: `fingerprintForIds` per block rebuilds the top-level table each call, O(n²) (2,000 blocks take 14-15 s). Byte-identical to per-block `fingerprintForIds`; all export fingerprints use this. Throws on a missing id, like `outlineOf`. */
export function topLevelFingerprints(fragment: Y.XmlFragment): { ids: string[]; fps: string[] } {
  const ids: string[] = [];
  const fps: string[] = [];
  for (const c of topLevelBlocks(fragment)) {
    const id = c.getAttribute("id");
    if (typeof id !== "string" || id === "") throw new Error("topLevelFingerprints：頂層 block 缺 id 屬性（文件不是 BlockNote 結構）");
    ids.push(id);
    fps.push(fingerprintOf(canonicalizeElements([c])));
  }
  return { ids, fps };
}

export function topLevelSnapshot(fragment: Y.XmlFragment): { ids: string[]; fps: string[]; types: string[] } {
  const ids: string[] = [];
  const fps: string[] = [];
  const types: string[] = [];
  for (const c of topLevelBlocks(fragment)) {
    const id = c.getAttribute("id");
    if (typeof id !== "string" || id === "") throw new Error("topLevelSnapshot：頂層 block 缺 id 屬性（文件不是 BlockNote 結構）");
    ids.push(id);
    fps.push(fingerprintOf(canonicalizeElements([c])));
    const first = c.get(0);
    types.push(c.nodeName === "columnList" ? "columnList" : first instanceof Y.XmlElement ? first.nodeName : "");
  }
  return { ids, fps, types };
}

/** Each `expectEach` fingerprint is compared separately (order isn't checked); every anchor id must be at top level. Never call `fingerprintForIds` per id (O(n²), see `topLevelFingerprints`). */
export function checkExpectations(fragment: Y.XmlFragment, expectEach: ReadonlyArray<{ id: string; fp: string }>, anchorIds: readonly string[]): boolean {
  const byId = new Map<string, Y.XmlElement>();
  for (const c of topLevelBlocks(fragment)) {
    const id = c.getAttribute("id");
    if (typeof id === "string") byId.set(id, c);
  }
  for (const e of expectEach) {
    const c = byId.get(e.id);
    if (c === undefined || fingerprintOf(canonicalizeElements([c])) !== e.fp) return false;
  }
  return anchorIds.every(id => byId.has(id));
}

/** Empty array → null: a record row with `after_block_ids: []` pairs with `after_fingerprint: null` (`fingerprint_chk`); any id missing from the top level or out of document order → null. Byte-identical to `fingerprintForIds(fragment, group)`: `editRevertable` later recomputes with it. */
export function fingerprintsOfGroups(fragment: Y.XmlFragment, groups: ReadonlyArray<readonly string[]>): (string | null)[] {
  const byId = new Map<string, { c: Y.XmlElement; i: number }>();
  topLevelBlocks(fragment).forEach((c, i) => {
    const id = c.getAttribute("id");
    if (typeof id === "string") byId.set(id, { c, i });
  });
  return groups.map(g => {
    if (g.length === 0) return null;
    const picked: Y.XmlElement[] = [];
    let last = -1;
    for (const id of g) {
      const hit = byId.get(id);
      if (hit === undefined || hit.i <= last) return null;
      last = hit.i;
      picked.push(hit.c);
    }
    return fingerprintOf(canonicalizeElements(picked));
  });
}

export function fingerprintForIds(fragment: Y.XmlFragment, ids: string[]): string | null {
  if (ids.length === 0) return EMPTY_SECTION_FINGERPRINT;
  const canonical = canonicalizeSection(fragment, ids);
  return canonical === null ? null : fingerprintOf(canonical);
}

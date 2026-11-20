import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { MAX_LINK_TARGETS } from "@knotebook/shared";
import { normalizeLinkTargets } from "../../src/notes/links.js";

const SOURCE = "00000000-0000-0000-0000-000000000000";

function uuidAt(n: number): string {
  return `00000000-0000-0000-0000-${n.toString().padStart(12, "0")}`;
}

describe("normalizeLinkTargets", () => {
  it("dedup: the same target repeated many times counts once", () => {
    const t1 = uuidAt(1);
    const result = normalizeLinkTargets(SOURCE, [t1, t1, t1]);
    expect(result).toEqual({ ok: true, targets: [t1] });
  });

  it("filters self-links: target === source is dropped", () => {
    const t1 = uuidAt(1);
    const result = normalizeLinkTargets(SOURCE, [SOURCE, t1, SOURCE]);
    expect(result).toEqual({ ok: true, targets: [t1] });
  });

  it("empty array -> ok:true, targets empty (meaning: clear all links)", () => {
    expect(normalizeLinkTargets(SOURCE, [])).toEqual({ ok: true, targets: [] });
  });

  it("after normalization (dedup + self-link filter) exactly MAX_LINK_TARGETS -> ok:true", () => {
    const targets = Array.from({ length: MAX_LINK_TARGETS }, (_, i) => uuidAt(i + 1));
    const result = normalizeLinkTargets(SOURCE, targets);
    expect(result.ok).toBe(true);
    expect(result.ok && result.targets).toHaveLength(MAX_LINK_TARGETS);
  });

  it("one more than MAX_LINK_TARGETS after normalization -> ok:false", () => {
    const targets = Array.from({ length: MAX_LINK_TARGETS + 1 }, (_, i) => uuidAt(i + 1));
    expect(normalizeLinkTargets(SOURCE, targets)).toEqual({ ok: false });
  });

  it("the limit is judged after normalization: the raw array is far over the limit but within it after dedup + self-link filtering -> ok:true", () => {
    // Deliberately many duplicates + many self-links so raw.length far exceeds MAX_LINK_TARGETS, verifying the limit is applied to the
    // normalized set rather than the raw input length: a misjudgement would return ok:false.
    const t1 = uuidAt(1);
    const t2 = uuidAt(2);
    const raw = [
      ...Array.from({ length: MAX_LINK_TARGETS * 3 }, () => SOURCE),
      ...Array.from({ length: MAX_LINK_TARGETS * 3 }, () => t1),
      t2,
    ];
    const result = normalizeLinkTargets(SOURCE, raw);
    expect(result).toEqual({ ok: true, targets: [t1, t2] });
  });
});

describe("#240 normalizeLinkTargets: letter case", () => {
  const SRC = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const SRC_MIXED = "0F8fAd5B-d9Cb-469F-a165-70867728950E";
  const T = "6ecc5cdd-7666-45a4-8740-3ccff326fa97";
  const T_MIXED = "6ECc5cDd-7666-45A4-8740-3cCff326Fa97";

  it("an own id in uppercase/mixed case is excluded", () => {
    expect(normalizeLinkTargets(SRC, [SRC.toUpperCase(), SRC_MIXED, T])).toEqual({ ok: true, targets: [T] });
  });

  it("case variants are deduped into one lowercase id; output is all lowercase", () => {
    expect(normalizeLinkTargets(SRC, [T.toUpperCase(), T, T_MIXED])).toEqual({ ok: true, targets: [T] });
  });

  it("MAX_LINK_TARGETS distinct targets plus an uppercase variant of one -> ok (no longer over the limit because of case duplicates)", () => {
    const ids = Array.from({ length: MAX_LINK_TARGETS }, () => randomUUID());
    const r = normalizeLinkTargets(SRC, [...ids, ids[0]!.toUpperCase()]);
    expect(r.ok).toBe(true);
    expect(r.ok && r.targets.length).toBe(MAX_LINK_TARGETS);
  });

  it("when sourceNoteId is passed in uppercase, the lowercase own id is excluded too", () => {
    expect(normalizeLinkTargets(SRC.toUpperCase(), [SRC, T])).toEqual({ ok: true, targets: [T] });
  });
});

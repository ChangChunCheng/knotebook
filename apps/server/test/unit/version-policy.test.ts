import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { selectVersionsToDelete, type VersionPolicyRow } from "../../src/collab/version-policy.js";

const NOW = new Date("2026-10-09T12:00:00Z"); // Friday
const at = (iso: string) => new Date(iso);
const auto = (seq: number, iso: string): VersionPolicyRow => ({ seq, kind: "auto", createdAt: at(iso) });
const manual = (seq: number, iso: string): VersionPolicyRow => ({ seq, kind: "manual", createdAt: at(iso) });
const run = (rows: VersionPolicyRow[], o: { f?: number; d?: number; base?: number | null } = {}) =>
  selectVersionsToDelete(rows, { now: NOW, keepAllDays: o.f ?? 7, dailyUntilDays: o.d ?? 30, baseSeq: o.base ?? null });

describe("selectVersionsToDelete (everything kept within F days, one version per UTC day between F and D days, one per UTC Monday-week beyond D days)", () => {
  it("everything within F days is kept (two versions on the same day too)", () => {
    expect(run([auto(1, "2026-10-05T01:00:00Z"), auto(2, "2026-10-05T23:00:00Z"), auto(3, "2026-10-09T11:00:00Z")])).toEqual([]);
  });

  it("between F and D days: only the version with the newest createdAt per UTC day is kept; different days each keep one", () => {
    const rows = [auto(1, "2026-09-20T01:00:00Z"), auto(2, "2026-09-20T23:00:00Z"), auto(3, "2026-09-21T10:00:00Z"), auto(9, "2026-10-09T11:00:00Z")];
    expect(run(rows)).toEqual([1]);
  });

  it("D days or older: only the newest per UTC week (starting Monday 00:00) is kept; crossing Monday 00:00 is a different week", () => {
    // 2026-07-27 is a Monday: seq 1 (Saturday) and seq 2 (Sunday 23:59:59) are in the same week; seq 3 is the next week's Monday 00:00.
    const rows = [auto(1, "2026-08-01T10:00:00Z"), auto(2, "2026-08-02T23:59:59Z"), auto(3, "2026-08-03T00:00:00Z"), auto(9, "2026-10-09T11:00:00Z")];
    expect(run(rows)).toEqual([1]);
  });

  it("the same day across the F boundary: the version inside F is not compared with the one outside - the one outside is the only version of its day in its band, so it is kept", () => {
    // The F=7 boundary is 2026-10-02T12:00Z: seq 1 is outside (7 days 1 hour), seq 2 is inside.
    const rows = [auto(1, "2026-10-02T11:00:00Z"), auto(2, "2026-10-02T13:00:00Z"), auto(9, "2026-10-09T11:00:00Z")];
    expect(run(rows)).toEqual([]);
  });

  it("the same week across the D boundary: week buckets are compared only among rows at D or older", () => {
    // The D=30 boundary is 2026-09-09T12:00Z (a Wednesday); same week (starting Monday 2026-09-07): seq 3 is within D (day bucket), seq 1 / seq 2 are outside D (week bucket).
    const rows = [auto(1, "2026-09-08T10:00:00Z"), auto(2, "2026-09-09T11:00:00Z"), auto(3, "2026-09-09T13:00:00Z"), auto(9, "2026-10-09T11:00:00Z")];
    expect(run(rows)).toEqual([1]);
  });

  it("exactly F days and exactly D days: fall into the older band (F <= age, D <= age)", () => {
    const rows = [auto(1, "2026-10-02T11:00:00Z"), auto(2, "2026-10-02T12:00:00Z"), auto(3, "2026-09-09T12:00:00Z"), auto(4, "2026-09-08T01:00:00Z"), auto(9, "2026-10-09T11:00:00Z")];
    // seq 2 is exactly 7 days -> day bucket, same day as seq 1 and newer -> seq 1 is deleted; seq 3 is exactly 30 days -> week bucket, same week as seq 4 (starting 2026-09-07) and newer -> seq 4 is deleted.
    expect(run(rows)).toEqual([1, 4]);
  });

  it("F = D: no day bucket, beyond F goes straight to weeks", () => {
    const rows = [auto(1, "2026-09-28T01:00:00Z"), auto(2, "2026-09-30T01:00:00Z"), auto(9, "2026-10-09T11:00:00Z")];
    expect(run(rows, { f: 7, d: 7 })).toEqual([1]); // 2026-09-28 is a Monday, the two rows are in the same week
  });

  it("manual, base and the latest version are kept; a row that satisfies several rules is still counted once", () => {
    const rows = [manual(1, "2026-08-01T00:00:00Z"), auto(2, "2026-08-01T01:00:00Z"), auto(3, "2026-08-01T02:00:00Z"), auto(4, "2026-08-01T03:00:00Z")];
    // seq 4 is the latest (largest seq); seq 2 is the base; seq 1 is manual; among the automatic ones in the same week only seq 3 and seq 4 compete - seq 4 is already kept as the latest, so seq 3 is the only candidate in the week bucket -> kept.
    expect(run(rows, { base: 2 })).toEqual([]);
    expect(run([...rows, auto(5, "2026-08-01T04:00:00Z")], { base: 2 })).toEqual([3]); // seq 5 becomes the latest; seq 4 and seq 3 compete in the same week, seq 4 is newer
  });

  it("same createdAt: the larger seq is kept; empty input gives empty output; the result is in ascending order", () => {
    // the smaller seq comes first (the DB's natural order) - without the tie-break, seq 3 seen first would be kept, giving [5].
    expect(run([auto(3, "2026-09-20T01:00:00Z"), auto(5, "2026-09-20T01:00:00Z"), auto(9, "2026-10-09T11:00:00Z")])).toEqual([3]);
    expect(run([])).toEqual([]);
    const many = [auto(7, "2026-09-20T01:00:00Z"), auto(2, "2026-09-20T02:00:00Z"), auto(4, "2026-09-20T03:00:00Z"), auto(9, "2026-10-09T11:00:00Z")];
    expect(run(many)).toEqual([2, 7]);
  });

  it("time is injected from outside: the file (comments stripped) has no Date.now or new Date(", () => {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/collab/version-policy.ts");
    const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/Date\.now|new Date\(/);
  });
});

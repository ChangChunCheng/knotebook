import { describe, expect, it } from "vitest";
import { crossesFifteenMinuteBoundary, selectPrunable } from "../../src/collab/backup-policy.js";

describe("crossesFifteenMinuteBoundary (15-minute buckets; half-open [start, end), aligned to the UTC clock)", () => {
  it("within the same [10:00,10:15) bucket -> false", () => {
    const last = new Date("2026-08-06T10:07:00Z");
    const now = new Date("2026-08-06T10:11:00Z");
    expect(crossesFifteenMinuteBoundary(last, now)).toBe(false);
  });

  it("crossing into the next bucket [10:15,10:30) -> true", () => {
    const last = new Date("2026-08-06T10:14:00Z");
    const now = new Date("2026-08-06T10:16:00Z");
    expect(crossesFifteenMinuteBoundary(last, now)).toBe(true);
  });

  it("lastBackupAt null -> true (never backed up)", () => {
    const now = new Date("2026-08-06T10:16:00Z");
    expect(crossesFifteenMinuteBoundary(null, now)).toBe(true);
  });
});

describe("selectPrunable (concrete vector; newest per bucket, everything outside the union of the three tiers is deleted)", () => {
  it("concrete vector at now=2026-08-06T12:00:00Z: the retained set is exactly the hard-coded one below, everything else is deleted", () => {
    const now = new Date("2026-08-06T12:00:00Z");
    const existing: Date[] = [];

    // One entry every 5 minutes, 09:00-11:55 (36 entries).
    for (let totalMin = 9 * 60; totalMin <= 11 * 60 + 55; totalMin += 5) {
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      existing.push(new Date(Date.UTC(2026, 7, 6, h, m, 0)));
    }
    // One entry on every hour, 00:00-08:00 (9 entries).
    for (let h = 0; h <= 8; h += 1) {
      existing.push(new Date(Date.UTC(2026, 7, 6, h, 0, 0)));
    }
    // One entry daily at 12:00:00Z, 07-28 to 08-05 (9 entries).
    for (let day = 28; day <= 31; day += 1) {
      existing.push(new Date(Date.UTC(2026, 6, day, 12, 0, 0)));
    }
    for (let day = 1; day <= 5; day += 1) {
      existing.push(new Date(Date.UTC(2026, 7, day, 12, 0, 0)));
    }
    expect(existing.length).toBe(36 + 9 + 9);

    // Hard-coded retained set:
    const retainedIso = new Set(
      [
        // 15-minute tier: {11:10, 11:25, 11:40, 11:55}
        "2026-08-06T11:10:00.000Z",
        "2026-08-06T11:25:00.000Z",
        "2026-08-06T11:40:00.000Z",
        "2026-08-06T11:55:00.000Z",
        // hourly tier: {06:00, 07:00, 08:00, 09:55, 10:55, 11:55}
        // Note: the newest entry in the [09:00,10:00) bucket is 09:55, not 09:00.
        "2026-08-06T06:00:00.000Z",
        "2026-08-06T07:00:00.000Z",
        "2026-08-06T08:00:00.000Z",
        "2026-08-06T09:55:00.000Z",
        "2026-08-06T10:55:00.000Z",
        "2026-08-06T11:55:00.000Z",
        // daily tier: the last 7 UTC calendar days including today (07-31 to 08-06); today's newest entry (11:55) is already included above.
        "2026-07-31T12:00:00.000Z",
        "2026-08-01T12:00:00.000Z",
        "2026-08-02T12:00:00.000Z",
        "2026-08-03T12:00:00.000Z",
        "2026-08-04T12:00:00.000Z",
        "2026-08-05T12:00:00.000Z",
      ]
    );

    const prunable = selectPrunable(existing, now);
    const prunableIso = new Set(prunable.map(d => d.toISOString()));

    const expectedPrunable = existing.filter(d => !retainedIso.has(d.toISOString()));
    expect(prunableIso.size).toBe(expectedPrunable.length);
    for (const d of expectedPrunable) {
      expect(prunableIso.has(d.toISOString())).toBe(true);
    }
    // Inverse: none of the retained entries may appear in prunable (07-30 and earlier must be deleted).
    for (const iso of retainedIso) {
      expect(prunableIso.has(iso)).toBe(false);
    }
    expect(prunable.length).toBe(54 - 15);
  });
});

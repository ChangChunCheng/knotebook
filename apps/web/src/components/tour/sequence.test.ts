import { beforeEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { buildSequence, stopTitle } from "./sequence";
import { FULL_TOUR, STOPS, type StopId } from "./stops";

describe("buildSequence", () => {
  it("sequence follows the full tour order, the last stop is userMenu, and no stop carries a version marker", () => {
    const seq = buildSequence(FULL_TOUR);
    expect(seq.map((e) => e.id)).toEqual([...FULL_TOUR]);
    expect(seq[seq.length - 1]!.id).toBe("userMenu");
    for (const entry of seq) expect(Object.keys(entry)).toEqual(["id"]);
  });

  it("does not mutate the array passed by the caller", () => {
    const full: [StopId, ...StopId[]] = ["tabs", "userMenu"];
    buildSequence(full);
    expect(full).toEqual(["tabs", "userMenu"]);
  });
});

describe("stopTitle", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("the title is the stop title, with no version prefix in either language", async () => {
    const title = i18n.t(STOPS.header.titleKey);
    expect(stopTitle(i18n.t, STOPS.header)).toBe(title);
    expect(title).not.toMatch(/New in v|v\d+\.\d+\.\d+/);
    await i18n.changeLanguage("zh-TW");
    const zh = i18n.t(STOPS.header.titleKey);
    expect(stopTitle(i18n.t, STOPS.header)).toBe(zh);
    expect(zh).not.toMatch(/新增：|v\d+\.\d+\.\d+/);
  });
});

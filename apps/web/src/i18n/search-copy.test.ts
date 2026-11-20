import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import zhTW from "./zh-TW.json";
import en from "./en.json";

/**
 * #93 sidebar content-search copy (zh-TW literals). Changing these strings changes product copy: confirm with the maintainer first.
 */
const SPEC_COPY: Record<string, string> = {
  "sidebar.titleMatches_one": "標題符合 · {{count}} 篇",
  "sidebar.titleMatches_other": "標題符合 · {{count}} 篇",
  "sidebar.resultsRegion": "搜尋結果",
  "sidebar.matchesCount_one": "{{count}} 筆結果",
  "sidebar.matchesCount_other": "{{count}} 筆結果",
  "sidebar.matchesCountMore_one": "已載入 {{count}} 筆，還有更多",
  "sidebar.matchesCountMore_other": "已載入 {{count}} 筆，還有更多",
  "sidebar.bodySearching": "正在搜尋內文…",
  "sidebar.bodySearchFailed": "無法搜尋內文。",
  "sidebar.bodySearchRateLimited": "搜尋太頻繁，請稍等一下再試。",
  "sidebar.bodyLoadMore": "載入更多",
  "sidebar.bodyLoadingMore": "載入中…",
  "sidebar.bodySearchTooShort": "再多打一個字就會搜尋內文。",
  "sidebar.bodySearchTooLong": "搜尋字太長，只比對標題。",
  "sidebar.noMatch": "沒有符合搜尋的筆記。",
};

function get(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

describe("sidebar search copy = string table (zh-TW)", () => {
  for (const [key, text] of Object.entries(SPEC_COPY)) {
    it(key, () => expect(get(zhTW, key)).toBe(text));
  }

  it("titleMatches plural (count=3)", () => {
    expect(i18n.t("sidebar.titleMatches", { count: 3, lng: "zh-TW" })).toBe("標題符合 · 3 篇");
    expect(i18n.t("sidebar.titleMatches", { count: 1, lng: "en" })).toBe("1 title match");
    expect(i18n.t("sidebar.titleMatches", { count: 3, lng: "en" })).toBe("3 title matches");
  });
});

describe("en has the same new keys, and the copy does not imply a total hit count", () => {
  for (const key of Object.keys(SPEC_COPY)) {
    it(key, () => expect(typeof get(en, key)).toBe("string"));
  }
  it("matchesCount counts listed items (one per hit location), not notes; with a next page the wording says 'loaded' (已載入)", () => {
    expect(i18n.t("sidebar.matchesCount", { count: 1, lng: "en" })).toBe("1 result");
    expect(i18n.t("sidebar.matchesCount", { count: 5, lng: "en" })).toBe("5 results");
    expect(i18n.t("sidebar.matchesCount", { count: 5, lng: "zh-TW" })).toBe("5 筆結果");
    expect(i18n.t("sidebar.matchesCountMore", { count: 5, lng: "en" })).toBe("5 results loaded, more available");
    expect(i18n.t("sidebar.matchesCountMore", { count: 5, lng: "zh-TW" })).toBe("已載入 5 筆，還有更多");
  });
  it("the whole 'show N more / collapse' set is removed", () => {
    for (const key of ["sidebar.moreSnippets_one", "sidebar.moreSnippets_other", "sidebar.lessSnippets"]) {
      expect(get(en, key)).toBeUndefined();
      expect(get(zhTW, key)).toBeUndefined();
    }
  });
});

describe("old searchResults removed (renamed to 'title matches')", () => {
  for (const key of ["sidebar.searchResults_one", "sidebar.searchResults_other", "sidebar.bodyMatchesHeading", "sidebar.bodyMatchesCount_one", "sidebar.bodyMatchesCount_other"]) {
    it(key, () => {
      expect(get(en, key)).toBeUndefined();
      expect(get(zhTW, key)).toBeUndefined();
    });
  }
});

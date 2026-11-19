import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import "@/i18n/select-strings";
import enRaw from "./en.json?raw";
import zhTWRaw from "./zh-TW.json?raw";
import selectEn from "./select.en.json";
import selectZhTW from "./select.zh-TW.json";
import selectEnRaw from "./select.en.json?raw";
import selectZhTWRaw from "./select.zh-TW.json?raw";

/**
 * #181 lazy string bundle for ordinary-tab select mode (`select.*`, registered only by the SelectLazy chain via `select-strings.ts`).
 * The main-JSON parity test (`index.test.ts`) does not cover these two files, so parity, literal text, no overlap with the main file and no duplicate keys are checked here.
 */

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key));
}

function get(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

/** Same as `index.test.ts`: `JSON.parse` keeps only the last of duplicate keys, so scan the raw text. */
function duplicateKeys(raw: string): string[] {
  const dups: string[] = [];
  const stack: { keys: Set<string> | null; expectKey: boolean }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    const top = stack[stack.length - 1];
    if (ch === "{") stack.push({ keys: new Set(), expectKey: true });
    else if (ch === "[") stack.push({ keys: null, expectKey: false });
    else if (ch === "}" || ch === "]") stack.pop();
    else if (ch === ":" && top) top.expectKey = false;
    else if (ch === "," && top?.keys) top.expectKey = true;
    else if (ch === '"') {
      let j = i + 1;
      while (raw[j] !== '"') j += raw[j] === "\\" ? 2 : 1;
      if (top?.keys && top.expectKey) {
        const key = raw.slice(i + 1, j);
        if (top.keys.has(key)) dups.push(key);
        top.keys.add(key);
      }
      i = j;
    }
  }
  return dups;
}

describe("select bundle: both locales have the same key set, top level is only select", () => {
  it("same key set", () => {
    expect(flattenKeys(selectZhTW).sort()).toEqual(flattenKeys(selectEn).sort());
  });

  it("exactly one top-level key, select", () => {
    expect(Object.keys(selectEn)).toEqual(["select"]);
    expect(Object.keys(selectZhTW)).toEqual(["select"]);
  });
});

describe("select-mode copy literals (zh-TW)", () => {
  const SPEC_COPY: Record<string, string> = {
    "select.selected_other": "已選 {{count}} 項",
    "select.moveTo": "移動到",
    "select.copyTo": "複製到",
    "select.deleteSelected_other": "刪除選取的 {{count}} 項",
    "select.trashed_other": "已移到垃圾桶 {{count}} 篇",
  };
  for (const [key, text] of Object.entries(SPEC_COPY)) {
    it(key, () => expect(get(selectZhTW, key)).toBe(text));
  }
});

const FOLDER_SPEC_ZH: Record<string, string> = {
  acrossGroups: "選取的筆記分屬不同群組，無法一起移動",
  foldersOnlyWithinSpace: "資料夾只能在同一個空間內移動",
  foldersCantCopy: "資料夾不能複製",
  deleteFoldersTitle_one: "刪除 {{count}} 個資料夾？",
  deleteFoldersTitle_other: "刪除 {{count}} 個資料夾？",
  deleteFoldersBody_one: "這些資料夾與其中的子資料夾會刪除，{{count}} 篇筆記會移到垃圾桶。",
  deleteFoldersBody_other: "這些資料夾與其中的子資料夾會刪除，{{count}} 篇筆記會移到垃圾桶。",
  deleteFoldersAlsoNotes_one: "另外 {{count}} 篇選取的筆記也會移到垃圾桶。",
  deleteFoldersAlsoNotes_other: "另外 {{count}} 篇選取的筆記也會移到垃圾桶。",
  removeFoldersTitle_one: "移除 {{count}} 個資料夾？",
  removeFoldersTitle_other: "移除 {{count}} 個資料夾？",
  removeFoldersBody: "資料夾會移除，裡面的共享筆記回到最上層，不會刪除任何筆記。",
  foldersBlockedSuffix_one: "，{{count}} 個資料夾沒有刪除（裡面有你不能刪除的筆記）",
  foldersBlockedSuffix_other: "，{{count}} 個資料夾沒有刪除（裡面有你不能刪除的筆記）",
  foldersGoneSuffix_one: "，{{count}} 個資料夾已不存在",
  foldersGoneSuffix_other: "，{{count}} 個資料夾已不存在",
};

const FOLDER_SPEC_EN: Record<string, string> = {
  acrossGroups: "The selected notes are in different groups and can't be moved together",
  foldersOnlyWithinSpace: "Folders can only move within the same space",
  foldersCantCopy: "Folders can't be copied",
  deleteFoldersTitle_one: "Delete 1 folder?",
  deleteFoldersTitle_other: "Delete {{count}} folders?",
  deleteFoldersBody_one: "These folders and their subfolders will be deleted, and 1 note will move to the trash.",
  deleteFoldersBody_other: "These folders and their subfolders will be deleted, and {{count}} notes will move to the trash.",
  deleteFoldersAlsoNotes_one: "The 1 selected note will also move to the trash.",
  deleteFoldersAlsoNotes_other: "The {{count}} selected notes will also move to the trash.",
  removeFoldersTitle_one: "Remove 1 folder?",
  removeFoldersTitle_other: "Remove {{count}} folders?",
  removeFoldersBody: "The folders will be removed and their shared notes moved back to the top level. No notes are deleted.",
  foldersBlockedSuffix_one: ", 1 folder wasn't deleted (it holds notes you can't delete)",
  foldersBlockedSuffix_other: ", {{count}} folders weren't deleted (they hold notes you can't delete)",
  foldersGoneSuffix_one: ", 1 folder no longer exists",
  foldersGoneSuffix_other: ", {{count}} folders no longer exist",
};

describe("folder literals", () => {
  it.each(Object.entries(FOLDER_SPEC_ZH))("zh-TW select.%s", (key, text) => {
    expect(get(selectZhTW, `select.${key}`)).toBe(text);
  });

  it.each(Object.entries(FOLDER_SPEC_EN))("en select.%s", (key, text) => {
    expect(get(selectEn, `select.${key}`)).toBe(text);
  });
});

const FAVORITE_SPEC_ZH: Record<string, string> = {
  unfavorite: "移出最愛",
  unfavoriteTitle_one: "要把 {{count}} 篇筆記移出最愛嗎？",
  unfavoriteTitle_other: "要把 {{count}} 篇筆記移出最愛嗎？",
  unfavoriteDescription: "筆記本身不受影響，之後可以再加回來。",
  unfavorited_one: "已移出最愛 {{count}} 篇",
  unfavorited_other: "已移出最愛 {{count}} 篇",
};

const FAVORITE_SPEC_EN: Record<string, string> = {
  unfavorite: "Remove from favorites",
  unfavoriteTitle_one: "Remove {{count}} note from favorites?",
  unfavoriteTitle_other: "Remove {{count}} notes from favorites?",
  unfavoriteDescription: "The notes themselves aren't changed, and you can add them back later.",
  unfavorited_one: "Removed {{count}} note from favorites",
  unfavorited_other: "Removed {{count}} notes from favorites",
};

describe("favorites tab literals", () => {
  it.each(Object.entries(FAVORITE_SPEC_ZH))("zh-TW select.%s", (key, text) => {
    expect(get(selectZhTW, `select.${key}`)).toBe(text);
  });

  it.each(Object.entries(FAVORITE_SPEC_EN))("en select.%s", (key, text) => {
    expect(get(selectEn, `select.${key}`)).toBe(text);
  });
});

// Read the raw text: deep-merge addResourceBundle merges `select` into the main JSON object from i18n init (the same import),
// so after select-strings loads, the imported main JSON already has a `select` key.
describe("main JSON has no select top-level key (strings go only into the lazy bundle)", () => {
  it.each([
    ["en", enRaw],
    ["zh-TW", zhTWRaw],
  ] as const)("%s", (_name, raw) => {
    expect(Object.keys(JSON.parse(raw) as object)).not.toContain("select");
  });
});

describe("available after registration, main file not overridden", () => {
  it("select.selected: en '3 selected', zh-TW '已選 3 項'", () => {
    expect(i18n.t("select.selected", { count: 3, lng: "en" })).toBe("3 selected");
    expect(i18n.t("select.selected", { count: 3, lng: "zh-TW" })).toBe("已選 3 項");
  });

  it("trash.select is still Select", () => {
    expect(i18n.t("trash.select", { lng: "en" })).toBe("Select");
  });
});

describe("select bundle has no duplicate keys", () => {
  it.each([
    ["en", selectEnRaw],
    ["zh-TW", selectZhTWRaw],
  ] as const)("%s", (_name, raw) => {
    expect(duplicateKeys(raw)).toEqual([]);
  });
});

describe("every _one has an _other", () => {
  it.each([
    ["en", selectEn],
    ["zh-TW", selectZhTW],
  ] as const)("%s", (_name, resource) => {
    const keys = new Set(flattenKeys(resource));
    const missing = [...keys].filter((k) => k.endsWith("_one") && !keys.has(`${k.slice(0, -"_one".length)}_other`));
    expect(missing).toEqual([]);
  });
});

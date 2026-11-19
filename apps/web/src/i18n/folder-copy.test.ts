import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import "@/i18n/folder-strings";
import enRaw from "./en.json?raw";
import zhTWRaw from "./zh-TW.json?raw";
import foldersEn from "./folders.en.json";
import foldersZhTW from "./folders.zh-TW.json";
import foldersEnRaw from "./folders.en.json?raw";
import foldersZhTWRaw from "./folders.zh-TW.json?raw";

/**
 * Lazy string bundle for the folder dialogs (`folderDialogs.*`, registered only by the FolderLazy chain via `folder-strings.ts`; same shape as `select-copy.test.ts`).
 * The main-JSON parity test (`index.test.ts`) does not cover these two files, so parity, literal text, no overlap with the main file and no duplicate keys are checked here.
 */

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key));
}

function get(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

/** Same as `select-copy.test.ts`: `JSON.parse` keeps only the last of duplicate keys, so scan the raw text. */
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

describe("folders bundle: both locales have the same key set, top level is only folderDialogs", () => {
  it("same key set", () => {
    expect(flattenKeys(foldersZhTW).sort()).toEqual(flattenKeys(foldersEn).sort());
  });

  it("exactly one top-level key, folderDialogs", () => {
    expect(Object.keys(foldersEn)).toEqual(["folderDialogs"]);
    expect(Object.keys(foldersZhTW)).toEqual(["folderDialogs"]);
  });
});

describe("folder copy literals", () => {
  const ZH: Record<string, string> = {
    "folderDialogs.renameTitle": "重新命名資料夾",
    "folderDialogs.nameLabel": "資料夾名稱",
    "folderDialogs.nameControlChars": "名稱不能包含換行或控制字元",
    "folderDialogs.deleteTitle": "刪除資料夾「{{name}}」？",
    "folderDialogs.subfoldersPart_other": "資料夾（含 {{count}} 個子資料夾）會刪除，",
    "folderDialogs.noSubfoldersPart": "資料夾會刪除，",
    "folderDialogs.notesPart_other": "其中 {{count}} 篇筆記會移到垃圾桶，",
    "folderDialogs.purgeDays_other": "{{count}} 天後自動永久刪除。",
    "folderDialogs.purgeNever": "不會自動清除。",
    "folderDialogs.restoreRebuilds": "從垃圾桶還原時會照原路徑重建資料夾。",
    "folderDialogs.emptyWithSub_other": "這個資料夾（含 {{count}} 個子資料夾）會刪除，裡面沒有筆記。",
    "folderDialogs.removeTitle": "移除資料夾「{{name}}」？",
    "folderDialogs.removeBody_other": "資料夾會移除，裡面 {{count}} 篇共享筆記回到「與我共享」最上層，不會刪除任何筆記。",
    "folderDialogs.deleted_other": "已刪除資料夾，{{count}} 篇筆記已移到垃圾桶",
    "folderDialogs.deletedEmpty": "已刪除資料夾",
    "folderDialogs.removed_other": "已移除資料夾，{{count}} 篇共享筆記回到最上層",
  };
  const EN: Record<string, string> = {
    "folderDialogs.renameTitle": "Rename folder",
    "folderDialogs.nameLabel": "Folder name",
    "folderDialogs.nameControlChars": "Names can't contain line breaks or control characters",
    "folderDialogs.deleted_one": "Folder deleted; 1 note moved to the trash",
    "folderDialogs.deleted_other": "Folder deleted; {{count}} notes moved to the trash",
    "folderDialogs.deletedEmpty": "Folder deleted",
    "folderDialogs.removed_one": "Folder removed; 1 shared note moved back to the top level",
    "folderDialogs.removed_other": "Folder removed; {{count}} shared notes moved back to the top level",
  };
  for (const [key, text] of Object.entries(ZH)) it(`zh ${key}`, () => expect(get(foldersZhTW, key)).toBe(text));
  for (const [key, text] of Object.entries(EN)) it(`en ${key}`, () => expect(get(foldersEn, key)).toBe(text));
});

// Read the raw text: deep-merge addResourceBundle merges folderDialogs into the main JSON object from i18n init.
describe("main JSON has no folderDialogs top-level key (strings go only into the lazy bundle)", () => {
  it.each([
    ["en", enRaw],
    ["zh-TW", zhTWRaw],
  ] as const)("%s", (_name, raw) => {
    expect(Object.keys(JSON.parse(raw) as object)).not.toContain("folderDialogs");
  });
});

describe("available after registration", () => {
  it("folderDialogs.deleted: en / zh-TW", () => {
    expect(i18n.t("folderDialogs.deleted", { count: 2, lng: "en" })).toBe("Folder deleted; 2 notes moved to the trash");
    expect(i18n.t("folderDialogs.deleted", { count: 2, lng: "zh-TW" })).toBe("已刪除資料夾，2 篇筆記已移到垃圾桶");
  });
});

describe("every _one has an _other", () => {
  it.each([
    ["en", foldersEn],
    ["zh-TW", foldersZhTW],
  ] as const)("%s", (_name, resource) => {
    const keys = new Set(flattenKeys(resource));
    const missing = [...keys].filter((k) => k.endsWith("_one") && !keys.has(`${k.slice(0, -"_one".length)}_other`));
    expect(missing).toEqual([]);
  });
});

describe("folders bundle has no duplicate keys", () => {
  it.each([
    ["en", foldersEnRaw],
    ["zh-TW", foldersZhTWRaw],
  ] as const)("%s", (_name, raw) => {
    expect(duplicateKeys(raw)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import "@/i18n/mobile-toolbar-strings";
import enRaw from "./en.json?raw";
import zhTWRaw from "./zh-TW.json?raw";
import toolbarEn from "./mobile-toolbar.en.json";
import toolbarZhTW from "./mobile-toolbar.zh-TW.json";
import toolbarEnRaw from "./mobile-toolbar.en.json?raw";
import toolbarZhTWRaw from "./mobile-toolbar.zh-TW.json?raw";

/**
 * 手機編輯工具列的 lazy 字串包（`mobileToolbar.*`，只由 `components/editor/mobile/*` 經 `mobile-toolbar-strings.ts` 註冊）。
 * 主 JSON 的 parity（`index.test.ts`）不涵蓋這兩檔，所以鍵集合相同、與主檔不重疊、無重複鍵都在這裡。
 * 主檔一律讀 `?raw`：註冊後 deep merge 會把包併進 i18n 初始化時那份主 JSON 物件。
 */

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key));
}

/** `JSON.parse` 遇重複鍵只留最後一份，直接掃原始文字（同 `select-copy.test.ts`）。 */
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

describe("MT1 兩語系鍵集合相同、頂層只有 mobileToolbar", () => {
  it("鍵集合相同", () => {
    expect(flattenKeys(toolbarZhTW).sort()).toEqual(flattenKeys(toolbarEn).sort());
  });

  it("頂層恰一個鍵 mobileToolbar", () => {
    expect(Object.keys(toolbarEn)).toEqual(["mobileToolbar"]);
    expect(Object.keys(toolbarZhTW)).toEqual(["mobileToolbar"]);
  });

  it("每個值都是非空字串", () => {
    for (const resource of [toolbarEn, toolbarZhTW]) {
      for (const value of Object.values(resource.mobileToolbar)) expect(value.trim()).not.toBe("");
    }
  });
});

describe("MT2 主 JSON 沒有 mobileToolbar 頂層鍵，也沒有與字串包重疊的鍵", () => {
  it.each([
    ["en", enRaw],
    ["zh-TW", zhTWRaw],
  ] as const)("%s", (_name, raw) => {
    const main = JSON.parse(raw) as object;
    expect(Object.keys(main)).not.toContain("mobileToolbar");
    const mainKeys = new Set(flattenKeys(main));
    expect(flattenKeys(toolbarEn).filter((key) => mainKeys.has(key))).toEqual([]);
  });
});

describe("MT3 字串包沒有重複鍵", () => {
  it.each([
    ["en", toolbarEnRaw],
    ["zh-TW", toolbarZhTWRaw],
  ] as const)("%s", (_name, raw) => {
    expect(duplicateKeys(raw)).toEqual([]);
  });
});

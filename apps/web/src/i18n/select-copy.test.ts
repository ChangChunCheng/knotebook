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
 * #181 PR-2c 一般 tab 選取模式的 lazy 字串包（`select.*`，只由 SelectLazy 鏈經 `select-strings.ts` 註冊）。
 * 主 JSON 的 parity（`index.test.ts`）不涵蓋這兩檔，所以 parity、逐字、與主檔不重疊、無重複鍵都在這裡。
 */

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key));
}

function get(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

/** 同 `index.test.ts`：`JSON.parse` 遇重複鍵只留最後一份，直接掃原始文字。 */
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

describe("SC1 select 包：兩語系鍵集合相同、頂層只有 select", () => {
  it("鍵集合相同", () => {
    expect(flattenKeys(selectZhTW).sort()).toEqual(flattenKeys(selectEn).sort());
  });

  it("頂層恰一個鍵 select", () => {
    expect(Object.keys(selectEn)).toEqual(["select"]);
    expect(Object.keys(selectZhTW)).toEqual(["select"]);
  });
});

describe("SC2 spec §6.11／§6.12 字面（zh-TW）", () => {
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

// 讀原始文字：deep merge 的 addResourceBundle 會把 select 併進 i18n 初始化時那份主 JSON 物件（同一個 import），
// 所以 import 進來的主 JSON 在 select-strings 載入後已帶 select 鍵。
describe("SC3 主 JSON 沒有 select 頂層鍵（字串只進 lazy 包）", () => {
  it.each([
    ["en", enRaw],
    ["zh-TW", zhTWRaw],
  ] as const)("%s", (_name, raw) => {
    expect(Object.keys(JSON.parse(raw) as object)).not.toContain("select");
  });
});

describe("SC4 註冊後可用、不覆寫主檔", () => {
  it("select.selected：en「3 selected」、zh-TW「已選 3 項」", () => {
    expect(i18n.t("select.selected", { count: 3, lng: "en" })).toBe("3 selected");
    expect(i18n.t("select.selected", { count: 3, lng: "zh-TW" })).toBe("已選 3 項");
  });

  it("trash.select 仍是 Select", () => {
    expect(i18n.t("trash.select", { lng: "en" })).toBe("Select");
  });
});

describe("SC5 select 包沒有重複鍵", () => {
  it.each([
    ["en", selectEnRaw],
    ["zh-TW", selectZhTWRaw],
  ] as const)("%s", (_name, raw) => {
    expect(duplicateKeys(raw)).toEqual([]);
  });
});

describe("SC6 每個 _one 都有 _other", () => {
  it.each([
    ["en", selectEn],
    ["zh-TW", selectZhTW],
  ] as const)("%s", (_name, resource) => {
    const keys = new Set(flattenKeys(resource));
    const missing = [...keys].filter((k) => k.endsWith("_one") && !keys.has(`${k.slice(0, -"_one".length)}_other`));
    expect(missing).toEqual([]);
  });
});

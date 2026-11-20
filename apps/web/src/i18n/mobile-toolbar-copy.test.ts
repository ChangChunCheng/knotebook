import { describe, expect, it } from "vitest";
import "@/i18n/mobile-toolbar-strings";
import enRaw from "./en.json?raw";
import zhTWRaw from "./zh-TW.json?raw";
import toolbarEn from "./mobile-toolbar.en.json";
import toolbarZhTW from "./mobile-toolbar.zh-TW.json";
import toolbarEnRaw from "./mobile-toolbar.en.json?raw";
import toolbarZhTWRaw from "./mobile-toolbar.zh-TW.json?raw";

/**
 * Lazy string bundle for the phone editing toolbar (`mobileToolbar.*`, registered only by `components/editor/mobile/*` via `mobile-toolbar-strings.ts`).
 * The main-JSON parity test (`index.test.ts`) does not cover these two files, so same key set, no overlap with the main file and no duplicate keys are checked here.
 * The main file is always read as `?raw`: after registration the deep merge folds the bundle into the main JSON object from i18n init.
 */

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key));
}

/** `JSON.parse` keeps only the last of duplicate keys, so scan the raw text (same as `select-copy.test.ts`). */
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

describe("both locales have the same key set, top level is only mobileToolbar", () => {
  it("same key set", () => {
    expect(flattenKeys(toolbarZhTW).sort()).toEqual(flattenKeys(toolbarEn).sort());
  });

  it("exactly one top-level key, mobileToolbar", () => {
    expect(Object.keys(toolbarEn)).toEqual(["mobileToolbar"]);
    expect(Object.keys(toolbarZhTW)).toEqual(["mobileToolbar"]);
  });

  it("every value is a non-empty string", () => {
    for (const resource of [toolbarEn, toolbarZhTW]) {
      for (const value of Object.values(resource.mobileToolbar)) expect(value.trim()).not.toBe("");
    }
  });
});

describe("main JSON has no mobileToolbar top-level key and no key overlapping the bundle", () => {
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

describe("bundle has no duplicate keys", () => {
  it.each([
    ["en", toolbarEnRaw],
    ["zh-TW", toolbarZhTWRaw],
  ] as const)("%s", (_name, raw) => {
    expect(duplicateKeys(raw)).toEqual([]);
  });
});

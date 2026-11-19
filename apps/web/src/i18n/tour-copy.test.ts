import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import "@/i18n/tour-strings";
import enRaw from "./en.json?raw";
import zhTWRaw from "./zh-TW.json?raw";
import tourEn from "./tour.en.json";
import tourZhTW from "./tour.zh-TW.json";
import tourEnRaw from "./tour.en.json?raw";
import tourZhTWRaw from "./tour.zh-TW.json?raw";

/**
 * Lazy string bundle for the feature tour (`tourGuide.*`, registered only by the tour's lazy chain via `tour-strings.ts`).
 * The main-JSON parity test (`index.test.ts`) does not cover these two files, so parity, no empty strings, no duplicate keys and no overlap with the main file are checked here.
 * Same skeleton as shortcuts-copy.test.ts.
 */

function leaves(value: unknown, prefix = ""): [string, unknown][] {
  if (typeof value !== "object" || value === null) return [[prefix, value]];
  return Object.entries(value).flatMap(([key, child]) => leaves(child, prefix ? `${prefix}.${key}` : key));
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

const BUNDLES = [
  ["en", tourEn],
  ["zh-TW", tourZhTW],
] as const;

describe("both locales have the same key set, top level is only tourGuide", () => {
  it("same key set", () => {
    const keys = (bundle: unknown) => leaves(bundle).map(([k]) => k).sort();
    expect(keys(tourZhTW)).toEqual(keys(tourEn));
  });

  it("exactly one top-level key, tourGuide", () => {
    expect(Object.keys(tourEn)).toEqual(["tourGuide"]);
    expect(Object.keys(tourZhTW)).toEqual(["tourGuide"]);
  });
});

describe("every value is a non-empty string", () => {
  it.each(BUNDLES)("%s", (_name, bundle) => {
    const bad = leaves(bundle).filter(([, v]) => typeof v !== "string" || v.trim().length === 0);
    expect(bad.map(([k]) => k)).toEqual([]);
  });
});

// Read the raw text: deep-merge addResourceBundle merges tourGuide into the main JSON object from i18n init (the same import),
// so after tour-strings loads, the imported main JSON already has a tourGuide key.
describe("main JSON has no tourGuide top-level key", () => {
  it.each([
    ["en", enRaw],
    ["zh-TW", zhTWRaw],
  ] as const)("%s", (_name, raw) => {
    expect(Object.keys(JSON.parse(raw) as object)).not.toContain("tourGuide");
  });
});

describe("bundle has no duplicate keys", () => {
  it.each([
    ["en", tourEnRaw],
    ["zh-TW", tourZhTWRaw],
  ] as const)("%s", (_name, raw) => {
    expect(duplicateKeys(raw)).toEqual([]);
  });
});

// 「導覽」 alone is already the name of the narrow-viewport sidebar drawer (`sidebar.drawerTitle`, `sidebar.openDrawer`);
// this feature is always written 「功能導覽」 so the two are not confused.
describe("zh-TW has no 「導覽」 without 「功能」", () => {
  it("every value", () => {
    const bad = leaves(tourZhTW).filter(([, v]) => typeof v === "string" && /(?<!功能)導覽/.test(v));
    expect(bad).toEqual([]);
  });
});

// The last stop's question must be its own key: the card's two buttons point to it with `aria-describedby`; if it were
// merged into the stop description, a screen reader would read the whole description for each button.
describe("the last stop's question is its own key, not part of the stop description", () => {
  const QUESTION = { en: "Keep the sample note, or move it to the trash?", "zh-TW": "要保留示範筆記，還是移到垃圾桶？" } as const;
  it.each(BUNDLES)("%s", (name, bundle) => {
    expect(bundle.tourGuide.keepOrDeleteSample).toBe(QUESTION[name]);
    const stops = leaves(bundle.tourGuide.stops).filter(([, v]) => typeof v === "string" && v.includes(QUESTION[name]));
    expect(stops).toEqual([]);
  });
});

describe("available after registration, main file not overridden", () => {
  it("bundle keys resolve, and the main file's keys are unchanged", () => {
    expect(i18n.t("tourGuide.progress", { lng: "en", n: 1, total: 7 })).toBe("1 / 7");
    expect(i18n.t("userMenu.help", { lng: "zh-TW" })).toBe("說明");
    expect(i18n.t("userMenu.logout", { lng: "en" })).toBe("Log out");
  });
});

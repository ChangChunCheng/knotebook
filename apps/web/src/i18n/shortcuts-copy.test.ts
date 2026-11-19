import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import "@/i18n/shortcuts-strings";
import { SHORTCUT_CATEGORIES, SHORTCUTS } from "@/components/shortcuts/shortcut-list";
import enRaw from "./en.json?raw";
import zhTWRaw from "./zh-TW.json?raw";
import guideEn from "./shortcuts.en.json";
import guideZhTW from "./shortcuts.zh-TW.json";
import guideEnRaw from "./shortcuts.en.json?raw";
import guideZhTWRaw from "./shortcuts.zh-TW.json?raw";

/**
 * Lazy string bundle for the shortcuts guide page (`shortcutsGuide.*`, registered only by the ShortcutsLazy chain via `shortcuts-strings.ts`).
 * The main-JSON parity test (`index.test.ts`) does not cover these two files, so parity, no duplicate keys, no overlap with the main file and agreement with the list are checked here.
 * Same skeleton as select-copy.test.ts.
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

const BUNDLES = [
  ["en", guideEn],
  ["zh-TW", guideZhTW],
] as const;

describe("both locales have the same key set, top level is only shortcutsGuide and helpGuide", () => {
  it("same key set", () => {
    expect(flattenKeys(guideZhTW).sort()).toEqual(flattenKeys(guideEn).sort());
  });

  it("exactly two top-level keys, shortcutsGuide and helpGuide", () => {
    expect(Object.keys(guideEn)).toEqual(["shortcutsGuide", "helpGuide"]);
    expect(Object.keys(guideZhTW)).toEqual(["shortcutsGuide", "helpGuide"]);
  });
});

describe("required keys in the bundle", () => {
  const REQUIRED = [
    "keys.space",
    "keys.enter",
    "keys.esc",
    "keys.tab",
    "keys.backspace",
    "keys.delete",
    "keys.click",
    "srKeys.command",
    "srKeys.shift",
    "srKeys.option",
    "srKeys.up",
    "srKeys.down",
    "srKeys.left",
    "srKeys.right",
    "srKeys.or",
    "srKeys.pair",
    "footer",
  ];
  it.each(BUNDLES)("%s", (_name, bundle) => {
    for (const key of REQUIRED) {
      const value = get(bundle, `shortcutsGuide.${key}`);
      expect(typeof value, key).toBe("string");
      expect((value as string).length, key).toBeGreaterThan(0);
    }
  });

  it("footer carries a <keys/> placeholder (for Trans)", () => {
    for (const [, bundle] of BUNDLES) expect(get(bundle, "shortcutsGuide.footer") as string).toContain("<keys/>");
  });
});

describe("list and strings match", () => {
  it.each(BUNDLES)("%s: every SHORTCUTS id has a name and desc", (_name, bundle) => {
    for (const e of SHORTCUTS) {
      for (const field of ["name", "desc"]) {
        const value = get(bundle, `shortcutsGuide.items.${e.id}.${field}`);
        expect(typeof value === "string" && value.length > 0, `${e.id}.${field}`).toBe(true);
      }
    }
  });

  it.each(BUNDLES)("%s: every category has a title", (_name, bundle) => {
    for (const category of SHORTCUT_CATEGORIES) {
      const value = get(bundle, `shortcutsGuide.categories.${category}`);
      expect(typeof value === "string" && value.length > 0, category).toBe(true);
    }
  });

  it.each(BUNDLES)("%s: reverse - bundle items contain no id missing from the list (guards leftover strings)", (_name, bundle) => {
    const known = new Set(SHORTCUTS.map((e) => e.id));
    const items = get(bundle, "shortcutsGuide.items") as Record<string, unknown>;
    expect(Object.keys(items).filter((id) => !known.has(id))).toEqual([]);
  });

  it.each(BUNDLES)("%s: reverse - categories contains no unknown category", (_name, bundle) => {
    const categories = get(bundle, "shortcutsGuide.categories") as Record<string, unknown>;
    expect(Object.keys(categories).filter((c) => !(SHORTCUT_CATEGORIES as readonly string[]).includes(c))).toEqual([]);
  });
});

// Read the raw text: deep-merge addResourceBundle merges shortcutsGuide into the main JSON object from i18n init (the same import),
// so after shortcuts-strings loads, the imported main JSON already has a shortcutsGuide key.
describe("main JSON has no shortcutsGuide top-level key and does not overlap the bundle's top-level keys", () => {
  it.each([
    ["en", enRaw],
    ["zh-TW", zhTWRaw],
  ] as const)("%s", (_name, raw) => {
    const main = Object.keys(JSON.parse(raw) as object);
    expect(main).not.toContain("shortcutsGuide");
    expect(main.filter((k) => Object.keys(guideEn).includes(k))).toEqual([]);
  });
});

describe("available after registration, main file not overridden", () => {
  it("category titles and the main file's three keys", () => {
    expect(i18n.t("shortcutsGuide.categories.typing", { lng: "en" })).toBe("Typing triggers");
    expect(i18n.t("shortcutsGuide.categories.typing", { lng: "zh-TW" })).toBe("打字觸發");
    expect(i18n.t("shortcuts.title", { lng: "en" })).toBe("Help");
    expect(i18n.t("shortcuts.title", { lng: "zh-TW" })).toBe("說明");
    expect(i18n.t("userMenu.help", { lng: "en" })).toBe("Help");
    expect(i18n.t("userMenu.help", { lng: "zh-TW" })).toBe("說明");
    expect(i18n.t("shortcuts.description", { lng: "zh-TW" })).toBe("功能導覽、這一版新增，以及常用快捷鍵與打字觸發字");
    expect(i18n.t("userMenu.logout", { lng: "en" })).toBe("Log out");
  });
});

describe("bundle has no duplicate keys", () => {
  it.each([
    ["en", guideEnRaw],
    ["zh-TW", guideZhTWRaw],
  ] as const)("%s", (_name, raw) => {
    expect(duplicateKeys(raw)).toEqual([]);
  });
});

describe("category title literals", () => {
  const TITLES: Record<string, { en: string; zh: string }> = {
    global: { en: "General", zh: "通用" },
    typing: { en: "Typing triggers", zh: "打字觸發" },
    markdown: { en: "Markdown shortcuts", zh: "Markdown 速記" },
    formatting: { en: "Text formatting", zh: "文字格式" },
    columns: { en: "Columns", zh: "並排" },
    sidebar: { en: "Sidebar", zh: "側欄" },
    presentation: { en: "Presentation", zh: "簡報模式" },
    ai: { en: "AI", zh: "AI" },
    mouse: { en: "Mouse", zh: "滑鼠操作" },
  };
  for (const [category, { en, zh }] of Object.entries(TITLES)) {
    it(category, () => {
      expect(get(guideEn, `shortcutsGuide.categories.${category}`)).toBe(en);
      expect(get(guideZhTW, `shortcutsGuide.categories.${category}`)).toBe(zh);
    });
  }
});

describe("help page strings", () => {
  const REQUIRED = ["nav.tour", "nav.whatsNew", "nav.shortcuts", "tour.heading", "tour.intro", "tour.start", "whatsNew.heading", "whatsNew.empty"];

  it.each(BUNDLES)("%s: required keys are non-empty strings, the version title carries {{version}}", (_name, bundle) => {
    for (const key of REQUIRED) {
      const value = get(bundle, `helpGuide.${key}`);
      expect(typeof value === "string" && value.length > 0, key).toBe(true);
    }
    expect(get(bundle, "helpGuide.whatsNew.heading") as string).toContain("{{version}}");
  });

  it.each([
    ["en", enRaw],
    ["zh-TW", zhTWRaw],
  ] as const)("%s: the main JSON has no helpGuide, and userMenu has help but not the old shortcuts", (_name, raw) => {
    const main = JSON.parse(raw) as { userMenu: Record<string, unknown> };
    expect(Object.keys(main)).not.toContain("helpGuide");
    expect(main.userMenu).toHaveProperty("help");
    expect(main.userMenu).not.toHaveProperty("shortcuts");
  });

  it("zh-TW says 「功能導覽」, not 「導覽」 alone", () => {
    const texts = flattenKeys(guideZhTW.helpGuide.tour).map((key) => get(guideZhTW.helpGuide.tour, key) as string);
    for (const text of [...texts, guideZhTW.helpGuide.nav.tour]) expect(text.replace(/功能導覽/g, "")).not.toMatch(/(?<!開始)導覽/);
  });
});

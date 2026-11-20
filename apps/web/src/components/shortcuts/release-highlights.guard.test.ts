import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import webPackage from "../../../package.json";
import shortcutsEn from "@/i18n/shortcuts.en.json";
import shortcutsZhTW from "@/i18n/shortcuts.zh-TW.json";
import { RELEASE_HIGHLIGHTS, visibleHighlightItems, type HighlightItem, type ReleaseHighlights } from "./release-highlights";
import registrySource from "./release-highlights.ts?raw";

/**
 * Guard for the "What's new" registry. Release preparation raises the package version; this goes red when the registry did not follow, so last release's
 * "vX.Y.Z new" does not carry on into the next version. The checks are pure functions, each proven to go red with fake data:
 * the real registry's entries may be emptied later, and run only against it the string check would check nothing.
 */

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** Whether `a` >= `b` (both must be X.Y.Z). Compares segment by segment as numbers, not as strings: string comparison would make 0.9.0 greater than 0.10.0. */
function versionAtLeast(a: string, b: string): boolean {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (pa === null || pb === null) return false;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

function get(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

interface GuardInput {
  highlights: ReleaseHighlights;
  packageVersion: string;
  bundles: readonly (readonly [string, unknown])[];
}

function highlightProblems({ highlights, packageVersion, bundles }: GuardInput): string[] {
  const problems: string[] = [];
  if (!SEMVER.test(highlights.version)) problems.push(`version 不是 X.Y.Z：${highlights.version}`);
  else if (!versionAtLeast(highlights.version, packageVersion)) {
    problems.push(`version ${highlights.version} 低於 apps/web/package.json 的 ${packageVersion}`);
  }
  for (const { id, adminOnly } of highlights.items) {
    if (adminOnly !== undefined && typeof adminOnly !== "boolean") problems.push(`${id} 的 adminOnly 不是布林：${String(adminOnly)}`);
    for (const [lang, bundle] of bundles) {
      for (const field of ["title", "desc"]) {
        const key = `helpGuide.whatsNew.items.${id}.${field}`;
        const value = get(bundle, key);
        if (typeof value !== "string" || value.length === 0) problems.push(`${lang} 缺 ${key}`);
      }
    }
  }
  return problems;
}

const BUNDLES = [
  ["en", shortcutsEn],
  ["zh-TW", shortcutsZhTW],
] as const;

describe("release-highlights registry", () => {
  it("real registry: valid version format, not below the package version, every entry has bilingual strings", () => {
    expect(highlightProblems({ highlights: RELEASE_HIGHLIGHTS, packageVersion: webPackage.version, bundles: BUNDLES })).toEqual([]);
  });

  it("entry ids are unique", () => {
    const ids = RELEASE_HIGHLIGHTS.items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("the string bundle has no entries missing from the registry (guards leftover strings)", () => {
    const ids = RELEASE_HIGHLIGHTS.items.map((item) => item.id);
    for (const [lang, bundle] of BUNDLES) {
      const items = (get(bundle, "helpGuide.whatsNew.items") ?? {}) as Record<string, unknown>;
      expect(Object.keys(items).filter((id) => !ids.includes(id)), lang).toEqual([]);
    }
  });
});

describe("the guard itself (fake data)", () => {
  const ok = (over: Partial<GuardInput>): string[] =>
    highlightProblems({ highlights: { version: "1.0.0", items: [] }, packageVersion: "1.0.0", bundles: BUNDLES, ...over });

  it("version equal to the package version: passes", () => {
    expect(ok({})).toEqual([]);
  });

  it("version not X.Y.Z: red", () => {
    for (const version of ["1.0", "v1.0.0", "1.0.0-rc.1", "", "1.0.0 "]) {
      expect(ok({ highlights: { version, items: [] } }), version).toHaveLength(1);
    }
  });

  it("version below the package version: red (numbers compared per segment)", () => {
    expect(ok({ highlights: { version: "0.15.0", items: [] }, packageVersion: "0.16.0" })).toHaveLength(1);
    expect(ok({ highlights: { version: "0.9.0", items: [] }, packageVersion: "0.10.0" })).toHaveLength(1);
    expect(ok({ highlights: { version: "1.9.9", items: [] }, packageVersion: "2.0.0" })).toHaveLength(1);
    expect(ok({ highlights: { version: "0.10.0", items: [] }, packageVersion: "0.9.0" })).toEqual([]);
    expect(ok({ highlights: { version: "0.16.0", items: [] }, packageVersion: "0.15.3" })).toEqual([]);
  });

  it("an entry missing a language's string: red", () => {
    const bundle = (title: string, desc: string | undefined): unknown => ({
      helpGuide: { whatsNew: { items: { sample: { title, desc } } } },
    });
    const highlights: ReleaseHighlights = { version: "1.0.0", items: [{ id: "sample" }] };
    expect(ok({ highlights, bundles: [["en", bundle("T", "D")], ["zh-TW", bundle("標題", "說明")]] })).toEqual([]);
    expect(ok({ highlights, bundles: [["en", bundle("T", undefined)], ["zh-TW", bundle("標題", "說明")]] })).toEqual([
      "en 缺 helpGuide.whatsNew.items.sample.desc",
    ]);
    expect(ok({ highlights, bundles: [["en", bundle("T", "D")], ["zh-TW", bundle("", "說明")]] })).toEqual([
      "zh-TW 缺 helpGuide.whatsNew.items.sample.title",
    ]);
    expect(ok({ highlights: { version: "1.0.0", items: [{ id: "missing" }] }, bundles: BUNDLES })).toHaveLength(4);
  });

  it("adminOnly not a boolean: red; omitted, true, false: pass", () => {
    const bundle: unknown = { helpGuide: { whatsNew: { items: { sample: { title: "T", desc: "D" } } } } };
    const bundles = [
      ["en", bundle],
      ["zh-TW", bundle],
    ] as const;
    const withAdminOnly = (adminOnly: unknown): string[] =>
      ok({ highlights: { version: "1.0.0", items: [{ id: "sample", adminOnly } as HighlightItem] }, bundles });
    expect(withAdminOnly(undefined)).toEqual([]);
    expect(withAdminOnly(true)).toEqual([]);
    expect(withAdminOnly(false)).toEqual([]);
    for (const bad of ["true", 1, 0, null, {}]) expect(withAdminOnly(bad), String(bad)).toHaveLength(1);
  });
});

describe("visibleHighlightItems", () => {
  const items: HighlightItem[] = [{ id: "a" }, { id: "b", adminOnly: true }, { id: "c", adminOnly: false }, { id: "d", adminOnly: true }];

  it("an ordinary user does not see adminOnly entries, order unchanged", () => {
    expect(visibleHighlightItems(items, false).map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("a site admin sees everything", () => {
    expect(visibleHighlightItems(items, true).map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("empty list and all adminOnly: an ordinary user gets an empty array", () => {
    expect(visibleHighlightItems([], false)).toEqual([]);
    expect(visibleHighlightItems([{ id: "x", adminOnly: true }], false)).toEqual([]);
  });

  it("does not modify the passed array", () => {
    const copy = [...items];
    visibleHighlightItems(items, false);
    expect(items).toEqual(copy);
  });

  it("real registry: adminOnly entries are invisible to an ordinary user and visible to an admin, the rest to both", () => {
    const all = RELEASE_HIGHLIGHTS.items.map((i) => i.id);
    const adminOnlyIds = RELEASE_HIGHLIGHTS.items.filter((i) => i.adminOnly === true).map((i) => i.id);
    const everyoneIds = RELEASE_HIGHLIGHTS.items.filter((i) => i.adminOnly !== true).map((i) => i.id);
    const asUser = visibleHighlightItems(RELEASE_HIGHLIGHTS.items, false).map((i) => i.id);
    const asAdmin = visibleHighlightItems(RELEASE_HIGHLIGHTS.items, true).map((i) => i.id);
    expect(asUser).toEqual(everyoneIds);
    expect(asUser.filter((id) => adminOnlyIds.includes(id))).toEqual([]);
    expect(asAdmin).toEqual(all);
  });
});

/** The help dialog's chunk reads the registry, so neither the registry nor the help dialog may pull the tour's code (site table etc.) into the same chunk. */
describe("import guard", () => {
  const IMPORT_FROM = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
  const importsOf = (source: string): string[] => [...source.matchAll(IMPORT_FROM)].map((m) => m[1]!);

  /** Resolves an import path to a path relative to `src/` without extension; package names give null. */
  function resolveImport(fromFile: string, spec: string): string | null {
    let resolved: string;
    if (spec.startsWith("@/")) resolved = posix.normalize(spec.slice(2));
    else if (spec.startsWith(".")) resolved = posix.join(posix.dirname(fromFile), spec);
    else return null;
    return resolved.replace(/\/index$/, "").replace(/\.(tsx?|jsx?)$/, "");
  }

  /** Keys of `sources` are file paths relative to `src/`; returns the files that import something for which `isTarget` is true. */
  function importers(sources: Record<string, string>, isTarget: (resolved: string) => boolean): string[] {
    return Object.entries(sources)
      .filter(([file, source]) =>
        importsOf(source).some((spec) => {
          const resolved = resolveImport(file, spec);
          return resolved !== null && isTarget(resolved);
        }),
      )
      .map(([file]) => file);
  }

  const REGISTRY = "components/shortcuts/release-highlights";
  const isRegistry = (resolved: string): boolean => resolved === REGISTRY;
  const isTourDir = (resolved: string): boolean => resolved === "components/tour" || resolved.startsWith("components/tour/");

  /** Converts a glob key (relative to this file) into a path relative to `src/`. */
  const fromSrc = (sources: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(sources).map(([key, source]) => [posix.join("components/shortcuts", key), source]));

  const tourSources = fromSrc(
    import.meta.glob(["../tour/**/*.{ts,tsx}", "../../lib/tour-*.{ts,tsx}", "../../collab/tour-*.{ts,tsx}"], {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>,
  );
  const shortcutSources = fromSrc(
    import.meta.glob(["./*.{ts,tsx}", "!./*.test.{ts,tsx}"], { query: "?raw", import: "default", eager: true }) as Record<string, string>,
  );

  it("the glob finds files (it did not come up empty)", () => {
    const tourFiles = Object.keys(tourSources);
    expect(tourFiles.filter((f) => f.startsWith("components/tour/")).length).toBeGreaterThan(5);
    expect(tourFiles).toContain("lib/tour-bridge.ts");
    expect(tourFiles).toContain("collab/tour-transaction-filter.ts");
    expect(Object.keys(shortcutSources)).toContain("components/shortcuts/ShortcutsDialog.tsx");
  });

  it("the tour code (tour directory, lib/tour-*, collab/tour-*) has no file importing the registry", () => {
    expect(importers(tourSources, isRegistry)).toEqual([]);
  });

  it("the registry itself has no imports", () => {
    expect(importsOf(registrySource)).toEqual([]);
    expect(registrySource).not.toMatch(/^\s*(import|export\s+.*\s+from)\b/m);
  });

  it("no non-test file under the help dialog directory imports the tour directory", () => {
    expect(importers(shortcutSources, isTourDir)).toEqual([]);
  });

  describe("the guard itself (fake data)", () => {
    const from = (file: string, spec: string): Record<string, string> => ({ [file]: `import { x } from "${spec}";` });

    it("various spellings all resolve to the same target", () => {
      for (const spec of [
        "@/components/shortcuts/release-highlights",
        "../shortcuts/release-highlights",
        "../../components/shortcuts/release-highlights",
        "./../shortcuts/./release-highlights",
        "../shortcuts/release-highlights.ts",
      ]) {
        expect(importers(from("components/tour/a.ts", spec), isRegistry), spec).toEqual(["components/tour/a.ts"]);
      }
      expect(importers(from("lib/tour-bridge.ts", "../components/shortcuts/release-highlights"), isRegistry)).toEqual(["lib/tour-bridge.ts"]);
      expect(importers(from("components/shortcuts/A.tsx", "./../tour/stops"), isTourDir)).toEqual(["components/shortcuts/A.tsx"]);
      expect(importers(from("components/shortcuts/A.tsx", "../tour"), isTourDir)).toEqual(["components/shortcuts/A.tsx"]);
    });

    it("unrelated imports do not count", () => {
      const src = {
        "components/tour/a.ts": 'import a from "react"; import b from "./stops"; import c from "@/lib/x"; import d from "../shortcuts/shortcut-list";',
      };
      expect(importers(src, isRegistry)).toEqual([]);
      expect(importers(from("components/shortcuts/A.tsx", "../tourist/x"), isTourDir)).toEqual([]);
    });

    it("dynamic import and re-export are also caught", () => {
      expect(importers({ "lib/tour-x.ts": 'const m = import("@/components/shortcuts/release-highlights");' }, isRegistry)).toEqual(["lib/tour-x.ts"]);
      expect(importers({ "lib/tour-x.ts": 'export * from "../components/shortcuts/release-highlights";' }, isRegistry)).toEqual(["lib/tour-x.ts"]);
    });
  });
});

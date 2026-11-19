import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SAFE_FRAME_PADDING,
  SAFE_INSETS,
  SAFE_PAGE_PADDING,
  SAFE_PAGE_PADDING_COMPACT,
} from "@/components/ui/safe-area";

/**
 * Source-level guard: components at the page edge (whole pages, fixed layers pinned to an edge, floating layers pinned to the bottom) must avoid the notch, rounded corners and home indicator.
 * After `viewport-fit=cover` content extends into those areas, and only positions using `env(safe-area-inset-*)` retreat.
 * jsdom can't compute `env()`, so this guards the source text: scan every non-test `.tsx`; any file with an edge-pinned class
 * must either use the constants from `ui/safe-area`, or write `env(safe-area-inset-*)` directly inside the class brackets, or be in the allowlist with a reason it doesn't need it.
 * Limit: it works per file, so two edge-pinned elements in one file with only one handled slip through (the per-file occurrence counts below cover some);
 * the rest relies on each component's class assertions.
 */

/** A line with both `fixed` and an edge-pinned position class (any order), or a full-page-height class. */
function isEdgeLine(line: string): boolean {
  if (/\bfixed\b/.test(line) && /\b(inset|inset-[xy]|top|bottom|left|right)-/.test(line)) return true;
  return /\b(min-)?h-(screen|dvh|svh|lvh)\b/.test(line);
}

/** file -> why it needs no safe-area handling. */
const ALLOWED: Record<string, string> = {
  "components/ui/dialog.tsx": "只有半透明背板（不放內容）與置中的對話框；panel 尺寸的寬度上限已避開左右 safe area",
  "components/tour/TourOverlay.tsx": "貼邊的只有蓋滿視窗的遮罩層（變暗與挖洞，不放內容）；說明卡依目標位置算座標，不貼邊",
};

function listTsx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".tsx") || entry.name.includes(".test.")) continue;
    out.push(`${entry.parentPath}/${entry.name}`.replace(/\\/g, "/"));
  }
  return out;
}

const SRC = `${process.cwd().replace(/\\/g, "/")}/src/`;

function rel(file: string): string {
  return file.slice(file.indexOf("/src/") + 5);
}

const SAFE_CONSTANT = /\bSAFE_(FRAME_PADDING|PAGE_PADDING|PAGE_PADDING_COMPACT|INSETS)\b/;
const SAFE_IMPORT = /from "@\/components\/ui\/safe-area"/;
/** Env written directly inside the class brackets (not counting the literal mentioned in comments). */
const SAFE_ARBITRARY = /\[[^\]\s]*env\(safe-area-inset-/;

function usesSafeArea(source: string): boolean {
  return SAFE_CONSTANT.test(source) || SAFE_IMPORT.test(source) || SAFE_ARBITRARY.test(source);
}

function count(source: string, pattern: RegExp): number {
  return source.match(new RegExp(pattern.source, "g"))?.length ?? 0;
}

describe("safe area source-level guard", () => {
  it("the scan recurses into subdirectories", () => {
    const files = listTsx(SRC).map(rel);
    expect(files).toContain("pages/LoginPage.tsx");
    expect(files).toContain("components/versions/VersionsSheet.tsx");
  });

  it("every constant carries env(safe-area-inset-*) on all four sides", () => {
    for (const value of [SAFE_FRAME_PADDING, SAFE_PAGE_PADDING, SAFE_PAGE_PADDING_COMPACT, SAFE_INSETS]) {
      for (const side of ["top", "right", "bottom", "left"]) {
        expect(value).toContain(`env(safe-area-inset-${side})`);
      }
    }
  });

  it("edge-pinned components all handle safe area (or are in the allowlist)", () => {
    const missing: string[] = [];
    for (const file of listTsx(SRC)) {
      const source = readFileSync(file, "utf8");
      if (!source.split(/\r?\n/).some(isEdgeLine)) continue;
      const name = rel(file);
      if (name in ALLOWED) continue;
      if (!usesSafeArea(source)) missing.push(name);
    }
    expect(missing).toEqual([]);
  });

  it("files in the allowlist still have edge-pinned classes (delete stale entries)", () => {
    for (const name of Object.keys(ALLOWED)) {
      const source = readFileSync(`${SRC}${name}`, "utf8");
      expect(source.split(/\r?\n/).some(isEdgeLine)).toBe(true);
    }
  });

  it("edge detection: any order, covers dvh / svh / lvh", () => {
    expect(isEdgeLine('className="bottom-5 right-5 fixed z-30"')).toBe(true);
    expect(isEdgeLine('className="fixed inset-x-3 z-50"')).toBe(true);
    expect(isEdgeLine('className="min-h-dvh"')).toBe(true);
    expect(isEdgeLine('className="h-svh"')).toBe(true);
    expect(isEdgeLine('className="fixed z-50 flex"')).toBe(false);
  });

  // Named per file: each of these components has its own edge to retreat. Count = the import plus every use; one fewer (e.g. one of the boxes reverting to the old padding) turns it red.
  const REQUIRED: Array<[string, RegExp, number]> = [
    ["components/AppShell.tsx", /\bSAFE_FRAME_PADDING\b/, 2],
    ["components/PublicNoteShell.tsx", /\bSAFE_INSETS\b/, 2],
    ["components/versions/VersionsSheet.tsx", /\bSAFE_INSETS\b/, 2],
    ["present/PresentationShell.tsx", /\bSAFE_INSETS\b/, 2],
    ["components/ui/toast.tsx", /pb-\[max\(1rem,env\(safe-area-inset-bottom\)\)\]/, 1],
    ["components/versions/VersionsLazyBoundary.tsx", /bottom-\[calc\(1\.25rem\+env\(safe-area-inset-bottom\)\)\]/, 1],
    ["components/sidebar/PhoneListFabs.tsx", /bottom-\[calc\(1rem\+env\(safe-area-inset-bottom\)\)\]/, 2],
    ["components/sidebar/PhoneListFabs.tsx", /(left|right)-\[calc\(1rem\+env\(safe-area-inset-(left|right)\)\)\]/, 2],
    ["components/sidebar/phone-bar.ts", /pb-\[calc\(0\.375rem\+env\(safe-area-inset-bottom\)\)\]/, 1],
    ["pages/LoginPage.tsx", /\bSAFE_PAGE_PADDING\b/, 2],
    ["pages/RegisterPage.tsx", /\bSAFE_PAGE_PADDING\b/, 3],
    ["pages/ResetPasswordPage.tsx", /\bSAFE_PAGE_PADDING\b/, 2],
    ["pages/LinkAccountPage.tsx", /\bSAFE_PAGE_PADDING\b/, 2],
    ["pages/ChangePasswordPage.tsx", /\bSAFE_PAGE_PADDING\b/, 2],
    ["pages/AuthorizePage.tsx", /\bSAFE_PAGE_PADDING\b/, 2],
    ["components/ErrorBoundary.tsx", /\bSAFE_PAGE_PADDING\b/, 2],
    ["components/ErrorBoundary.tsx", /\bSAFE_PAGE_PADDING_COMPACT\b/, 2],
    ["auth/guards.tsx", /\bSAFE_PAGE_PADDING\b/, 3],
  ];
  it.each(REQUIRED)("%s: %s appears at least %i times", (name, pattern, min) => {
    expect(count(readFileSync(`${SRC}${name}`, "utf8"), pattern)).toBeGreaterThanOrEqual(min);
  });

  it("viewport meta has viewport-fit=cover", () => {
    const html = readFileSync(`${SRC}../index.html`, "utf8");
    expect(html).toMatch(/<meta name="viewport"[^>]*viewport-fit=cover/);
  });
});

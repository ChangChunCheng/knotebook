import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SHORTCUTS } from "./shortcut-list";

/**
 * Two-way check between list ids and e2e tags.
 *
 * Each entry on the shortcut guide page needs an e2e that runs in a real browser: the test name ends with `[sc:<id>]` (`e2e/tests/*.spec.ts`).
 * This file scans those files' raw text: (1) every `SHORTCUTS` id appears in at least one test title; (2) no orphan tag in a title that the list lacks;
 * (3) the total number of `[sc:` occurrences in each file equals the number in titles (catches tags in comments, template-literal titles, and in `test.skip`/`test.fixme`/describe titles);
 * (4) the number of files scanned is >= 40 (guards a wrong path passing vacuously); (5) no `.skip(`, `.fixme(`, `.only(` (catches `test.describe.skip` wrapping and `test.skip()` inside a body).
 *
 * What it guards is that a tagged e2e exists and runs; it does not guard that the e2e asserts every word of the description - that is checked sentence by sentence against the assertions.
 * It also cannot see conditional registration: a test written in `if (...) test("... [sc:x]")` or a loop is still counted although it would not run when the environment does not match;
 * this guard is only a static text check, so that form has to be caught in review.
 * The tag is recognised only in the first string argument of `test("...")` (a plain string literal); an entry borrowing an existing spec gets the tag appended to those test names.
 */

const E2E_DIR = path.resolve(process.cwd(), "../../e2e/tests");

/** Strips comments (same as i18n/management-copy.test.ts; a `//` preceded by `:` counts as a URL and is not stripped). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const TITLE_RE = /\btest\(\s*(["'])((?:\\.|(?!\1).)*)\1/g;
const TAG_RE = /\[sc:([A-Za-z0-9]+)\]/g;

export interface ScanResult {
  files: string[];
  /** Per file: the tags in titles, and the count of `[sc:` in the whole file */
  perFile: Array<{ file: string; titleTags: string[]; totalOccurrences: number; banned: string[] }>;
}

export function scanE2e(dir: string = E2E_DIR): ScanResult {
  let files: string[];
  try {
    files = readdirSync(dir).filter((n) => n.endsWith(".spec.ts")).sort();
  } catch {
    files = []; // wrong path: let check (4) go red on its assertion (rather than the whole file blowing up during collection)
  }
  const perFile = files.map((file) => {
    const source = stripComments(readFileSync(path.join(dir, file), "utf8"));
    const titleTags: string[] = [];
    for (const m of source.matchAll(TITLE_RE)) for (const t of m[2]!.matchAll(TAG_RE)) titleTags.push(t[1]!);
    return {
      file,
      titleTags,
      totalOccurrences: (source.match(/\[sc:/g) ?? []).length,
      banned: [".skip(", ".fixme(", ".only("].filter((s) => source.includes(s)),
    };
  });
  return { files, perFile };
}

describe("list ids <-> e2e tags", () => {
  const scan = scanE2e();
  const tagged = new Set(scan.perFile.flatMap((f) => f.titleTags));

  it("(4) enough spec files are scanned (guards a wrong path passing vacuously)", () => {
    expect(scan.files.length).toBeGreaterThanOrEqual(40);
  });

  it("(1) every SHORTCUTS id appears in at least one test title", () => {
    const missing = SHORTCUTS.map((e) => e.id).filter((id) => !tagged.has(id));
    expect(missing, `沒有 e2e 標籤的條目：${missing.join(", ")}`).toEqual([]);
  });

  it("(2) no orphan tag in titles that the list lacks", () => {
    const known = new Set(SHORTCUTS.map((e) => e.id));
    const orphans = [...tagged].filter((id) => !known.has(id));
    expect(orphans, `孤兒標籤：${orphans.join(", ")}`).toEqual([]);
  });

  it("(3) in each file the total `[sc:` count equals the count in titles (a tag in a comment, template literal, skip/fixme/describe title makes the total larger)", () => {
    const bad = scan.perFile.filter((f) => f.totalOccurrences !== f.titleTags.length).map((f) => `${f.file}: 全檔 ${f.totalOccurrences}、標題 ${f.titleTags.length}`);
    expect(bad).toEqual([]);
  });

  it("(5) no .skip(, .fixme(, .only(", () => {
    const bad = scan.perFile.filter((f) => f.banned.length > 0).map((f) => `${f.file}: ${f.banned.join(" ")}`);
    expect(bad).toEqual([]);
  });
});

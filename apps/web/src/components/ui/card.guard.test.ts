import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cardSurface } from "./card";

/**
 * Source-level guard (#81): `cardSurface` is where the card look's class literal lives: its callers (AppShell, NoteEditor, NotePage, HomePage, NotePageFallback,
 * ErrorBoundary, ManagementShell, ShortcutsDialog, VersionsPanel, VersionsLazyBoundary) write `cn(cardSurface, "<other classes>")`.
 * Some of them have rendered-class assertions (e.g. `NoteEditor.layout.test.tsx` covers NoteEditor's body card and `NotePage.test.tsx` covers NotePage's
 * placeholder card, two different states rather than two different call sites); the others have no test pinning
 * the rendered output. So this checks not that the rendering is right but that the literal has not been copied back into source.
 *
 * Scan semantics (against the raw source text, comments included, deliberately the opposite of the comment-stripping `theme.*` guards): the literal
 * tends to get copied into a comment first and then back into a real class (`NotePage.tsx` once copied this contiguous literal
 * in a comment; this guard pins it from coming back). Only `.tsx` is scanned: `ui/card.ts` is the intended home of the literal (`.ts` is not
 * scanned, which excludes it naturally), and this file is `.test.ts`, so it is outside the scan set.
 *
 * Honest limits: only verbatim contiguous single-line copies are caught. Comment copies split across lines (e.g.
 * `` `rounded-xl border\n * border-border bg-card` ``) or in a shortened form (e.g.
 * `rounded-xl border bg-card`) are missed; those are left to code review and to rewriting the comments that point at cardSurface
 * when it changes. Also missed: someone removing cardSurface entirely for another look (diff review and visual checks cover that).
 * Also, the `.ts` exemption is by file extension, not just `ui/card.ts`: any other non-test `.ts` file that copies the literal is not scanned either;
 * `ui/card.ts` is merely where the literal is expected, not a special exclusion.
 */

const CARD_SURFACE_LITERAL = "rounded-xl border border-border bg-card";

function listTsxFiles(dir: string): string[] {
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".tsx")) continue;
    if (entry.name.includes(".test.")) continue;
    files.push(`${entry.parentPath}/${entry.name}`.replace(/\\/g, "/"));
  }
  return files;
}

describe("cardSurface source-level guard (#81)", () => {
  it("the constant literal itself is unchanged", () => {
    expect(cardSurface).toBe(CARD_SURFACE_LITERAL);
  });

  it(".tsx files under apps/web/src (excluding .test. files) contain no verbatim copy of the cardSurface literal", () => {
    const root = `${process.cwd()}/src`;
    const tsxFiles = listTsxFiles(root);
    // Pin that the recursion really reaches deep subdirectories: checking only length > 0 is too weak (without `{ recursive: true }` the root still has a few .tsx files and would pass).
    // AiSession.tsx is under components/ai/, so finding it proves the recursion happened rather than only the root being scanned.
    expect(tsxFiles.some((p) => p.replaceAll("\\", "/").endsWith("/components/ai/AiSession.tsx"))).toBe(true);

    const offenders: string[] = [];
    for (const file of tsxFiles) {
      const source = readFileSync(file, "utf8");
      if (source.includes(CARD_SURFACE_LITERAL)) {
        offenders.push(file);
      }
    }

    expect(offenders, `不應在這些檔案裡原樣出現 cardSurface 字面量：${offenders.join(", ")}`).toEqual([]);
  });
});

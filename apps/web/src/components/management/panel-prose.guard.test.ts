import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #247: the explanatory text inside the three management panels is not width-limited - `max-w-prose` (and its partners `text-justify hyphens-auto`)
 * must not appear in the panel content tree. Scans the raw text including comments (like card.guard.test.ts): the wording is often copied into a comment
 * and then back into a class, so when changing a class the related comments must be rewritten too.
 * Scan set: settings/*.tsx, components/management/*.tsx, components/groups/Group*.tsx, components/admin/*.tsx (skipped when absent); *.test.* is always excluded.
 * The note body's `text-align: justify` (index.css, guarded by theme.justify-wordbreak-guard.test.ts) is out of scope.
 */
const SRC = join(process.cwd(), "src");
const SCAN: Array<{ dir: string; match: (name: string) => boolean }> = [
  { dir: "settings", match: (n) => n.endsWith(".tsx") },
  { dir: "components/management", match: (n) => n.endsWith(".tsx") },
  { dir: "components/groups", match: (n) => /^Group.*\.tsx$/.test(n) },
  { dir: "components/admin", match: (n) => n.endsWith(".tsx") },
];

function scannedFiles(): string[] {
  const out: string[] = [];
  for (const { dir, match } of SCAN) {
    const abs = join(SRC, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      if (name.includes(".test.")) continue;
      if (match(name)) out.push(`${dir}/${name}`);
    }
  }
  return out;
}

describe("panel content must not contain max-w-prose (#247)", () => {
  it("the scan set really reaches each directory (guards against a wrong path passing vacuously)", () => {
    const files = scannedFiles();
    expect(files).toContain("settings/SettingsLayout.tsx");
    expect(files).toContain("settings/AutoVersionsSwitch.tsx");
    expect(files).toContain("components/management/ManagementShell.tsx");
    expect(files).toContain("components/groups/GroupMenu.tsx");
    expect(files).toContain("components/admin/AdminModal.tsx");
  });

  it("no file contains max-w-prose (including comments)", () => {
    const offenders = scannedFiles().filter((f) => readFileSync(join(SRC, f), "utf8").includes("max-w-prose"));
    expect(offenders).toEqual([]);
  });

  it("no file contains text-justify (justified text is removed along with the width limit)", () => {
    const offenders = scannedFiles().filter((f) => readFileSync(join(SRC, f), "utf8").includes("text-justify"));
    expect(offenders).toEqual([]);
  });
});

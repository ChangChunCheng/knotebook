import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { stripComments } from "./strip-comments.test-helper";

/**
 * Source-level guard: `brandSolid` / `brandDeep` are the two tiers of the filled brand-color button (see the `ui/button.tsx` convention):
 * choose by surface, never mix. `brandSolid` is for the single primary action at page level (sign-in, authorization consent, the main way out of a
 * full-page error); `brandDeep` is for the single primary action inside a modal/panel. The two tiers are designed never to appear on one screen,
 * but that invariant otherwise rests on code review alone: nothing stops someone from using `brandSolid` in yet another file and
 * putting two kinds of filled brand block on one screen.
 *
 * This pins the seven currently legitimate call sites mechanically; an eighth fails here first, so the author must reconsider whether the screen is
 * page-level or modal/panel-internal instead of silently stacking on.
 * (#187 added `pages/LinkAccountPage.tsx`: a full page at the same level as sign-in, where "confirm with password and link" is the page's primary action;
 * the SSO proof and cancel are outline, see `LinkAccountPage.test.tsx`.
 * #187 added `pages/RegisterPage.tsx`: a full page at the sign-in level whose primary action is "create account".
 * #286 added `pages/ResetPasswordPage.tsx`: a signed-out full page at the sign-in level whose form's primary action is "Set password"
 * (see `ResetPasswordPage.test.tsx`).)
 *
 * Scanning strips comments on purpose (same convention as the `theme.*` series, the opposite of `card.guard.test.ts` which includes comments):
 * the name `brandSolid` is often used in comments elsewhere to explain the difference between the tiers (e.g. `SettingsAccountSection.tsx` explains that
 * `ChangePasswordForm` uses `brandSolid` on the full `/change-password` page); that is documentation, not a second call site, so stripping comments
 * avoids flagging it. What matters is code like `variant="brandSolid"` / `variant={... "brandSolid" ...}` that actually renders a filled brand button.
 *
 * `ui/button.tsx` itself (where the variant is defined) and `.test.` files are excluded from the scan: they are the definition and tests,
 * not call sites that render a brandSolid button.
 */

const ALLOWED_FILES = [
  "auth/ChangePasswordForm.tsx",
  "auth/guards.tsx",
  "pages/AuthorizePage.tsx",
  "pages/LinkAccountPage.tsx",
  "pages/LoginPage.tsx",
  "pages/RegisterPage.tsx",
  "pages/ResetPasswordPage.tsx",
];

function listTsxFiles(dir: string): string[] {
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".tsx")) continue;
    if (entry.name.includes(".test.")) continue;
    const full = `${entry.parentPath}/${entry.name}`.replace(/\\/g, "/");
    if (full.endsWith("/components/ui/button.tsx")) continue; // the definition, not a call site
    files.push(full);
  }
  return files;
}

describe("brandSolid call-site scope guard", () => {
  it("brandSolid (comments stripped) appears only in the seven known page-level call sites", () => {
    const root = `${process.cwd()}/src`;
    const tsxFiles = listTsxFiles(root);
    // Pin that the recursion really reached deep subdirectories (same approach as card.guard.test.ts).
    expect(tsxFiles.some((p) => p.endsWith("/auth/guards.tsx"))).toBe(true);

    const offenders = tsxFiles
      .filter((file) => /\bbrandSolid\b/.test(stripComments(readFileSync(file, "utf8"), file)))
      .map((file) => file.slice(root.length + 1));

    expect(offenders.sort()).toEqual([...ALLOWED_FILES].sort());
  });
});

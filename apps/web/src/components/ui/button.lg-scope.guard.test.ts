import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buttonVariants } from "./button";
import { stripComments } from "./strip-comments.test-helper";

/**
 * Source-level guard: `Button`'s `size="lg"` (h-11, 44px) is the second exception to the site-wide "default height 32px" rule,
 * allowed only on the same kind of card page (sign-in, sign-up, password reset, account linking, forced password change, OAuth consent; reason in the `ui/button.tsx` convention).
 * This pins the legitimate call sites mechanically: any other file using `lg` fails first, forcing the author to revisit the convention and this list
 * instead of letting 44px spread silently.
 *
 * Two scans, same semantics as `button.brand-scope.guard.test.ts` (strip comments, exclude `.test.` files and the definition `ui/button.tsx`):
 * 1. direct forms: `size="lg"`, `size={"lg"}`, `size: "lg"` (`buttonVariants({ size: "lg" })`);
 * 2. any `"lg"` / `'lg'` / `` `lg` `` string literal, which catches indirect forms that bypass the first scan such as `size={x ? "lg" : "default"}`,
 *    `const S = "lg"; <Button size={S}>`.
 */

const ALLOWED_FILES = [
  "pages/AuthorizePage.tsx",
  "pages/ChangePasswordPage.tsx",
  "pages/LinkAccountPage.tsx",
  "pages/LoginPage.tsx",
  "pages/RegisterPage.tsx",
  "pages/ResetPasswordPage.tsx",
];
// ChangePasswordForm writes "lg" only through a tone conditional (32px inside panels), so only the literal scan matches it.
const LITERAL_FILES = [...ALLOWED_FILES, "auth/ChangePasswordForm.tsx"];

const LG_SIZE = /\bsize\s*[=:]\s*\{?\s*["'`]lg["'`]/;
const LG_LITERAL = /["'`]lg["'`]/;

function listTsxFiles(dir: string): string[] {
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (entry.name.includes(".test.")) continue;
    const full = `${entry.parentPath}/${entry.name}`.replace(/\\/g, "/");
    if (full.endsWith("/components/ui/button.tsx")) continue; // the definition, not a call site
    files.push(full);
  }
  return files;
}

describe("Button size=lg call-site scope guard (the card-page exception)", () => {
  it("lg is 44px (h-11)", () => {
    expect(buttonVariants({ size: "lg" })).toContain("h-11");
  });

  it("the detector matches the various spellings and lets other sizes through", () => {
    expect(LG_SIZE.test(`<Button size="lg">`)).toBe(true);
    expect(LG_SIZE.test(`<Button size={"lg"}>`)).toBe(true);
    expect(LG_SIZE.test(`buttonVariants({ size: "lg" })`)).toBe(true);
    expect(LG_SIZE.test(`<Button size="sm">`)).toBe(false);
    expect(LG_SIZE.test(`<Button size="icon">`)).toBe(false);
  });

  it("the second detector matches indirect spellings and lets other strings through", () => {
    expect(LG_LITERAL.test(`size={x ? "lg" : "default"}`)).toBe(true);
    expect(LG_LITERAL.test(`const S = 'lg';`)).toBe(true);
    expect(LG_LITERAL.test("const S = `lg`;")).toBe(true);
    expect(LG_LITERAL.test(`className="lg:flex"`)).toBe(false);
    expect(LG_LITERAL.test(`size="sm"`)).toBe(false);
  });

  it("size=lg (comments stripped) appears only on the card pages", () => {
    const root = `${process.cwd()}/src`;
    const files = listTsxFiles(root);
    expect(files.some((p) => p.endsWith("/auth/guards.tsx"))).toBe(true); // the recursion really reached subdirectories

    const offenders = files
      .filter((file) => LG_SIZE.test(stripComments(readFileSync(file, "utf8"), file)))
      .map((file) => file.slice(root.length + 1));

    expect(offenders.sort()).toEqual([...ALLOWED_FILES].sort());
  });

  it("any \"lg\" string literal (comments stripped) also appears only in the allow list", () => {
    const root = `${process.cwd()}/src`;
    const offenders = listTsxFiles(root)
      .filter((file) => LG_LITERAL.test(stripComments(readFileSync(file, "utf8"), file)))
      .map((file) => file.slice(root.length + 1));

    expect(offenders.sort(), '"lg" 字串只准給 Button 的 size 用在同款卡片頁；別的元件要用 lg 名稱請改名，或更新 button.tsx 規範與本守衛的允許清單').toEqual([...LITERAL_FILES].sort());
  });
});

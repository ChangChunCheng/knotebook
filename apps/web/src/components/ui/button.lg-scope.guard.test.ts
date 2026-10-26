import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buttonVariants } from "./button";
import { stripComments } from "./strip-comments.test-helper";

/**
 * 來源層守衛：`Button` 的 `size="lg"`（h-11，44px）是全站「預設高度 32px」規則的例外二，
 * **只准用在同款卡片頁**（登入、註冊、重設密碼、連結帳號、強制改密、OAuth 授權；理由見 `ui/button.tsx` 規範）。
 * 這裡機械釘住唯一合法的呼叫端；別的檔案一用 `lg` 就先紅，逼寫的人回頭改規範與這份清單，
 * 而不是讓 44px 靜默外擴。
 *
 * 兩道掃描，語意比照 `button.brand-scope.guard.test.ts`（剝註解、排除 `.test.` 檔與定義處 `ui/button.tsx`）：
 * 1. `size="lg"`、`size={"lg"}`、`size: "lg"`（`buttonVariants({ size: "lg" })`）這類直接寫法；
 * 2. 任何 `"lg"`／`'lg'`／`` `lg` `` 字串字面——擋住 `size={x ? "lg" : "default"}`、
 *    `const S = "lg"; <Button size={S}>` 這類繞過第 1 道的間接寫法。
 */

// LG_SIZE（正向）：這些頁直接寫了 size="lg"。
const ALLOWED_FILES = [
  "pages/AuthorizePage.tsx",
  "pages/ChangePasswordPage.tsx",
  "pages/LinkAccountPage.tsx",
  "pages/LoginPage.tsx",
  "pages/RegisterPage.tsx",
  "pages/ResetPasswordPage.tsx",
];
// LG_LITERAL（反向）：再加上以 tone 條件式寫 "lg" 的共用表單（面板內仍是 32px）。
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
    if (full.endsWith("/components/ui/button.tsx")) continue; // 定義處，不是呼叫端
    files.push(full);
  }
  return files;
}

describe("Button size=lg 呼叫端範圍守衛（同款卡片頁例外）", () => {
  it("lg 是 44px（h-11）", () => {
    expect(buttonVariants({ size: "lg" })).toContain("h-11");
  });

  it("偵測式本身抓得到各種寫法、放過其他 size", () => {
    expect(LG_SIZE.test(`<Button size="lg">`)).toBe(true);
    expect(LG_SIZE.test(`<Button size={"lg"}>`)).toBe(true);
    expect(LG_SIZE.test(`buttonVariants({ size: "lg" })`)).toBe(true);
    expect(LG_SIZE.test(`<Button size="sm">`)).toBe(false);
    expect(LG_SIZE.test(`<Button size="icon">`)).toBe(false);
  });

  it("偵測式 2 抓得到間接寫法、放過其他字串", () => {
    expect(LG_LITERAL.test(`size={x ? "lg" : "default"}`)).toBe(true);
    expect(LG_LITERAL.test(`const S = 'lg';`)).toBe(true);
    expect(LG_LITERAL.test("const S = `lg`;")).toBe(true);
    expect(LG_LITERAL.test(`className="lg:flex"`)).toBe(false);
    expect(LG_LITERAL.test(`size="sm"`)).toBe(false);
  });

  it("size=lg（剝註解後）只出現在同款卡片頁", () => {
    const root = `${process.cwd()}/src`;
    const files = listTsxFiles(root);
    expect(files.some((p) => p.endsWith("/auth/guards.tsx"))).toBe(true); // 遞迴確實走到子目錄

    const offenders = files
      .filter((file) => LG_SIZE.test(stripComments(readFileSync(file, "utf8"))))
      .map((file) => file.slice(root.length + 1));

    expect(offenders.sort()).toEqual([...ALLOWED_FILES].sort());
  });

  it("任何 \"lg\" 字串字面（剝註解後）也只出現在允許清單", () => {
    const root = `${process.cwd()}/src`;
    const offenders = listTsxFiles(root)
      .filter((file) => LG_LITERAL.test(stripComments(readFileSync(file, "utf8"))))
      .map((file) => file.slice(root.length + 1));

    expect(offenders.sort(), '"lg" 字串只准給 Button 的 size 用在同款卡片頁；別的元件要用 lg 名稱請改名，或更新 button.tsx 規範與本守衛的允許清單').toEqual([...LITERAL_FILES].sort());
  });
});

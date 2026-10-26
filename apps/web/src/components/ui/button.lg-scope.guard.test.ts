import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buttonVariants } from "./button";

/**
 * 來源層守衛：`Button` 的 `size="lg"`（h-11，44px）是全站「高度只有 32px」規則的第二個例外，
 * **只准用在登入頁**（理由見 `ui/button.tsx` 規範）。這裡機械釘住唯一合法的呼叫端；
 * 別的檔案一用 `lg` 就先紅，逼寫的人回頭改規範與這份清單，而不是讓 44px 靜默外擴。
 *
 * 掃描語意比照 `button.brand-scope.guard.test.ts`：剝註解（註解裡解釋 `lg` 是文件不是呼叫端）、
 * 排除 `.test.` 檔與定義處 `ui/button.tsx`。抓的寫法：`size="lg"`、`size={"lg"}`、
 * `size: "lg"`（`buttonVariants({ size: "lg" })`）。
 */

const ALLOWED_FILES = ["pages/LoginPage.tsx"];

const LG_SIZE = /\bsize\s*[=:]\s*\{?\s*["'`]lg["'`]/;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

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

describe("Button size=lg 呼叫端範圍守衛（登入頁例外）", () => {
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

  it("size=lg（剝註解後）只出現在登入頁", () => {
    const root = `${process.cwd()}/src`;
    const files = listTsxFiles(root);
    expect(files.some((p) => p.endsWith("/auth/guards.tsx"))).toBe(true); // 遞迴確實走到子目錄

    const offenders = files
      .filter((file) => LG_SIZE.test(stripComments(readFileSync(file, "utf8"))))
      .map((file) => file.slice(root.length + 1));

    expect(offenders.sort()).toEqual([...ALLOWED_FILES].sort());
  });
});

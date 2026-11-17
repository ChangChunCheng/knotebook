import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { stripComments } from "./strip-comments.test-helper";

const root = `${process.cwd()}/src`;
const SHARED = "components/ui/select.tsx";

/** src 下非測試的 .ts／.tsx（排除 *.test.*、src/test/）。 */
function sourceFiles(dir = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(`${root}/${dir}`)) {
    const rel = dir ? `${dir}/${name}` : name;
    if (statSync(`${root}/${rel}`).isDirectory()) {
      if (rel === "test") continue;
      out.push(...sourceFiles(rel));
    } else if (/\.tsx?$/.test(name) && !name.includes(".test.") && !name.includes(".test-helper.")) out.push(rel);
  }
  return out;
}

/** 去掉註解後在整份檔案文字上找 pattern（可跨行），回傳每個命中起點的 `path:line`。 */
function hits(pattern: RegExp, skip: string[] = []): string[] {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const out: string[] = [];
  for (const path of sourceFiles()) {
    if (skip.includes(path)) continue;
    const text = stripComments(readFileSync(`${root}/${path}`, "utf8").replace(/\r\n/g, "\n"), path);
    for (const m of text.matchAll(re)) out.push(`${path}:${text.slice(0, m.index).split("\n").length}`);
  }
  return out;
}

/** 從 radix-ui 匯入 Select（別名或不別名、單行或多行、import type）。 */
const RADIX_SELECT_IMPORT = /import\s*(?:type\s*)?\{[^}]*\bSelect\b[^}]*\}\s*from\s*["']radix-ui["']/;

describe("共用 Select 守衛（#287）", () => {
  it("src 內沒有原生 <select（程式碼區塊語言下拉是 BlockNote 內建，不在原始碼裡）", () => {
    expect(hits(/<select\b|createElement\(\s*["']select["']/)).toEqual([]);
  });

  it("src 內沒有各檔自訂的 SELECT_CLASS", () => {
    expect(hits(/\bSELECT_CLASS\b/)).toEqual([]);
  });

  it("ui/select.tsx 是唯一 import radix-ui 的 Select 的檔案", () => {
    const either = new RegExp(`${RADIX_SELECT_IMPORT.source}|["']@radix-ui/react-select["']`);
    expect(hits(either, [SHARED])).toEqual([]);
  });
});

import { render } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { Input } from "./input";

/**
 * 觸控裝置上輸入欄位字級 16px（iOS Safari 聚焦字級小於 16px 的欄位會把整頁放大）。
 * jsdom 不套 CSS，這裡守來源的 class 字面；真正的 computed font-size 在瀏覽器量。
 */

const TOKEN = "pointer-coarse:text-base";
const root = `${process.cwd()}/src`;

function tokens(value: string): Set<string> {
  return new Set(value.split(/\s+/).filter(Boolean));
}

function sourceFiles(dir = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(`${root}/${dir}`)) {
    const rel = dir ? `${dir}/${name}` : name;
    if (statSync(`${root}/${rel}`).isDirectory()) out.push(...sourceFiles(rel));
    else if (name.endsWith(".tsx") && !name.includes(".test.")) out.push(rel);
  }
  return out;
}

/** 剝掉區塊註解與行尾 `//` 註解，避免註解裡的字面干擾。 */
function code(path: string): string {
  return readFileSync(`${root}/${path}`, "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** 從開頭 `<` 往後走到標籤結尾 `>`（略過字串與 `{}` 內的 `=>`）。 */
function tagEnd(source: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote && source[i - 1] !== "\\") quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0 && source[i - 1] !== "=") return i;
  }
  return source.length;
}

/** 字串常值（雙引號、單引號）裡的 class token。 */
function literalTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"([^"]*)"|'([^']*)'/g)) out.push(...(m[1] ?? m[2] ?? "").split(/\s+/).filter(Boolean));
  return out;
}

/**
 * 標籤 className 的 class token：只看 className 的值（字串常值、`{...}` 裡的字串常值，以及它引用的同檔 const 的字串常值），
 * 不看別的屬性。比對時整個 token 要完全相等，`sm:text-base`、`placeholder:text-lg`、`data-x="…"` 都不算。
 */
function classTokens(tag: string, source: string): string[] {
  const at = tag.indexOf("className=");
  if (at < 0) return [];
  const start = at + "className=".length;
  let expr: string;
  if (tag[start] === '"') {
    expr = tag.slice(start, tag.indexOf('"', start + 1) + 1);
  } else {
    let depth = 0;
    let end = start;
    for (; end < tag.length; end++) {
      if (tag[end] === "{") depth++;
      else if (tag[end] === "}" && --depth === 0) break;
    }
    expr = tag.slice(start, end + 1);
  }
  const out = literalTokens(expr);
  for (const id of expr.replace(/"[^"]*"|'[^']*'/g, "").matchAll(/\b[A-Za-z_]\w*\b/g)) {
    const def = new RegExp(String.raw`const ${id[0]}\s*=([\s\S]*?);\n`).exec(source);
    if (def) out.push(...literalTokens(def[1]));
  }
  return out;
}

describe("輸入欄位基底", () => {
  it("Input：觸控 16px；呼叫端寫死的 text-[13px] 不會把它吃掉（twMerge 不合併不同 variant）", () => {
    const { container } = render(<Input className="h-8 text-[13px]" />);
    const set = tokens(container.querySelector("input")!.className);
    expect(set.has(TOKEN)).toBe(true);
    expect(set.has("text-[13px]")).toBe(true);
  });
});

describe("程式碼區塊語言下拉（BlockNote 內建原生 select）", () => {
  it("index.css：觸控時字級 16px，選擇器與上一條 12px 規則一致、未分層", () => {
    const css = readFileSync(`${root}/index.css`, "utf8").replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "");
    const selector = ".bn-editor .bn-block-content[data-content-type=codeBlock] > div > select";
    const blocks = css.match(/@media \(pointer: coarse\)\s*\{(?:[^{}]|\{[^{}]*\})*\}/g) ?? [];
    const rule = blocks.find((block) => block.includes(selector));
    expect(rule, "沒有 pointer: coarse 區塊處理語言下拉").toBeDefined();
    expect(rule).toMatch(/font-size:\s*var\(--text-base\)/);
    // 要排在 12px 那條規則之後（同 specificity，後者勝）。
    expect(css.indexOf(rule!)).toBeGreaterThan(css.indexOf(`${selector} {`));
  });
});

describe("原生 input／select／textarea 都有觸控 16px", () => {
  // 不吃字級的 input 型別。
  const NON_TEXT = /type="(?:checkbox|radio|range|file|hidden)"/;
  // 已經大於等於 16px 的字級，不需要觸控另設。
  const BIG = /^text-(?:base|lg|xl|\d?xl)$/;

  it("每個原生欄位的 class（含同檔 const 引用）帶 pointer-coarse:text-base，或本來就 ≥ 16px", () => {
    const missing: string[] = [];
    for (const path of sourceFiles()) {
      if (path === "components/ui/input.tsx") continue;
      const source = code(path);
      for (const match of source.matchAll(/<(input|select|textarea)\b/g)) {
        const start = match.index!;
        const tag = source.slice(start, tagEnd(source, start + match[0].length) + 1);
        if (NON_TEXT.test(tag)) continue;
        const found = classTokens(tag, source);
        const ok = found.some((token) => token === TOKEN || BIG.test(token));
        if (!ok) missing.push(`${path}:${source.slice(0, start).split("\n").length}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

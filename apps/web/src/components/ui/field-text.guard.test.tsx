import { render } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { Input } from "./input";

/**
 * Input fields use 16px text on touch devices (iOS Safari zooms the whole page when focusing a field smaller than 16px).
 * jsdom applies no CSS, so this guards the class literals in source; the real computed font-size must be measured in a browser.
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

/** Strip block comments and trailing `//` comments so literals in comments do not interfere. */
function code(path: string): string {
  return readFileSync(`${root}/${path}`, "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** From the opening `<` to the tag closing `>` (skipping strings and `=>` inside `{}`). */
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

function literalTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"([^"]*)"|'([^']*)'/g)) out.push(...(m[1] ?? m[2] ?? "").split(/\s+/).filter(Boolean));
  return out;
}

/**
 * A tag's className class tokens: only the className value is read (string literals, string literals inside `{...}`, and string literals of same-file consts it references),
 * not other attributes. A token must match exactly: `sm:text-base`, `placeholder:text-lg` and `data-x="..."` do not count.
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

describe("input field base", () => {
  it("Input: 16px on touch; a caller's hard-coded text-[13px] does not swallow it (twMerge does not merge different variants)", () => {
    const { container } = render(<Input className="h-8 text-[13px]" />);
    const set = tokens(container.querySelector("input")!.className);
    expect(set.has(TOKEN)).toBe(true);
    expect(set.has("text-[13px]")).toBe(true);
  });
});

describe("code block language dropdown (BlockNote's built-in native select)", () => {
  it("index.css: 16px text on touch, with the same selector as the preceding 12px rule and not layered", () => {
    const css = readFileSync(`${root}/index.css`, "utf8").replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "");
    const selector = ".bn-editor .bn-block-content[data-content-type=codeBlock] > div > select";
    const blocks = css.match(/@media \(pointer: coarse\)\s*\{(?:[^{}]|\{[^{}]*\})*\}/g) ?? [];
    const rule = blocks.find((block) => block.includes(selector));
    expect(rule, "沒有 pointer: coarse 區塊處理語言下拉").toBeDefined();
    expect(rule).toMatch(/font-size:\s*var\(--text-base\)/);
    // It must come after the 12px rule (same specificity, the later one wins).
    expect(css.indexOf(rule!)).toBeGreaterThan(css.indexOf(`${selector} {`));
  });
});

describe("native input / select / textarea all have 16px on touch", () => {
  const NON_TEXT = /type="(?:checkbox|radio|range|file|hidden)"/;
  const BIG = /^text-(?:base|lg|xl|\d?xl)$/;

  it("every native field's classes (including same-file const references) carry pointer-coarse:text-base or are already >= 16px", () => {
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

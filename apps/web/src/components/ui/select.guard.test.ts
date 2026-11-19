import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { stripComments } from "./strip-comments.test-helper";

const root = `${process.cwd()}/src`;
const SHARED = "components/ui/select.tsx";

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

const RADIX_SELECT_IMPORT = /import\s*(?:type\s*)?\{[^}]*\bSelect\b[^}]*\}\s*from\s*["']radix-ui["']/;

describe("shared Select guard (#287)", () => {
  it("src contains no native <select (the code block language dropdown is BlockNote's built-in, not in our source)", () => {
    expect(hits(/<select\b|createElement\(\s*["']select["']/)).toEqual([]);
  });

  it("src has no per-file custom SELECT_CLASS", () => {
    expect(hits(/\bSELECT_CLASS\b/)).toEqual([]);
  });

  it("ui/select.tsx is the only file importing Select from radix-ui", () => {
    const either = new RegExp(`${RADIX_SELECT_IMPORT.source}|["']@radix-ui/react-select["']`);
    expect(hits(either, [SHARED])).toEqual([]);
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Source-level guard: removals/replacements that web source code triggers always go through `collab/columns/keep-columns.ts`. Core's `removeBlocks`/`replaceBlocks` collapse columns and flatten a row left with one column; if they were used again, jsdom tests would only turn red in cases that have columns, and a newly added call site has no such case, so reading the source is what blocks it.
 *
 * Scan semantics: all `.ts`/`.tsx` under `src`, excluding `*.test.*` and any `test/` directory (tests may build content with core methods), allowing only the one file `collab/columns/keep-columns.ts`. It matches the literal `.removeBlocks(` / `.replaceBlocks(`, and mentions inside comments count too. Not covered: destructuring (`const { removeBlocks } = editor`) or `editor["removeBlocks"](...)`; only single-line literals are matched, so forms with a line break or a space (`.removeBlocks` and `(` on separate lines, `.removeBlocks (`) aren't caught either.
 */

const root = `${process.cwd()}/src`;
const ALLOWED = new Set(["collab/columns/keep-columns.ts"]);

function sourceFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === "test") continue;
      out.push(...sourceFiles(`${dir}/${entry.name}`, path));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

const scanned = sourceFiles(root).filter((path) => !ALLOWED.has(path));

describe("source guard: removals/replacements go through keep-columns", () => {
  it("apart from keep-columns.ts, web source contains no `.removeBlocks(` / `.replaceBlocks(`", () => {
    const hits = scanned.flatMap((path) => {
      const lines = readFileSync(`${root}/${path}`, "utf8").split(/\r?\n/);
      return lines.flatMap((line, i) => (line.includes(".removeBlocks(") || line.includes(".replaceBlocks(") ? [`${path}:${i + 1}: ${line.trim()}`] : []));
    });
    expect(hits).toEqual([]);
  });

  it("key files are within the scan range (the allow-list hasn't swallowed them)", () => {
    for (const path of [
      "ai/apply.ts",
      "collab/mermaid-paste.ts",
      "collab/paste.ts",
      "uploads/upload-file.ts",
      "components/ai/AiToolbar.tsx",
      "components/editor/KnotebookFileDeleteButton.tsx",
      "components/editor/KnotebookSideMenu.tsx",
    ]) {
      expect(scanned).toContain(path);
    }
  });

  it("the side menu no longer uses core's delete item", () => {
    const source = readFileSync(`${root}/components/editor/KnotebookSideMenu.tsx`, "utf8");
    expect(source.match(/(?<![A-Za-z])RemoveBlockItem\b/g) ?? []).toHaveLength(0);
  });

  it("more than 50 files scanned (guards against an empty scan)", () => {
    expect(scanned.length).toBeGreaterThan(50);
  });
});

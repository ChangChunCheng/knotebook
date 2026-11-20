import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// `lib/tour-bridge.ts` is in the first bundle (AppShell and NoteEditor both import it). Following its runtime imports must not reach
// the editor packages: once tiptap or ProseMirror come in, the first bundle gains the whole editor chain. The entry limit in
// `scripts/check-bundle-size.mjs` catches the result; this catches the cause, and needs no build. `import type` disappears at compile time and does not count.

const SRC = `${process.cwd().replace(/\\/g, "/")}/src`;
const EDITOR_PACKAGES = /^(@tiptap\/|prosemirror-|y-prosemirror|@blocknote\/)/;

function runtimeSpecifiers(code: string): string[] {
  const out: string[] = [];
  const re = /^\s*(import|export)\s+(?!type\s)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm;
  for (const m of code.matchAll(re)) out.push(m[2]!);
  for (const m of code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]!);
  return out;
}

function resolveLocal(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = `${SRC}/${spec.slice(2)}`;
  else if (spec.startsWith(".")) base = new URL(spec, `file:///${fromFile}`).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  throw new Error(`resolve failed: ${spec} from ${fromFile}`);
}

function closure(entry: string): { files: string[]; packages: string[] } {
  const files: string[] = [];
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (files.includes(file)) continue;
    files.push(file);
    for (const spec of runtimeSpecifiers(readFileSync(file, "utf8"))) {
      const local = resolveLocal(spec, file);
      if (local === null) packages.add(spec);
      else queue.push(local);
    }
  }
  return { files: files.map((f) => f.slice(SRC.length + 1)), packages: [...packages] };
}

describe("tour-bridge stays in the first bundle without pulling in editor packages", () => {
  const { files, packages } = closure(`${SRC}/lib/tour-bridge.ts`);

  it("reaches the switch module (guards against a broken regex or path silently passing)", () => {
    expect(files).toContain("lib/tour-bridge.ts");
    expect(files).toContain("collab/tour-filter-flag.ts");
  });

  it("packages imported at runtime contain no tiptap, ProseMirror, y-prosemirror or BlockNote, and the walk does not reach the filter plugin itself", () => {
    expect(packages.filter((p) => EDITOR_PACKAGES.test(p))).toEqual([]);
    expect(files).not.toContain("collab/tour-transaction-filter.ts");
  });

  it("contrast: the same walk starting from the filter plugin itself sees tiptap (proves the detection works)", () => {
    expect(closure(`${SRC}/collab/tour-transaction-filter.ts`).packages).toContain("@tiptap/core");
  });
});

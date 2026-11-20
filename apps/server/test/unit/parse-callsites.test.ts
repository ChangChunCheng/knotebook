/**
 * #398 structure guard: the server's markdown write parsing always goes through `EditingRuntime.parser` (in production, the worker pool). In `src/`, only the file that defines
 * `parseMarkdownForNote`, `trailingOpenFenceLine` or `tryParseHTMLToBlocks` and the parse core may **mention** them (import, aliased import, namespace access, call: after stripping comments any appearance of the name counts);
 * a new write path that parses on the main thread itself turns this red (checking only calls would miss `import { x as y }`).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));
/** Files in which the name appears after stripping comments (`//` to end of line and block comments). */
const mentioning = (name: string) => {
  const re = new RegExp(`\\b${name}\\b`);
  return files(src)
    .filter(f => re.test(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")))
    .map(f => path.relative(src, f).replaceAll("\\", "/"))
    .sort();
};

describe("parse call sites (#398)", () => {
  it("parseMarkdownForNote appears only in markdown.ts (its definition) and parse-core.ts", () => {
    expect(mentioning("parseMarkdownForNote")).toEqual(["notes/editing/markdown.ts", "notes/editing/parse-core.ts"]);
  });
  it("trailingOpenFenceLine (the unclosed-fence check of batch write-back; a whole-file markdownToHTML is very slow on large repetitive input) appears only in transfer/regions.ts (the definition) and parse-core.ts", () => {
    expect(mentioning("trailingOpenFenceLine")).toEqual(["notes/editing/parse-core.ts", "transfer/regions.ts"]);
  });
  it("tryParseHTMLToBlocks appears only in markdown.ts (inside parseMarkdownForNote)", () => {
    expect(mentioning("tryParseHTMLToBlocks")).toEqual(["notes/editing/markdown.ts"]);
  });
});

/**
 * After the read-out and apply conversions moved off the main thread (`doc-jobs.ts`): the Y document <-> BlockNote/markdown conversion functions may only be called through `executeDocOp`
 * (in a worker, or on the main thread when `EditingRuntime.runDoc` judges the input small). A new path converting on the main thread itself turns this red.
 * Exceptions (documented in known-limitations): applying a version (`apply-version.ts` through `apply.ts`'s `prepareEdit` -> `editOnFork`) and the one-time link conversion after an upgrade (`link-conversion.ts` mounts by itself).
 */
describe("call sites of conversions (read-out and apply moved off the main thread)", () => {
  it("readNoteContentFromDoc: the defining read.ts and doc-jobs.ts", () => {
    expect(mentioning("readNoteContentFromDoc")).toEqual(["notes/editing/doc-jobs.ts", "notes/editing/read.ts"]);
  });
  it("exportNoteForTransfer/exportNoteBody: the defining export-note.ts and doc-jobs.ts", () => {
    expect(mentioning("exportNoteForTransfer")).toEqual(["notes/editing/doc-jobs.ts", "transfer/export-note.ts"]);
    expect(mentioning("exportNoteBody")).toEqual(["notes/editing/doc-jobs.ts", "transfer/export-note.ts"]);
  });
  it("planSync/applySync: the defining file and doc-jobs.ts", () => {
    expect(mentioning("planSync")).toEqual(["notes/editing/doc-jobs.ts", "transfer/sync-plan.ts"]);
    expect(mentioning("applySync")).toEqual(["notes/editing/doc-jobs.ts", "transfer/sync-apply.ts"]);
  });
  it("prepareRevertOnFork: the defining revert-core.ts and doc-jobs.ts; editOnFork: doc-jobs.ts and apply.ts, used by apply-version (prepareEdit)", () => {
    expect(mentioning("prepareRevertOnFork")).toEqual(["notes/editing/doc-jobs.ts", "notes/editing/revert-core.ts"]);
    expect(mentioning("editOnFork")).toEqual(["notes/editing/apply.ts", "notes/editing/doc-jobs.ts"]);
    expect(mentioning("prepareEdit")).toEqual(["notes/editing/apply-version.ts", "notes/editing/apply.ts"]);
  });
  it("EditorSession.open or withForkEditor (mount): the ones doc-jobs.ts calls, plus the link conversion", () => {
    const re = /EditorSession\.open\(|withForkEditor\(/;
    const hits = files(src)
      .filter(f => re.test(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")))
      .map(f => path.relative(src, f).replaceAll("\\", "/"))
      .sort();
    expect(hits).toEqual(["notes/editing/doc-jobs.ts", "notes/editing/read.ts", "notes/editing/revert-core.ts", "notes/editing/session.ts", "notes/link-conversion.ts", "transfer/export-note.ts", "transfer/sync-apply.ts", "transfer/sync-plan.ts"]);
  });
});

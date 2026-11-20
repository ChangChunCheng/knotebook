/**
 * #285: `must_change_password` has no writer: the server source (comments stripped) must not contain a way of setting it to true.
 * Registration, accepting an invitation, OIDC auto-created accounts and env bootstrap all use false; only accounts created by an older version that haven't changed their password carry true.
 * The consumers that remain (`ChangePasswordGate`, clearing the flag when the password changes, etc.) are not scanned here.
 * Caught: the drizzle column `mustChangePassword: true` (the key may be quoted), `mustChangePassword: sql`true`` (case-insensitive), the bare SQL literal `must_change_password = true`.
 * Not caught: indirection through a variable (`const v = true`), raw SQL INSERT column lists or other UPDATE forms, string concatenation;
 * false positives: `where must_change_password = true` in read-only queries, `mustChangePassword: true` in response DTOs/TS types, string literals. Review covers the rest; exhaustive detection isn't a goal.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

// walk/code have the same shape as in tx-nested-pool-borrow-structure.test.ts (copied; that file doesn't export them).
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith(".ts") ? [p] : [];
  });
}
function code(p: string): string {
  return readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const WRITERS = [/["']?mustChangePassword["']?\s*:\s*(true\b|sql`\s*true\s*`)/i, /must_change_password\s*=\s*true/i];

describe("must_change_password has no writer", () => {
  it("no file under src writes it as true", () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(50); // walk really reached something
    const hits = files.filter(p => WRITERS.some(re => re.test(code(p)))).map(p => path.relative(SRC, p).split(path.sep).join("/"));
    expect(hits).toEqual([]);
    // Positive control: the scan really reads a writer (register.ts explicitly writes false); if the scan idles this goes red.
    expect(files.some(p => /mustChangePassword\s*:\s*false\b/.test(code(p)))).toBe(true);
  });

  it("both regexes recognize their target forms (self-check, so the guard can't idle)", () => {
    expect(WRITERS[0].test("set({ mustChangePassword: true })")).toBe(true);
    expect(WRITERS[0].test("set({ mustChangePassword: sql`true` })")).toBe(true);
    expect(WRITERS[0].test("set({ mustChangePassword: false })")).toBe(false);
    expect(WRITERS[0].test('set({ "mustChangePassword": true })')).toBe(true);
    expect(WRITERS[0].test("set({ 'mustChangePassword': true })")).toBe(true);
    expect(WRITERS[0].test("set({ mustChangePassword: sql`TRUE` })")).toBe(true);
    expect(WRITERS[1].test("update users set must_change_password = true")).toBe(true);
    expect(WRITERS[1].test("update users set must_change_password = false")).toBe(false);
  });
});

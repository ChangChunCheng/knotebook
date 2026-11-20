/**
 * Structural guard for storage quota: scans `src/` with comments stripped (same stripping as `code()` in tx-nested-pool-borrow-structure.test.ts).
 * Literal scan only: renamed re-exports, aliased calls and hand-offs through another module are deliberate evasions it can't catch;
 * behaviour is covered by storage-quota-race.test.ts.
 * - `insert(uploads)` appears only in upload (`insertUploadInTx`) and copy (`copyNoteInTx`); any new path that adds `uploads` rows
 *   must join the whitelist.
 * - `assertSpaceRoomInTx(` calls appear only in the five whitelisted files, once each except avatars/tx/avatars.ts (three). The
 *   delete-group.ts call is inside the `transferGroupInTx` body; the three in avatars/tx/avatars.ts are one each inside
 *   `insertAvatarInTx` (shared by the upload and OIDC forms), `replaceOidcAvatarInTx` (only in the branch that replaces the original
 *   image; with no candidate found it calls `insertAvatarInTx` instead) and `updateAvatarDisplayInTx`; `selectAvatarInTx` and
 *   `deleteAvatarInTx` (usage only shrinks or stays) don't call it. quota.ts has exactly one declaration and no calls; other files none.
 * - `pg_advisory` appears only in quota.ts and the folder structure lock folders/tx/lock.ts (a second kind of advisory lock; its key
 *   prefix `knotebook.folders:` differs from the capacity lock's `knotebook.storage:`, so the key spaces don't overlap).
 * - The `tx.execute(` call in quota.ts that takes the lock does not contain `sum(`; the SUM query comes after it, as separate statements.
 * - In the whitelisted files `assertSpaceRoomInTx(` precedes `writeSlugInTx(` / `insertNoteWithAutoSlug(` in the same function (the
 *   space lock before the slug write).
 * - quota.ts, the whitelisted files and their route files contain no isolationLevel / setTransaction / set transaction. Scoped to those
 *   files because the search-query.ts transaction legitimately uses setTransaction, so all of src/ can't be scanned.
 * - The HTTP 409 message literal appears only in storage/space.ts (STORAGE_QUOTA_EXCEEDED_MESSAGE); the helper in errors.ts and
 *   StorageQuotaExceeded both reference it, since with the literal in two places changing one lets the other drift.
 * - `update(uploads)` appears once, in notes/tx/move.ts, inside moveNoteToGroupInTx after the whole `writeSlugInTx(…)` call and before
 *   `recordRedirectsInTx(` (#247: not inside a callback that reruns when a slug collision forces a retry).
 * - The lock wait limit is never a hard-coded number: `(storage)lockTimeoutMs` is not followed by a number literal and `lock_timeout`
 *   is not set to a number or `'<n>ms'` literal; the only number is `DEFAULT_STORAGE_LOCK_TIMEOUT_MS = 5000` in quota.ts. The integration
 *   tests that inject a value (the lock-timeout-bound.ts family) only catch a fall-back to this constant and can't tell a different
 *   hard-coded number apart, which this scan covers.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith(".ts") ? [p] : [];
  });
}
function code(p: string): string {
  return readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join("/");
const at = (f: string) => code(path.join(SRC, f));

/** `src[open]` must be `(` or `{`: returns the matching inner text. */
function balanced(src: string, open: number): { body: string; end: number } {
  const o = src[open]!, c = o === "(" ? ")" : "}";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++;
    else if (src[i] === c && --depth === 0) return { body: src.slice(open + 1, i), end: i };
  }
  throw new Error(`不配對：${open}`);
}
function fnBody(src: string, name: string): { start: number; end: number } {
  const m = new RegExp(`\\bfunction\\s+${name}\\b`).exec(src);
  if (!m) throw new Error(`找不到 function ${name}`);
  const paren = src.indexOf("(", m.index);
  const afterParams = balanced(src, paren).end;
  // The body's `{` is the first `{` after the parameters whose previous non-space character is `)` or `>`, which skips object types in the return type
  // (the `{` in `Promise<{ removedShareUserIds: string[] }>` follows `<`).
  let brace = afterParams;
  for (;;) {
    brace = src.indexOf("{", brace + 1);
    if (brace < 0) throw new Error(`找不到 ${name} 的函式體`);
    const prev = src.slice(0, brace).trimEnd().slice(-1);
    if (prev === ")" || prev === ">") break;
  }
  return { start: brace, end: balanced(src, brace).end };
}

const WHITELIST = ["uploads/tx/insert-upload.ts", "notes/tx/copy.ts", "notes/tx/move.ts", "groups/tx/delete-group.ts", "avatars/tx/avatars.ts"];
const CALL = /(?<!function\s+)\bassertSpaceRoomInTx\(/g;
const DECL = /\bfunction\s+assertSpaceRoomInTx\(/g;

describe("storage quota structure guard", () => {
  const files = walk(SRC);

  it("insert(uploads) appears only in uploads/tx/insert-upload.ts and notes/tx/copy.ts", () => {
    expect(files.length).toBeGreaterThan(50); // non-vacuous: src/ was actually scanned
    const hits = files.filter(p => /\.insert\(\s*uploads\s*\)/.test(code(p))).map(rel).sort();
    expect(hits).toEqual(["notes/tx/copy.ts", "uploads/tx/insert-upload.ts"]);
  });

  it("assertSpaceRoomInTx calls: five whitelisted files (avatars three, the rest one each), none elsewhere; quota.ts has one declaration; delete-group's call is in transferGroupInTx, avatars' three are in insertAvatarInTx, replaceOidcAvatarInTx and updateAvatarDisplayInTx", () => {
    const counts: Record<string, number> = {};
    for (const p of files) {
      const n = [...code(p).matchAll(CALL)].length;
      if (n > 0) counts[rel(p)] = n;
    }
    expect(counts).toEqual(Object.fromEntries(WHITELIST.map(f => [f, f === "avatars/tx/avatars.ts" ? 3 : 1])));
    expect([...at("storage/tx/quota.ts").matchAll(DECL)]).toHaveLength(1);
    expect([...at("storage/tx/quota.ts").matchAll(CALL)]).toHaveLength(0);
    const dg = at("groups/tx/delete-group.ts");
    const idx = dg.search(/(?<!function\s+)\bassertSpaceRoomInTx\(/);
    const t6 = fnBody(dg, "transferGroupInTx");
    expect(idx > t6.start && idx < t6.end).toBe(true);
    const av = at("avatars/tx/avatars.ts");
    const callsIn = (name: string): number => {
      const { start, end } = fnBody(av, name);
      return [...av.slice(start, end).matchAll(CALL)].length;
    };
    expect(callsIn("insertAvatarInTx")).toBe(1);
    expect(callsIn("updateAvatarDisplayInTx")).toBe(1);
    expect(callsIn("replaceOidcAvatarInTx")).toBe(1);
    expect(callsIn("selectAvatarInTx")).toBe(0);
    expect(callsIn("deleteAvatarInTx")).toBe(0);
  });

  it("pg_advisory appears only in storage/tx/quota.ts and folders/tx/lock.ts (folder structure lock, different key prefix)", () => {
    expect(files.filter(p => /pg_advisory/.test(code(p))).map(rel).sort()).toEqual(["folders/tx/lock.ts", "storage/tx/quota.ts"]);
  });

  it("quota.ts: the lock-taking tx.execute( does not contain sum(; a SUM query follows separately", () => {
    const q = at("storage/tx/quota.ts");
    const lockAt = q.indexOf("pg_advisory_xact_lock");
    expect(lockAt).toBeGreaterThan(-1);
    const execAt = q.lastIndexOf("tx.execute(", lockAt);
    expect(execAt).toBeGreaterThan(-1);
    const { body, end } = balanced(q, execAt + "tx.execute".length);
    expect(body).toContain("pg_advisory_xact_lock");
    expect(body).not.toMatch(/sum\(|sumUploadSizeSql/i);
    expect(q.slice(end)).toMatch(/sumUploadSizeSql\(\)/);
  });

  it("space lock precedes the slug write in the same function", () => {
    const cases: Array<[string, string, RegExp]> = [
      ["notes/tx/copy.ts", "copyNoteInTx", /\binsertNoteWithAutoSlug\(/],
      ["notes/tx/move.ts", "moveNoteToGroupInTx", /\bwriteSlugInTx\(/],
      ["groups/tx/delete-group.ts", "transferGroupInTx", /\bwriteSlugInTx\(/],
    ];
    for (const [f, fn, write] of cases) {
      const src = at(f);
      const { start, end } = fnBody(src, fn);
      const body = src.slice(start, end);
      const lock = body.search(/(?<!function\s+)\bassertSpaceRoomInTx\(/);
      const w = body.search(write);
      expect(lock, `${f} 有空間鎖`).toBeGreaterThan(-1);
      expect(w, `${f} 有 slug 寫入`).toBeGreaterThan(-1);
      expect(lock < w, `${f}：assertSpaceRoomInTx 必須早於 slug 寫入`).toBe(true);
    }
  });

  it("scoped files must not set an isolation level", () => {
    const scoped = ["storage/tx/quota.ts", ...WHITELIST, "routes/uploads.ts", "routes/avatars.ts", "avatars/oidc-job.ts", "routes/notes.ts", "routes/note-content.ts", "routes/note-sharing.ts", "routes/groups.ts", "notes/copy-note.ts", "notes/move-note.ts"];
    // non-vacuous: every scoped file has content (`at` throws if it can't read one)
    for (const f of scoped) expect(at(f).length, `${f} 非空`).toBeGreaterThan(100);
    const bad = scoped.filter(f => /isolationLevel|setTransaction|set\s+transaction/i.test(at(f)));
    expect(bad).toEqual([]);
  });

  it("the quota message literal appears only in storage/space.ts (errors.ts and quota.ts reference the constant)", () => {
    const hits = files.filter(p => code(p).includes("This space's storage quota is full.")).map(rel).sort();
    expect(hits).toEqual(["storage/space.ts"]);
    expect(at("http/errors.ts")).toContain("STORAGE_QUOTA_EXCEEDED_MESSAGE");
  });

  it("update(uploads) appears once, in notes/tx/move.ts, after the writeSlugInTx(...) call and before recordRedirectsInTx( (#247)", () => {
    const hits = files.filter(p => /\.update\(\s*uploads\s*\)/.test(code(p))).map(rel).sort();
    expect(hits).toEqual(["notes/tx/move.ts"]);
    const src = at("notes/tx/move.ts");
    const { start, end } = fnBody(src, "moveNoteToGroupInTx");
    const body = src.slice(start, end);
    expect([...src.matchAll(/\.update\(\s*uploads\s*\)/g)]).toHaveLength(1);
    const ws = body.search(/\bwriteSlugInTx\(/);
    const rr = body.search(/\brecordRedirectsInTx\(/);
    const up = body.search(/\.update\(\s*uploads\s*\)/);
    expect(ws, "move.ts 有 writeSlugInTx(").toBeGreaterThan(-1);
    expect(rr, "move.ts 有 recordRedirectsInTx(").toBeGreaterThan(-1);
    expect(up, "UPDATE uploads 在 moveNoteToGroupInTx 函式體內").toBeGreaterThan(-1);
    const wsEnd = balanced(body, ws + "writeSlugInTx".length).end;
    expect(up > wsEnd && up < rr, "UPDATE uploads 必須在 writeSlugInTx(…) 整個呼叫之後、recordRedirectsInTx 之前").toBe(true);
  });

  it("lock wait limit is not hard-coded: the only number literal is DEFAULT_STORAGE_LOCK_TIMEOUT_MS = 5000 in quota.ts", () => {
    const LITERALS = [
      /(?<![A-Za-z0-9_])(?:storage)?lockTimeoutMs\s*(?::|=|\?\?|\|\|)\s*\d+/gi, // lockTimeoutMs: 300, storageLockTimeoutMs ?? 5000
      /lock_timeout[^;\n]*?['"`]\s*\d+\s*(?:ms|s|min)?\s*['"`]/gi, // set_config('lock_timeout', '300ms', …), = '2s'
      /lock_timeout\s*(?:=|to)\s*\d+/gi, // set local lock_timeout = 300
      /\w*LOCK_TIMEOUT_MS\s*=\s*\d+/g, // constant definition
    ];
    const hits = files.flatMap(p => {
      const src = code(p);
      return LITERALS.flatMap(re => [...src.matchAll(re)].map(m => `${rel(p)}: ${m[0]}`));
    });
    expect(hits).toEqual(["storage/tx/quota.ts: DEFAULT_STORAGE_LOCK_TIMEOUT_MS = 5000"]);
  });
});

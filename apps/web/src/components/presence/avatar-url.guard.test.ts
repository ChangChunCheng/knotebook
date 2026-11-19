import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source-level guard (#293): avatar URLs are built only by shared's `avatarUrl`, and no non-test web source file may hand-build `/api/avatars/`.
 *
 * The structural defence is that `Avatar`'s prop type accepts only `AvatarRef` and `presencePeople` always runs `parseAvatarRef` first;
 * this guard backs it up by catching anyone who bypasses `Avatar` and assembles the URL themselves. The scan count has a lower bound so an
 * empty scan cannot pass (a broken path or exclusion rule goes red first).
 *
 * Scans ts/tsx/js/mjs/css/html under `src/` plus `index.html`; the needle has no trailing slash (`/api/avatars?...` and `"/api/avatars" + "/"` count too)
 * and does not hit `/api/auth/avatars`.
 *
 * Before matching, the import-path literal of the hooks module (`"@/api/avatars"`) is stripped since it is not a URL.
 *
 * Not caught: a literal that splits `/api/avatars` itself apart and concatenates it (`"/api/" + "avatars"`), and what is written in test files and under `src/test/`.
 */

const WEB_ROOT = process.cwd();
const WEB_SRC = join(WEB_ROOT, "src");
const SHARED_SRC = join(WEB_ROOT, "..", "..", "packages", "shared", "src");
const NEEDLE = "/api/avatars";
/** The module-path literal that imports `api/avatars.ts` (the candidate-management hooks) contains the needle but is not a URL. */
const HOOKS_MODULE = '"@/api/avatars"';
/** 80% of the actual count 244 (245 with index.html). */
const MIN_WEB_FILES = 196;
const SOURCE_RE = /\.(?:tsx?|m?js|css|html)$/;

function sourceFiles(dir: string, skipDirs: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.includes(full)) out.push(...sourceFiles(full, skipDirs));
    } else if (SOURCE_RE.test(entry.name) && !entry.name.includes(".test.")) {
      out.push(full);
    }
  }
  return out;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("avatar URLs go only through avatarUrl", () => {
  it("no non-test web source file contains /api/avatars", () => {
    const files = [...sourceFiles(WEB_SRC, [join(WEB_SRC, "test")]), join(WEB_ROOT, "index.html")];
    expect(files.length).toBeGreaterThanOrEqual(MIN_WEB_FILES);
    const hits = files.filter((f) => readFileSync(f, "utf8").replaceAll(HOOKS_MODULE, "").includes(NEEDLE)).map((f) => relative(WEB_ROOT, f).split(sep).join("/"));
    expect(hits).toEqual([]);
  });

  it("shared's non-test sources contain it once, in avatar.ts", () => {
    const hits = sourceFiles(SHARED_SRC)
      .map((f) => ({ file: relative(SHARED_SRC, f).split(sep).join("/"), n: count(readFileSync(f, "utf8"), NEEDLE) }))
      .filter((h) => h.n > 0);
    expect(hits).toEqual([{ file: "avatar.ts", n: 1 }]);
  });
});

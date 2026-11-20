/**
 * #398: the production build (`tsc -p tsconfig.json`, as in the Dockerfile's `pnpm -r build`) must contain the worker entry and open workers without tsx; the production image only has `dist/` (`pnpm deploy --prod`, no tsx).
 * Built under `node_modules/.cache/` so module resolution finds apps/server/node_modules. The child runs a `.mjs` file, not `node -e`:
 * workers inherit the parent's `execArgv`, so `-e` would make the worker run that string too.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cacheDir = path.join(serverDir, "node_modules", ".cache");
const outDir = (() => {
  execFileSync(process.execPath, ["-e", `require("node:fs").mkdirSync(${JSON.stringify(cacheDir)}, { recursive: true })`]);
  return mkdtempSync(path.join(cacheDir, "parse-dist-"));
})();
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

// Child processes run async (tsc over the whole server takes over ten seconds on CI): execFileSync would block the vitest worker and stall
// RPC (onTaskUpdate, 60 s timeout) the whole time (CI of PR #400).
const run = promisify(execFile);

describe("production build uses a worker", () => {
  it("builds dist/notes/editing/parse-worker.js; plain node without a loader parses via createEditingRuntime and the pool opened a worker", async () => {
    const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
    await run(process.execPath, [tsc, "-p", path.join(serverDir, "tsconfig.json"), "--outDir", outDir], { maxBuffer: 64 * 1024 * 1024 });
    expect(existsSync(path.join(outDir, "notes/editing/parse-worker.js"))).toBe(true);
    const url = (p: string) => JSON.stringify(pathToFileURL(path.join(outDir, p)).href);
    const script = `
      const { loadConfig } = await import(${url("config.js")});
      const { createEditingRuntime } = await import(${url("notes/editing/runtime.js")});
      const config = loadConfig({ DATABASE_URL: "postgres://u:p@localhost:5432/db", APP_SECRET: "a".repeat(64), PUBLIC_URL: "http://localhost:3000", PARSE_WORKERS: "1" });
      const rt = createEditingRuntime(config, { workers: 1, workerMemoryMb: 1024, timeoutMs: 10000, queueWaitMs: 45000 });
      const r = await rt.parser.parse({ owner: "u", markdown: "# t\\n\\nhello **b**", candidates: [], siteOrigin: "http://localhost:3000" });
      console.log(JSON.stringify({ pool: rt.parser.constructor.name, spawned: rt.parser.stats().spawned, types: r.blocks.map(b => b.type) }));
      await rt.close();
    `;
    const file = path.join(outDir, "run-check.mjs");
    writeFileSync(file, script, "utf8");
    const { stdout: out } = await run(process.execPath, [file], { cwd: serverDir, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
    expect(JSON.parse(out.trim().split("\n").pop()!)).toEqual({ pool: "ParsePool", spawned: 1, types: ["heading", "paragraph"] });
  }, 180_000);
});

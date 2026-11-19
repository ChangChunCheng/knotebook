/**
 * #93: the backfill call comes **after** `app.listen` (the opposite direction of the back-fill guard in handle.test.ts) and the shutdown handler aborts it first.
 * Anchors on the **call-site literal** (`backfillSearchIndex(db`), not the function name, which would match the import first.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/index.ts"), "utf8");

describe("#93: backfill wiring in index.ts", () => {
  it("the backfill call comes after app.listen", () => {
    const callAt = src.indexOf("backfillSearchIndex(db");
    const listenAt = src.indexOf(".listen(");
    expect(callAt, "index.ts 必須呼叫 backfillSearchIndex(db…)").toBeGreaterThan(-1);
    expect(listenAt).toBeGreaterThan(-1);
    expect(callAt, "回填必須在 listen 之後").toBeGreaterThan(listenAt);
  });
  it("the shutdown handler aborts the backfill first, then destroys collab", () => {
    const onceAt = src.indexOf("process.once(");
    const abortAt = src.indexOf("backfillAbort.abort()", onceAt);
    const destroyAt = src.indexOf(".destroy()", onceAt);
    expect(onceAt).toBeGreaterThan(-1);
    expect(abortAt).toBeGreaterThan(onceAt);
    expect(destroyAt).toBeGreaterThan(-1);
    expect(abortAt).toBeLessThan(destroyAt);
  });
  it("#269: link conversion starts after listen; the SIGTERM chain first waits for app.linkConversion.stop() with a shared 2 s grace, then collab.destroy() (holds whether #272 merges before or after)", () => {
    const listenAt = src.indexOf(".listen(");
    const startAt = src.indexOf("app.linkConversion.start()");
    expect(startAt).toBeGreaterThan(listenAt);
    const onceAt = src.indexOf("process.once(");
    expect(onceAt, "index.ts 要有 process.once( 關機 handler").toBeGreaterThan(-1);
    // strip comment lines before searching (#272: comment literals above/inside the handler would match first).
    const handler = src.slice(onceAt).replace(/^\s*\/\/.*$/gm, "");
    // accepts both the standalone form (#272 not merged) and the form folded into Promise.all (#272 merged); stop must be inside the race that comes before collab.destroy().
    const race = /Promise\.race\(\[(?:Promise\.all\(\[[^\]]*\bapp\.linkConversion\.stop\(\)[^\]]*\]\)|app\.linkConversion\.stop\(\)), stopGrace\(\)\]\)/.exec(handler);
    expect(race, "關機要以 Promise.race([… app.linkConversion.stop() …, stopGrace()]) 有上限地等轉換工作").not.toBeNull();
    const destroyAt = handler.indexOf("collab.destroy()");
    expect(destroyAt, "關機要呼叫 collab.destroy()").toBeGreaterThan(-1);
    expect(destroyAt, "race 要在 collab.destroy() 之前").toBeGreaterThan(race!.index + race![0].length - 1);
    // Grace constant (a single copy after #272, now in collab/versions.ts): first take the constant name stopGrace actually uses, then look in the file that defines it
    // (index.ts itself, or the file index.ts imports it from ./...) with `//` comment lines stripped for `const <name> = 2_000;` - turns red if stopGrace switches to another
    // local constant, or if 2_000 survives only in a comment.
    const grace = /const stopGrace = \(\): Promise<void> => new Promise\(resolve => setTimeout\(resolve, ([A-Z_]+)\)\.unref\(\)\);/.exec(src);
    expect(grace, "stopGrace 要寫成 new Promise(resolve => setTimeout(resolve, <常數>).unref())").not.toBeNull();
    const graceName = grace![1]!;
    const importedFrom = new RegExp(`^import \\{[^}]*\\b${graceName}\\b[^}]*\\} from "\\./([^"]+)\\.js";`, "m").exec(src);
    const definingSrc = importedFrom
      ? readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../../src/${importedFrom[1]}.ts`), "utf8")
      : src;
    const definingCode = definingSrc.replace(/^\s*\/\/.*$/gm, "");
    expect(definingCode, `${graceName} 的定義（剔掉 // 註解行）要是 2_000`).toMatch(new RegExp(`^\\s*(?:export )?const ${graceName} = 2_000;`, "m"));
  });
});

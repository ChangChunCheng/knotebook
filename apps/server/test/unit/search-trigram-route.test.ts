/** Only queries with 3+ characters that yield trigrams take the trigram (LIKE) path; a wrong guess costs speed, never correctness. */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initCjkTrigramMode, setCjkYieldsTrigrams, usesTrigramPath } from "../../src/notes/search-sql.js";

afterEach(() => setCjkYieldsTrigrams(false));

describe("usesTrigramPath when CJK yields trigrams (UTF-8 locale)", () => {
  it.each(["ab", "鯨魚", "a b c", "a-b-c", "ab_c", "😀😀😀", "%_\\", "①②③", "²³⁴"])("%s → position", q => {
    setCjkYieldsTrigrams(true);
    expect(usesTrigramPath(q)).toBe(false);
  });
  it.each(["abc", "x1y", "資料庫", "foo bar", "50%_off", "100%", "Résumé", "किताब", "１２３", "ⅠⅡⅢ", "KUBERNETES"])("%s → trigram", q => {
    setCjkYieldsTrigrams(true);
    expect(usesTrigramPath(q)).toBe(true);
  });
});

describe("usesTrigramPath when CJK yields no trigrams (C locale)", () => {
  it.each(["ab", "鯨魚", "資料庫", "資料庫設計", "ab資cd", "a b c", "😀😀😀", "%_\\", "Привет", "Αθήνα", "é1é"])("%s → position", q => {
    setCjkYieldsTrigrams(false);
    expect(usesTrigramPath(q)).toBe(false);
  });
  it.each(["abc", "x1y", "foo bar", "Résumé", "50%_off", "資料庫abc", "abc資料庫", "KUBERNETES"])("%s → trigram", q => {
    setCjkYieldsTrigrams(false);
    expect(usesTrigramPath(q)).toBe(true);
  });
  it("a freshly loaded module starts in this mode (before the startup probe runs)", async () => {
    setCjkYieldsTrigrams(true);
    vi.resetModules();
    const fresh = await import("../../src/notes/search-sql.js");
    expect(fresh.usesTrigramPath("資料庫")).toBe(false);
    expect(fresh.usesTrigramPath("abc")).toBe(true);
  });
});

describe("initCjkTrigramMode", () => {
  const logs = () => ({ info: vi.fn(), warn: vi.fn() });
  const dbReturning = (ok: boolean) => ({ execute: async () => ({ rows: [{ ok }] }) }) as never;

  it("probe true → UTF-8 rule, one info line", async () => {
    const log = logs();
    await initCjkTrigramMode(dbReturning(true), log);
    expect(usesTrigramPath("資料庫")).toBe(true);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });
  it("probe false → C rule, one info line", async () => {
    setCjkYieldsTrigrams(true);
    const log = logs();
    await initCjkTrigramMode(dbReturning(false), log);
    expect(usesTrigramPath("資料庫")).toBe(false);
    expect(log.info).toHaveBeenCalledTimes(1);
  });
  it("probe error → fallback rule, a warning with only the SQLSTATE, no throw", async () => {
    setCjkYieldsTrigrams(true);
    const log = logs();
    const db = { execute: async () => { throw Object.assign(new Error("secret detail"), { code: "42883" }); } } as never;
    await initCjkTrigramMode(db, log);
    expect(usesTrigramPath("資料庫")).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toEqual({ code: "42883", constraint: null });
  });
  it("index.ts calls it at startup", () => {
    const src = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
    expect(src).toMatch(/^\s*await initCjkTrigramMode\(db, logger\);/m);
  });
});

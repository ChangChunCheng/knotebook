import { describe, expect, it } from "vitest";
import type { TokenScope } from "@knotebook/shared";
import { checksFromScope, scopeFromChecks } from "./token-scope";

const R = "notes:read";
const RW = "notes:read notes:write";
const RWM = "notes:read notes:write notes:move";
const RWD = "notes:read notes:write notes:delete";
const RWMD = "notes:read notes:write notes:move notes:delete";

describe("token-scope", () => {
  it("scopeFromChecks 八格（搬移、刪除不搭編輯 → 唯讀，fail-closed）", () => {
    expect(scopeFromChecks(false, false, false)).toBe(R);
    expect(scopeFromChecks(false, true, false)).toBe(R);
    expect(scopeFromChecks(false, false, true)).toBe(R);
    expect(scopeFromChecks(false, true, true)).toBe(R);
    expect(scopeFromChecks(true, false, false)).toBe(RW);
    expect(scopeFromChecks(true, true, false)).toBe(RWM);
    expect(scopeFromChecks(true, false, true)).toBe(RWD);
    expect(scopeFromChecks(true, true, true)).toBe(RWMD);
  });
  it("checksFromScope 五形", () => {
    expect(checksFromScope(R)).toEqual({ write: false, move: false, delete: false });
    expect(checksFromScope(RW)).toEqual({ write: true, move: false, delete: false });
    expect(checksFromScope(RWM)).toEqual({ write: true, move: true, delete: false });
    expect(checksFromScope(RWD)).toEqual({ write: true, move: false, delete: true });
    expect(checksFromScope(RWMD)).toEqual({ write: true, move: true, delete: true });
  });
  it("五形來回恆等：scopeFromChecks(checksFromScope(s)) === s", () => {
    for (const s of [R, RW, RWM, RWD, RWMD] as const) {
      const c = checksFromScope(s);
      expect(scopeFromChecks(c.write, c.move, c.delete)).toBe(s);
    }
  });
  it("刪除不搭編輯的非正規值 → 三者皆 false", () => {
    expect(checksFromScope("notes:read notes:delete" as TokenScope)).toEqual({ write: false, move: false, delete: false });
  });
});

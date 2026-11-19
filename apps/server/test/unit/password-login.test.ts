import { describe, expect, it } from "vitest";
import { effectivePasswordLogin } from "../../src/auth/password-login.js";

describe("effectivePasswordLogin (#187: effective value = DB value OR env force; an unreadable row counts as on)", () => {
  it.each([
    [true, false, true],
    [false, false, false],
    [null, false, true],
    [true, true, true],
    [false, true, true],
    [null, true, true],
  ] as const)("DB=%s, env force=%s -> %s", (dbValue, forced, expected) => {
    expect(effectivePasswordLogin(dbValue, forced)).toBe(expected);
  });
});

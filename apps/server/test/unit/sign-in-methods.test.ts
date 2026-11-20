import { describe, expect, it } from "vitest";
import { canUnlinkIdentity, usableIdentityIds } from "../../src/auth/sign-in-methods.js";

describe("usableIdentityIds (effective issuer, exact equality)", () => {
  it("accepts only identities whose issuer equals an enabled provider's effective issuer; a different trailing slash does not count (loose matching is used only for same-issuer exclusion)", () => {
    const ids = usableIdentityIds(
      [{ id: "a", issuer: "https://a.example" }, { id: "b", issuer: "https://b.example" }, { id: "c", issuer: "https://c.example/" }],
      [{ effectiveIssuer: "https://a.example" }, { effectiveIssuer: "https://c.example" }],
    );
    expect([...ids]).toEqual(["a"]);
  });
});

describe("canUnlinkIdentity (a password counts only when the DB value is true)", () => {
  const set = (...ids: string[]) => new Set(ids);
  it.each([
    // [hasPassword, dbValue, usable, target, expected]
    [true, true, set(), "x", true],
    [true, false, set("x"), "x", false],
    [true, false, set("x", "y"), "x", true],
    [false, true, set("x"), "x", false],
    [false, true, set("x", "y"), "x", true],
    [false, true, set("y"), "x", true],
    [false, false, set(), "x", false],
  ] as const)("password=%s, DB=%s, usable=%o, unlink %s -> %s", (hasPassword, passwordLoginDbValue, usable, target, expected) => {
    expect(canUnlinkIdentity(target, { hasPassword, passwordLoginDbValue, usableIdentityIds: usable })).toBe(expected);
  });
});

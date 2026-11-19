/** #175: unit cases for `packages/shared/src/group-roles.ts` (reading is implicit; the six settable flags do not imply one another). */
import { describe, expect, it } from "vitest";
import { BUILTIN_ROLE_DISPLAY_NAMES, GROUP_ROLE_FLAGS, isReservedRoleName, normalizeRoleName } from "@knotebook/shared";

describe("GROUP_ROLE_FLAGS", () => {
  it("exactly six settable flags, read excluded", () => {
    expect([...GROUP_ROLE_FLAGS]).toEqual(["create", "edit", "delete", "managePublicLink", "manageMembers", "manageGroup"]);
  });
});

describe("role names", () => {
  it("normalizeRoleName: trim, then NFC", () => {
    expect(normalizeRoleName("  Reader \t")).toBe("Reader");
    // NFD (e + U+0301) must compose to NFC (U+00E9); written as escapes so the two forms are distinguishable by eye.
    expect(normalizeRoleName("Cafe\u0301")).toBe("Caf\u00e9");
  });
  it("isReservedRoleName: true only when equal to a built-in display name in either locale (case-insensitive); near matches are not", () => {
    for (const n of ["admin", "ADMIN", "Member", "member", "管理員", "一般成員", "\u3000管理員\u3000"]) expect(isReservedRoleName(normalizeRoleName(n)), n).toBe(true);
    for (const n of ["Admins", "Reader", "管理者", "成員"]) expect(isReservedRoleName(normalizeRoleName(n)), n).toBe(false);
  });
  it("BUILTIN_ROLE_DISPLAY_NAMES has exactly four (two en, two zh-TW; consistency with web i18n is checked by the web i18n test)", () => {
    expect([...BUILTIN_ROLE_DISPLAY_NAMES].sort()).toEqual(["Admin", "Member", "一般成員", "管理員"].sort());
  });
});

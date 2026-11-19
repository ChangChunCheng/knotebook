import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "./index.js";
import {
  VERSION_AUTO_WAIT_MINUTES_DEFAULT, VERSION_AUTO_WAIT_MINUTES_MAX, VERSION_AUTO_WAIT_MINUTES_MIN,
  VERSION_DAILY_UNTIL_DAYS_DEFAULT, VERSION_DAYS_MAX, VERSION_KEEP_ALL_DAYS_DEFAULT,
  VERSION_LIST_LIMIT_DEFAULT, VERSION_LIST_LIMIT_MAX, VERSION_NAME_MAX, normalizeVersionName,
} from "./versions.js";

describe("versions constants", () => {
  it("name 120, list 50 / 100, days 7 / 30 / 3650", () => {
    expect(VERSION_NAME_MAX).toBe(120);
    expect([VERSION_LIST_LIMIT_DEFAULT, VERSION_LIST_LIMIT_MAX]).toEqual([50, 100]);
    expect([VERSION_KEEP_ALL_DAYS_DEFAULT, VERSION_DAILY_UNTIL_DAYS_DEFAULT, VERSION_DAYS_MAX]).toEqual([7, 30, 3650]);
  });

  it("#272: auto-save wait X defaults to 5, range 1-60 (minutes)", () => {
    expect([VERSION_AUTO_WAIT_MINUTES_DEFAULT, VERSION_AUTO_WAIT_MINUTES_MIN, VERSION_AUTO_WAIT_MINUTES_MAX]).toEqual([5, 1, 60]);
  });

  it("the three new error codes are all in ERROR_CODES", () => {
    for (const code of ["version_is_base", "version_unsaved_changes", "version_mismatch"]) expect(ERROR_CODES).toContain(code);
  });
});

describe("normalizeVersionName (trim, empty string = NULL, cap 120 characters)", () => {
  it("null / empty string / whitespace only (including full-width spaces) -> NULL", () => {
    expect(normalizeVersionName(null)).toEqual({ ok: true, name: null });
    expect(normalizeVersionName("")).toEqual({ ok: true, name: null });
    expect(normalizeVersionName(" \u3000\t ")).toEqual({ ok: true, name: null });
  });

  it("trims both ends, keeps inner whitespace", () => {
    expect(normalizeVersionName("  初稿 v2  ")).toEqual({ ok: true, name: "初稿 v2" });
  });

  it("length counts code points: 120 emoji (.length 240) accepted, 121 rejected", () => {
    const smile = String.fromCodePoint(0x1f600);
    expect(normalizeVersionName(smile.repeat(120))).toEqual({ ok: true, name: smile.repeat(120) });
    expect(normalizeVersionName(smile.repeat(121))).toEqual({ ok: false });
    expect(normalizeVersionName("a".repeat(121))).toEqual({ ok: false });
  });

  it("NUL and lone surrogates rejected (PostgreSQL cannot store them); paired surrogates accepted", () => {
    expect(normalizeVersionName(`a${String.fromCodePoint(0)}b`)).toEqual({ ok: false });
    expect(normalizeVersionName("a\uD800b")).toEqual({ ok: false });
    expect(normalizeVersionName("a\uDC00")).toEqual({ ok: false });
    expect(normalizeVersionName("\uD83D\uDE00")).toEqual({ ok: true, name: "\uD83D\uDE00" });
  });
});

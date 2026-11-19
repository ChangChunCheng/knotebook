import { describe, expect, it } from "vitest";
import { BUILTIN_ROLE_DISPLAY_NAMES, ERROR_CODES } from "@knotebook/shared";
import en from "./en.json";
import zhTW from "./zh-TW.json";
import enRaw from "./en.json?raw";
import zhTWRaw from "./zh-TW.json?raw";

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key));
}

// The key sets of the two locales must be identical: a missing key shows up in the UI silently as the key string itself
// (i18next default behavior), with no error, so only a test catches it.
describe("i18n key parity", () => {
  it("en and zh-TW have the same key set", () => {
    expect(flattenKeys(zhTW).sort()).toEqual(flattenKeys(en).sort());
  });
});

/**
 * `JSON.parse` keeps only the last of duplicate keys within one object, which neither parity nor lint catches: the earlier one
 * becomes a dead string and the PR diff shows a seemingly added line. This scans the raw text and reports a key that appears a second time at the same object level.
 */
function duplicateKeys(raw: string): string[] {
  const dups: string[] = [];
  const stack: { keys: Set<string> | null; expectKey: boolean }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    const top = stack[stack.length - 1];
    if (ch === "{") stack.push({ keys: new Set(), expectKey: true });
    else if (ch === "[") stack.push({ keys: null, expectKey: false });
    else if (ch === "}" || ch === "]") stack.pop();
    else if (ch === ":" && top) top.expectKey = false;
    else if (ch === "," && top?.keys) top.expectKey = true;
    else if (ch === '"') {
      let j = i + 1;
      while (raw[j] !== '"') j += raw[j] === "\\" ? 2 : 1;
      if (top?.keys && top.expectKey) {
        const key = raw.slice(i + 1, j);
        if (top.keys.has(key)) dups.push(key);
        top.keys.add(key);
      }
      i = j;
    }
  }
  return dups;
}

describe("i18n has no duplicate keys", () => {
  it.each([
    ["en", enRaw],
    ["zh-TW", zhTWRaw],
  ] as const)("%s: no duplicate key within one object", (_name, raw) => {
    expect(duplicateKeys(raw)).toEqual([]);
  });
});

// Guards the contract that errors.<code> maps every ERROR_CODES entry plus errors.fallback (relied on verbatim: any
// ApiFail.code must resolve to copy in both locales).
//
// This test is why the keys `errors.not_loaded` and `errors.file_too_large` exist (new ERROR_CODES entries):
// - `errors.not_loaded`: exists only for ERROR_CODES parity and currently has no UI call path - the link-sync client
//   retries silently once on a 409 `not_loaded` and then gives up, so this copy is never shown to a user.
// - `errors.file_too_large`: is shown to the user as a toast through uploadFile's error handling (image upload flow).
describe("i18n error message coverage", () => {
  for (const [langName, resource] of [
    ["en", en],
    ["zh-TW", zhTW],
  ] as const) {
    it(`${langName}: has an errors.<code> entry for every ErrorCode`, () => {
      for (const code of ERROR_CODES) {
        expect(resource.errors, `missing errors.${code} in ${langName}`).toHaveProperty(code);
        expect(typeof resource.errors[code as keyof typeof resource.errors]).toBe("string");
      }
    });

    it(`${langName}: has errors.fallback`, () => {
      expect(resource.errors.fallback).toBeTypeOf("string");
    });
  }
});

// #175: the server rejects a custom role taking a built-in display name via `BUILTIN_ROLE_DISPLAY_NAMES`; that constant must equal the values of
// `groups.role.admin` / `groups.role.member` in both locales, so renaming a display name turns this red. Adding a locale does not (only the
// hard-imported en / zh-TW are compared): update this array and `BUILTIN_ROLE_DISPLAY_NAMES` together.
describe("built-in role display names = reserved-name constant", () => {
  it("BUILTIN_ROLE_DISPLAY_NAMES equals groups.role.admin and groups.role.member in en / zh-TW", () => {
    expect([...BUILTIN_ROLE_DISPLAY_NAMES].sort()).toEqual(
      [en.groups.role.admin, en.groups.role.member, zhTW.groups.role.admin, zhTW.groups.role.member].sort(),
    );
  });
});

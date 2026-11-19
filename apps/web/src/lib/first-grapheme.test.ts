import { describe, expect, it } from "vitest";
import { firstGrapheme, hasVisibleText } from "./first-grapheme";

describe("firstGrapheme", () => {
  it.each([
    ["ann", "A"],
    ["王小明", "王"],
    ["👩‍💻 dev", "👩‍💻"],
    ["éclair", "É"],
    ["  ", "?"],
    ["", "?"],
    [" bob", "B"],
  ])("%j -> %j", (name, expected) => {
    expect(firstGrapheme(name)).toBe(expected);
  });

  // #293: leading bidi / format characters are invisible; take the first visible grapheme.
  it.each([
    [String.fromCharCode(0x202e) + "Ann", "A"],
    [String.fromCharCode(0x200f, 0x2066) + "bob", "B"],
    [String.fromCharCode(0xfeff, 0x200b) + "王", "王"],
    [String.fromCharCode(0x200b), "?"],
    [String.fromCharCode(0x202e, 0x3000, 0x200e), "?"],
  ])("leading invisible characters %j -> %j", (name, expected) => {
    expect(firstGrapheme(name)).toBe(expected);
  });
});

describe("hasVisibleText", () => {
  it.each([
    ["ann", true],
    ["  ", false],
    ["", false],
    [String.fromCharCode(0x200b, 0x202e), false],
  ])("%j -> %j", (name, expected) => {
    expect(hasVisibleText(name)).toBe(expected);
  });
});

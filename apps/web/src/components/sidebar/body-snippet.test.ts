import { describe, expect, it } from "vitest";
import { displaySnippet } from "./body-snippet";

describe("displaySnippet (keeps about 12 characters before the match)", () => {
  it("match within the first 12 characters -> unchanged", () => {
    expect(displaySnippet("abcdefghijk needle tail", ["needle"])).toBe("abcdefghijk needle tail"); // exactly 12 characters before the match
    expect(displaySnippet("needle first", ["needle"])).toBe("needle first");
  });

  it("match at character 30 -> ellipsis, 12 code points before the match, then the rest from the match", () => {
    const s = `${"x".repeat(18)}0123456789abNEEDLE tail`;
    expect(displaySnippet(s, ["needle"])).toBe("…0123456789abNEEDLE tail");
  });

  it("cut point inside a surrogate pair -> never splits it (counted in code points)", () => {
    const s = `${"x".repeat(10)}${"😀".repeat(12)}needle`;
    const out = displaySnippet(s, ["needle"]);
    expect(out).toBe(`…${"😀".repeat(12)}needle`);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(false);
  });

  it("length changes after toLowerCase (dotted capital I) -> unchanged; not found -> unchanged", () => {
    const s = `İ${"x".repeat(30)}needle`;
    expect(displaySnippet(s, ["needle"])).toBe(s);
    expect(displaySnippet("x".repeat(40), ["needle"])).toBe("x".repeat(40));
  });

  it("already starts with an ellipsis (server truncated the lead) -> still a single ellipsis after trimming", () => {
    const s = `…${"x".repeat(30)}needle`;
    expect(displaySnippet(s, ["needle"])).toBe(`…${"x".repeat(12)}needle`);
    expect(displaySnippet("…short needle", ["needle"])).toBe("…short needle");
  });

  it("#399 several keywords: trims before the earliest hit of any of them", () => {
    const s = `${"x".repeat(30)}beta ${"y".repeat(20)}alpha`;
    expect(displaySnippet(s, ["alpha", "beta"])).toBe(`…${"x".repeat(12)}beta ${"y".repeat(20)}alpha`);
  });
});

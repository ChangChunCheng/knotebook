import { describe, expect, it } from "vitest";
import { validateSlug } from "@knotebook/shared";
import { nextSlugCandidate } from "../../src/notes/slug.js";

describe("nextSlugCandidate (#175: the -N suffix and re-truncation to <=60 shared by move/transfer/create)", () => {
  it("n=1 returns the base itself (not truncated)", () => {
    expect(nextSlugCandidate("meeting", 1)).toBe("meeting");
    const long = "a".repeat(100);
    expect(nextSlugCandidate(long, 1)).toBe(long);
  });
  it("n>=2 appends -N, total length <=60", () => {
    expect(nextSlugCandidate("meeting", 2)).toBe("meeting-2");
    expect(nextSlugCandidate("meeting", 21)).toBe("meeting-21");
  });
  it("a 100-char custom slug's -2 candidate is <=60, ends with -2, and passes validateSlug", () => {
    const c = nextSlugCandidate("b".repeat(100), 2);
    expect(Array.from(c).length).toBeLessThanOrEqual(60);
    expect(c.endsWith("-2")).toBe(true);
    expect(validateSlug(c)).toBeNull();
  });
  it("when the cut lands on a hyphen the trailing hyphen is removed (no --2)", () => {
    const base = `${"c".repeat(57)}-dddd`; // first 58 chars = 57 c's + '-'
    expect(nextSlugCandidate(base, 2)).toBe(`${"c".repeat(57)}-2`);
  });
  it("length counts code points (CJK isn't cut in half)", () => {
    const c = nextSlugCandidate("會".repeat(70), 3);
    expect(Array.from(c).length).toBe(60);
    expect(c.endsWith("-3")).toBe(true);
  });
});

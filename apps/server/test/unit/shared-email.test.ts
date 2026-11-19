import { describe, it, expect } from "vitest";
import { normalizeEmail } from "@knotebook/shared";

describe("normalizeEmail", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeEmail("  alice@example.com  ")).toBe("alice@example.com");
  });

  it("upper case -> lower case", () => {
    expect(normalizeEmail("AliCE@Example.COM")).toBe("alice@example.com");
  });

  it("already-normalised input -> idempotent (unchanged)", () => {
    expect(normalizeEmail("alice@example.com")).toBe("alice@example.com");
  });
});

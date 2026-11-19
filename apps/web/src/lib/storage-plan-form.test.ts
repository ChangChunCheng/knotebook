import { describe, expect, it } from "vitest";
import { quotaBytesFromInput, quotaInputFromBytes, validPlanName } from "./storage-plan-form";

describe("validPlanName (1-40 code points after trim; the server still has the final say)", () => {
  it("trim (including fullwidth space U+3000)", () => expect(validPlanName("　 Team 　")).toBe("Team"));
  it("blank -> null", () => expect(validPlanName("   ")).toBeNull());
  it("40 astral characters (.length 80) -> valid; 41 -> null", () => {
    expect(validPlanName("😀".repeat(40))).toBe("😀".repeat(40));
    expect(validPlanName("😀".repeat(41))).toBeNull();
  });
});

describe("quotaBytesFromInput", () => {
  it("1 MB -> 1048576; 1.5 GB -> 1610612736; surrounding whitespace allowed", () => {
    expect(quotaBytesFromInput("1", "MB")).toBe(1048576);
    expect(quotaBytesFromInput(" 1.5 ", "GB")).toBe(1610612736);
  });
  it("0 is valid (a plan with quota 0)", () => expect(quotaBytesFromInput("0", "MB")).toBe(0));
  it("rounds to a whole byte: 0.0005 MB -> 524", () => expect(quotaBytesFromInput("0.0005", "MB")).toBe(524));
  it("empty string, negative, exponent, non-numeric -> null", () => {
    for (const raw of ["", "-1", "1e3", "abc", "1.", ".5", "1,5"]) expect(quotaBytesFromInput(raw, "MB"), raw).toBeNull();
  });
  it("upper bound: 1048576 GB (= 2^50) is valid; 1048577 GB -> null", () => {
    expect(quotaBytesFromInput("1048576", "GB")).toBe(2 ** 50);
    expect(quotaBytesFromInput("1048577", "GB")).toBeNull();
  });
});

describe("quotaInputFromBytes (initial value of the edit dialog)", () => {
  it("whole GiB -> GB", () => expect(quotaInputFromBytes(2147483648)).toEqual({ value: "2", unit: "GB" }));
  it("whole MiB but not whole GiB -> MB", () => expect(quotaInputFromBytes(1536 * 1048576)).toEqual({ value: "1536", unit: "MB" }));
  it("0 -> 0 MB", () => expect(quotaInputFromBytes(0)).toEqual({ value: "0", unit: "MB" }));
  it("not divisible -> MB with at most 6 decimals (1000 bytes -> 0.000954)", () => expect(quotaInputFromBytes(1000)).toEqual({ value: "0.000954", unit: "MB" }));
});

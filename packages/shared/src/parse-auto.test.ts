import { describe, expect, it } from "vitest";
import { defaultParseWorkers, memoryParseWorkers } from "./parse-auto.js";

describe("parse-auto", () => {
  it("defaultParseWorkers: leave 1 core, at least 1, at most 4", () => {
    expect(defaultParseWorkers(1)).toBe(1);
    expect(defaultParseWorkers(2)).toBe(1);
    expect(defaultParseWorkers(5)).toBe(4);
    expect(defaultParseWorkers(64)).toBe(4);
  });

  it("memoryParseWorkers: half the memory / per-worker cap, at least 1", () => {
    expect(memoryParseWorkers(2 * 2 ** 30, 1024)).toBe(1);
    expect(memoryParseWorkers(16 * 2 ** 30, 1024)).toBe(8);
    expect(memoryParseWorkers(256 * 2 ** 20, 1024)).toBe(1);
  });
});

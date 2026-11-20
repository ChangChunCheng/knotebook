import { describe, it, expect } from "vitest";
import { BoundedMap } from "../../src/lib/bounded-map.js";

describe("BoundedMap", () => {
  it("behaves like a plain Map below the limit", () => {
    const map = new BoundedMap<number>(3);
    map.set("a", 1);
    map.set("b", 2);

    expect(map.get("a")).toBe(1);
    expect(map.get("b")).toBe(2);
    expect(map.get("missing")).toBeUndefined();
    expect(map.size).toBe(2);
  });

  it("over the limit, evicts the oldest entry (insertion order)", () => {
    const map = new BoundedMap<number>(2);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);

    expect(map.size).toBe(2);
    expect(map.get("a")).toBeUndefined();
    expect(map.get("b")).toBe(2);
    expect(map.get("c")).toBe(3);
  });

  it("rewriting an existing key moves it to the end (so it escapes the next eviction)", () => {
    const map = new BoundedMap<number>(2);
    map.set("a", 1);
    map.set("b", 2);
    // 'a' is rewritten -> moves to the end, so 'b' becomes the oldest.
    map.set("a", 10);
    map.set("c", 3);

    expect(map.get("a")).toBe(10);
    expect(map.get("b")).toBeUndefined();
    expect(map.get("c")).toBe(3);
  });

  it("rewriting an existing key never evicts another key (delete happens before the size check)", () => {
    // This ordering underpins LoginThrottle's security argument: failing again for an already-tracked key must not push out someone
    // else's record. If the implementation checked size before delete, this write would first evict the oldest entry.
    //
    // The rewritten key must NOT be the oldest, otherwise both implementations give the same result (the wrong one evicts the key
    // itself and then re-adds it); the previous test can't tell them apart.
    const map = new BoundedMap<number>(3);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    map.set("b", 20);

    expect(map.size).toBe(3);
    expect(map.get("a")).toBe(1);
    expect(map.get("b")).toBe(20);
    expect(map.get("c")).toBe(3);
  });

  it("get does not affect eviction order (deliberately not an access-recency LRU)", () => {
    const map = new BoundedMap<number>(2);
    map.set("a", 1);
    map.set("b", 2);
    map.get("a");
    map.set("c", 3);

    expect(map.get("a")).toBeUndefined();
    expect(map.get("b")).toBe(2);
  });

  it("delete frees space, so later inserts don't evict others", () => {
    const map = new BoundedMap<number>(2);
    map.set("a", 1);
    map.set("b", 2);
    expect(map.delete("a")).toBe(true);
    expect(map.delete("a")).toBe(false);

    map.set("c", 3);
    expect(map.get("b")).toBe(2);
    expect(map.get("c")).toBe(3);
    expect(map.size).toBe(2);
  });

  it("with a limit of 1, each insert keeps only the newest entry", () => {
    const map = new BoundedMap<number>(1);
    map.set("a", 1);
    map.set("b", 2);

    expect(map.size).toBe(1);
    expect(map.get("a")).toBeUndefined();
    expect(map.get("b")).toBe(2);
  });

  it("maxKeys that is not a positive integer throws (silently becoming unbounded would be the worst failure)", () => {
    expect(() => new BoundedMap<number>(0)).toThrow();
    expect(() => new BoundedMap<number>(-1)).toThrow();
    expect(() => new BoundedMap<number>(1.5)).toThrow();
  });
});

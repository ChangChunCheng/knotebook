import { describe, it, expect, beforeEach } from "vitest";
import { hashPassword, verifyPassword, HashBusyError, setHashConcurrency, DUMMY_HASH } from "../../src/auth/password.js";

describe("password service", () => {
  beforeEach(() => {
    setHashConcurrency(4);
  });

  it("hash/verify round trip", async () => {
    const h = await hashPassword("correct horse battery st");
    expect(await verifyPassword(h, "correct horse battery st")).toBe(true);
    expect(await verifyPassword(h, "wrong password here!!")).toBe(false);
  });

  it("argon2id parameters meet the minimum", async () => {
    const h = await hashPassword("correct horse battery st");
    expect(h).toMatch(/^\$argon2id\$/);
    expect(h).toMatch(/m=19456,t=2,p=1/);
  });

  it("throws HashBusyError instead of queueing when concurrency is exceeded (hash)", async () => {
    setHashConcurrency(2);
    const rs = await Promise.all(Array.from({ length: 6 }, () => hashPassword("x".repeat(16)).catch(e => e)));
    const errors = rs.filter(r => r instanceof HashBusyError);
    const successes = rs.filter(r => typeof r === "string");
    expect(errors.length).toBe(4);
    expect(successes.length).toBe(2);
    successes.forEach(h => {
      expect(h).toMatch(/^\$argon2id\$/);
    });
  });

  it("throws HashBusyError instead of queueing when concurrency is exceeded (verify)", async () => {
    const h = await hashPassword("x".repeat(16));
    setHashConcurrency(2);
    const rs = await Promise.all(Array.from({ length: 6 }, () => verifyPassword(h, "x".repeat(16)).catch(e => e)));
    const errors = rs.filter(r => r instanceof HashBusyError);
    const successes = rs.filter(r => typeof r === "boolean");
    expect(errors.length).toBe(4);
    expect(successes.length).toBe(2);
    successes.forEach(result => {
      expect(result).toBe(true);
    });
  });

  it("release path (hash): back to normal after the limit was full", async () => {
    setHashConcurrency(1);
    const h1 = await hashPassword("password1");
    expect(h1).toMatch(/^\$argon2id\$/);
    const rs = await Promise.allSettled([
      hashPassword("password2"),
      hashPassword("password3"),
    ]);
    expect(rs[0].status === "rejected" || rs[1].status === "rejected").toBe(true);
    const h2 = await hashPassword("password4");
    expect(h2).toMatch(/^\$argon2id\$/);
  });

  it("release path (verify): the slot is also released when argon2 errors", async () => {
    setHashConcurrency(1);
    const validHash = await hashPassword("password1");
    const badResult = await verifyPassword("invalid-hash-format", "password");
    expect(badResult).toBe(false);
    const goodResult = await verifyPassword(validHash, "password1");
    expect(goodResult).toBe(true);
  });

  it("shared counter: a hash holding a slot gets verify calls rejected", async () => {
    setHashConcurrency(2);
    // Concurrency 2, six calls dispatched synchronously: hash and verify share one counter, so the hash takes a slot,
    // one verify gets the other, and the remaining four are rejected.
    const hash1 = hashPassword("x".repeat(16));
    const verify1 = verifyPassword(DUMMY_HASH, "x".repeat(16));
    const verify2 = verifyPassword(DUMMY_HASH, "x".repeat(16));
    const verify3 = verifyPassword(DUMMY_HASH, "x".repeat(16));
    const verify4 = verifyPassword(DUMMY_HASH, "x".repeat(16));
    const verify5 = verifyPassword(DUMMY_HASH, "x".repeat(16));
    const results = await Promise.allSettled([hash1, verify1, verify2, verify3, verify4, verify5]);
    const rejectedCount = results.filter(r => r.status === "rejected").length;
    const verifyRejectedCount = results
      .slice(1)
      .filter(r => r.status === "rejected")
      .length;
    expect(verifyRejectedCount).toBeGreaterThan(0);
    expect(rejectedCount).toBe(4);
  });

  it("setHashConcurrency validates its input", async () => {
    expect(() => setHashConcurrency(NaN)).toThrow(RangeError);
    expect(() => setHashConcurrency(0)).toThrow(RangeError);
    expect(() => setHashConcurrency(-1)).toThrow(RangeError);
    expect(() => setHashConcurrency(1.5)).toThrow(RangeError);
    expect(() => setHashConcurrency(1)).not.toThrow();
  });

  it("verifyPassword returns false for an invalid hash instead of throwing", async () => {
    const result = await verifyPassword("not-a-valid-hash-format", "any password");
    expect(result).toBe(false);
  });
});

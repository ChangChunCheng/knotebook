import { describe, it, expect, vi, afterEach } from "vitest";
import { siteLimitDef, type SiteLimitKey } from "@knotebook/shared";
import { LoginThrottle } from "../../src/auth/rate-limit.js";
import {
  AI_LIMIT,
  CONTENT_READ_LIMIT,
  EDIT_LIMIT,
  FixedWindowLimiter,
  FOLDER_LIMIT,
  ONE_TIME_LINK_ATTEMPT_LIMIT,
  ONE_TIME_LINK_MISS_LIMIT,
  SEARCH_LIMIT,
  TOKEN_READ_LIMIT,
  TOKEN_WRITE_LIMIT,
  TRANSFER_EXPORT_LIMIT,
  TRANSFER_WRITE_LIMIT,
  UPLOAD_LIMIT,
  retryAfterSeconds,
} from "../../src/http/rate-limit.js";

describe("#397: constants of the 9 tunable buckets match the registry", () => {
  const pairs: Array<[SiteLimitKey, { readonly limit: number; readonly windowMs: number }]> = [
    ["rateTokenRead", TOKEN_READ_LIMIT],
    ["rateTokenWrite", TOKEN_WRITE_LIMIT],
    ["rateContentRead", CONTENT_READ_LIMIT],
    ["rateEdit", EDIT_LIMIT],
    ["rateSearch", SEARCH_LIMIT],
    ["rateUpload", UPLOAD_LIMIT],
    ["rateAi", AI_LIMIT],
    ["rateTransferExport", TRANSFER_EXPORT_LIMIT],
    ["rateTransferWrite", TRANSFER_WRITE_LIMIT],
  ];
  it.each(pairs)("%s: windowMs and limit equal the registry", (k, c) => {
    expect(c.windowMs).toBe(siteLimitDef(k).windowMs);
    expect(c.limit).toBe(siteLimitDef(k).default);
  });
  it("currentLimit() returns the live limit (for both number and function limits)", () => {
    let n = 5;
    expect(new FixedWindowLimiter({ limit: 7, windowMs: 1_000 }).currentLimit()).toBe(7);
    const l = new FixedWindowLimiter({ limit: () => n, windowMs: 1_000 });
    expect(l.currentLimit()).toBe(5);
    n = 9;
    expect(l.currentLimit()).toBe(9);
  });
});

describe("LoginThrottle key cap (issue #15)", () => {
  /** Uses a different account each time so the assertion reflects only the IP track. */
  const fail = (throttle: LoginThrottle, ip: string, times: number, tag = ip) => {
    for (let i = 0; i < times; i += 1) throttle.recordFailure(`${tag}-account-${i}`, ip);
  };

  it("flooding from different IPs evicts old records instead of growing without bound", () => {
    const now = 1000;
    const throttle = new LoginThrottle({ now: () => now, maxKeys: 2 });

    fail(throttle, "10.0.0.1", 5);
    expect(throttle.checkAllowed("someone-else", "10.0.0.1").allowed).toBe(false);

    // two other IPs fail once each: the cap is 2, 10.0.0.1 is the oldest and is pushed out.
    fail(throttle, "10.0.0.2", 1);
    fail(throttle, "10.0.0.3", 1);

    expect(throttle.checkAllowed("someone-else", "10.0.0.1").allowed).toBe(true);
  });

  it("the most recently failed record is evicted last (a blocked one is not displaced by an older one)", () => {
    let now = 1000;
    const throttle = new LoginThrottle({ now: () => now, maxKeys: 2 });

    fail(throttle, "10.0.0.1", 5); // blocked
    now += 1;
    fail(throttle, "10.0.0.2", 5); // also blocked, but newer
    now += 1;
    fail(throttle, "10.0.0.1", 1); // 10.0.0.1 moves to the tail again
    now += 1;
    fail(throttle, "10.0.0.3", 1); // evicts the oldest - now 10.0.0.2

    expect(throttle.checkAllowed("someone-else", "10.0.0.1").allowed).toBe(false);
    expect(throttle.checkAllowed("someone-else", "10.0.0.2").allowed).toBe(true);
  });

  it("an over-long key is truncated (the entry count is capped, and so must the bytes be)", () => {
    // login's body schema deliberately validates only `z.string()` (so format validation does not become an account-existence oracle) and
    // Fastify's default bodyLimit is 1 MiB, so without truncation a single key could use a lot of memory.
    const now = 1000;
    const throttle = new LoginThrottle({ now: () => now });
    const prefix = "a".repeat(400);

    for (let i = 0; i < 5; i += 1) throttle.recordFailure(`${prefix}@example.com`, "10.0.0.1");

    // two keys that differ only after character 320 land on the same record (real emails never reach it: the RFC 5321 limit is 254).
    // Use an IP that is not blocked, so the assertion reflects only the account track.
    expect(throttle.checkAllowed(`${prefix}@other.example`, "203.0.113.7").allowed).toBe(false);
    expect(throttle.checkAllowed("short@example.com", "203.0.113.7").allowed).toBe(true);
  });

  it("the account track has a cap too", () => {
    const now = 1000;
    const throttle = new LoginThrottle({ now: () => now, maxKeys: 2 });

    for (let i = 0; i < 5; i += 1) throttle.recordFailure("victim@example.com", `10.0.0.${i}`);
    expect(throttle.checkAllowed("victim@example.com", "203.0.113.9").allowed).toBe(false);

    throttle.recordFailure("other-a@example.com", "203.0.113.1");
    throttle.recordFailure("other-b@example.com", "203.0.113.2");

    expect(throttle.checkAllowed("victim@example.com", "203.0.113.9").allowed).toBe(true);
  });
});

describe("LoginThrottle", () => {
  describe("basic backoff mechanism", () => {
    it("still allowed after 4 failures", () => {
      const now = 1000;
      const throttle = new LoginThrottle({ now: () => now });

      for (let i = 0; i < 4; i++) {
        throttle.recordFailure("user1", "192.168.1.1");
      }

      const result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(true);
      expect(result.retryAfterMs).toBeUndefined();
    });

    it("blocked after the 5th failure with retryAfterMs > 0", () => {
      const now = 1000;
      const throttle = new LoginThrottle({ now: () => now });

      for (let i = 0; i < 5; i++) {
        throttle.recordFailure("user1", "192.168.1.1");
      }

      const result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(2000);
    });

    it("retryAfterMs grows with the failure count", () => {
      const failureCounts = [5, 6, 7];
      const retryAfterTimes: number[] = [];

      for (const count of failureCounts) {
        const now = 1000;
        const throttle = new LoginThrottle({ now: () => now });
        for (let i = 0; i < count; i++) {
          throttle.recordFailure("user1", "192.168.1.1");
        }
        const result = throttle.checkAllowed("user1", "192.168.1.1");
        retryAfterTimes.push(result.retryAfterMs!);
      }

      // After 5 failures: 2^(5-4) = 2 seconds = 2000ms
      expect(retryAfterTimes[0]).toBe(2000);

      // After 6 failures: 2^(6-4) = 4 seconds = 4000ms
      expect(retryAfterTimes[1]).toBe(4000);

      // After 7 failures: 2^(7-4) = 8 seconds = 8000ms
      expect(retryAfterTimes[2]).toBe(8000);
    });
  });

  describe("failure count preservation (critical)", () => {
    it("the count is not reset when the backoff window expires: 5 failures -> locked 2 s -> +1 after unlock -> locked 4 s", () => {
      let now = 1000;
      const throttle = new LoginThrottle({ now: () => now });

      for (let i = 0; i < 5; i++) {
        throttle.recordFailure("user1", "192.168.1.1");
      }

      let result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(2000);

      now = 3001;

      result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(true);

      throttle.recordFailure("user1", "192.168.1.1");

      // 2^(6-4) = 4 seconds from lastFailureTime = 3001
      result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(4000);
    });
  });

  describe("time-based unlocking with fake clock", () => {
    it("fake clock advancing past the backoff window -> allowed", () => {
      let now = 1000;
      const throttle = new LoginThrottle({ now: () => now });

      for (let i = 0; i < 5; i++) {
        throttle.recordFailure("user1", "192.168.1.1");
      }

      let result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(false);

      now = 3001;

      result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(true);
    });

    it("exact boundary: allowed at last+2000, blocked at last+1999", () => {
      let now = 1000;
      const throttle = new LoginThrottle({ now: () => now });

      for (let i = 0; i < 5; i++) {
        throttle.recordFailure("user1", "192.168.1.1");
      }

      now = 2999;
      let result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(1);

      // half-open window: blocked while elapsedMs < backoffMs, not <=
      now = 3000;
      result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(true);
      expect(result.retryAfterMs).toBeUndefined();

      now = 2999;
      result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(1);
    });
  });

  describe("recordSuccess behavior", () => {
    it("recordSuccess clears the account count but keeps the IP count", () => {
      const now = 1000;
      const throttle = new LoginThrottle({ now: () => now });

      for (let i = 0; i < 5; i++) {
        throttle.recordFailure("account1", "192.168.1.1");
      }

      let result = throttle.checkAllowed("account1", "192.168.1.1");
      expect(result.allowed).toBe(false);

      throttle.recordSuccess("account1", "192.168.1.1");

      result = throttle.checkAllowed("account1", "192.168.1.1");
      expect(result.allowed).toBe(false);

      result = throttle.checkAllowed("account1", "192.168.1.2");
      expect(result.allowed).toBe(true);

      result = throttle.checkAllowed("account2", "192.168.1.1");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(2000);
    });

    it("after recordSuccess the count restarts from zero (on a different IP): 4 more failures are still allowed", () => {
      const now = 1000;
      const throttle = new LoginThrottle({ now: () => now });

      for (let i = 0; i < 5; i++) {
        throttle.recordFailure("user1", "192.168.1.1");
      }

      let result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(false);

      throttle.recordSuccess("user1", "192.168.1.1");

      result = throttle.checkAllowed("user1", "192.168.1.2");
      expect(result.allowed).toBe(true);

      for (let i = 0; i < 4; i++) {
        throttle.recordFailure("user1", "192.168.1.2");
        result = throttle.checkAllowed("user1", "192.168.1.2");
        expect(result.allowed).toBe(true);
      }

      throttle.recordFailure("user1", "192.168.1.2");
      result = throttle.checkAllowed("user1", "192.168.1.2");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(2000);
    });

    it("unrelated accounts/IPs are unaffected by another recordSuccess", () => {
      const now = 1000;
      const throttle = new LoginThrottle({ now: () => now });

      for (let i = 0; i < 5; i++) {
        throttle.recordFailure("user1", "192.168.1.1");
      }

      for (let i = 0; i < 5; i++) {
        throttle.recordFailure("user2", "192.168.1.2");
      }

      throttle.recordSuccess("user1", "192.168.1.1");

      let result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(false);

      result = throttle.checkAllowed("user1", "192.168.1.3");
      expect(result.allowed).toBe(true);

      result = throttle.checkAllowed("user2", "192.168.1.2");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(2000);
    });
  });

  describe("account and IP independence (take stricter)", () => {
    it("an account failing once on each of 5 IPs -> a clean IP is also blocked by the account count", () => {
      const now = 1000;
      const throttle = new LoginThrottle({ now: () => now });

      for (let i = 0; i < 5; i++) {
        throttle.recordFailure("account1", `192.168.1.${i}`);
      }

      const result = throttle.checkAllowed("account1", "192.168.1.99");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(2000);
    });

    it("an IP failed once by each of 5 accounts -> a new account on the same IP is also blocked by the IP count", () => {
      const now = 1000;
      const throttle = new LoginThrottle({ now: () => now });

      for (let i = 0; i < 5; i++) {
        throttle.recordFailure(`account${i}`, "192.168.1.1");
      }

      const result = throttle.checkAllowed("newaccount", "192.168.1.1");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(2000);
    });

    it("account and IP backoff windows differ -> retryAfterMs is the larger one (exact)", () => {
      let now = 1000;
      const throttle = new LoginThrottle({ now: () => now });

      for (let i = 0; i < 5; i++) {
        throttle.recordFailure("account1", "192.168.1.1");
      }

      now = 2500;

      for (let i = 0; i < 1; i++) {
        throttle.recordFailure("account2", "192.168.1.1");
      }

      now = 2500;

      // Now account1 has 5 failures (last at 1000), IP has 6 failures (last at 2500)
      // account1 retryAfter: max(0, 2000 - 1500) = 500ms
      // IP retryAfter: max(0, 4000 - 0) = 4000ms
      // Should return max(500, 4000) = 4000ms
      const result = throttle.checkAllowed("account1", "192.168.1.1");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(4000);
    });
  });

  describe("backoff expiration cap", () => {
    it("backoff cap: after many failures retryAfterMs <= 15 minutes (900000 ms)", () => {
      const now = 1000;
      const throttle = new LoginThrottle({ now: () => now });

      for (let i = 0; i < 50; i++) {
        throttle.recordFailure("user1", "192.168.1.1");
      }

      const result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(900000);
    });

    it("exact cap: the 14th failure reaches the 15-minute cap", () => {
      const now = 1000;
      const throttle = new LoginThrottle({ now: () => now });

      // 2^(14-4) = 2^10 = 1024 seconds > 900 seconds cap (n>=14 hits cap)
      for (let i = 0; i < 14; i++) {
        throttle.recordFailure("user1", "192.168.1.1");
      }

      const result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(900000);
    });
  });

  describe("idle timeout cleanup", () => {
    it("a record with no new failure for over 15 minutes is cleaned up", () => {
      let now = 1000;
      const throttle = new LoginThrottle({ now: () => now });

      for (let i = 0; i < 5; i++) {
        throttle.recordFailure("user1", "192.168.1.1");
      }

      let result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(false);

      now = 1000 + 900000 + 1;

      result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(true);

      throttle.recordFailure("user1", "192.168.1.1");
      result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(true);
    });

    it("a record under 5 failures is also cleaned up after 15 minutes without new failures", () => {
      let now = 1000;
      const throttle = new LoginThrottle({ now: () => now });

      for (let i = 0; i < 3; i++) {
        throttle.recordFailure("user1", "192.168.1.1");
      }

      let result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(true);

      now = 1000 + 900000 + 1;

      result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(true);

      throttle.recordFailure("user1", "192.168.1.1");
      result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(true);

      for (let i = 0; i < 3; i++) {
        throttle.recordFailure("user1", "192.168.1.1");
      }
      result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(true); // only 4 failures in total

      throttle.recordFailure("user1", "192.168.1.1");
      result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(2000);
    });
  });

  describe("edge cases", () => {
    it("checkAllowed returns allowed=true when there are no failures", () => {
      const now = 1000;
      const throttle = new LoginThrottle({ now: () => now });
      const result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(true);
      expect(result.retryAfterMs).toBeUndefined();
    });

    it("exact boundary: checkAllowed returns allowed=true after the 4th failure", () => {
      const now = 1000;
      const throttle = new LoginThrottle({ now: () => now });
      for (let i = 0; i < 4; i++) {
        throttle.recordFailure("user1", "192.168.1.1");
      }
      const result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(true);
      expect(result.retryAfterMs).toBeUndefined();
    });

    it("exact boundary: checkAllowed returns allowed=false with retryAfterMs=2000 after the 5th failure", () => {
      const now = 1000;
      const throttle = new LoginThrottle({ now: () => now });
      for (let i = 0; i < 5; i++) {
        throttle.recordFailure("user1", "192.168.1.1");
      }
      const result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(2000);
    });
  });
});

// POST /api/ai throttle shape (same validation convention as the other *_LIMIT constants exported from http/rate-limit.ts):
// pins the concrete figure "30 per minute" so it cannot change unnoticed.
describe("AI_LIMIT", () => {
  it("shape: limit=30, windowMs=60_000 (30 per minute)", () => {
    expect(AI_LIMIT).toEqual({ limit: 30, windowMs: 60_000 });
  });

  it("applied to FixedWindowLimiter: 30 allowed, the 31st blocked", () => {
    const limiter = new FixedWindowLimiter(AI_LIMIT);
    for (let i = 0; i < 30; i++) {
      expect(limiter.consume("user1")).toBe(true);
    }
    expect(limiter.consume("user1")).toBe(false);
  });

  it("different users are counted independently", () => {
    const limiter = new FixedWindowLimiter(AI_LIMIT);
    for (let i = 0; i < 30; i++) limiter.consume("user1");
    expect(limiter.consume("user1")).toBe(false);
    expect(limiter.consume("user2")).toBe(true);
  });
});

// #286: the two buckets of the reset link; pins the concrete figures.
describe("ONE_TIME_LINK_MISS_LIMIT / ONE_TIME_LINK_ATTEMPT_LIMIT", () => {
  it("miss bucket: 30 per minute (key=ip)", () => {
    expect(ONE_TIME_LINK_MISS_LIMIT).toEqual({ limit: 30, windowMs: 60_000 });
  });

  it("attempt bucket: 10 per hour (key=link:id)", () => {
    expect(ONE_TIME_LINK_ATTEMPT_LIMIT).toEqual({ limit: 10, windowMs: 3_600_000 });
  });
});

// Folder write bucket (folders/service.ts routes and the MCP folder tools): pins "600 per minute" - the docs and CHANGELOG hard-code this figure.
describe("FOLDER_LIMIT", () => {
  it("shape: limit=600, windowMs=60_000 (600 per minute)", () => {
    expect(FOLDER_LIMIT).toEqual({ limit: 600, windowMs: 60_000 });
  });
});

describe("FixedWindowLimiter.isBlocked (#72: pre-check that does not count)", () => {
  it("isBlocked does not consume quota: asking N times leaves consume's available count unchanged", () => {
    const limiter = new FixedWindowLimiter({ limit: 2, windowMs: 60_000 });
    for (let i = 0; i < 10; i += 1) expect(limiter.isBlocked("k")).toBe(false);
    expect(limiter.consume("k")).toBe(true);
    expect(limiter.consume("k")).toBe(true);
    expect(limiter.consume("k")).toBe(false);
  });

  it("isBlocked returns true once the quota is used up; other keys are unaffected", () => {
    const limiter = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    expect(limiter.isBlocked("a")).toBe(false);
    limiter.consume("a");
    expect(limiter.isBlocked("a")).toBe(true);
    expect(limiter.isBlocked("b")).toBe(false);
  });

  it("isBlocked returns false after the window expires (same window semantics as consume)", () => {
    vi.useFakeTimers();
    try {
      const limiter = new FixedWindowLimiter({ limit: 1, windowMs: 1_000 });
      limiter.consume("k");
      expect(limiter.isBlocked("k")).toBe(true);
      vi.advanceTimersByTime(1_001);
      expect(limiter.isBlocked("k")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("FixedWindowLimiter function limits and retryAfterMs", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("limit as a function: read live on every consume (not a snapshot at construction)", () => {
    let cap = 2;
    const l = new FixedWindowLimiter({ limit: () => cap, windowMs: 60_000 });
    expect(l.consume("u")).toBe(true);
    expect(l.consume("u")).toBe(true);
    expect(l.consume("u")).toBe(false);
    cap = 5; // raised within the same window: the 4th (count 4 <= 5) is allowed
    expect(l.consume("u")).toBe(true);
  });

  it("isBlocked also uses the current function value", () => {
    let cap = 1;
    const l = new FixedWindowLimiter({ limit: () => cap, windowMs: 60_000 });
    expect(l.consume("u")).toBe(true);
    expect(l.isBlocked("u")).toBe(true);
    cap = 3;
    expect(l.isBlocked("u")).toBe(false);
  });

  it("consumeMany also uses the current function value (including clamping when n > limit)", () => {
    let cap = 2;
    const l = new FixedWindowLimiter({ limit: () => cap, windowMs: 60_000 });
    expect(l.consumeMany("u", 2)).toBe(true);
    expect(l.consumeMany("u", 1)).toBe(false);
    cap = 4;
    expect(l.consumeMany("u", 2)).toBe(true);
    expect(l.consumeMany("u", 1)).toBe(false);
  });

  it("a numeric limit works as before (existing call sites unchanged)", () => {
    const l = new FixedWindowLimiter({ limit: 2, windowMs: 60_000 });
    expect([l.consume("u"), l.consume("u"), l.consume("u")]).toEqual([true, true, false]);
    expect(l.isBlocked("u")).toBe(true);
  });

  it("retryAfterMs: 0 with no window; 50 000 left at t+10 s once opened; 0 after expiry; neither counts nor opens a window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-03T00:00:00Z"));
    const l = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    expect(l.retryAfterMs("u")).toBe(0);
    expect(l.consume("u")).toBe(true); // retryAfterMs did not open a window: this call is still the first
    vi.setSystemTime(new Date("2026-11-03T00:00:10Z"));
    expect(l.retryAfterMs("u")).toBe(50_000);
    expect(l.retryAfterMs("u")).toBe(50_000);
    expect(l.isBlocked("u")).toBe(true); // retryAfterMs does not count: the count is still 1
    vi.setSystemTime(new Date("2026-11-03T00:01:00Z"));
    expect(l.retryAfterMs("u")).toBe(0);
    vi.setSystemTime(new Date("2026-11-03T00:01:01Z")); // after expiry it is also 0, not negative
    expect(l.retryAfterMs("u")).toBe(0);
    expect(l.retryAfterMs("other")).toBe(0);
  });

  it("retryAfterSeconds: rounds up, at least 1 (Retry-After must not be 0)", () => {
    expect([1, 1000, 1001, 0, 59_999, 60_000].map(retryAfterSeconds)).toEqual([1, 1, 2, 1, 60, 60]);
  });

  it("TRANSFER_EXPORT_LIMIT: 10 per hour", () => {
    expect(TRANSFER_EXPORT_LIMIT).toEqual({ limit: 10, windowMs: 3_600_000 });
  });

  it("TRANSFER_WRITE_LIMIT: 30 per minute", () => {
    expect(TRANSFER_WRITE_LIMIT).toEqual({ limit: 30, windowMs: 60_000 });
  });
});

describe("FixedWindowLimiter.consumeTicket / refund (charged before write-back parsing, refunded for empty regions; a refund must land in the same window)", () => {
  afterEach(() => vi.useRealTimers());

  it("refund of one in the current window: limit 1 used up -> refund(that ticket) -> another consume is allowed", () => {
    const l = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const ticket = l.consumeTicket("u");
    expect(ticket).not.toBeNull();
    expect(l.isBlocked("u")).toBe(true);
    l.refund("u", ticket!);
    expect(l.isBlocked("u")).toBe(false);
    expect(l.consume("u")).toBe(true);
    expect(l.consume("u")).toBe(false);
  });

  it("a rejected call returns null (still counted); with no window and count 0, refund does nothing (count does not go negative, no window opened)", () => {
    vi.useFakeTimers();
    const l = new FixedWindowLimiter({ limit: 1, windowMs: 1_000 });
    l.refund("u", Date.now()); // no window
    expect(l.retryAfterMs("u")).toBe(0);
    const t1 = l.consumeTicket("u");
    expect(t1).toBe(Date.now());
    expect(l.consumeTicket("u")).toBeNull(); // a rejected call is counted too (count 2)
    l.refund("u", t1!);
    l.refund("u", t1!);
    l.refund("u", t1!); // count is already 0: does not go negative
    expect(l.consume("u")).toBe(true);
    expect(l.consume("u")).toBe(false);
  });

  it("after the window expired and a new one opened, refunding an old ticket does not reduce the new window", () => {
    vi.useFakeTimers();
    const l = new FixedWindowLimiter({ limit: 1, windowMs: 1_000 });
    const old = l.consumeTicket("u");
    expect(old).not.toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(l.consume("u")).toBe(true); // new window, used up
    l.refund("u", old!); // ticket of the old window: leaves the new window alone
    expect(l.isBlocked("u")).toBe(true);
    expect(l.consume("u")).toBe(false);
  });
});

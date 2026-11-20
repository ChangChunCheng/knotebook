import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { decodeJwt, SignJWT } from "jose";
import { schemaVersionFromBody, signCollabToken, verifyCollabToken } from "../../src/collab/token.js";
import { FixedWindowLimiter } from "../../src/http/rate-limit.js";

const secret = "a".repeat(64);
const SID = "00000000-0000-4000-8000-0000000000aa";

describe("collab token jwt", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sign/verify round trip: noteId/role/tv/sid are correct", async () => {
    const token = await signCollabToken(secret, { noteId: "note-1", userId: "user-1", role: "editor", tv: 3, sid: SID, sv: 0 });
    const result = await verifyCollabToken(secret, token);
    expect(result).toEqual({ noteId: "note-1", userId: "user-1", role: "editor", tv: 3, sid: SID, sv: 0 });
  });

  it("role 'none' can be signed and verified (users without permission also get a valid token)", async () => {
    const token = await signCollabToken(secret, { noteId: "note-1", userId: "user-1", role: "none", tv: 0, sid: SID, sv: 0 });
    const result = await verifyCollabToken(secret, token);
    expect(result).toEqual({ noteId: "note-1", userId: "user-1", role: "none", tv: 0, sid: SID, sv: 0 });
  });

  it("claims include tv (verifiable at the JWT payload level)", async () => {
    const token = await signCollabToken(secret, { noteId: "note-1", userId: "user-1", role: "viewer", tv: 7, sid: SID, sv: 0 });
    const payload = decodeJwt(token);
    expect(payload.tv).toBe(7);
  });

  it("tampered token -> null", async () => {
    // Change the first character of the payload (not the last character of the signature: only some bits of the last base64url
    // character are meaningful, so flipping it could, with tiny probability, leave the decoded bytes unchanged and give a false green).
    const token = await signCollabToken(secret, { noteId: "note-1", userId: "user-1", role: "owner", tv: 1, sid: SID, sv: 0 });
    const [header, payload, signature] = token.split(".");
    const flippedFirstChar = payload[0] === "a" ? "b" : "a";
    const tampered = `${header}.${flippedFirstChar + payload.slice(1)}.${signature}`;
    expect(await verifyCollabToken(secret, tampered)).toBeNull();
  });

  it("garbage string -> null", async () => {
    expect(await verifyCollabToken(secret, "not-a-jwt-at-all")).toBeNull();
    expect(await verifyCollabToken(secret, "")).toBeNull();
  });

  it("expired token -> null", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const token = await signCollabToken(secret, { noteId: "note-1", userId: "user-1", role: "editor", tv: 1, sid: SID, sv: 0 });
    // 120s TTL (COLLAB_TOKEN_TTL_SECONDS), advance 121s
    vi.setSystemTime(new Date("2026-01-01T00:02:01Z"));
    expect(await verifyCollabToken(secret, token)).toBeNull();
  });

  it("a token signed with the :session key must fail verification with :collab (the two keys must not verify each other, see sessionKey in auth/session.ts)", async () => {
    // Reproduce sessionKey's derivation (sha256(secret + ":session")) to sign a token, then check that verifyCollabToken here
    // (sha256(secret + ":collab")) rejects it.
    const sessionKey = createHash("sha256").update(`${secret}:session`).digest();
    const token = await new SignJWT({ noteId: "note-1", role: "editor", tv: 1 })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-1")
      .setIssuedAt()
      .setExpirationTime("120s")
      .sign(sessionKey);
    expect(await verifyCollabToken(secret, token)).toBeNull();
  });
  it("#269: sv claim round-trips; an old-shape token (no sv) verifies as sv=0 and is not treated as a bad token", async () => {
    const withSv = await signCollabToken(secret, { noteId: "note-1", userId: "user-1", role: "owner", tv: 1, sid: SID, sv: 7 });
    expect((await verifyCollabToken(secret, withSv))?.sv).toBe(7);
    const key = createHash("sha256").update(`${secret}:collab`).digest();
    const legacy = await new SignJWT({ noteId: "note-1", role: "owner", tv: 1, sid: SID }).setProtectedHeader({ alg: "HS256" }).setSubject("user-1").setIssuedAt().setExpirationTime("120s").sign(key);
    expect(await verifyCollabToken(secret, legacy)).toEqual({ userId: "user-1", noteId: "note-1", role: "owner", tv: 1, sid: SID, sv: 0 });
  });

  it("#388: a token without sid (signed before the upgrade) -> null (bad token); the same one with a sid passes", async () => {
    const key = createHash("sha256").update(`${secret}:collab`).digest();
    const sign = (claims: Record<string, unknown>) =>
      new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setSubject("user-1").setIssuedAt().setExpirationTime("120s").sign(key);
    expect(await verifyCollabToken(secret, await sign({ noteId: "note-1", role: "owner", tv: 1, sv: 0 }))).toBeNull();
    expect(await verifyCollabToken(secret, await sign({ noteId: "note-1", role: "owner", tv: 1, sid: "not-a-uuid", sv: 0 }))).toBeNull(); // shape follows verifySession
    expect(await verifyCollabToken(secret, await sign({ noteId: "note-1", role: "owner", tv: 1, sid: SID.toUpperCase(), sv: 0 }))).toBeNull();
    expect((await verifyCollabToken(secret, await sign({ noteId: "note-1", role: "owner", tv: 1, sid: SID, sv: 0 })))?.sid).toBe(SID);
  });

  it("#269: schemaVersionFromBody: absent, non-object, non-integer all give 0; integers are accepted", () => {
    expect(schemaVersionFromBody(undefined)).toBe(0);
    expect(schemaVersionFromBody(null)).toBe(0);
    expect(schemaVersionFromBody("1")).toBe(0);
    expect(schemaVersionFromBody({})).toBe(0);
    expect(schemaVersionFromBody({ noteSchemaVersion: "1" })).toBe(0);
    expect(schemaVersionFromBody({ noteSchemaVersion: 1.5 })).toBe(0);
    expect(schemaVersionFromBody({ noteSchemaVersion: 3 })).toBe(3);
  });
});

describe("FixedWindowLimiter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("60 calls pass, the 61st is blocked", () => {
    const limiter = new FixedWindowLimiter({ limit: 60, windowMs: 60_000 });
    for (let i = 0; i < 60; i++) {
      expect(limiter.consume("user-1")).toBe(true);
    }
    expect(limiter.consume("user-1")).toBe(false);
  });

  it("calls after exceeding the limit still count (not only failures count): continued calls within the window keep returning false", () => {
    const limiter = new FixedWindowLimiter({ limit: 2, windowMs: 60_000 });
    expect(limiter.consume("k")).toBe(true);
    expect(limiter.consume("k")).toBe(true);
    expect(limiter.consume("k")).toBe(false);
    expect(limiter.consume("k")).toBe(false);
  });

  it("window rolling: after exceeding, advancing past windowMs resets the count and allows again", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new FixedWindowLimiter({ limit: 2, windowMs: 1_000 });
    expect(limiter.consume("k")).toBe(true);
    expect(limiter.consume("k")).toBe(true);
    expect(limiter.consume("k")).toBe(false);

    vi.setSystemTime(1_000);
    expect(limiter.consume("k")).toBe(true);
    expect(limiter.consume("k")).toBe(true);
    expect(limiter.consume("k")).toBe(false);
  });

  it("consumeMany (#175): enough quota deducts n at once; not enough returns false and deducts nothing; n <= 0 always passes without counting", () => {
    const limiter = new FixedWindowLimiter({ limit: 5, windowMs: 60_000 });
    expect(limiter.consumeMany("k", 0)).toBe(true);
    expect(limiter.isBlocked("k")).toBe(false);
    expect(limiter.consumeMany("k", 3)).toBe(true);
    expect(limiter.consumeMany("k", 3)).toBe(false); // 3 + 3 > 5: rejected, count stays 3
    expect(limiter.consumeMany("k", 2)).toBe(true); // 3 + 2 = 5: allowed (shows the previous call was not charged)
    expect(limiter.consume("k")).toBe(false);
  });

  it("consumeMany with n > limit is clamped to the whole window quota: allowed and charged in full only in an empty window; another call in the same window is rejected without charge; the next window allows again", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new FixedWindowLimiter({ limit: 5, windowMs: 1_000 });
    expect(limiter.consumeMany("k", 7)).toBe(true); // new window: allowed (without clamping 0 + 7 > 5 would be rejected in every window)
    expect(limiter.isBlocked("k")).toBe(true);
    expect(limiter.consumeMany("k", 7)).toBe(false);
    expect(limiter.consume("k")).toBe(false); // a regular upload is blocked until the window ends

    vi.setSystemTime(1_000);
    expect(limiter.consumeMany("k", 1)).toBe(true);
    expect(limiter.consumeMany("k", 7)).toBe(false); // non-empty window (count 1): clamped it needs 5, and 1 + 5 > 5 -> rejected, not charged
    expect(limiter.consumeMany("k", 4)).toBe(true); // 1 + 4 = 5: allowed (shows the previous call was not charged)
    expect(limiter.consume("k")).toBe(false);
  });

  it("different keys are counted independently", () => {
    const limiter = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    expect(limiter.consume("a")).toBe(true);
    expect(limiter.consume("b")).toBe(true);
    expect(limiter.consume("a")).toBe(false);
    expect(limiter.consume("b")).toBe(false);
  });

  it("maxKeys evicts the oldest key (insertion order)", () => {
    const limiter = new FixedWindowLimiter({ limit: 1, windowMs: 60_000, maxKeys: 2 });
    expect(limiter.consume("k1")).toBe(true);
    expect(limiter.consume("k2")).toBe(true);
    expect(limiter.consume("k3")).toBe(true); // evicts the oldest, k1 -> {k2,k3}

    // k1 was evicted, so it is a brand-new key and is allowed once more (had it not been evicted it would be blocked, limit=1 used up);
    // this insert evicts the current oldest k2 -> {k3,k1}.
    expect(limiter.consume("k1")).toBe(true);

    // k3 was never evicted (it stayed in the map throughout), so its already-at-limit count is unaffected.
    expect(limiter.consume("k3")).toBe(false);
  });
});

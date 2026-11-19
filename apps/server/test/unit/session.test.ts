import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { decodeJwt, SignJWT } from "jose";
import type { FastifyReply } from "fastify";
import { SITE_LIMITS } from "@knotebook/shared";
import type { AppConfig } from "../../src/config.js";
import { setSessionCookie } from "../../src/auth/cookies.js";
import { signSession, verifySession } from "../../src/auth/session.js";
import { newSessionValues } from "../../src/auth/tx/sessions.js";

const secret = "a".repeat(64);
const sid = "0f3c2a4e-1b2d-4c5e-8f60-7a8b9c0d1e2f";
const TTL = SITE_LIMITS.sessionTtlSeconds.default;

describe("session jwt", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sign/verify round trip: sub/tv/sid correct", async () => {
    const token = await signSession(secret, { userId: "user-123", tv: 5, sid }, TTL);
    const result = await verifySession(secret, token);
    expect(result).toEqual({ userId: "user-123", tv: 5, sid });
  });

  it("#388: an old JWT without sid -> null; a sid that is not uuid-shaped -> null; the same signing with a valid sid passes", async () => {
    const key = createHash("sha256").update(`${secret}:session`).digest();
    const sign = (claims: Record<string, unknown>) =>
      new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setSubject("user-123").setIssuedAt().setExpirationTime("7d").sign(key);
    expect(await verifySession(secret, await sign({ tv: 5 }))).toBeNull();
    expect(await verifySession(secret, await sign({ tv: 5, sid: "not-a-uuid" }))).toBeNull();
    expect(await verifySession(secret, await sign({ tv: 5, sid: sid.toUpperCase() }))).toBeNull(); // the DB outputs uuids in lowercase
    expect(await verifySession(secret, await sign({ tv: 5, sid: 42 }))).toBeNull();
    expect(await verifySession(secret, await sign({ tv: 5, sid }))).toEqual({ userId: "user-123", tv: 5, sid });
  });

  it("tampered token -> null", async () => {
    // Tamper with the payload segment, not the signature's last character: only some bits of the last base64url character are
    // significant, so flipping it has a small chance of leaving the decoded bytes unchanged (false green). Changing the payload's first
    // character changes the decoded result, and the signature is still over the original payload, so verification must fail.
    const token = await signSession(secret, { userId: "user-123", tv: 5, sid }, TTL);
    const [header, payload, signature] = token.split(".");
    const flippedFirstChar = payload[0] === "a" ? "b" : "a";
    const tamperedPayload = flippedFirstChar + payload.slice(1);
    const tampered = `${header}.${tamperedPayload}.${signature}`;
    expect(await verifySession(secret, tampered)).toBeNull();
  });

  it("garbage string -> null", async () => {
    expect(await verifySession(secret, "not-a-jwt-at-all")).toBeNull();
    expect(await verifySession(secret, "")).toBeNull();
  });

  it("token signed with the wrong secret -> null", async () => {
    const token = await signSession(secret, { userId: "user-123", tv: 5, sid }, TTL);
    expect(await verifySession("b".repeat(64), token)).toBeNull();
  });

  it("expired token -> null", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const token = await signSession(secret, { userId: "user-123", tv: 1, sid }, TTL);
    // 7-day exp, advance 8 days
    vi.setSystemTime(new Date("2026-01-09T00:00:00Z"));
    expect(await verifySession(secret, token)).toBeNull();
  });

  it("default lifetime: exp is exactly issue time + 7 days", async () => {
    const token = await signSession(secret, { userId: "user-123", tv: 5, sid }, TTL);
    const payload = decodeJwt(token);
    expect(payload.exp).toBeDefined();
    expect(payload.iat).toBeDefined();
    expect(payload.exp! - payload.iat!).toBe(7 * 24 * 60 * 60);
  });

  it("#397: signSession's exp - iat equals the ttl passed in", async () => {
    const payload = decodeJwt(await signSession(secret, { userId: "user-123", tv: 5, sid }, 3600));
    expect(payload.exp! - payload.iat!).toBe(3600);
  });
});

describe("#397: session row and cookie lifetimes follow the ttl passed in", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("newSessionValues(\"u\", 3600).expiresAt is now + 3600 s", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const values = newSessionValues("u", 3600);
    expect(values).toEqual({ userId: "u", expiresAt: new Date("2026-01-01T01:00:00Z") });
  });

  it("setSessionCookie's maxAge equals the ttl passed in", () => {
    const setCookie = vi.fn();
    const reply = { setCookie } as unknown as FastifyReply;
    setSessionCookie(reply, { cookieSecure: false } as AppConfig, "jwt-value", 3600);
    expect(setCookie).toHaveBeenCalledTimes(1);
    expect(setCookie.mock.calls[0]![2]).toMatchObject({ maxAge: 3600 });
  });
});

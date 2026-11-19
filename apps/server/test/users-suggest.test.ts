import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { USER_SUGGEST_MAX_RESULTS, type UserSuggestResponse } from "@knotebook/shared";
import { users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { buildTestApp, freshLimiters } from "./helpers.js";
import { cookieOf, seedGroup } from "./group-helpers.js";

async function user(db: Db, email: string, displayName: string, disabled = false): Promise<{ id: string; email: string }> {
  const handle = email.split("@")[0]!.replace(/[^a-z0-9-]/g, "-");
  const [u] = await db
    .insert(users)
    .values({ email, handle, displayName, ...(disabled ? { disabledAt: new Date() } : {}) })
    .returning();
  return { id: u!.id, email: u!.email };
}

async function suggest(app: FastifyInstance, userId: string, q: string) {
  return app.inject({ method: "GET", url: `/api/users/suggest?q=${encodeURIComponent(q)}`, cookies: await cookieOf(userId) });
}

async function emails(app: FastifyInstance, userId: string, q: string): Promise<string[]> {
  const res = await suggest(app, userId, q);
  expect(res.statusCode).toBe(200);
  return (res.json() as UserSuggestResponse).users.map(u => u.email);
}

describe("GET /api/users/suggest", () => {
  it("returns only members of the same groups: strangers do not appear; correct shape", async () => {
    const { app, db } = await buildTestApp();
    const me = await user(db, "me-s1@example.com", "Me");
    const mate = await user(db, "mate-s1@example.com", "Teammate");
    await user(db, "stranger-s1@example.com", "Stranger");
    await seedGroup(db, "G", [{ userId: me.id, role: "admin" }, { userId: mate.id, role: "member" }]);

    const res = await suggest(app, me.id, "s1@");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ users: [{ userId: mate.id, email: "mate-s1@example.com", displayName: "Teammate", avatar: null }] });
  });

  it("no longer appears after being removed from the group", async () => {
    const { app, db } = await buildTestApp();
    const me = await user(db, "me-s2@example.com", "Me");
    const mate = await user(db, "mate-s2@example.com", "Teammate");
    const g = await seedGroup(db, "G", [{ userId: me.id, role: "admin" }, { userId: mate.id, role: "member" }]);
    expect(await emails(app, me.id, "mate")).toEqual(["mate-s2@example.com"]);

    const del = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${mate.id}`, cookies: await cookieOf(me.id) });
    expect(del.statusCode).toBe(204);
    expect(await emails(app, me.id, "mate")).toEqual([]);
    expect(await emails(app, mate.id, "me-s2")).toEqual([]);
  });

  it("people I shared notes with appear; an owner who shared with me does not (the sharee cannot see the owner's email)", async () => {
    const { app, db } = await buildTestApp();
    const me = await user(db, "me-s3@example.com", "Me");
    const recipient = await user(db, "recipient-s3@example.com", "Recipient");
    const created = await app.inject({ method: "POST", url: "/api/notes", cookies: await cookieOf(me.id), payload: {} });
    const noteId = (created.json() as { id: string }).id;
    const put = await app.inject({
      method: "PUT", url: `/api/notes/${noteId}/shares`, cookies: await cookieOf(me.id), payload: { email: recipient.email, role: "viewer" },
    });
    expect(put.statusCode).toBe(200);

    expect(await emails(app, me.id, "recipient")).toEqual(["recipient-s3@example.com"]);
    expect(await emails(app, recipient.id, "me-s3")).toEqual([]);

    const revoke = await app.inject({ method: "DELETE", url: `/api/notes/${noteId}/shares/${recipient.id}`, cookies: await cookieOf(me.id) });
    expect(revoke.statusCode).toBe(204);
    expect(await emails(app, me.id, "recipient")).toEqual([]);
  });

  it("after a shared note goes to trash, the other person no longer appears", async () => {
    const { app, db } = await buildTestApp();
    const me = await user(db, "me-s10@example.com", "Me");
    const recipient = await user(db, "recipient-s10@example.com", "Recipient");
    const created = await app.inject({ method: "POST", url: "/api/notes", cookies: await cookieOf(me.id), payload: {} });
    const noteId = (created.json() as { id: string }).id;
    const put = await app.inject({
      method: "PUT", url: `/api/notes/${noteId}/shares`, cookies: await cookieOf(me.id), payload: { email: recipient.email, role: "editor" },
    });
    expect(put.statusCode).toBe(200);
    expect(await emails(app, me.id, "recipient")).toEqual(["recipient-s10@example.com"]);

    const del = await app.inject({ method: "DELETE", url: `/api/notes/${noteId}`, cookies: await cookieOf(me.id) });
    expect(del.statusCode).toBeLessThan(300);
    expect(await emails(app, me.id, "recipient")).toEqual([]);
  });

  it("excludes yourself and disabled accounts; email and display name are matched case-insensitively", async () => {
    const { app, db } = await buildTestApp();
    const me = await user(db, "alpha-s4@example.com", "Alpha Me");
    const mate = await user(db, "zed-s4@example.com", "ALPHA Mate");
    const off = await user(db, "alpha-off-s4@example.com", "Alpha Off", true);
    await seedGroup(db, "G", [{ userId: me.id, role: "admin" }, { userId: mate.id, role: "member" }, { userId: off.id, role: "member" }]);

    expect(await emails(app, me.id, "aLpHa")).toEqual(["zed-s4@example.com"]);
  });

  it("prefix hits come first, the rest by display name", async () => {
    const { app, db } = await buildTestApp();
    const me = await user(db, "me-s5@example.com", "Me");
    const a = await user(db, "x-ann-s5@example.com", "Aaa");
    const b = await user(db, "ann-s5@example.com", "Zzz");
    const c = await user(db, "y-s5@example.com", "Ann Bbb");
    await seedGroup(db, "G", [a, b, c, me].map(u => ({ userId: u.id, role: u === me ? "admin" as const : "member" as const })));

    // b and c hit by prefix (email / display name), ordered by display name Ann Bbb < Zzz; a hits only as a substring and comes last.
    expect(await emails(app, me.id, "ann")).toEqual(["y-s5@example.com", "ann-s5@example.com", "x-ann-s5@example.com"]);
  });

  it(`at most ${USER_SUGGEST_MAX_RESULTS} results; whitespace around q is trimmed`, async () => {
    const { app, db } = await buildTestApp();
    const me = await user(db, "me-s6@example.com", "Me");
    const mates = [];
    for (let i = 0; i < USER_SUGGEST_MAX_RESULTS + 3; i++) mates.push(await user(db, `mate${i}-s6@example.com`, `Mate ${String(i).padStart(2, "0")}`));
    await seedGroup(db, "G", [{ userId: me.id, role: "admin" }, ...mates.map(m => ({ userId: m.id, role: "member" as const }))]);

    const got = await emails(app, me.id, "  mate  ");
    expect(got).toHaveLength(USER_SUGGEST_MAX_RESULTS);
    expect(got[0]).toBe("mate0-s6@example.com");
  });

  it("wildcards are matched literally (%, _, \\)", async () => {
    const { app, db } = await buildTestApp();
    const me = await user(db, "me-s7@example.com", "Me");
    const plain = await user(db, "plain-s7@example.com", "Plain");
    const pct = await user(db, "pct-s7@example.com", "100% sure");
    const und = await user(db, "under-s7@example.com", "a_b");
    const bs = await user(db, "bs-s7@example.com", "back\\slash");
    await seedGroup(db, "G", [me, plain, pct, und, bs].map(u => ({ userId: u.id, role: u === me ? "admin" as const : "member" as const })));

    expect(await emails(app, me.id, "%%")).toEqual([]);
    expect(await emails(app, me.id, "0%")).toEqual(["pct-s7@example.com"]);
    expect(await emails(app, me.id, "__")).toEqual([]);
    expect(await emails(app, me.id, "a_")).toEqual(["under-s7@example.com"]);
    expect(await emails(app, me.id, "k\\s")).toEqual(["bs-s7@example.com"]);
  });

  it("invalid q -> 400 invalid_body (too short, too short after trim, too long, missing, duplicated, extra parameter)", async () => {
    const { app, db } = await buildTestApp();
    const me = await user(db, "me-s8@example.com", "Me");
    const cookies = await cookieOf(me.id);
    for (const url of [
      "/api/users/suggest?q=a",
      "/api/users/suggest?q=%20a%20",
      `/api/users/suggest?q=${"a".repeat(101)}`,
      "/api/users/suggest",
      "/api/users/suggest?q=ab&q=cd",
      "/api/users/suggest?q=ab&x=1",
    ]) {
      const res = await app.inject({ method: "GET", url, cookies });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
    }
    expect((await app.inject({ method: "GET", url: `/api/users/suggest?q=${"a".repeat(100)}`, cookies })).statusCode).toBe(200);
  });

  it("unauthenticated -> 401; Bearer not accepted", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/users/suggest?q=ab" });
    expect(res.statusCode).toBe(401);
    const bearer = await app.inject({ method: "GET", url: "/api/users/suggest?q=ab", headers: { authorization: "Bearer knb_whatever" } });
    expect(bearer.statusCode).toBe(401);
  });

  it("throttle: over the quota -> 429 too_many_requests; 400 does not charge the bucket; key is userId", async () => {
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ userSuggest: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) }) });
    const me = await user(db, "me-s9@example.com", "Me");
    const other = await user(db, "other-s9@example.com", "Other");
    expect((await suggest(app, me.id, "a")).statusCode).toBe(400);
    expect((await suggest(app, me.id, "ab")).statusCode).toBe(200);
    expect((await suggest(app, me.id, "ab")).statusCode).toBe(200);
    const limited = await suggest(app, me.id, "ab");
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("too_many_requests");
    expect((await suggest(app, other.id, "ab")).statusCode).toBe(200);
  });
});

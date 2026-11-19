/** Revocation on disable is covered in the disable section of `admin-users.test.ts`. */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { asc, eq, sql } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp, testConfig } from "./helpers.js";
import { cookieOf, seedUser, waitForBlockedOrSettled, waitForLockWaiters } from "./group-helpers.js";
import { oneTimeLinks, siteSettings, users } from "../src/db/schema.js";
import type { AppDeps } from "../src/app.js";
import type { Db } from "../src/db/index.js";
import { hashPassword } from "../src/auth/password.js";
import { hashToken } from "../src/auth/api-token.js";

const PASSWORD = "correct-horse-battery";
const TOKEN_RE = /^knbp_[A-Za-z0-9_-]{43}$/;
const REDACTED = "產生重設密碼連結時發生非預期的資料庫錯誤（錯誤本體已遮蔽）";
/** Same as `admin-ai-log-redaction.test.ts`: the two shapes in which DrizzleQueryError params reach the JSON log. */
const PARAMS_LEAK = /params: |"params"\s*:/;

/** Account with a password built via the real `hashPassword` (like insertUser in `admin-users.test.ts`). */
async function userWithPassword(db: Db, over: { disabled?: boolean; email?: string } = {}) {
  const tag = randomUUID().slice(0, 12);
  const [u] = await db
    .insert(users)
    .values({
      email: over.email ?? `pr-${tag}@example.com`,
      handle: `pr-${tag}`,
      displayName: `PR ${tag}`,
      passwordHash: await hashPassword(PASSWORD),
      ...(over.disabled ? { disabledAt: new Date() } : {}),
    })
    .returning();
  return u!;
}

/** Collects both the `logMethod` hook (structured fields) and the stream (whole output string). */
function logs() {
  const lines: Array<{ msg?: string; obj: Record<string, unknown> }> = [];
  const out: string[] = [];
  return {
    lines,
    out,
    options: {
      logger: {
        level: "info",
        stream: { write: (chunk: string) => void out.push(chunk) },
        hooks: {
          logMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => void) {
            const [obj, msg] = args as [Record<string, unknown>, string | undefined];
            if (typeof obj === "object" && obj !== null) lines.push({ msg, obj });
            method.apply(this, args as never[]);
          },
        },
      },
    },
  };
}

async function setup(overrides: Partial<AppDeps> = {}) {
  const log = logs();
  const built = await buildTestApp(overrides, log.options);
  const admin = await seedUser(built.db, { isAdmin: true });
  return { ...built, admin, cookies: await cookieOf(admin.id), log };
}

const url = (id: string) => `/api/admin/users/${id}/password-reset`;

function issue(app: FastifyInstance, cookies: Record<string, string>, id: string, payload: unknown = { expiresInHours: 1 }) {
  return app.inject({ method: "POST", url: url(id), cookies, payload: payload as object });
}

function cancel(app: FastifyInstance, cookies: Record<string, string>, id: string) {
  return app.inject({ method: "DELETE", url: url(id), cookies });
}

async function allLinks(db: Db) {
  return db.select().from(oneTimeLinks).orderBy(asc(oneTimeLinks.createdAt), asc(oneTimeLinks.id));
}

async function linkById(db: Db, id: string) {
  const [row] = await db.select().from(oneTimeLinks).where(eq(oneTimeLinks.id, id));
  return row!;
}

/** Pushes the whole link row into the past (including `created_at`, to keep `expiry_chk` satisfied). */
async function expireLink(db: Db, id: string) {
  await db.execute(sql`update one_time_links set created_at = now() - interval '3 hours', expires_at = now() - interval '1 hour' where id = ${id}`);
}

async function disablePasswordLogin(db: Db) {
  await db.update(siteSettings).set({ passwordLoginEnabled: false });
}

describe("POST /api/admin/users/:id/password-reset", () => {
  it("201 returns only token/expiresAt; the DB row stores only the hash, lifetime = expiresInHours", async () => {
    const { app, db, admin, cookies } = await setup();
    const target = await userWithPassword(db);
    const res = await issue(app, cookies, target.id, { expiresInHours: 3 });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { token: string; expiresAt: string };
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "token"]);
    expect(body.token).toMatch(TOKEN_RE);

    const rows = await allLinks(db);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({ kind: "password_reset", targetUserId: target.id, createdById: admin.id, usedAt: null, revokedAt: null });
    expect(row.tokenHash).toBe(hashToken(body.token));
    const [{ secs }] = (await db.execute<{ secs: number }>(sql`select extract(epoch from expires_at - created_at)::int as secs from one_time_links where id = ${row.id}`)).rows;
    expect(secs).toBe(10800);
    expect(body.expiresAt).toBe(row.expiresAt.toISOString());
  });

  it.each([
    ["0", { expiresInHours: 0 }],
    ["25", { expiresInHours: 25 }],
    ["1.5", { expiresInHours: 1.5 }],
    ["字串 \"1\"", { expiresInHours: "1" }],
    ["空物件", {}],
    ["多欄", { expiresInHours: 1, extra: 1 }],
  ])("body %s -> 400 invalid_body, no row inserted", async (_name, payload) => {
    const { app, db, cookies } = await setup();
    const target = await userWithPassword(db);
    const res = await issue(app, cookies, target.id, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "invalid_body" } });
    expect(await allLinks(db)).toHaveLength(0);
  });

  it("boundaries 1 and 24 -> 201", async () => {
    const { app, db, cookies } = await setup();
    const target = await userWithPassword(db);
    expect((await issue(app, cookies, target.id, { expiresInHours: 1 })).statusCode).toBe(201);
    expect((await issue(app, cookies, target.id, { expiresInHours: 24 })).statusCode).toBe(201);
  });

  it("disabled 409 user_disabled; no password 409 password_not_set; nonexistent/non-uuid 404; no row inserted in any case", async () => {
    const { app, db, cookies } = await setup();
    const disabled = await userWithPassword(db, { disabled: true });
    const res1 = await issue(app, cookies, disabled.id);
    expect(res1.statusCode).toBe(409);
    expect(res1.json()).toMatchObject({ error: { code: "user_disabled" } });

    const sso = await seedUser(db);
    const res2 = await issue(app, cookies, sso.id);
    expect(res2.statusCode).toBe(409);
    expect(res2.json()).toMatchObject({ error: { code: "password_not_set" } });

    const res3 = await issue(app, cookies, randomUUID());
    expect(res3.statusCode).toBe(404);
    expect(res3.json()).toMatchObject({ error: { code: "user_not_found" } });

    const res4 = await issue(app, cookies, "not-a-uuid");
    expect(res4.statusCode).toBe(404);
    expect(res4.json()).toMatchObject({ error: { code: "user_not_found" } });

    expect(await allLinks(db)).toHaveLength(0);
  });

  it("regression: uppercase UUID -> 201, exactly one row inserted", async () => {
    const { app, db, cookies } = await setup();
    const target = await userWithPassword(db);
    expect((await issue(app, cookies, target.id.toUpperCase())).statusCode).toBe(201);
    expect(await allLinks(db)).toHaveLength(1);
  });

  it("effective password login value off -> valid target and nonexistent uuid both 403; non-uuid 404; bad body 400; no row inserted", async () => {
    const { app, db, cookies } = await setup();
    const target = await userWithPassword(db);
    await disablePasswordLogin(db);

    const res1 = await issue(app, cookies, target.id);
    expect(res1.statusCode).toBe(403);
    expect(res1.json()).toMatchObject({ error: { code: "password_login_disabled" } });
    const res2 = await issue(app, cookies, randomUUID());
    expect(res2.statusCode).toBe(403);
    const res3 = await issue(app, cookies, "not-a-uuid");
    expect(res3.statusCode).toBe(404);
    const res4 = await issue(app, cookies, target.id, { expiresInHours: 0 });
    expect(res4.statusCode).toBe(400);
    expect(await allLinks(db)).toHaveLength(0);
  });

  it("PASSWORD_LOGIN_FORCE_ENABLE + DB off -> 201", async () => {
    const { app, db, cookies } = await setup({ config: { ...testConfig, passwordLoginForceEnable: true } });
    const target = await userWithPassword(db);
    await disablePasswordLogin(db);
    expect((await issue(app, cookies, target.id)).statusCode).toBe(201);
  });

  it("generating two in a row -> the first is revoked, the second valid; log's replaced is 0, then 1", async () => {
    const { app, db, cookies, log } = await setup();
    const target = await userWithPassword(db);
    expect((await issue(app, cookies, target.id)).statusCode).toBe(201);
    expect((await issue(app, cookies, target.id)).statusCode).toBe(201);
    const [first, second] = await allLinks(db);
    expect(first!.revokedAt).not.toBeNull();
    expect(second!.revokedAt).toBeNull();
    expect(second!.usedAt).toBeNull();
    expect(log.lines.filter(l => l.msg === "產生重設密碼連結").map(l => l.obj.replaced)).toEqual([0, 1]);
  });

  it("generating doesn't affect the current login and password (cookie still valid, old password still logs in, token_version unchanged)", async () => {
    const { app, db, cookies } = await setup();
    const target = await userWithPassword(db);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: target.email, password: PASSWORD } });
    expect(login.statusCode).toBe(200);
    const targetCookie = login.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    expect((await issue(app, cookies, target.id)).statusCode).toBe(201);

    const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: targetCookie } });
    expect(me.statusCode).toBe(200);
    const again = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: target.email, password: PASSWORD } });
    expect(again.statusCode).toBe(200);
    const [row] = await db.select({ tv: users.tokenVersion }).from(users).where(eq(users.id, target.id));
    expect(row!.tv).toBe(0);
  });

  it("generate log has exactly five keys; whole log contains neither the token plaintext nor the hash", async () => {
    const { app, db, admin, cookies, log } = await setup();
    const target = await userWithPassword(db);
    const res = await issue(app, cookies, target.id);
    expect(res.statusCode).toBe(201);
    const { token } = res.json() as { token: string };
    const lines = log.lines.filter(l => l.msg === "產生重設密碼連結");
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0]!.obj).sort()).toEqual(["expiresAt", "linkId", "replaced", "targetUserId", "userId"]);
    expect(lines[0]!.obj).toMatchObject({ userId: admin.id, targetUserId: target.id, replaced: 0 });
    const out = log.out.join("");
    expect(out).toContain("產生重設密碼連結");
    expect(out).not.toContain(token);
    expect(out).not.toContain(hashToken(token));
  });

  it("unexpected DB error in the transaction -> 500, log redacted (no params, no 64-digit hex)", async () => {
    const { app, db, cookies, log } = await setup();
    const target = await userWithPassword(db);
    await db.execute(sql.raw("ALTER TABLE one_time_links ADD CONSTRAINT t286_block CHECK (false) NOT VALID"));
    const res = await issue(app, cookies, target.id);
    expect(res.statusCode).toBe(500);
    const out = log.out.join("");
    expect(out).toContain(REDACTED);
    expect(out).not.toMatch(PARAMS_LEAK);
    expect(out).not.toMatch(/[0-9a-f]{64}/);
  });

  it("after a successful generate, old rows that ended more than 30 days ago are cleaned up opportunistically", async () => {
    const { app, db, cookies } = await setup();
    const other = await userWithPassword(db);
    const target = await userWithPassword(db);
    const [{ id: oldId }] = (
      await db.execute<{ id: string }>(
        sql`insert into one_time_links (kind, token_hash, target_user_id, created_at, expires_at, revoked_at)
            values ('password_reset', ${hashToken(randomUUID())}, ${other.id}, now() - interval '32 days', now() - interval '31 days' + interval '1 hour', now() - interval '31 days')
            returning id`,
      )
    ).rows;
    expect((await issue(app, cookies, target.id)).statusCode).toBe(201);
    const deadline = Date.now() + 2_000;
    let gone = false;
    while (Date.now() < deadline) {
      const rows = await db.select({ id: oneTimeLinks.id }).from(oneTimeLinks).where(eq(oneTimeLinks.id, oldId!));
      if (rows.length === 0) {
        gone = true;
        break;
      }
      await new Promise(r => setTimeout(r, 50));
    }
    expect(gone).toBe(true);
  });

  // Generating locks the users row first. Without that lock, if generation reads "not disabled" and the disable commits afterwards,
  // the INSERT's FK takes only KEY SHARE and isn't blocked -> a disabled account keeps a valid link (usable once re-enabled).
  it("generate vs disable concurrency: raw client holds the users row lock while disabling, generate is blocked, then 409 user_disabled and no row after release", async () => {
    const { app, db, cookies } = await setup();
    const target = await userWithPassword(db);
    const client = await db.$client.connect();
    let pending: ReturnType<typeof issue> | undefined;
    try {
      await client.query("begin");
      await client.query("select 1 from users where id = $1 for no key update", [target.id]);
      pending = issue(app, cookies, target.id);
      expect(await waitForBlockedOrSettled(db.$client, pending)).toBe("blocked");
      await client.query("update users set disabled_at = now() where id = $1", [target.id]);
    } finally {
      await client.query("commit");
      client.release();
    }
    const res = await pending!;
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "user_disabled" } });
    expect(await allLinks(db)).toHaveLength(0);
  });

  // Same user generating two concurrently: the users row lock queues them and the later one marks the earlier as replaced, avoiding the partial unique index.
  // Interleaving: a raw client takes SHARE MODE on one_time_links so both stop before the revoke statement - with a NO KEY UPDATE lock the second stops at the users row;
  // if the lock were weakened to FOR SHARE both would get the row lock and each INSERT, and the later one would hit 23505 -> 500.
  it("same user generating two concurrently -> both 201, exactly one valid at the end", async () => {
    const { app, db, cookies } = await setup();
    const target = await userWithPassword(db);
    const client = await db.$client.connect();
    let first: ReturnType<typeof issue> | undefined;
    let second: ReturnType<typeof issue> | undefined;
    try {
      await client.query("begin");
      await client.query("lock table one_time_links in share mode");
      first = issue(app, cookies, target.id);
      second = issue(app, cookies, target.id);
      await waitForLockWaiters(db.$client, 2);
    } finally {
      await client.query("commit");
      client.release();
    }
    const results = await Promise.all([first!, second!]);
    expect(results.map(r => r.statusCode)).toEqual([201, 201]);
    const active = (await allLinks(db)).filter(l => l.usedAt === null && l.revokedAt === null);
    expect(active).toHaveLength(1);
  });
});

describe("DELETE /api/admin/users/:id/password-reset", () => {
  it("204 revokes; cancelling again 204; never generated 204; nonexistent/non-uuid 404; log has three keys", async () => {
    const { app, db, admin, cookies, log } = await setup();
    const target = await userWithPassword(db);
    expect((await issue(app, cookies, target.id)).statusCode).toBe(201);
    const [link] = await allLinks(db);

    expect((await cancel(app, cookies, target.id)).statusCode).toBe(204);
    expect((await linkById(db, link!.id)).revokedAt).not.toBeNull();
    expect((await cancel(app, cookies, target.id)).statusCode).toBe(204);

    const never = await userWithPassword(db);
    expect((await cancel(app, cookies, never.id)).statusCode).toBe(204);

    const missing = await cancel(app, cookies, randomUUID());
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "user_not_found" } });
    const bad = await cancel(app, cookies, "not-a-uuid");
    expect(bad.statusCode).toBe(404);
    expect(bad.json()).toMatchObject({ error: { code: "user_not_found" } });

    const cancelLogs = log.lines.filter(l => l.msg === "取消重設密碼連結");
    expect(cancelLogs.map(l => l.obj)).toEqual([
      { userId: admin.id, targetUserId: target.id, revoked: 1 },
      { userId: admin.id, targetUserId: target.id, revoked: 0 },
      { userId: admin.id, targetUserId: never.id, revoked: 0 },
    ]);
  });

  it("an expired but unused row is also revoked", async () => {
    const { app, db, cookies } = await setup();
    const target = await userWithPassword(db);
    expect((await issue(app, cookies, target.id)).statusCode).toBe(201);
    const [link] = await allLinks(db);
    await expireLink(db, link!.id);
    expect((await cancel(app, cookies, target.id)).statusCode).toBe(204);
    expect((await linkById(db, link!.id)).revokedAt).not.toBeNull();
  });

  it("cancelling with password login off is still 204 and revokes", async () => {
    const { app, db, cookies } = await setup();
    const target = await userWithPassword(db);
    expect((await issue(app, cookies, target.id)).statusCode).toBe(201);
    const [link] = await allLinks(db);
    await disablePasswordLogin(db);
    expect((await cancel(app, cookies, target.id)).statusCode).toBe(204);
    expect((await linkById(db, link!.id)).revokedAt).not.toBeNull();
  });

  it("a user disabled directly in the DB -> cancel 204 and revokes", async () => {
    const { app, db, cookies } = await setup();
    const target = await userWithPassword(db);
    expect((await issue(app, cookies, target.id)).statusCode).toBe(201);
    const [link] = await allLinks(db);
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, target.id));
    expect((await cancel(app, cookies, target.id)).statusCode).toBe(204);
    expect((await linkById(db, link!.id)).revokedAt).not.toBeNull();
  });
});

describe("hasPassword/passwordResetExpiresAt of AdminUserDto", () => {
  type Dto = { id: string; hasPassword: boolean; passwordResetExpiresAt: string | null };

  async function listed(app: FastifyInstance, cookies: Record<string, string>): Promise<Map<string, Dto>> {
    const res = await app.inject({ method: "GET", url: "/api/admin/users", cookies });
    expect(res.statusCode).toBe(200);
    return new Map((res.json() as Dto[]).map(u => [u.id, u]));
  }

  it("both GET/PATCH storage-plan responses; expired and revoked -> null; response carries no token or hash", async () => {
    const { app, db, cookies } = await setup();
    const a = await userWithPassword(db);
    const b = await userWithPassword(db);
    const c = await seedUser(db);
    const issued = await issue(app, cookies, a.id);
    expect(issued.statusCode).toBe(201);
    const tokens = [(issued.json() as { token: string }).token];
    const [link] = await allLinks(db);
    const iso = link!.expiresAt.toISOString();
    const bodies: string[] = [];

    const getRes = await app.inject({ method: "GET", url: "/api/admin/users", cookies });
    bodies.push(getRes.body);
    const list = await listed(app, cookies);
    expect(list.get(a.id)).toMatchObject({ hasPassword: true, passwordResetExpiresAt: iso });
    expect(list.get(b.id)).toMatchObject({ hasPassword: true, passwordResetExpiresAt: null });
    expect(list.get(c.id)).toMatchObject({ hasPassword: false, passwordResetExpiresAt: null });

    // RETURNING relation (drizzle's single-table RETURNING drops the table name): with a valid link the PATCH response must also carry the expiry.
    const [{ id: planId }] = (await db.execute<{ id: string }>(sql`select id from storage_plans limit 1`)).rows;
    const patched = await app.inject({ method: "PATCH", url: `/api/admin/users/${a.id}/storage-plan`, cookies, payload: { planId } });
    expect(patched.statusCode).toBe(200);
    bodies.push(patched.body);
    expect(patched.json()).toMatchObject({ id: a.id, hasPassword: true, passwordResetExpiresAt: iso });

    await expireLink(db, link!.id);
    expect((await listed(app, cookies)).get(a.id)!.passwordResetExpiresAt).toBeNull();

    const reissued = await issue(app, cookies, a.id);
    expect(reissued.statusCode).toBe(201);
    tokens.push((reissued.json() as { token: string }).token);
    expect((await listed(app, cookies)).get(a.id)!.passwordResetExpiresAt).not.toBeNull();
    await db.execute(sql`update one_time_links set revoked_at = now() where target_user_id = ${a.id} and revoked_at is null`);
    expect((await listed(app, cookies)).get(a.id)!.passwordResetExpiresAt).toBeNull();

    for (const body of bodies) {
      for (const token of tokens) {
        expect(body).not.toContain(token);
        expect(body).not.toContain(hashToken(token));
      }
    }
  });
});

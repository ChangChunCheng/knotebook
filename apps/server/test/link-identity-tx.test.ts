import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildTestApp } from "./helpers.js";
import { waitForBlockedOrSettled } from "./group-helpers.js";
import { identitiesOf } from "./helpers/oidc-provider.js";
import { userIdentities, users } from "../src/db/schema.js";
import { linkPendingIdentityInTx, type LinkPendingInput } from "../src/auth/tx/link-identity.js";
import { TxAbort } from "../src/http/tx-abort.js";
import type { OidcTestHook } from "../src/auth/oidc-test-hook.js";
import type { Db } from "../src/db/index.js";

const ISS = "https://b.example";
async function seedTarget(db: Db, over: Partial<typeof users.$inferInsert> = {}) {
  const [u] = await db.insert(users).values({ email: "t@example.com", displayName: "T", passwordHash: "hash-1", mustChangePassword: true, ...over }).returning();
  return u!;
}
const input = (userId: string, over: Partial<LinkPendingInput> = {}): LinkPendingInput => ({
  targetUserId: userId, pendingEmail: "t@example.com", issuer: ISS, sub: "new-sub", proof: { kind: "password", passwordHash: "hash-1" }, ...over,
});
const link = (db: Db, i: LinkPendingInput, hook?: OidcTestHook) => db.transaction(tx => linkPendingIdentityInTx(tx, i, hook));
async function rejected(p: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof TxAbort) return { status: err.status, code: err.errCode };
    throw err;
  }
  throw new Error("expected TxAbort");
}

describe("linkPendingIdentityInTx (#187, SSO proof)", () => {
  it("password proof succeeds: INSERT identity (with last_login_at), must_change_password not cleared, returns LinkedUser", async () => {
    const { db } = await buildTestApp();
    const u = await seedTarget(db);
    const r = await link(db, input(u.id));
    expect(r).toMatchObject({ id: u.id, email: "t@example.com", mustChangePassword: true, hasPassword: true, tokenVersion: u.tokenVersion });
    expect(await identitiesOf(db, u.id)).toEqual([{ issuer: ISS, sub: "new-sub" }]);
    const [i] = await db.select().from(userIdentities).where(eq(userIdentities.userId, u.id));
    expect(i!.lastLoginAt).not.toBeNull();
    const [after] = await db.select({ m: users.mustChangePassword }).from(users).where(eq(users.id, u.id));
    expect(after!.m).toBe(true);
  });

  it("re-check under the lock: account missing / email changed -> 409 oidc_link_expired; hash changed -> 401 invalid_credentials; nothing written in either case", async () => {
    const { db } = await buildTestApp();
    const u = await seedTarget(db);
    expect(await rejected(link(db, input("00000000-0000-0000-0000-000000000000")))).toEqual({ status: 409, code: "oidc_link_expired" });
    expect(await rejected(link(db, input(u.id, { pendingEmail: "other@example.com" })))).toEqual({ status: 409, code: "oidc_link_expired" });
    expect(await rejected(link(db, input(u.id, { proof: { kind: "password", passwordHash: "hash-OLD" } })))).toEqual({ status: 401, code: "invalid_credentials" });
    expect(await identitiesOf(db, u.id)).toEqual([]);
  });

  it("proof is verified first, then disabled is judged: disabled + hash changed -> 401; disabled + valid proof -> 403 account_disabled", async () => {
    const { db } = await buildTestApp();
    const u = await seedTarget(db, { disabledAt: new Date() });
    expect(await rejected(link(db, input(u.id, { proof: { kind: "password", passwordHash: "x" } })))).toEqual({ status: 401, code: "invalid_credentials" });
    expect(await rejected(link(db, input(u.id)))).toEqual({ status: 403, code: "account_disabled" });
  });

  it("another sub of the same issuer already linked -> 409 identity_already_linked (revealed only after the proof)", async () => {
    const { db } = await buildTestApp();
    const u = await seedTarget(db);
    await db.insert(userIdentities).values({ userId: u.id, issuer: ISS, sub: "older" });
    expect(await rejected(link(db, input(u.id)))).toEqual({ status: 409, code: "identity_already_linked" });
  });

  it("identity belongs to someone else -> 409 identity_taken; already the user's own -> idempotent success, no duplicate", async () => {
    const { db } = await buildTestApp();
    const u = await seedTarget(db);
    const [v] = await db.insert(users).values({ email: "v@example.com", displayName: "V" }).returning();
    await db.insert(userIdentities).values({ userId: v!.id, issuer: ISS, sub: "new-sub" });
    expect(await rejected(link(db, input(u.id)))).toEqual({ status: 409, code: "identity_taken" });
    const { db: db2 } = await buildTestApp();
    const w = await seedTarget(db2);
    await link(db2, input(w.id));
    await link(db2, input(w.id));
    expect(await identitiesOf(db2, w.id)).toEqual([{ issuer: ISS, sub: "new-sub" }]);
  });

  it("SSO proof: the proving identity belongs to the target -> success and the proving identity's last_login_at is updated; belongs to someone else or doesn't exist -> 409 oidc_link_proof_mismatch (nothing written)", async () => {
    const { db } = await buildTestApp();
    const u = await seedTarget(db, { passwordHash: null });
    const [v] = await db.insert(users).values({ email: "v@example.com", displayName: "V" }).returning();
    await db.insert(userIdentities).values([
      { userId: u.id, issuer: "https://a.example", sub: "ua" },
      { userId: v!.id, issuer: "https://a.example", sub: "va" },
    ]);
    const sso = (sub: string) => input(u.id, { proof: { kind: "sso", issuer: "https://a.example", sub } });
    expect(await rejected(link(db, sso("va")))).toEqual({ status: 409, code: "oidc_link_proof_mismatch" });
    expect(await rejected(link(db, sso("nobody")))).toEqual({ status: 409, code: "oidc_link_proof_mismatch" });
    expect(await identitiesOf(db, u.id)).toEqual([{ issuer: "https://a.example", sub: "ua" }]);
    await link(db, sso("ua"));
    expect(await identitiesOf(db, u.id)).toEqual([{ issuer: "https://a.example", sub: "ua" }, { issuer: ISS, sub: "new-sub" }]);
    const [proof] = await db.select().from(userIdentities).where(eq(userIdentities.sub, "ua"));
    expect(proof!.lastLoginAt).not.toBeNull();
  });

  it("same account, same issuer, two subs concurrently -> the latecomer blocks on the users row lock; after release exactly one succeeds and the other gets identity_already_linked", async () => {
    const { db } = await buildTestApp();
    const pool = db.$client;
    const u = await seedTarget(db);
    const gate = { release: () => {} };
    const held = new Promise<void>(resolve => (gate.release = resolve));
    const entered = { resolve: () => {} };
    const lockedOnce = new Promise<void>(resolve => (entered.resolve = resolve));
    let first = true;
    const hook: OidcTestHook = async point => {
      if (point === "link-locked" && first) {
        first = false;
        entered.resolve();
        await held;
      }
    };
    const a = link(db, input(u.id, { sub: "sub-a" }), hook);
    await lockedOnce;
    const b = link(db, input(u.id, { sub: "sub-b" }), hook);
    try {
      expect(await waitForBlockedOrSettled(pool, b)).toBe("blocked");
    } finally {
      gate.release();
    }
    await a;
    expect(await rejected(b)).toEqual({ status: 409, code: "identity_already_linked" });
    expect(await identitiesOf(db, u.id)).toEqual([{ issuer: ISS, sub: "sub-a" }]);
  });

  it("someone else's uncommitted transaction already inserted the same (issuer, sub) -> the link's INSERT waits for it; after it commits the link gets identity_taken", async () => {
    const { db } = await buildTestApp();
    const pool = db.$client;
    const u = await seedTarget(db);
    const [v] = await db.insert(users).values({ email: "v@example.com", displayName: "V" }).returning();
    const other = await pool.connect();
    try {
      await other.query("begin");
      await other.query("insert into user_identities (user_id, issuer, sub) values ($1, $2, 'new-sub')", [v!.id, ISS]);
      const p = link(db, input(u.id));
      expect(await waitForBlockedOrSettled(pool, p)).toBe("blocked");
      await other.query("commit");
      expect(await rejected(p)).toEqual({ status: 409, code: "identity_taken" });
    } finally {
      await other.query("rollback").catch(() => undefined);
      other.release();
    }
  });
});

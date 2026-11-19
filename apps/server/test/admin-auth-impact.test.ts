import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { authProviders, siteSettings, userIdentities, users } from "../src/db/schema.js";
import { createOidcRuntimeRegistry } from "../src/auth/oidc-client.js";
import { insertPasswordUser, testConfig } from "./helpers.js";
import { seedUser } from "./group-helpers.js";
import { createFakeIdp } from "./helpers/fake-idp.js";
import { seedAuthProvider } from "./helpers/oidc-provider.js";
import { adminApp, expectAdminOnly } from "./helpers/admin-auth.js";

const IA = "https://a.example.com";
const IB = "https://b.example.com";

type Built = Awaited<ReturnType<typeof adminApp>>;
async function identity(db: Built["db"], userId: string, issuer: string, sub: string) {
  await db.insert(userIdentities).values({ userId, issuer, sub });
}
async function impact(built: Built, id: string) {
  const res = await built.app.inject({ method: "GET", url: `/api/admin/auth/providers/${id}/impact`, cookies: built.cookies });
  return { status: res.statusCode, body: res.json() };
}

describe("GET /api/admin/auth/providers/:id/impact (#187; 'no password' = no password set, or the DB value of the password-login switch is off)", () => {
  it("site admins only", async () => {
    const built = await adminApp();
    const a = await seedAuthProvider(built.db, { issuerUrl: IA });
    await expectAdminOnly(built.app, built.db, "GET", `/api/admin/auth/providers/${a.id}/impact`);
  });

  it("linked/lockedOut: having a password is not locked, another enabled provider left is not locked, disabled accounts and accounts not linked to this issuer don't count; becomes locked once the other provider is disabled", async () => {
    const built = await adminApp();
    const { db } = built;
    const a = await seedAuthProvider(db, { issuerUrl: IA, resolvedIssuer: IA });
    const b = await seedAuthProvider(db, { issuerUrl: IB, resolvedIssuer: IB });
    const withPassword = await insertPasswordUser(db);
    await identity(db, withPassword.id, IA, "u1");
    const ssoOnly = await seedUser(db);
    await identity(db, ssoOnly.id, IA, "u2");
    const twoIdps = await seedUser(db);
    await identity(db, twoIdps.id, IA, "u3");
    await identity(db, twoIdps.id, IB, "u3b");
    const disabled = await seedUser(db, { disabled: true });
    await identity(db, disabled.id, IA, "u4");
    const onlyB = await seedUser(db);
    await identity(db, onlyB.id, IB, "u5");

    expect(await impact(built, a.id)).toEqual({ status: 200, body: { linkedUsers: 3, lockedOutUsers: 1, issuerResolved: true, actingAdminLockedOut: false } });
    await db.update(authProviders).set({ enabled: false }).where(eq(authProviders.id, b.id));
    expect((await impact(built, a.id)).body).toEqual({ linkedUsers: 3, lockedOutUsers: 2, issuerResolved: true, actingAdminLockedOut: false });
  });

  it("the same account counts once per issuer (a late backfill can leave two subs for the same issuer)", async () => {
    const built = await adminApp();
    const a = await seedAuthProvider(built.db, { issuerUrl: IA, resolvedIssuer: IA });
    const u = await seedUser(built.db);
    await identity(built.db, u.id, IA, "x1");
    await identity(built.db, u.id, IA, "x2");
    expect((await impact(built, a.id)).body).toEqual({ linkedUsers: 1, lockedOutUsers: 1, issuerResolved: true, actingAdminLockedOut: false });
  });

  it("two enabled providers pointing at the same issuer: disabling one leaves SSO-only accounts of this issuer able to use the other -> not locked", async () => {
    const built = await adminApp();
    const a = await seedAuthProvider(built.db, { issuerUrl: IA, resolvedIssuer: IA });
    await seedAuthProvider(built.db, { issuerUrl: IA, resolvedIssuer: IA, clientId: "second-client" });
    const u = await seedUser(built.db);
    await identity(built.db, u.id, IA, "twin");
    expect((await impact(built, a.id)).body).toEqual({ linkedUsers: 1, lockedOutUsers: 0, issuerResolved: true, actingAdminLockedOut: false });
  });

  it.each([
    ["尾斜線形", "https://gitlab.example/"],
    ["大寫 host 形", "https://GitLab.Example"],
  ])("%s: no match while resolved_issuer is NULL (issuerResolved=false, 0 users); matches after the connection test writes it", async (_name, typed) => {
    const idp = createFakeIdp("https://gitlab.example");
    const built = await adminApp({ oidcRegistry: createOidcRuntimeRegistry({ fetch: idp.fetch }) });
    const p = await seedAuthProvider(built.db, { issuerUrl: typed });
    const u = await seedUser(built.db);
    await identity(built.db, u.id, "https://gitlab.example", "tail");
    expect((await impact(built, p.id)).body).toEqual({ linkedUsers: 0, lockedOutUsers: 0, issuerResolved: false, actingAdminLockedOut: false });
    expect((await built.app.inject({ method: "POST", url: `/api/admin/auth/providers/${p.id}/test`, cookies: built.cookies })).statusCode).toBe(200);
    expect((await impact(built, p.id)).body).toEqual({ linkedUsers: 1, lockedOutUsers: 1, issuerResolved: true, actingAdminLockedOut: false });
  });

  it("uppercase uuid path is equivalent; nonexistent -> 404; non-uuid -> 404", async () => {
    const built = await adminApp();
    const a = await seedAuthProvider(built.db, { issuerUrl: IA });
    expect((await impact(built, a.id.toUpperCase())).status).toBe(200);
    expect(await impact(built, "00000000-0000-4000-8000-000000000000")).toEqual({ status: 404, body: { error: { code: "not_found", message: "No sign-in service with that id." } } });
    expect((await impact(built, "zzz")).status).toBe(404);
  });

  it("disabled accounts never count, with or without a password (only non-disabled accounts are counted)", async () => {
    const built = await adminApp();
    const a = await seedAuthProvider(built.db, { issuerUrl: IA, resolvedIssuer: IA });
    const u = await insertPasswordUser(built.db);
    await built.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, u.id));
    await identity(built.db, u.id, IA, "d");
    expect((await impact(built, a.id)).body).toEqual({ linkedUsers: 0, lockedOutUsers: 0, issuerResolved: true, actingAdminLockedOut: false });
  });
});

describe("locked-out follows the DB value, plus actingAdminLockedOut (#187)", () => {
  it("same fixture: password + identity only at this provider - DB switch on does not count, off counts; env force has no effect (the DB value decides)", async () => {
    for (const forced of [false, true]) {
      const built = await adminApp({ config: { ...testConfig, passwordLoginForceEnable: forced } });
      const a = await seedAuthProvider(built.db, { issuerUrl: IA, resolvedIssuer: IA });
      const u = await insertPasswordUser(built.db);
      await identity(built.db, u.id, IA, "ua");
      expect((await impact(built, a.id)).body).toMatchObject({ linkedUsers: 1, lockedOutUsers: 0 });
      await built.db.update(siteSettings).set({ passwordLoginEnabled: false });
      expect((await impact(built, a.id)).body).toMatchObject({ linkedUsers: 1, lockedOutUsers: 1 });
    }
  });

  it("actingAdminLockedOut: the admin's only usable identity is at this provider -> true; another enabled provider's identity (including another provider with the same issuer, counted per provider) -> false; no identity at this provider -> false", async () => {
    const built = await adminApp();
    const a = await seedAuthProvider(built.db, { issuerUrl: IA, resolvedIssuer: IA });
    const b = await seedAuthProvider(built.db, { issuerUrl: IB, resolvedIssuer: IB });
    expect((await impact(built, a.id)).body.actingAdminLockedOut).toBe(false);
    await identity(built.db, built.admin.id, IA, "admin-a");
    expect((await impact(built, a.id)).body.actingAdminLockedOut).toBe(true);
    expect((await impact(built, b.id)).body.actingAdminLockedOut).toBe(false);
    const twin = await seedAuthProvider(built.db, { issuerUrl: IA, resolvedIssuer: IA, displayName: "Twin" });
    expect((await impact(built, a.id)).body.actingAdminLockedOut).toBe(false);
    await built.db.update(authProviders).set({ enabled: false }).where(eq(authProviders.id, twin.id));
    await identity(built.db, built.admin.id, IB, "admin-b");
    expect((await impact(built, a.id)).body.actingAdminLockedOut).toBe(false);
  });
});

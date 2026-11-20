import { describe, expect, it } from "vitest";
import { Client } from "pg";
import { eq, sql } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { authProviders, userIdentities } from "../src/db/schema.js";
import { createOidcRuntimeRegistry, type OidcRuntimeRegistry } from "../src/auth/oidc-client.js";
import { cookieOf, seedUser, waitForBlockedOrSettled } from "./group-helpers.js";
import { buildOidcApp, seedAuthProvider, ssoRoundTrip } from "./helpers/oidc-provider.js";
import { adminApp, expectAdminOnly, providerRow } from "./helpers/admin-auth.js";

const ISS = "https://idp.example.com";

describe("DELETE /api/admin/auth/providers/:id (#187)", () => {
  it("site admins only", async () => {
    const { app, db } = await adminApp();
    const p = await seedAuthProvider(db, { issuerUrl: ISS, enabled: false });
    await expectAdminOnly(app, db, "DELETE", `/api/admin/auth/providers/${p.id}`);
  });

  it("enabled -> 409 provider_enabled and the row stays; nonexistent -> 404; non-uuid -> 404", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedAuthProvider(db, { issuerUrl: ISS, enabled: true });
    const res = await app.inject({ method: "DELETE", url: `/api/admin/auth/providers/${p.id}`, cookies });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("provider_enabled");
    expect(await providerRow(db, p.id)).toBeDefined();
    const missing = await app.inject({ method: "DELETE", url: "/api/admin/auth/providers/00000000-0000-4000-8000-000000000000", cookies });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("not_found");
    expect((await app.inject({ method: "DELETE", url: "/api/admin/auth/providers/nope", cookies })).statusCode).toBe(404);
  });

  it("disabled -> 204 (uppercase uuid path is equivalent); identities untouched; registry.invalidate receives the lowercase id", async () => {
    const invalidated: string[] = [];
    const inner = createOidcRuntimeRegistry();
    const registry: OidcRuntimeRegistry = { get: inner.get, probe: inner.probe, invalidate: id => { invalidated.push(id); inner.invalidate(id); } };
    const { app, db, cookies } = await adminApp({ oidcRegistry: registry });
    const p = await seedAuthProvider(db, { issuerUrl: ISS, enabled: false });
    const user = await seedUser(db);
    await db.insert(userIdentities).values({ userId: user.id, issuer: ISS, sub: "s-1" });
    const res = await app.inject({ method: "DELETE", url: `/api/admin/auth/providers/${p.id.toUpperCase()}`, cookies });
    expect(res.statusCode).toBe(204);
    expect(await providerRow(db, p.id)).toBeUndefined();
    expect(await db.select().from(userIdentities).where(eq(userIdentities.userId, user.id))).toHaveLength(1);
    expect(invalidated).toEqual([p.id]);
  });

  it("disable -> delete (existing sessions not revoked) -> recreate with the same issuer (API) -> the original identity logs in to the same account as before", async () => {
    const { app, db, idp, provider } = await buildOidcApp({ providers: [{ key: "a", issuerUrl: ISS }] });
    const admin = await seedUser(db, { isAdmin: true });
    const adminCookies = await cookieOf(admin.id);
    const claims = { sub: "keeps-identity", email: "keeps@example.com", name: "Keeps" };
    const first = await ssoRoundTrip(app, idp("a"), { loginUrl: `/api/auth/oidc/login/${provider("a").id}`, claims });
    expect(first.callbackRes.headers.location).toBe("/");
    const meBefore = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: first.cookies[SESSION_COOKIE]! } });

    const oldId = provider("a").id;
    expect((await app.inject({ method: "PATCH", url: `/api/admin/auth/providers/${oldId}`, cookies: adminCookies, payload: { enabled: false } })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/api/admin/auth/providers/${oldId}`, cookies: adminCookies })).statusCode).toBe(204);
    // Neither disabling nor deleting revokes sessions: a session that logged in through that provider stays valid.
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: first.cookies[SESSION_COOKIE]! } })).statusCode).toBe(200);
    const created = await app.inject({ method: "POST", url: "/api/admin/auth/providers", cookies: adminCookies, payload: { template: "oidc", displayName: "Again", issuerUrl: ISS, clientId: "test-client", clientSecret: "test-secret" } });
    const newId = created.json().id as string;
    expect((await app.inject({ method: "PATCH", url: `/api/admin/auth/providers/${newId}`, cookies: adminCookies, payload: { enabled: true } })).statusCode).toBe(200);

    const again = await ssoRoundTrip(app, idp("a"), { loginUrl: `/api/auth/oidc/login/${newId}`, claims });
    expect(again.callbackRes.headers.location).toBe("/");
    expect(again.redirectUri).toBe(`http://localhost:3000/api/auth/oidc/callback/${newId}`);
    const meAfter = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: again.cookies[SESSION_COOKIE]! } });
    expect(meAfter.json().id).toBe(meBefore.json().id);
  });

  it("deleting a legacy provider (disabled) really deletes the row; a provider later created with the same issuer is not legacy and its callback URL carries the id", async () => {
    const { app, db, cookies } = await adminApp();
    const legacy = await seedAuthProvider(db, { issuerUrl: ISS, legacyCallback: true, enabled: false });
    expect((await app.inject({ method: "DELETE", url: `/api/admin/auth/providers/${legacy.id}`, cookies })).statusCode).toBe(204);
    expect(await providerRow(db, legacy.id)).toBeUndefined();
    const created = await app.inject({ method: "POST", url: "/api/admin/auth/providers", cookies, payload: { template: "oidc", displayName: "SSO", issuerUrl: ISS, clientId: "test-client" } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ legacyCallback: false, callbackUrl: `http://localhost:3000/api/auth/oidc/callback/${created.json().id}` });
  });

  it("disable/delete interleaving: DELETE blocks on the row lock of another connection re-enabling it -> after that commits, 409 provider_enabled and the row stays", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedAuthProvider(db, { issuerUrl: ISS, enabled: false });
    const [{ current_database: dbName }] = (await db.execute<{ current_database: string }>(sql`select current_database()`)).rows;
    const dsn = new URL(process.env.TEST_DATABASE_URL!);
    dsn.pathname = `/${dbName}`;
    const holder = new Client({ connectionString: dsn.toString() });
    await holder.connect();
    let res: Awaited<ReturnType<typeof app.inject>>;
    try {
      await holder.query("begin");
      await holder.query("update auth_providers set enabled = true where id = $1", [p.id]);
      const pending = app.inject({ method: "DELETE", url: `/api/admin/auth/providers/${p.id}`, cookies });
      expect(await waitForBlockedOrSettled(db.$client, pending)).toBe("blocked");
      await holder.query("commit");
      res = await pending;
    } finally {
      await holder.end();
    }
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("provider_enabled");
    const [row] = await db.select({ enabled: authProviders.enabled }).from(authProviders).where(eq(authProviders.id, p.id));
    expect(row!.enabled).toBe(true);
  });
});

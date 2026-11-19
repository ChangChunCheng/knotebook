import { describe, expect, it } from "vitest";
import type { CustomFetch } from "openid-client";
import type { BuildAppOptions } from "../src/app.js";
import { authProviders } from "../src/db/schema.js";
import { createOidcRuntimeRegistry } from "../src/auth/oidc-client.js";
import { sealClientSecret } from "../src/auth/oidc-providers.js";
import { testConfig } from "./helpers.js";
import { createFakeIdp } from "./helpers/fake-idp.js";
import { seedAuthProvider } from "./helpers/oidc-provider.js";
import { adminApp, captureLogs, expectAdminOnly, providerRow } from "./helpers/admin-auth.js";

const ISS = "https://idp.example.com";

/** Wraps the registry's fetch with a recorder: URL, headers and body of every outbound request (direct guard for "the secret is never sent"). */
async function probeApp(idpIssuer: string, options: BuildAppOptions = {}) {
  const idp = createFakeIdp(idpIssuer);
  const requests: Array<{ url: string; headers: string; body: string }> = [];
  const fetch: CustomFetch = async (url, init) => {
    requests.push({ url: String(url), headers: JSON.stringify(init.headers ?? {}), body: init.body == null ? "" : String(init.body) });
    return idp.fetch(url, init);
  };
  const built = await adminApp({ oidcRegistry: createOidcRuntimeRegistry({ fetch }) }, options);
  return { ...built, idp, requests };
}

/** #299: a provider without client ID is created via POST (`seedAuthProvider` can't seed NULL). */
async function createWithoutClientId(
  app: Awaited<ReturnType<typeof adminApp>>["app"],
  cookies: Record<string, string>,
  issuerUrl: string,
  clientSecret?: string,
): Promise<string> {
  const payload = { template: "oidc", displayName: "SSO", issuerUrl, ...(clientSecret !== undefined ? { clientSecret } : {}) };
  const res = await app.inject({ method: "POST", url: "/api/admin/auth/providers", cookies, payload });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

describe("POST /api/admin/auth/providers/:id/test (#187)", () => {
  it("site admins only", async () => {
    const { app, db } = await probeApp(ISS);
    const p = await seedAuthProvider(db, { issuerUrl: ISS });
    await expectAdminOnly(app, db, "POST", `/api/admin/auth/providers/${p.id}/test`);
  });

  it("success: returns the IdP's issuer, no warning; discovers afresh every time (bypasses the cache); outbound requests are only discovery and no URL/header/body contains the secret; writes resolved_issuer", async () => {
    const { app, db, cookies, idp, requests } = await probeApp(ISS);
    const p = await seedAuthProvider(db, { issuerUrl: ISS, clientSecret: "test-secret" });
    for (let i = 0; i < 2; i += 1) {
      const res = await app.inject({ method: "POST", url: `/api/admin/auth/providers/${p.id}/test`, cookies });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ issuer: ISS, warnings: [] });
    }
    // Going through registry.get (cached) would not discover the second time -> 1.
    expect(idp.counts).toEqual({ discovery: 2, token: 0, userinfo: 0 });
    expect(requests.map(req => new URL(req.url).pathname)).toEqual(["/.well-known/openid-configuration", "/.well-known/openid-configuration"]);
    for (const req of requests) expect(`${req.url} ${req.headers} ${req.body}`).not.toContain("test-secret");
    expect((await providerRow(db, p.id))!.resolvedIssuer).toBe(ISS);
  });

  it("trailing-slash form: provider has https://gitlab.example/, IdP returns no slash -> success, resolved_issuer has no slash; list issuerResolved turns true", async () => {
    const { app, db, cookies } = await probeApp("https://gitlab.example");
    const p = await seedAuthProvider(db, { issuerUrl: "https://gitlab.example/" });
    const res = await app.inject({ method: "POST", url: `/api/admin/auth/providers/${p.id}/test`, cookies });
    expect(res.json().issuer).toBe("https://gitlab.example");
    expect((await providerRow(db, p.id))!.resolvedIssuer).toBe("https://gitlab.example");
    const list = await app.inject({ method: "GET", url: "/api/admin/auth/providers", cookies });
    expect(list.json().providers[0].issuerResolved).toBe(true);
  });

  it("three warnings: http issuer -> insecure_issuer; metadata doesn't advertise client_secret_post -> client_secret_post_not_advertised; secret can't be decrypted -> secret_undecryptable (still 200)", async () => {
    const { app, db, cookies, idp } = await probeApp("http://idp.lan");
    idp.omitFromMetadata(["token_endpoint_auth_methods_supported"]);
    const p = await seedAuthProvider(db, { issuerUrl: "http://idp.lan", clientSecret: null, enabled: false });
    // Ciphertext sealed for a different id: valid format, AAD mismatch -> can't be decrypted.
    await db.update(authProviders).set({ clientSecretEncrypted: sealClientSecret(testConfig.appSecret, "00000000-0000-4000-8000-000000000000", "x") });
    const res = await app.inject({ method: "POST", url: `/api/admin/auth/providers/${p.id}/test`, cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json().warnings).toEqual(["insecure_issuer", "client_secret_post_not_advertised", "secret_undecryptable"]);
  });

  it("(#299) no client ID -> still 200, warnings only client_id_missing; resolved_issuer still written", async () => {
    const { app, db, cookies } = await probeApp(ISS);
    const id = await createWithoutClientId(app, cookies, ISS);
    const res = await app.inject({ method: "POST", url: `/api/admin/auth/providers/${id}/test`, cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json().warnings).toEqual(["client_id_missing"]);
    expect((await providerRow(db, id))!.resolvedIssuer).toBe(ISS);
  });

  it("http issuer with no client ID -> client_id_missing comes after probeWarnings", async () => {
    const { app, cookies } = await probeApp("http://idp.lan");
    const id = await createWithoutClientId(app, cookies, "http://idp.lan");
    const res = await app.inject({ method: "POST", url: `/api/admin/auth/providers/${id}/test`, cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json().warnings).toEqual(["insecure_issuer", "client_id_missing"]);
  });

  it("order when all four warnings appear: insecure_issuer -> client_secret_post_not_advertised -> client_id_missing -> secret_undecryptable", async () => {
    const { app, db, cookies, idp } = await probeApp("http://idp.lan");
    idp.omitFromMetadata(["token_endpoint_auth_methods_supported"]);
    const id = await createWithoutClientId(app, cookies, "http://idp.lan", "s3cret");
    await db.update(authProviders).set({ clientSecretEncrypted: sealClientSecret(testConfig.appSecret, "00000000-0000-4000-8000-000000000000", "x") });
    const res = await app.inject({ method: "POST", url: `/api/admin/auth/providers/${id}/test`, cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json().warnings).toEqual(["insecure_issuer", "client_secret_post_not_advertised", "client_id_missing", "secret_undecryptable"]);
  });

  it("no secret -> no secret_undecryptable (nothing to decrypt)", async () => {
    const { app, db, cookies } = await probeApp(ISS);
    const p = await seedAuthProvider(db, { issuerUrl: ISS, clientSecret: null, enabled: false });
    const res = await app.inject({ method: "POST", url: `/api/admin/auth/providers/${p.id}/test`, cookies });
    expect(res.json().warnings).toEqual([]);
  });

  it("discovery failure -> 502 oidc_discovery_failed, resolved_issuer not written; warn log carries only {providerId, issuer}, no error message", async () => {
    const logs = captureLogs();
    const { app, db, cookies, idp } = await probeApp(ISS, logs.options);
    const p = await seedAuthProvider(db, { issuerUrl: ISS });
    // Precondition: what the error message of this same failure looks like (the assertion below says the log doesn't contain it; an empty message would measure nothing).
    idp.failNext("discovery");
    const errMessage = await createOidcRuntimeRegistry({ fetch: idp.fetch })
      .probe(ISS)
      .then(
        () => "",
        (err: unknown) => (err instanceof Error ? err.message : ""),
      );
    expect(errMessage).not.toBe("");

    idp.failNext("discovery");
    const res = await app.inject({ method: "POST", url: `/api/admin/auth/providers/${p.id}/test`, cookies });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("oidc_discovery_failed");
    expect((await providerRow(db, p.id))!.resolvedIssuer).toBeNull();
    const line = logs.lines.find(l => l.msg === "登入服務測試連線失敗");
    expect(line!.level).toBe("warn");
    expect(line!.obj).toEqual({ providerId: p.id, issuer: "https://idp.example.com/" });
    // Exclude fastify lifecycle lines: same reason as the /discover failure case below.
    expect(JSON.stringify(logs.lines.filter(l => l.msg !== "incoming request" && l.msg !== "request completed"))).not.toContain(errMessage);
  });

  it("uppercase uuid path is equivalent; nonexistent -> 404 not_found", async () => {
    const { app, db, cookies } = await probeApp(ISS);
    const p = await seedAuthProvider(db, { issuerUrl: ISS });
    expect((await app.inject({ method: "POST", url: `/api/admin/auth/providers/${p.id.toUpperCase()}/test`, cookies })).statusCode).toBe(200);
    const missing = await app.inject({ method: "POST", url: "/api/admin/auth/providers/00000000-0000-4000-8000-000000000000/test", cookies });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("not_found");
  });
});

describe("POST /api/admin/auth/discover (#187: probe before saving)", () => {
  it("site admins only", async () => {
    const { app, db } = await probeApp(ISS);
    await expectAdminOnly(app, db, "POST", "/api/admin/auth/discover", { issuerUrl: ISS });
  });

  it("success returns issuer + warnings; creates no row", async () => {
    const { app, db, cookies, idp } = await probeApp("http://idp.lan");
    idp.omitFromMetadata(["token_endpoint_auth_methods_supported"]);
    const res = await app.inject({ method: "POST", url: "/api/admin/auth/discover", cookies, payload: { issuerUrl: "http://idp.lan" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ issuer: "http://idp.lan", warnings: ["insecure_issuer", "client_secret_post_not_advertised"] });
    expect(await db.select().from(authProviders)).toHaveLength(0);
  });

  it("discovery failure -> 502; warn log carries only origin+pathname, no userinfo and no error message", async () => {
    const logs = captureLogs();
    const { app, cookies, idp } = await probeApp(ISS, logs.options);
    idp.failNext("discovery");
    // An issuer with user:pass@ now gets 400 at the entry (next case); a query is used here, still verifying the log keeps only origin+pathname.
    const res = await app.inject({ method: "POST", url: "/api/admin/auth/discover", cookies, payload: { issuerUrl: "https://idp.example.com?k=query-secret-marker" } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("oidc_discovery_failed");
    const line = logs.lines.find(l => l.msg === "登入服務先試探失敗");
    expect(line!.obj).toEqual({ issuer: "https://idp.example.com/" });
    // Fastify lifecycle lines (incoming request / request completed) are seen by the logMethod hook as the raw req/res objects before serialization (including light-my-request's payload);
    // the real output goes through `serializers.req` (app.ts `withTokenRedaction`) and keeps only method/url/host/remote, no body - exclude those two lines.
    expect(JSON.stringify(logs.lines.filter(l => l.msg !== "incoming request" && l.msg !== "request completed"))).not.toContain("query-secret-marker");
  });

  it("issuer with credentials -> 400 invalid_body, IdP not called; log has no password", async () => {
    const logs = captureLogs();
    const { app, cookies, idp } = await probeApp(ISS, logs.options);
    for (const issuerUrl of ["https://user:pass@idp.example.com", "https://user@idp.example.com"]) {
      const res = await app.inject({ method: "POST", url: "/api/admin/auth/discover", cookies, payload: { issuerUrl } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
    }
    expect(idp.counts.discovery).toBe(0);
    expect(JSON.stringify(logs.lines.filter(l => l.msg !== "incoming request" && l.msg !== "request completed"))).not.toContain("pass@");
  });

  it("invalid issuer (uppercase scheme, NUL) -> 400, IdP not called", async () => {
    const { app, cookies, idp } = await probeApp(ISS);
    for (const issuerUrl of ["HTTPS://idp.example.com", `https://idp.example.com/${String.fromCodePoint(0)}`]) {
      expect((await app.inject({ method: "POST", url: "/api/admin/auth/discover", cookies, payload: { issuerUrl } })).statusCode).toBe(400);
    }
    expect(idp.counts.discovery).toBe(0);
  });
});

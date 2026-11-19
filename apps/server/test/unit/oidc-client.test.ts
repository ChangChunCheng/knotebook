import { describe, expect, it } from "vitest";
import type { CustomFetch } from "openid-client";
import { OidcUnavailableError, createOidcRuntime, oidcRedirectUri, type OidcClientSettings } from "../../src/auth/oidc-client.js";
import { loadConfig } from "../../src/config.js";

function config(publicUrl: string) {
  return loadConfig({
    DATABASE_URL: "postgres://u:p@localhost:5432/test",
    APP_SECRET: "a".repeat(64),
    PUBLIC_URL: publicUrl,
  });
}

const ISSUER_URL = "https://idp.example.com";

/** #187: `AppConfig.oidc` was removed; the runtime takes `OidcClientSettings` directly. */
function oidcSettings(): OidcClientSettings {
  return { issuerUrl: ISSUER_URL, clientId: "test-client", clientSecret: "test-secret" };
}

/** Hand-written CustomFetch stub: answers only the discovery URL, so `getConfiguration()` never reaches other endpoints.
 * When `algs` is `undefined` the whole field is omitted (tests the missing-field branch); otherwise it goes into metadata as-is. */
function discoveryOnlyFetch(algs: string[] | undefined): CustomFetch {
  return async url => {
    if (!new URL(url).pathname.endsWith("/.well-known/openid-configuration")) {
      return new Response(null, { status: 404 });
    }
    const metadata: Record<string, unknown> = {
      issuer: ISSUER_URL,
      authorization_endpoint: `${ISSUER_URL}/authorize`,
      token_endpoint: `${ISSUER_URL}/token`,
      userinfo_endpoint: `${ISSUER_URL}/userinfo`,
      jwks_uri: `${ISSUER_URL}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
    };
    if (algs !== undefined) metadata.id_token_signing_alg_values_supported = algs;
    return new Response(JSON.stringify(metadata), { status: 200, headers: { "content-type": "application/json" } });
  };
}

const LEGACY = { id: "p1", legacyCallback: true };
const PER_PROVIDER = { id: "p1", legacyCallback: false };

describe("auth/oidc-client: oidcRedirectUri (the one helper shared by login, callback and the SSO proof start, #187)", () => {
  it("legacy provider -> <publicUrl origin>/api/auth/oidc/callback (the one imported from env keeps the old callback URL)", () => {
    expect(oidcRedirectUri(config("https://notes.example.com"), LEGACY)).toBe(
      "https://notes.example.com/api/auth/oidc/callback"
    );
  });

  it("ordinary provider -> <publicUrl origin>/api/auth/oidc/callback/<id>", () => {
    expect(oidcRedirectUri(config("https://notes.example.com"), PER_PROVIDER)).toBe(
      "https://notes.example.com/api/auth/oidc/callback/p1"
    );
  });

  it("publicUrl with a port -> the port is kept", () => {
    expect(oidcRedirectUri(config("http://192.168.1.50:3000"), PER_PROVIDER)).toBe(
      "http://192.168.1.50:3000/api/auth/oidc/callback/p1"
    );
  });

  it("publicUrl with a path -> the absolute path overrides (the second argument of new URL takes only the origin, it doesn't append to an existing path)", () => {
    expect(oidcRedirectUri(config("https://notes.example.com/base/path"), PER_PROVIDER)).toBe(
      "https://notes.example.com/api/auth/oidc/callback/p1"
    );
  });
});

describe("auth/oidc-client: how createOidcRuntime judges id_token_signing_alg_values_supported (three branches)", () => {
  it("metadata lacks the field -> treated as containing RS256, not blocked (getConfiguration resolves normally)", async () => {
    const runtime = createOidcRuntime(oidcSettings(), { fetch: discoveryOnlyFetch(undefined) });
    await expect(runtime.getConfiguration()).resolves.toBeDefined();
  });

  it('metadata contains only HS256 (no asymmetric algorithm) -> throws OidcUnavailableError', async () => {
    const runtime = createOidcRuntime(oidcSettings(), { fetch: discoveryOnlyFetch(["HS256"]) });
    await expect(runtime.getConfiguration()).rejects.toBeInstanceOf(OidcUnavailableError);
  });

  it('metadata contains RS256 -> passes normally', async () => {
    const runtime = createOidcRuntime(oidcSettings(), { fetch: discoveryOnlyFetch(["RS256"]) });
    await expect(runtime.getConfiguration()).resolves.toBeDefined();
  });
});

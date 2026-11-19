// Per app instance, never a module singleton (same reason as `AppDeps.limiters`).

import * as client from "openid-client";
import type { AppConfig } from "../config.js";
import { fetchErrorSummary, type FetchErrorSummary } from "../lib/fetch-error-summary.js";
import { safeTarget } from "../lib/safe-target.js";

export class OidcUnavailableError extends Error {
  // No raw issuer URL (may carry `user:pass@`; use `safeTarget`) and no underlying message (fetch's TypeError holds the full URL);
  // only `fetchErrorSummary` goes in `underlying`. Exception: the registry's loadSecret wrapper appends `SecretDecryptError`'s message,
  // a fixed text from `lib/sealed-secret.ts` (unknown format, fingerprint mismatch, auth failure) with no secret or URL.
  constructor(
    message: string,
    readonly underlying?: FetchErrorSummary
  ) {
    super(message);
    this.name = "OidcUnavailableError";
  }
}

export function oidcErrorLogFields(err: unknown): Record<string, unknown> {
  if (err instanceof OidcUnavailableError) {
    return { errName: err.name, reason: err.message, ...(err.underlying !== undefined ? { underlying: err.underlying } : {}) };
  }
  return { ...fetchErrorSummary(err) };
}

export interface OidcClientSettings {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
}

export interface OidcRuntimeOptions {
  fetch?: client.CustomFetch;
}

export interface OidcRuntime {
  /** Failures and unusable metadata are not cached (retried next call); concurrent first calls share one discovery. */
  getConfiguration(): Promise<client.Configuration>;
}

const ASYMMETRIC_ALG_PREFIXES = ["RS", "ES", "PS"];

/** A missing field counts as RS256-capable: most IdPs that omit this optional field still support it. */
function hasAsymmetricSigningAlg(algs: readonly string[] | undefined): boolean {
  if (algs === undefined) return true;
  return algs.some(alg => ASYMMETRIC_ALG_PREFIXES.some(prefix => alg.startsWith(prefix)));
}

/** Shared by login and `probeOidcIssuer` so the admin "test connection" can't say OK while login says `oidc_unavailable`. */
function assertUsableMetadata(metadata: client.ServerMetadata, issuerUrl: string): void {
  if (!metadata.jwks_uri || !hasAsymmetricSigningAlg(metadata.id_token_signing_alg_values_supported)) {
    throw new OidcUnavailableError(`OIDC issuer metadata 不可用（issuer=${safeTarget(issuerUrl)}）：缺 jwks_uri 或無非對稱簽章演算法`);
  }
  if (metadata.issuer.length > MAX_ISSUER_LENGTH) {
    // Bounds the issuer stored in identities and the pending cookie; the `auth_providers` CHECK only covers the admin's literal input.
    throw new OidcUnavailableError(`OIDC issuer 過長（${metadata.issuer.length} > ${MAX_ISSUER_LENGTH}）`);
  }
}

function discoveryOptionsFor(issuerUrl: URL, fetch: client.CustomFetch | undefined): client.DiscoveryRequestOptions {
  const execute: Array<(config: client.Configuration) => void> = [];
  if (issuerUrl.protocol === "http:") execute.push(client.allowInsecureRequests);
  const options: client.DiscoveryRequestOptions = { execute };
  if (fetch) options[client.customFetch] = fetch;
  return options;
}

export function createOidcRuntime(oidc: OidcClientSettings, opts: OidcRuntimeOptions = {}): OidcRuntime {
  let cached: client.Configuration | undefined;
  let inflight: Promise<client.Configuration> | undefined;

  async function runDiscovery(): Promise<client.Configuration> {
    const issuerUrl = new URL(oidc.issuerUrl);

    // openid-client v6 is TLS-only by default: an http: issuer (trusted LAN) needs allowInsecureRequests, even for discovery.
    const discoveryOptions = discoveryOptionsFor(issuerUrl, opts.fetch);

    let configuration: client.Configuration;
    try {
      configuration = await client.discovery(
        issuerUrl,
        oidc.clientId,
        undefined,
        // Explicit ClientSecretPost rather than relying on discovery's token_endpoint_auth_method.
        client.ClientSecretPost(oidc.clientSecret),
        discoveryOptions
      );
    } catch (err) {
      throw new OidcUnavailableError(`OIDC discovery 失敗（issuer=${safeTarget(oidc.issuerUrl)}）`, fetchErrorSummary(err));
    }

    // discovery already got this fetch via discoveryOptions; set it on the Configuration too so the later token/userinfo/jwks requests use the same (mock) fetch.
    if (opts.fetch) configuration[client.customFetch] = opts.fetch;

    assertUsableMetadata(configuration.serverMetadata(), oidc.issuerUrl);

    // After the usability check: enabling this makes every id_token verification require an asymmetric signature.
    client.enableNonRepudiationChecks(configuration);

    return configuration;
  }

  return {
    async getConfiguration(): Promise<client.Configuration> {
      if (cached) return cached;
      if (!inflight) {
        inflight = runDiscovery()
          .then(configuration => {
            cached = configuration;
            return configuration;
          })
          .finally(() => {
            inflight = undefined;
          });
      }
      return inflight;
    },
  };
}

/** Discovery only (client.None(), no secret, no cache). It can't verify the client id/secret (the IdP only checks those on a real token exchange): the UI text must say so. */
export async function probeOidcIssuer(issuerUrl: string, opts: OidcRuntimeOptions = {}): Promise<client.ServerMetadata> {
  let url: URL;
  try {
    url = new URL(issuerUrl);
    // Unparsable: no safeTarget available, and the raw string may carry credentials, so it stays out of the message.
  } catch {
    throw new OidcUnavailableError("OIDC issuer 不是合法網址");
  }
  let configuration: client.Configuration;
  try {
    configuration = await client.discovery(url, PROBE_CLIENT_ID, undefined, client.None(), discoveryOptionsFor(url, opts.fetch));
  } catch (err) {
    throw new OidcUnavailableError(`OIDC discovery 失敗（issuer=${safeTarget(issuerUrl)}）`, fetchErrorSummary(err));
  }
  const metadata = configuration.serverMetadata();
  assertUsableMetadata(metadata, issuerUrl);
  return metadata;
}

const PROBE_CLIENT_ID = "knotebook-discovery-probe";

/** Legacy (env-imported) providers keep the old path so the callback URL registered at the IdP stays valid. An absolute path drops any sub-path of PUBLIC_URL. */
export function oidcRedirectUri(config: Pick<AppConfig, "publicUrl">, provider: { id: string; legacyCallback: boolean }): string {
  const path = provider.legacyCallback ? "/api/auth/oidc/callback" : `/api/auth/oidc/callback/${provider.id}`;
  return new URL(path, config.publicUrl).href;
}

/** Same value as the CHECK in migration 0014. */
export const MAX_ISSUER_LENGTH = 512;

export interface OidcRuntimeKey {
  id: string;
  issuerUrl: string;
  clientId: string;
  configVersion: number;
}

/** Keyed by `(id, configVersion)` so a missed `invalidate` self-heals; issuerUrl/clientId are compared as defence in depth. `loadSecret` runs only when a runtime is built; its failure becomes `OidcUnavailableError` and isn't cached. `/test` uses `probe` and bypasses the cache. */
export interface OidcRuntimeRegistry {
  get(key: OidcRuntimeKey, loadSecret: () => Promise<string>): Promise<client.Configuration>;
  invalidate(id: string): void;
  probe(issuerUrl: string): Promise<client.ServerMetadata>;
}

export function createOidcRuntimeRegistry(opts: OidcRuntimeOptions = {}): OidcRuntimeRegistry {
  interface Entry extends OidcRuntimeKey {
    runtime: Promise<OidcRuntime>;
  }
  const entries = new Map<string, Entry>();
  return {
    async get(key, loadSecret) {
      let entry = entries.get(key.id);
      if (!entry || entry.configVersion !== key.configVersion || entry.issuerUrl !== key.issuerUrl || entry.clientId !== key.clientId) {
        const runtime = (async () => {
          let clientSecret: string;
          try {
            clientSecret = await loadSecret();
          } catch (err) {
            throw new OidcUnavailableError(`OIDC client secret 無法取得（provider=${key.id}）：${err instanceof Error ? err.message : String(err)}`);
          }
          return createOidcRuntime({ issuerUrl: key.issuerUrl, clientId: key.clientId, clientSecret }, opts);
        })();
        const created: Entry = { ...key, runtime };
        entries.set(key.id, created);
        // Delete only our own entry (a newer version may have replaced it). This catch also swallows the unhandled rejection; callers await separately.
        runtime.catch(() => {
          if (entries.get(key.id) === created) entries.delete(key.id);
        });
        entry = created;
      }
      const runtime = await entry.runtime;
      return runtime.getConfiguration();
    },
    invalidate(id) {
      entries.delete(id);
    },
    probe(issuerUrl) {
      return probeOidcIssuer(issuerUrl, opts);
    },
  };
}

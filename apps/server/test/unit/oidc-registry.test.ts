import { describe, expect, it } from "vitest";
import type { CustomFetch } from "openid-client";
import { OidcUnavailableError, createOidcRuntimeRegistry, probeOidcIssuer, type OidcRuntimeKey } from "../../src/auth/oidc-client.js";
import { createFakeIdp } from "../helpers/fake-idp.js";

const ISSUER = "https://idp.example.com";
const key = (over: Partial<OidcRuntimeKey> = {}): OidcRuntimeKey => ({ id: "p1", issuerUrl: ISSUER, clientId: "c", configVersion: 1, ...over });

describe("createOidcRuntimeRegistry (#187)", () => {
  it("same (id, configVersion) -> cached (discovery once, loadSecret once, the same Configuration)", async () => {
    const idp = createFakeIdp(ISSUER);
    const registry = createOidcRuntimeRegistry({ fetch: idp.fetch });
    let loads = 0;
    const load = async () => { loads += 1; return "s"; };
    const a = await registry.get(key(), load);
    const b = await registry.get(key(), load);
    expect(b).toBe(a);
    expect(idp.counts.discovery).toBe(1);
    expect(loads).toBe(1);
  });

  it("configVersion changed -> discovery and loadSecret again (self-heals even if invalidate was missed)", async () => {
    const idp = createFakeIdp(ISSUER);
    const registry = createOidcRuntimeRegistry({ fetch: idp.fetch });
    let loads = 0;
    const load = async () => { loads += 1; return "s"; };
    const a = await registry.get(key(), load);
    const b = await registry.get(key({ configVersion: 2 }), load);
    expect(b).not.toBe(a);
    expect(idp.counts.discovery).toBe(2);
    expect(loads).toBe(2);
  });

  it("invalidate(id) -> the next call discovers again", async () => {
    const idp = createFakeIdp(ISSUER);
    const registry = createOidcRuntimeRegistry({ fetch: idp.fetch });
    await registry.get(key(), async () => "s");
    registry.invalidate("p1");
    await registry.get(key(), async () => "s");
    expect(idp.counts.discovery).toBe(2);
  });

  it("the first concurrent wave shares one discovery (in-flight dedup is kept)", async () => {
    const idp = createFakeIdp(ISSUER);
    const registry = createOidcRuntimeRegistry({ fetch: idp.fetch });
    await Promise.all([1, 2, 3].map(() => registry.get(key(), async () => "s")));
    expect(idp.counts.discovery).toBe(1);
  });

  it("loadSecret fails -> OidcUnavailableError, and is not cached (the next attempt calls loadSecret again)", async () => {
    const idp = createFakeIdp(ISSUER);
    const registry = createOidcRuntimeRegistry({ fetch: idp.fetch });
    await expect(registry.get(key(), async () => { throw new Error("undecryptable"); })).rejects.toBeInstanceOf(OidcUnavailableError);
    let loads = 0;
    await registry.get(key(), async () => { loads += 1; return "s"; });
    expect(loads).toBe(1);
  });

  it("same configVersion but a new issuerUrl -> discovery again and the new issuer's Configuration; a changed clientId also rebuilds (defence in depth)", async () => {
    const ISSUER2 = "https://idp2.example.com";
    const idp1 = createFakeIdp(ISSUER);
    const idp2 = createFakeIdp(ISSUER2);
    // Two fake IdPs share one fetch: dispatch by host (not relying on trailing-slash issuer comparison details).
    const fetch: CustomFetch = (url, options) => (String(url).startsWith(`${ISSUER2}/`) ? idp2 : idp1).fetch(url, options);
    const registry = createOidcRuntimeRegistry({ fetch });
    const a = await registry.get(key(), async () => "s");
    expect(a.serverMetadata().issuer).toBe(ISSUER);
    const b = await registry.get(key({ issuerUrl: ISSUER2 }), async () => "s");
    expect(b.serverMetadata().issuer).toBe(ISSUER2);
    expect(idp1.counts.discovery + idp2.counts.discovery).toBe(2);
    const c = await registry.get(key({ issuerUrl: ISSUER2, clientId: "other-client" }), async () => "s");
    expect(c).not.toBe(b);
    expect(idp2.counts.discovery).toBe(2);
  });

  it("metadata.issuer over 512 characters -> OidcUnavailableError (not cached; upper bound on issuer length)", async () => {
    const longIssuer = `https://idp.example.com/${"x".repeat(500)}`;
    expect(longIssuer.length).toBeGreaterThan(512);
    const idp = createFakeIdp(longIssuer);
    const registry = createOidcRuntimeRegistry({ fetch: idp.fetch });
    await expect(registry.get(key({ issuerUrl: longIssuer }), async () => "s")).rejects.toBeInstanceOf(OidcUnavailableError);
    await expect(registry.get(key({ issuerUrl: longIssuer }), async () => "s")).rejects.toBeInstanceOf(OidcUnavailableError);
    expect(idp.counts.discovery).toBe(2);
  });
});

describe("registry.probe/probeOidcIssuer (#187: used by /test and /discover; bypasses the cache, sends no secret)", () => {
  it("returns the discovery metadata; only hits discovery, not token; afterwards get still has to discover itself (probe doesn't write the cache)", async () => {
    const idp = createFakeIdp(ISSUER);
    const registry = createOidcRuntimeRegistry({ fetch: idp.fetch });
    const metadata = await registry.probe(ISSUER);
    expect(metadata.issuer).toBe(ISSUER);
    expect(idp.counts).toEqual({ discovery: 1, token: 0, userinfo: 0 });
    await registry.get(key(), async () => "s");
    expect(idp.counts.discovery).toBe(2);
  });

  it("probe neither reads nor touches the cache: after get has built a runtime probe still discovers again; get after probe still uses the cache (discovery doesn't increase)", async () => {
    const idp = createFakeIdp(ISSUER);
    const registry = createOidcRuntimeRegistry({ fetch: idp.fetch });
    await registry.get(key(), async () => "s");
    await registry.probe(ISSUER);
    expect(idp.counts.discovery).toBe(2);
    await registry.get(key(), async () => "s");
    expect(idp.counts.discovery).toBe(2);
  });

  it("discovery fails, jwks_uri missing, URL unparsable -> OidcUnavailableError", async () => {
    const idp = createFakeIdp(ISSUER);
    const registry = createOidcRuntimeRegistry({ fetch: idp.fetch });
    idp.failNext("discovery");
    await expect(registry.probe(ISSUER)).rejects.toBeInstanceOf(OidcUnavailableError);
    idp.omitFromMetadata(["jwks_uri"]);
    await expect(registry.probe(ISSUER)).rejects.toBeInstanceOf(OidcUnavailableError);
    await expect(registry.probe("not a url")).rejects.toBeInstanceOf(OidcUnavailableError);
  });

  it("the issuer the IdP reports differs from the input (trailing-slash form with a path) -> OidcUnavailableError", async () => {
    const idp = createFakeIdp(`${ISSUER}/realms/x`);
    const registry = createOidcRuntimeRegistry({ fetch: idp.fetch });
    await expect(registry.probe(`${ISSUER}/realms/x/`)).rejects.toBeInstanceOf(OidcUnavailableError);
  });

  it("probeOidcIssuer shares the availability check with the runtime: metadata.issuer over 512 characters -> OidcUnavailableError", async () => {
    const longIssuer = `${ISSUER}/${"a".repeat(520)}`;
    const idp = createFakeIdp(longIssuer);
    await expect(probeOidcIssuer(longIssuer, { fetch: idp.fetch })).rejects.toBeInstanceOf(OidcUnavailableError);
  });
});

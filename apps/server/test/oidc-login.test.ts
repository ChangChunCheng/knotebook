import { describe, expect, it } from "vitest";
import { MAX_NEXT_PATH_LENGTH, OIDC_STATE_COOKIE } from "@knotebook/shared";
import type { CustomFetch } from "openid-client";
import { Writable } from "node:stream";
import { eq } from "drizzle-orm";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { createOidcRuntimeRegistry } from "../src/auth/oidc-client.js";
import { authProviders } from "../src/db/schema.js";
import { buildTestApp, freshDb, freshLimiters } from "./helpers.js";
import { createFakeIdp } from "./helpers/fake-idp.js";
import { legacyOidcApp, seedAuthProvider } from "./helpers/oidc-provider.js";
import { unsealOidcState, type OidcStatePayload } from "../src/auth/oidc-state.js";

const ISSUER_URL = "https://idp.example.com";

/** A fetch whose underlying behaviour can be swapped: lets the same registry change behaviour mid-test (e.g. "discovery fails first,
 * retry after fixing") without rebuilding the registry, which would lose the cache state being verified. */
function switchableFetch(initial: CustomFetch): { fetch: CustomFetch; set(next: CustomFetch): void } {
  let current = initial;
  const fetch: CustomFetch = (...args) => current(...args);
  return { fetch, set: next => (current = next) };
}

const throwingFetch: CustomFetch = async () => {
  throw new Error("network unreachable");
};

/**
 * The state payload's next. `OidcStatePayload` is a union (the prove form has no next); reading `p.next` directly is TS2339 under
 * `tsconfig.test.json`, so always go through this narrowing helper.
 */
function nextOf(p: OidcStatePayload | null): string | undefined {
  return p !== null && p.intent === "login" ? p.next : undefined;
}

describe("GET /api/auth/oidc/login (legacy entry, #187)", () => {
  it("no legacy provider (the one on the old callback URL) -> 302 /login?error=oidc_unavailable; legacy provider disabled -> same", async () => {
    const { app, db } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=oidc_unavailable");

    await seedAuthProvider(db, { issuerUrl: ISSUER_URL, legacyCallback: true, enabled: false });
    const disabled = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(disabled.statusCode).toBe(302);
    expect(disabled.headers.location).toBe("/login?error=oidc_unavailable");
  });

  it("configured + mock IdP -> 302 to the authorize endpoint with correct query/cookie; redirect_uri is the old callback URL; the state cookie binds providerId/configVersion/intent", async () => {
    const fakeIdp = createFakeIdp(ISSUER_URL);
    const { app, config, provider } = await legacyOidcApp(fakeIdp.fetch, ISSUER_URL);

    const res = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(res.statusCode).toBe(302);

    const location = new URL(res.headers.location as string);
    expect(location.origin).toBe(ISSUER_URL);
    expect(location.pathname).toBe("/authorize");
    // Exact URL-decoded assertion (searchParams.get already decodes): the scope is verbatim "openid email profile".
    expect(location.searchParams.get("scope")).toBe("openid email profile");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(location.searchParams.get("nonce")).toBeTruthy();
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toBeTruthy();
    // The legacy provider keeps the old callback URL (the one registered at the IdP needn't change).
    expect(location.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/auth/oidc/callback");

    const cookie = res.cookies.find(c => c.name === OIDC_STATE_COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.path).toBe("/api/auth/oidc");
    // sameSite and maxAge are asserted: changing one to "none" or the seconds (say 5) would otherwise keep the whole matrix green.
    expect(cookie?.sameSite).toBe("Lax");
    expect(cookie?.maxAge).toBe(600);

    // Sealed cookie value matches the authorize URL: reading back the sealed state/nonce must equal the 302 location's query,
    // proving both come from the same generation.
    const nowEpochSeconds = Math.floor(Date.now() / 1000);
    const sealedPayload = unsealOidcState(config.appSecret, cookie!.value, nowEpochSeconds);
    expect(sealedPayload).not.toBeNull();
    expect(sealedPayload?.state).toBe(location.searchParams.get("state"));
    expect(sealedPayload?.nonce).toBe(location.searchParams.get("nonce"));
    // The cookie binds the provider that issued it and the current config version; login is always intent "login".
    expect(sealedPayload).toMatchObject({ providerId: provider.id, configVersion: 1, intent: "login" });

    // Unpredictability: a second request must produce a different state (not a fixed value/predictable sequence).
    const res2 = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    const location2 = new URL(res2.headers.location as string);
    expect(location2.searchParams.get("state")).not.toBe(location.searchParams.get("state"));
  });

  it("discovery network failure (IdP 5xx, harness failNext one-shot) -> 302 oidc_unavailable; not cached: hitting the same app again (failNext consumed, restored) -> 302 to the IdP", async () => {
    const fakeIdp = createFakeIdp(ISSUER_URL);
    fakeIdp.failNext("discovery");
    const { app } = await legacyOidcApp(fakeIdp.fetch, ISSUER_URL);

    const first = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).toBe("/login?error=oidc_unavailable");

    // failNext is one-shot, so no manual "fix" is needed here: the call above already consumed and restored it.
    const second = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(second.statusCode).toBe(302);
    expect(new URL(second.headers.location as string).origin).toBe(ISSUER_URL);
  });

  it("discovery succeeds but metadata has no jwks_uri -> 302 oidc_unavailable; after fixing, retry succeeds: unavailability isn't cached", async () => {
    const fakeIdp = createFakeIdp(ISSUER_URL);
    fakeIdp.omitFromMetadata(["jwks_uri"]);
    const { app } = await legacyOidcApp(fakeIdp.fetch, ISSUER_URL);

    const first = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).toBe("/login?error=oidc_unavailable");

    fakeIdp.omitFromMetadata([]);

    const second = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(second.statusCode).toBe(302);
    expect(new URL(second.headers.location as string).origin).toBe(ISSUER_URL);
  });

  it("after discovery succeeded, replacing fetch with a throwing one -> still 302 to the IdP (success is cached until the config version changes or restart)", async () => {
    const fakeIdp = createFakeIdp(ISSUER_URL);
    const swap = switchableFetch(fakeIdp.fetch);
    const { app } = await legacyOidcApp(swap.fetch, ISSUER_URL);

    const first = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(first.statusCode).toBe(302);
    expect(new URL(first.headers.location as string).origin).toBe(ISSUER_URL);

    swap.set(throwingFetch);

    const second = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(second.statusCode).toBe(302);
    expect(new URL(second.headers.location as string).origin).toBe(ISSUER_URL);
  });

  it("in-flight dedupe: the first concurrent wave shares one discovery -> exactly one discovery fetch", async () => {
    const fakeIdp = createFakeIdp(ISSUER_URL);
    const { app } = await legacyOidcApp(fakeIdp.fetch, ISSUER_URL);

    const [first, second] = await Promise.all([
      app.inject({ method: "GET", url: "/api/auth/oidc/login" }),
      app.inject({ method: "GET", url: "/api/auth/oidc/login" }),
    ]);
    expect(first.statusCode).toBe(302);
    expect(second.statusCode).toBe(302);
    expect(fakeIdp.counts.discovery).toBe(1);
  });

  it("resolved_issuer write-back failure (DB error) -> best effort: login still 302s to the IdP and logs one warn (carrying only the provider id and error message), not oidc_unavailable", async () => {
    // A providerConfiguration write-back failure must not become a login failure. The only UPDATE on the login path is
    // recordResolvedIssuer: make the app db's update always throw, everything else as usual.
    const { db } = await freshDb();
    const failingUpdates = new Proxy(db, {
      get(target, key, receiver) {
        if (key === "update") return () => { throw new Error("simulated DB failure"); };
        return Reflect.get(target, key, receiver);
      },
    });
    const lines: string[] = [];
    const stream = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
    const fakeIdp = createFakeIdp(ISSUER_URL);
    const { app } = await buildTestApp(
      { db: failingUpdates, oidcRegistry: createOidcRuntimeRegistry({ fetch: fakeIdp.fetch }) },
      { logger: { level: "warn", stream } },
    );
    const provider = await seedAuthProvider(db, { issuerUrl: ISSUER_URL, legacyCallback: true });

    const res = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(res.statusCode).toBe(302);
    expect(new URL(res.headers.location as string).origin).toBe(ISSUER_URL);

    const warned = lines.flatMap(l => l.split("\n")).filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)
      .filter(l => l.msg === "resolved_issuer 寫回失敗（盡力而為，登入照常）");
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ level: 40, providerId: provider.id, error: "simulated DB failure" });
    // It really wasn't written (the write-back really failed, not skipped).
    const [row] = await db.select({ r: authProviders.resolvedIssuer }).from(authProviders).where(eq(authProviders.id, provider.id));
    expect(row!.r).toBeNull();
  });

  it("limiter: the 30th request from the same IP still passes, the 31st -> 302 too_many_requests", async () => {
    const fakeIdp = createFakeIdp(ISSUER_URL);
    const { app } = await legacyOidcApp(fakeIdp.fetch, ISSUER_URL);

    let res: Awaited<ReturnType<typeof app.inject>> | undefined;
    for (let i = 0; i < 31; i += 1) {
      res = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
      // Pinning only the 31st proves the quota has a limit, not that it is exactly 30: also pinning that the 30th still succeeds
      // with a 302 to the IdP locks the limit to exactly OIDC_LIMIT=30.
      if (i === 29) {
        expect(res.statusCode).toBe(302);
        expect(new URL(res.headers.location as string).origin).toBe(ISSUER_URL);
      }
    }
    expect(res!.statusCode).toBe(302);
    expect(res!.headers.location).toBe("/login?error=too_many_requests");
  });

  it("limiter: callback has its own quota and doesn't charge login (issue #16)", async () => {
    // A full SSO login is always login then callback. If they shared one bucket, every login would cost two units and usable logins
    // would be half the nominal (an office network behind a shared egress IP would hit it sooner).
    const fakeIdp = createFakeIdp(ISSUER_URL);
    const { app } = await legacyOidcApp(fakeIdp.fetch, ISSUER_URL);

    // First exhaust callback's quota (no state cookie, always 302 back to oidc_state_mismatch, but **still counted**: this route can
    // be hit externally without first going through login).
    for (let i = 0; i < 31; i += 1) {
      await app.inject({ method: "GET", url: "/api/auth/oidc/callback?code=x&state=y" });
    }
    const exhausted = await app.inject({ method: "GET", url: "/api/auth/oidc/callback?code=x&state=y" });
    expect(exhausted.headers.location).toBe("/login?error=too_many_requests");

    // login's quota must be completely untouched.
    const login = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(login.statusCode).toBe(302);
    expect(new URL(login.headers.location as string).origin).toBe(ISSUER_URL);
  });
});

// login accepts ?next= and seals it into the state cookie. The only criterion is safeNextPath (shared with the web app, including the
// 2048 cap). There is deliberately no second length gate: the sealed cookie's 4 KB limit doesn't require one (see the "sealed cookie
// bytes" case below).
describe("login endpoint's next (#131)", () => {
  async function loginWithNext(
    url: string,
  ): Promise<{ next: string | undefined; cookieBytes: number; setCookieBytes: number }> {
    const fakeIdp = createFakeIdp(ISSUER_URL);
    const { app, config } = await legacyOidcApp(fakeIdp.fetch, ISSUER_URL);

    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    // Really went to the IdP: otherwise the undefined decoded below is a false green from being redirected back to /login.
    expect(location.origin).toBe(ISSUER_URL);
    // next goes only through the sealed cookie and **must not** appear in the authorize query sent to the IdP. Use searchParams.has,
    // not a substring match on the whole location: state is 43 random base64url chars and can occasionally spell "next".
    expect(location.searchParams.has("next")).toBe(false);

    const cookie = res.cookies.find(c => c.name === OIDC_STATE_COOKIE);
    expect(cookie).toBeDefined();
    const payload = unsealOidcState(config.appSecret, cookie!.value, Math.floor(Date.now() / 1000));
    expect(payload).not.toBeNull();
    const setCookieHeader = res.headers["set-cookie"];
    const setCookieLine = Array.isArray(setCookieHeader)
      ? setCookieHeader.find(line => line.startsWith(`${OIDC_STATE_COOKIE}=`))!
      : setCookieHeader!;
    return {
      next: nextOf(payload),
      // What Chrome actually limits is name=value; the RFC 6265 §6.1 4096 budget includes attributes: measure both.
      cookieBytes: Buffer.byteLength(`${cookie!.name}=${cookie!.value}`, "utf8"),
      setCookieBytes: Buffer.byteLength(setCookieLine, "utf8"),
    };
  }

  const sealedNextOf = async (url: string) => (await loginWithNext(url)).next;

  it("valid next -> sealed into the state cookie verbatim", async () => {
    expect(await sealedNextOf("/api/auth/oidc/login?next=%2Fn%2Falice%2Fmy-note%3Fx%3D1")).toBe(
      "/n/alice/my-note?x=1",
    );
  });

  it("cross-site next -> not sealed (safeNextPath blocks it, login still goes to the IdP)", async () => {
    expect(await sealedNextOf("/api/auth/oidc/login?next=%2F%2Fevil.example")).toBeUndefined();
  });

  it("next that isn't an SPA path (/api/notes) -> not sealed", async () => {
    expect(await sealedNextOf("/api/auth/oidc/login?next=%2Fapi%2Fnotes")).toBeUndefined();
  });

  it("the only length gate is safeNextPath's 2048: 2048 sealed, 2049 not", async () => {
    const atLimit = "/" + "a".repeat(2047);
    const overLimit = "/" + "a".repeat(2048);
    expect(atLimit).toHaveLength(MAX_NEXT_PATH_LENGTH);
    expect(await sealedNextOf(`/api/auth/oidc/login?next=${encodeURIComponent(atLimit)}`)).toBe(atLimit);
    expect(await sealedNextOf(`/api/auth/oidc/login?next=${encodeURIComponent(overLimit)}`)).toBeUndefined();
  });

  it("sealed cookie bytes: worst case (2048-char next) is still far below the browser's 4 KB", async () => {
    // Measured guard for the decision "the server needs no second length gate". With providerId/configVersion/intent in the state
    // the worst case is 3165 bytes (`name=value`; the same measurement as the comment in `auth/oidc-state.ts`), still under 3500.
    const worstCaseNext = "/" + "a".repeat(MAX_NEXT_PATH_LENGTH - 1);
    const { next, cookieBytes, setCookieBytes } = await loginWithNext(
      `/api/auth/oidc/login?next=${encodeURIComponent(worstCaseNext)}`,
    );
    // Without this line this case would get **greener** if someone re-added a 1000-char gate: first pin that the worst case really went into the cookie.
    expect(next).toHaveLength(MAX_NEXT_PATH_LENGTH);
    expect(cookieBytes).toBeLessThan(4096);
    expect(setCookieBytes).toBeLessThan(4096);
    // Also pins the headroom: under 3500 counts as "far below"; a sudden approach (e.g. more payload fields) should prompt reconsidering a gate.
    expect(cookieBytes).toBeLessThan(3500);
  });

  it("next appearing more than once (?next=/a&next=/b) -> not sealed (the query parses as an array, the route first collapses it to null)", async () => {
    expect(await sealedNextOf("/api/auth/oidc/login?next=%2Fa&next=%2Fb")).toBeUndefined();
  });

  it("no next -> not sealed (existing behaviour unchanged)", async () => {
    expect(await sealedNextOf("/api/auth/oidc/login")).toBeUndefined();
  });

  // The five early exits redirecting to /login?error=... never carry next (configuration-error paths: the user restarts from the
  // client; including "provider id isn't a UUID"). The five cases below map one to one: changing any single exit to carry next fails exactly its case.
  it("early exit carries no next: no legacy provider", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/auth/oidc/login?next=%2Fn%2Falice%2Fmy-note" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=oidc_unavailable");
  });

  it("early exit carries no next: provider id is not a UUID (/api/auth/oidc/login/not-a-uuid)", async () => {
    const fakeIdp = createFakeIdp(ISSUER_URL);
    const { app } = await legacyOidcApp(fakeIdp.fetch, ISSUER_URL);
    const res = await app.inject({ method: "GET", url: "/api/auth/oidc/login/not-a-uuid?next=%2Fn%2Falice%2Fmy-note" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=oidc_unavailable");
    expect(fakeIdp.counts.discovery).toBe(0);
  });

  it("early exit carries no next: discovery unavailable", async () => {
    const fakeIdp = createFakeIdp(ISSUER_URL);
    fakeIdp.failNext("discovery");
    const { app } = await legacyOidcApp(fakeIdp.fetch, ISSUER_URL);

    const res = await app.inject({ method: "GET", url: "/api/auth/oidc/login?next=%2Fn%2Falice%2Fmy-note" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=oidc_unavailable");
  });

  it("early exit carries no next: building the authorization URL fails (outer catch)", async () => {
    // When metadata lacks authorization_endpoint, getConfiguration **succeeds** (it only checks jwks_uri and signing algorithms) and only
    // buildAuthorizationUrl throws: the path this harness can build that reaches the outer catch. This case only asserts "redirected
    // back without next", **not** which branch it took.
    const fakeIdp = createFakeIdp(ISSUER_URL);
    fakeIdp.omitFromMetadata(["authorization_endpoint"]);
    const { app } = await legacyOidcApp(fakeIdp.fetch, ISSUER_URL);

    const res = await app.inject({ method: "GET", url: "/api/auth/oidc/login?next=%2Fn%2Falice%2Fmy-note" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=oidc_unavailable");
    expect(res.cookies.find(c => c.name === OIDC_STATE_COOKIE)).toBeUndefined();
  });

  it("early exit carries no next: rate limit (the 2nd request hits a limit=1 bucket)", async () => {
    const fakeIdp = createFakeIdp(ISSUER_URL);
    const { app } = await legacyOidcApp(fakeIdp.fetch, ISSUER_URL, {
      limiters: freshLimiters({ oidcLogin: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }),
    });
    const url = "/api/auth/oidc/login?next=%2Fn%2Falice%2Fmy-note";

    const first = await app.inject({ method: "GET", url });
    expect(new URL(first.headers.location as string).origin).toBe(ISSUER_URL);

    const second = await app.inject({ method: "GET", url });
    expect(second.statusCode).toBe(302);
    expect(second.headers.location).toBe("/login?error=too_many_requests");
    expect(second.cookies.find(c => c.name === OIDC_STATE_COOKIE)).toBeUndefined();
  });

  it("UUID gate before the limiter: after the limit=1 bucket was hit by /login/not-a-uuid, legacy /login still 302s to the IdP (a non-UUID doesn't charge quota)", async () => {
    const fakeIdp = createFakeIdp(ISSUER_URL);
    const { app } = await legacyOidcApp(fakeIdp.fetch, ISSUER_URL, {
      limiters: freshLimiters({ oidcLogin: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }),
    });

    const bad = await app.inject({ method: "GET", url: "/api/auth/oidc/login/not-a-uuid" });
    expect(bad.statusCode).toBe(302);
    expect(bad.headers.location).toBe("/login?error=oidc_unavailable");

    const legacy = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(legacy.statusCode).toBe(302);
    expect(legacy.headers.location).not.toBe("/login?error=too_many_requests");
    expect(new URL(legacy.headers.location as string).origin).toBe(ISSUER_URL);
  });
});

import Fastify from "fastify";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, parsePasswordLoginForceEnable, parseTrustProxy, publicUrlIssuer, publicUrlPathWarning, testHooksStartupWarning, type AppConfig } from "../../src/config.js";
import { oidcRedirectUri } from "../../src/auth/oidc-client.js";
const valid = { DATABASE_URL: "postgres://u:p@localhost:5432/db", APP_SECRET: "a".repeat(64), PUBLIC_URL: "https://notes.example.com" };
describe("loadConfig", () => {
  it("valid config; cookieSecure follows the PUBLIC_URL scheme", () => {
    expect(loadConfig(valid).cookieSecure).toBe(true);
    expect(loadConfig({ ...valid, PUBLIC_URL: "http://localhost:3000" }).cookieSecure).toBe(false);
  });
  it("returns the full object - https", () => {
    const config = loadConfig(valid);
    expect(config).toEqual({
      databaseUrl: "postgres://u:p@localhost:5432/db",
      appSecret: "a".repeat(64),
      publicUrl: new URL("https://notes.example.com"),
      cookieSecure: true,
      insecureHttpWarning: false,
      trustProxy: false,
      passwordLoginForceEnable: false,
      databasePoolMax: 10,
      databasePoolConnectionTimeoutMs: 10000,
      testHooks: false,
      testHooksIgnored: false,
      // #397: site limits set via env and machine info (effective parse-worker values come from SiteLimits, not config)
      limitEnv: {},
      machine: expect.objectContaining({ cpus: expect.any(Number) }),
    });
  });
  it("#175 pool fuses: both env overrides apply; empty string counts as unset; non-positive-integer -> throw", () => {
    const c = loadConfig({ ...valid, DATABASE_POOL_MAX: "3", DATABASE_POOL_CONNECTION_TIMEOUT_MS: "250" });
    expect([c.databasePoolMax, c.databasePoolConnectionTimeoutMs]).toEqual([3, 250]);
    const d = loadConfig({ ...valid, DATABASE_POOL_MAX: "", DATABASE_POOL_CONNECTION_TIMEOUT_MS: "" });
    expect([d.databasePoolMax, d.databasePoolConnectionTimeoutMs]).toEqual([10, 10000]);
    for (const bad of ["0", "-1", "1.5", "ten"]) {
      expect(() => loadConfig({ ...valid, DATABASE_POOL_MAX: bad }), bad).toThrow(/DATABASE_POOL_MAX/);
      expect(() => loadConfig({ ...valid, DATABASE_POOL_CONNECTION_TIMEOUT_MS: bad }), bad).toThrow(/DATABASE_POOL_CONNECTION_TIMEOUT_MS/);
    }
  });
  it("#175 pool timeout cap: above the Node timer limit 2147483647 -> throw naming the variable; exactly the limit is accepted", () => {
    expect(() => loadConfig({ ...valid, DATABASE_POOL_CONNECTION_TIMEOUT_MS: "3000000000" })).toThrow(/DATABASE_POOL_CONNECTION_TIMEOUT_MS/);
    expect(loadConfig({ ...valid, DATABASE_POOL_CONNECTION_TIMEOUT_MS: "2147483647" }).databasePoolConnectionTimeoutMs).toBe(2147483647);
  });
  it("APP_SECRET too short -> throw with an openssl hint", () => {
    expect(() => loadConfig({ ...valid, APP_SECRET: "short" })).toThrow(/openssl rand -hex 32/);
  });
  it("missing PUBLIC_URL -> throw", () => {
    const { PUBLIC_URL, ...rest } = valid;
    expect(() => loadConfig(rest)).toThrow(/PUBLIC_URL/);
  });
  it("http on a non-localhost host -> accepted with insecureHttpWarning=true, cookieSecure stays false (trusted-LAN topology)", () => {
    const config = loadConfig({ ...valid, PUBLIC_URL: "http://notes.example.com" });
    expect(config.insecureHttpWarning).toBe(true);
    expect(config.cookieSecure).toBe(false);
  });
  it("http localhost -> insecureHttpWarning=false", () => {
    expect(loadConfig({ ...valid, PUBLIC_URL: "http://localhost:3000" }).insecureHttpWarning).toBe(false);
  });
  it("https -> insecureHttpWarning=false", () => {
    expect(loadConfig(valid).insecureHttpWarning).toBe(false);
  });
  it("no scheme -> throw", () => {
    expect(() => loadConfig({ ...valid, PUBLIC_URL: "localhost:3000" })).toThrow(/http\/https/);
  });
  describe("ADMIN_EMAIL / ADMIN_PASSWORD (env bootstrap admin)", () => {
    it("neither set -> passes, adminEmail/adminPassword both undefined", () => {
      const config = loadConfig(valid);
      expect(config.adminEmail).toBeUndefined();
      expect(config.adminPassword).toBeUndefined();
    });

    it("only ADMIN_EMAIL set -> fail-fast", () => {
      expect(() => loadConfig({ ...valid, ADMIN_EMAIL: "admin@example.com" })).toThrow(
        /ADMIN_EMAIL 與 ADMIN_PASSWORD 必須同時設定/
      );
    });

    it("only ADMIN_PASSWORD set -> fail-fast", () => {
      expect(() => loadConfig({ ...valid, ADMIN_PASSWORD: "correct-horse-battery" })).toThrow(
        /ADMIN_EMAIL 與 ADMIN_PASSWORD 必須同時設定/
      );
    });

    it("both set but password under 12 characters -> fail-fast", () => {
      expect(() =>
        loadConfig({ ...valid, ADMIN_EMAIL: "admin@example.com", ADMIN_PASSWORD: "short" })
      ).toThrow(/ADMIN_PASSWORD 至少需要 12 字元/);
    });

    it("both set but ADMIN_EMAIL malformed -> fail-fast", () => {
      expect(() =>
        loadConfig({ ...valid, ADMIN_EMAIL: "not-an-email", ADMIN_PASSWORD: "correct-horse-battery" })
      ).toThrow(/ADMIN_EMAIL 格式錯誤/);
    });

    it("both set and valid -> passes, config carries both fields", () => {
      const config = loadConfig({ ...valid, ADMIN_EMAIL: "admin@example.com", ADMIN_PASSWORD: "correct-horse-battery" });
      expect(config.adminEmail).toBe("admin@example.com");
      expect(config.adminPassword).toBe("correct-horse-battery");
    });

    it("empty ADMIN_EMAIL + ADMIN_PASSWORD set -> counts as half-configured, fail-fast (empty string equals unset)", () => {
      expect(() =>
        loadConfig({ ...valid, ADMIN_EMAIL: "", ADMIN_PASSWORD: "correct-horse-battery" })
      ).toThrow(/ADMIN_EMAIL 與 ADMIN_PASSWORD 必須同時設定/);
    });
  });

  describe("leftover OIDC_* variables (the import mechanism was removed)", () => {
    it("OIDC_ISSUER_URL / CLIENT_ID / CLIENT_SECRET, complete or partial, are ignored: no throw, config has no OIDC fields", () => {
      const three = { OIDC_ISSUER_URL: "https://idp.example.com", OIDC_CLIENT_ID: "abc", OIDC_CLIENT_SECRET: "s" };
      for (const extra of [three, { OIDC_ISSUER_URL: "ftp://bad" }, {}]) {
        const c = loadConfig({ ...valid, ...extra });
        expect(Object.keys(c).filter(k => /oidc/i.test(k))).toEqual([]);
        expect(c.publicUrl.href).toBe(loadConfig(valid).publicUrl.href);
      }
    });
  });
});

describe("parseTrustProxy (issue #13)", () => {
  it("unset / empty string / false -> false (the safe default when clients can connect directly)", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("  ")).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("FALSE")).toBe(false);
  });

  it("true -> true (same as the behaviour before this issue was fixed; the deployer opts in)", () => {
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy(" True ")).toBe(true);
  });

  it("non-negative integer -> hop count", () => {
    expect(parseTrustProxy("1")).toBe(1);
    expect(parseTrustProxy("2")).toBe(2);
  });

  it("IP / CIDR / named ranges -> array of individually validated strings", () => {
    expect(parseTrustProxy("127.0.0.1")).toEqual(["127.0.0.1"]);
    expect(parseTrustProxy("10.0.0.0/8, 172.16.0.0/12")).toEqual(["10.0.0.0/8", "172.16.0.0/12"]);
    expect(parseTrustProxy("loopback,uniquelocal")).toEqual(["loopback", "uniquelocal"]);
    expect(parseTrustProxy("::1")).toEqual(["::1"]);
    expect(parseTrustProxy("fd00::/8")).toEqual(["fd00::/8"]);
  });

  it("syntax errors throw at startup instead of failing on each request", () => {
    expect(() => parseTrustProxy("not-an-ip")).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxy("10.0.0.0/999")).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxy("10.0.0.0/8/8")).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxy("10.0.0.0/abc")).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxy("999.1.1.1")).toThrow(/TRUST_PROXY/);
    // The prefix limit is 128 for IPv6 and 32 for IPv4; they must not be mixed.
    expect(() => parseTrustProxy("10.0.0.0/64")).toThrow(/TRUST_PROXY/);
    expect(parseTrustProxy("fd00::/64")).toEqual(["fd00::/64"]);
  });

  // Catches shapes we validate but fastify rejects. Two real cases: named ranges that are not lowercase (proxy-addr matches exactly, so
  // `Loopback` throws `invalid IP address`) and `/0` (proxy-addr rejects `range <= 0`). Both blow up in the Fastify constructor in
  // buildApp without naming the env variable, which defeats fail-fast.
  it.each([
    "true",
    "1",
    "2",
    "127.0.0.1",
    "10.0.0.0/8, 172.16.0.0/12",
    "loopback,uniquelocal",
    "Loopback",
    "LOOPBACK, 10.0.0.0/8",
    "::1",
    "fd00::/8",
    "fd00::/64",
  ])("%s accepted by us is also accepted by fastify (round-trip)", value => {
    const trustProxy = parseTrustProxy(value);
    expect(() => Fastify({ logger: false, trustProxy })).not.toThrow();
  });

  it("`/0` is rejected here (proxy-addr rejects it too; the message must point to TRUST_PROXY=true)", () => {
    expect(() => parseTrustProxy("0.0.0.0/0")).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxy("::/0")).toThrow(/TRUST_PROXY/);
  });

  it("named ranges are normalised to lowercase (proxy-addr expects lowercase)", () => {
    expect(parseTrustProxy("Loopback")).toEqual(["loopback"]);
    expect(parseTrustProxy("LOOPBACK, 10.0.0.0/8")).toEqual(["loopback", "10.0.0.0/8"]);
  });

  it("hop count 0 normalises to false (writing 0 means off)", () => {
    expect(parseTrustProxy("0")).toBe(false);
  });

  it("loadConfig carries this field, false when unset", () => {
    const base = {
      DATABASE_URL: "postgres://u:p@localhost:5432/test",
      APP_SECRET: "a".repeat(64),
      PUBLIC_URL: "http://localhost:3000",
    };
    expect(loadConfig(base).trustProxy).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: "loopback" }).trustProxy).toEqual(["loopback"]);
    expect(() => loadConfig({ ...base, TRUST_PROXY: "nope" })).toThrow(/TRUST_PROXY/);
  });
});

describe("OAuth issuer uses the origin; extra PUBLIC_URL components only warn", () => {
  it("publicUrlIssuer: keeps the port, drops path / query / fragment / userinfo, lowercases scheme and host", () => {
    // A port is the common self-hosted form (e.g. http://192.168.1.50:3000); building the issuer as protocol + "//" + hostname would lose it.
    expect(publicUrlIssuer(new URL("http://192.168.1.50:3000/knb"))).toBe("http://192.168.1.50:3000");
    expect(publicUrlIssuer(new URL("https://example.com/knb?q=1#f"))).toBe("https://example.com");
    expect(publicUrlIssuer(new URL("https://u:p@example.com/knb"))).toBe("https://example.com");
    expect(publicUrlIssuer(new URL("HTTPS://Notes.Example.com"))).toBe("https://notes.example.com");
    // Must not return href: it adds a trailing slash, which later yields `…//.well-known/…`.
    expect(publicUrlIssuer(new URL("http://localhost:3000"))).toBe("http://localhost:3000");
  });

  it("publicUrlPathWarning: a bare origin (with trailing slash or port) does not warn", () => {
    expect(publicUrlPathWarning(new URL("https://notes.example.com"))).toBeNull();
    expect(publicUrlPathWarning(new URL("https://notes.example.com/"))).toBeNull();
    expect(publicUrlPathWarning(new URL("http://192.168.1.50:3000/"))).toBeNull();
  });

  it("publicUrlPathWarning: path / query / fragment / userinfo each warn (all are components the origin drops)", () => {
    for (const url of [
      "https://example.com/knb",
      "https://example.com/knb/",
      "https://example.com/?q=1",
      "https://example.com/#f",
      "https://u:p@example.com/",
    ]) {
      expect(publicUrlPathWarning(new URL(url)), url).not.toBeNull();
    }
  });

  it("the warning message tells the operator what to change and what is already broken", () => {
    const message = publicUrlPathWarning(new URL("https://example.com/knb"));
    // Not stringContaining("origin"): any string containing those letters would pass.
    expect(message).toContain("PUBLIC_URL");
    expect(message).toContain("sub-path");
    // #187: one redirect URI per provider (/api/auth/oidc/callback[/<id>]); these are the ones that already fail to match.
    expect(message).toContain("OIDC redirect URIs");
    expect(message).toContain("will not match");
  });

  it("the message is a compile-time constant (interpolating would make pino's msg differ per deployment and break log aggregation and alerts)", () => {
    const first = publicUrlPathWarning(new URL("https://a.example.com/knb"));
    // Pin that a message exists first: comparing only equality would also pass when both sides are null.
    expect(first).toBeTypeOf("string");
    expect(first).toBe(publicUrlPathWarning(new URL("https://b.example.com/other?q=1")));
  });

  it("precondition of the warning: the sub-path is dropped from both the issuer and the OIDC redirect URI, userinfo only from the issuer", () => {
    // Pins the facts the message wording relies on: the server drops the sub-path, so it does not match the
    // <PUBLIC_URL>/api/auth/oidc/callback… registered at the IdP. If oidcRedirectUri ever keeps the sub-path this fails,
    // forcing a re-read of that sentence. Both the legacy and the regular provider shapes are asserted.
    const subpath = loadConfig({ ...valid, PUBLIC_URL: "https://example.com/knb" });
    expect(publicUrlIssuer(subpath.publicUrl)).toBe("https://example.com");
    expect(oidcRedirectUri(subpath, { id: "p1", legacyCallback: true })).toBe("https://example.com/api/auth/oidc/callback");
    expect(oidcRedirectUri(subpath, { id: "p1", legacyCallback: false })).toBe("https://example.com/api/auth/oidc/callback/p1");

    const withCreds = loadConfig({ ...valid, PUBLIC_URL: "https://u:p@example.com/" });
    expect(publicUrlIssuer(withCreds.publicUrl)).toBe("https://example.com");
    expect(oidcRedirectUri(withCreds, { id: "p1", legacyCallback: true })).toBe("https://u:p@example.com/api/auth/oidc/callback");
  });

  it("structure guard: index.ts calls publicUrlPathWarning, before listen", () => {
    // Unit tests of the pure function stay green if the call is deleted from index.ts.
    // Anchored on the call-site literal, not the function name, which would match the import first
    // (same approach as the backfillHandleRegistry structure test in handle.test.ts).
    //
    // This checks that the call literal exists before listen, not that the warning is printed: a dead branch, a missing log
    // call, or the literal appearing only in a comment all still pass. Asserting real output would need an e2e stdout capture,
    // which costs far more than it returns.
    const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/index.ts"), "utf8");
    const callAt = src.indexOf("publicUrlPathWarning(config.publicUrl");
    const listenAt = src.indexOf(".listen(");
    expect(callAt, "index.ts 必須呼叫 publicUrlPathWarning(config.publicUrl…)").toBeGreaterThan(-1);
    expect(listenAt).toBeGreaterThan(-1);
    expect(callAt, "警告要在 listen 之前印出來").toBeLessThan(listenAt);
  });

  it("structure guard (#187): index.ts calls the legacy-column backfill after initializeInstance and before listen", () => {
    const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/index.ts"), "utf8");
    // Anchored on the call-site literal (with the start of its arguments), not the function name, which would match the import first.
    const initAt = src.indexOf("await initializeInstance(");
    const backfillAt = src.indexOf("await backfillLegacyOidcIdentities(db");
    const listenAt = src.indexOf(".listen(");
    expect(initAt).toBeGreaterThan(-1);
    expect(backfillAt, "index.ts 必須呼叫 backfillLegacyOidcIdentities(db…").toBeGreaterThan(initAt);
    expect(backfillAt, "補登必須在 listen 之前").toBeLessThan(listenAt);
  });
});

describe("PASSWORD_LOGIN_FORCE_ENABLE (#187)", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["  ", false],
    ["false", false],
    ["FALSE", false],
    ["true", true],
    ["TRUE", true],
    [" True ", true],
  ] as const)("%j -> %s", (raw, expected) => {
    expect(parsePasswordLoginForceEnable(raw)).toBe(expected);
  });

  it.each(["1", "yes", "on", "0", "tru", "true,false"])("%j -> throw (believing the rescue switch is on while it is off must not happen silently)", raw => {
    expect(() => parsePasswordLoginForceEnable(raw)).toThrow(/PASSWORD_LOGIN_FORCE_ENABLE/);
  });

  it("loadConfig carries this field; an invalid value blocks startup", () => {
    expect(loadConfig(valid).passwordLoginForceEnable).toBe(false);
    expect(loadConfig({ ...valid, PASSWORD_LOGIN_FORCE_ENABLE: "True" }).passwordLoginForceEnable).toBe(true);
    expect(() => loadConfig({ ...valid, PASSWORD_LOGIN_FORCE_ENABLE: "yes" })).toThrow(/PASSWORD_LOGIN_FORCE_ENABLE/);
  });

  it("structure guard: the startup check runs after the legacy-column backfill and before listen", () => {
    const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/index.ts"), "utf8");
    const backfillAt = src.indexOf("await backfillLegacyOidcIdentities(db");
    const checkAt = src.indexOf("await warnPasswordLoginAtBoot(db");
    const listenAt = src.indexOf(".listen(");
    expect(checkAt, "index.ts 必須呼叫 warnPasswordLoginAtBoot(db…").toBeGreaterThan(backfillAt);
    expect(checkAt, "開機檢查要在 listen 之前").toBeLessThan(listenAt);
  });
});

describe("#269 structure guard: app.ts onClose for the link-conversion job", () => {
  it("onClose races linkConversion.stop() against a 2 s grace (SCAN_STOP_GRACE_MS, shared with the #272 scan onClose and the index.ts shutdown cap), so an in-flight conversion cannot hold app.close() / pool.end() until SIGKILL", () => {
    // Strip comment lines first so a literal in a comment cannot satisfy the match.
    const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/app.ts"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    expect(src).toMatch(
      /app\.addHook\("onClose", async \(\) => \{\s*await Promise\.race\(\[linkConversion\.stop\(\), new Promise<void>\(resolve => setTimeout\(resolve, SCAN_STOP_GRACE_MS\)\.unref\(\)\)\]\);\s*\}\);/,
    );
  });
});

describe("KNOTEBOOK_E2E_TEST_HOOKS (#272)", () => {
  const pick = (c: AppConfig) => ({ testHooks: c.testHooks, testHooksIgnored: c.testHooksIgnored });
  const local = { ...valid, PUBLIC_URL: "http://localhost:3100" };

  it("only the literal \"1\" counts, and only when PUBLIC_URL is localhost / 127.0.0.1 / [::1]; other hosts -> ignored (testHooksIgnored)", () => {
    expect(pick(loadConfig(local))).toEqual({ testHooks: false, testHooksIgnored: false });
    for (const url of ["http://localhost:3100", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      expect(pick(loadConfig({ ...valid, PUBLIC_URL: url, KNOTEBOOK_E2E_TEST_HOOKS: "1" })), url).toEqual({ testHooks: true, testHooksIgnored: false });
    }
    for (const v of ["0", "true", "", " 1"]) {
      expect(pick(loadConfig({ ...local, KNOTEBOOK_E2E_TEST_HOOKS: v })), JSON.stringify(v)).toEqual({ testHooks: false, testHooksIgnored: false });
    }
    for (const url of ["https://notes.example.com", "http://192.168.1.5:3000", "http://localhost.example.com"]) {
      expect(pick(loadConfig({ ...valid, PUBLIC_URL: url, KNOTEBOOK_E2E_TEST_HOOKS: "1" })), url).toEqual({ testHooks: false, testHooksIgnored: true });
    }
  });

  it("testHooksStartupWarning: enabled -> says this is an e2e test stack; ignored -> says it has no effect; neither -> null", () => {
    expect(testHooksStartupWarning({ testHooks: false, testHooksIgnored: false })).toBeNull();
    expect(testHooksStartupWarning({ testHooks: true, testHooksIgnored: false })).toContain("e2e 測試縫已開啟");
    expect(testHooksStartupWarning({ testHooks: false, testHooksIgnored: true })).toContain("已忽略");
  });

  it("structure guard: index.ts logs testHooksStartupWarning before listen; shortens the scan interval to 1 s only when the test hooks are on; on shutdown runs stopScan (at most 2 s) before collab.destroy()", () => {
    // Checks source literals and their order only; same limit as the publicUrlPathWarning structure test: it can't prove the warning is printed.
    const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/index.ts"), "utf8");
    const warnAt = src.indexOf("testHooksStartupWarning(config)");
    const listenAt = src.indexOf(".listen(");
    expect(warnAt, "index.ts 必須呼叫 testHooksStartupWarning(config)").toBeGreaterThan(-1);
    expect(warnAt, "警告要在 listen 之前").toBeLessThan(listenAt);
    expect(src).toContain("...(config.testHooks ? { versionAutoScanIntervalMs: 1000 } : {})");
    // Search only inside the SIGTERM handler (after `process.once(`): the shutdown comment above it also mentions `collab.destroy()`
    // (same approach as unit/search-backfill-wiring.test.ts).
    const onceAt = src.indexOf("process.once(");
    expect(onceAt, "index.ts 要有 process.once( 關機 handler").toBeGreaterThan(-1);
    const handler = src.slice(onceAt).replace(/^\s*\/\/.*$/gm, ""); // Strip comment lines so a literal in a comment inside the handler can't match.
    const stopAt = handler.indexOf("collab.versions.stopScan()");
    const destroyAt = handler.indexOf("collab.destroy()");
    expect(stopAt, "關機要呼叫 collab.versions.stopScan()").toBeGreaterThan(-1);
    expect(destroyAt, "關機要呼叫 collab.destroy()").toBeGreaterThan(-1);
    expect(stopAt, "stopScan 要在 collab.destroy() 之前").toBeLessThan(destroyAt);
    // The wait for the scan to stop is capped at 2 s so a stuck scan can't use up docker stop's grace period, which collab needs to flush to disk;
    // it runs in parallel with the link-conversion stop and shares the same 2 s grace.
    expect(handler).toMatch(/Promise\.race\(\[Promise\.all\(\[collab\.versions\.stopScan\(\), app\.linkConversion\.stop\(\)\]\), stopGrace\(\)\]\)/);
  });

  it("structure guard: the app.ts onClose wait for the scan to stop is also capped by SCAN_STOP_GRACE_MS (shared with the index.ts shutdown cap)", () => {
    // Checks source literals only (building a stuck scan and timing close isn't worth the cost); same as the index.ts race test above.
    // Comment lines are stripped so only code is checked.
    const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/app.ts"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    expect(src).toMatch(/await Promise\.race\(\[versions\.stopScan\(\), new Promise<void>\(resolve => setTimeout\(resolve, SCAN_STOP_GRACE_MS\)\.unref\(\)\)\]\);/);
  });
});

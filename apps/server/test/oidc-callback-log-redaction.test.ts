import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { OIDC_STATE_COOKIE } from "@knotebook/shared";
import { createFakeIdp, type FakeIdp, type FakeIdpClaims } from "./helpers/fake-idp.js";
import { INSTANCE_NOT_INITIALIZED, logInitFailure } from "../src/auth/bootstrap.js";
import { seedAuthProvider } from "./helpers/oidc-provider.js";
import { buildTestApp } from "./helpers.js";
import { createOidcRuntimeRegistry } from "../src/auth/oidc-client.js";
import type { OidcTestHook } from "../src/auth/oidc-test-hook.js";

// The remaining callback failure paths (code exchange, userinfo, race re-check, catch-all) must not log the whole `err`: a
// DrizzleQueryError's params may hold the signing-in user's sub/email, and a fetch error's message may hold a URL (#211).

const ISSUER_URL = "https://idp.example.com";
const SECRET = "LEAKME-sub-and-email@example.com";

type Line = Record<string, unknown>;

async function appWithLogs(oidcTestHook?: OidcTestHook): Promise<{ app: FastifyInstance; fakeIdp: FakeIdp; out: string[] }> {
  const out: string[] = [];
  const fakeIdp = createFakeIdp(ISSUER_URL);
  const built = await buildTestApp(
    { oidcRegistry: createOidcRuntimeRegistry({ fetch: fakeIdp.fetch }), ...(oidcTestHook === undefined ? {} : { oidcTestHook }) },
    { logger: { level: "info", stream: { write: (chunk: string) => void out.push(chunk) } } },
  );
  await seedAuthProvider(built.db, { issuerUrl: ISSUER_URL, legacyCallback: true });
  return { app: built.app, fakeIdp, out };
}

async function runCallback(app: FastifyInstance, fakeIdp: FakeIdp, claims: FakeIdpClaims, prepare?: (idp: FakeIdp) => void): Promise<void> {
  fakeIdp.setNextLogin(claims);
  const loginRes = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
  const { code, state } = fakeIdp.authorize(loginRes.headers.location as string);
  const cookieValue = loginRes.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value;
  prepare?.(fakeIdp);
  const res = await app.inject({
    method: "GET",
    url: `/api/auth/oidc/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    cookies: { [OIDC_STATE_COOKIE]: cookieValue },
  });
  expect(res.headers.location).toBe("/login?error=oidc_exchange_failed");
}

function lineFor(out: string[], msgPart: string): Line {
  const lines = out.map(s => JSON.parse(s) as Line).filter(l => typeof l.msg === "string" && l.msg.includes(msgPart));
  expect(lines).toHaveLength(1);
  return lines[0]!;
}

function expectNoRawErr(out: string[], line: Line): void {
  expect(line).not.toHaveProperty("err");
  expect(JSON.stringify(line)).not.toContain("stack");
  expect(out.join("")).not.toContain(SECRET);
}

/** Simulates a DB error carrying values (DrizzleQueryError shape: message and params both contain user values). */
function dbErrorWithValues(code: string): Error {
  const cause = Object.assign(new Error(`duplicate key value (${SECRET})`), { code, detail: `Key (email)=(${SECRET}) already exists.` });
  return Object.assign(new Error(`Failed query: insert ... params: ${SECRET}`, { cause }), { params: [SECRET], code });
}

describe("OIDC callback failure paths don't log the whole err (#211)", () => {
  it("code exchange failure: no err, only an errName summary", async () => {
    const { app, fakeIdp, out } = await appWithLogs();
    await runCallback(app, fakeIdp, { sub: "u1", email: "a@example.com", email_verified: true }, idp => idp.failNext("token"));
    const line = lineFor(out, "OIDC code 交換失敗");
    expectNoRawErr(out, line);
    expect(line).toHaveProperty("errName");
  });

  it("userinfo failure: no err, only an errName summary", async () => {
    const { app, fakeIdp, out } = await appWithLogs();
    fakeIdp.omitFromIdToken(["email"]);
    await runCallback(app, fakeIdp, { sub: "u2", email: "b@example.com", email_verified: true }, idp => idp.failNext("userinfo"));
    const line = lineFor(out, "OIDC userinfo 取得失敗");
    expectNoRawErr(out, line);
    expect(line).toHaveProperty("errName");
  });

  it("failure after the race re-check (DB error): goes through redactDbError, logging only code/constraint/context", async () => {
    const hook: OidcTestHook = async point => {
      if (point === "login-identity-missed") throw dbErrorWithValues("23505");
    };
    const { app, fakeIdp, out } = await appWithLogs(hook);
    await runCallback(app, fakeIdp, { sub: "u3", email: "c@example.com", email_verified: true });
    const line = lineFor(out, "資料庫錯誤");
    expectNoRawErr(out, line);
    expect(line).toMatchObject({ code: "23505", context: "OIDC 帳號解析 race 重查" });
    expect(line).not.toHaveProperty("params");
  });

  it("callback catch-all (unexpected DB error): no err/params", async () => {
    const hook: OidcTestHook = async point => {
      if (point === "login-identity-missed") throw dbErrorWithValues("XX000");
    };
    const { app, fakeIdp, out } = await appWithLogs(hook);
    await runCallback(app, fakeIdp, { sub: "u4", email: "d@example.com", email_verified: true });
    const line = lineFor(out, "資料庫錯誤");
    expectNoRawErr(out, line);
    expect(line).toMatchObject({ code: "XX000", context: "OIDC callback" });
  });

  it("callback catch-all (unexpected non-DB error): no err, only an errName summary", async () => {
    const hook: OidcTestHook = async point => {
      if (point === "login-identity-missed") throw new Error(`boom ${SECRET}`);
    };
    const { app, fakeIdp, out } = await appWithLogs(hook);
    await runCallback(app, fakeIdp, { sub: "u5", email: "e@example.com", email_verified: true });
    const line = lineFor(out, "OIDC callback 發生未預期錯誤");
    expectNoRawErr(out, line);
    expect(line).toHaveProperty("errName");
  });
});

describe("startup admin-creation failure log (#211)", () => {
  function capture(err: unknown): { out: string; lines: Line[] } {
    const lines: Line[] = [];
    const out: string[] = [];
    const log = {
      error(obj: object, msg: string): void {
        // Simulates pino: the err field is serialized into message/stack/enumerable properties (including params).
        const e = (obj as { err?: unknown }).err;
        const ser = e instanceof Error ? { ...e, message: e.message, stack: e.stack } : e;
        const line = { ...obj, ...(e === undefined ? {} : { err: ser }), msg };
        lines.push(line as Line);
        out.push(JSON.stringify(line));
      },
    };
    logInitFailure(log, err);
    return { out: out.join(String.fromCharCode(10)), lines };
  }
  const drizzleShaped = (cause: Error): Error => Object.assign(new Error(`Failed query: insert into users params: ${SECRET}`, { cause }), { params: [SECRET] });

  it("DrizzleQueryError shape with an SQLSTATE: logs only code/context", () => {
    const { out, lines } = capture(drizzleShaped(Object.assign(new Error(`dup ${SECRET}`), { code: "23505" })));
    expect(out).not.toContain(SECRET);
    expect(lines[0]).toMatchObject({ code: "23505", context: "實例初始化" });
    expect(lines[0]).not.toHaveProperty("err");
  });

  it("DrizzleQueryError shape whose cause has no code (connection dropped): no err, logs the name", () => {
    const { out, lines } = capture(drizzleShaped(new Error("Connection terminated unexpectedly")));
    expect(out).not.toContain(SECRET);
    expect(lines[0]).toMatchObject({ code: null, context: "實例初始化" });
    expect(lines[0]).toHaveProperty("name");
    expect(lines[0]).not.toHaveProperty("err");
  });

  it("the known \"not initialized\" error: logged as is (the message is actionable)", () => {
    const { lines } = capture(Object.assign(new Error("此實例尚未初始化：請設定 ADMIN_EMAIL"), { name: INSTANCE_NOT_INITIALIZED }));
    expect(lines[0]).toHaveProperty("err");
    expect((lines[0]!.err as { message: string }).message).toContain("ADMIN_EMAIL");
  });

  it("structure guard: index.ts calls logInitFailure", () => {
    const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/index.ts"), "utf8");
    const catchAt = src.indexOf("catch (err)", src.indexOf("await initializeInstance("));
    expect(src.slice(catchAt, src.indexOf("process.exit(1)", catchAt))).toContain("logInitFailure(logger, err)");
  });

  it("structure guard: index.ts site-limits loading failure goes through redactDbError and doesn't log the whole err", () => {
    const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/index.ts"), "utf8");
    const catchAt = src.indexOf("catch (err)", src.indexOf("await SiteLimits.load("));
    const block = src.slice(catchAt, src.indexOf("process.exit(1)", catchAt));
    expect(block).toContain("redactDbError(logger, err,");
    expect(block).not.toMatch(/\{\s*err\s*\}/);
  });
});

import { isIP } from "node:net";
import { z } from "zod";
import { MIN_PASSWORD_LENGTH } from "./auth/constants.js";
import { detectMachine, parseEnvLimits, type CpuProbe } from "./notes/editing/parse-settings.js";
import type { LimitEnv, MachineInfo } from "./site-limits/types.js";
import { DEFAULT_NOTE_MAX_BYTES, NOTE_MAX_BYTES_MAX } from "./notes/note-size.js";
const schema = z.object({
  DATABASE_URL: z.string().url("DATABASE_URL 必須是有效的 PostgreSQL URL（如 postgres://user:pass@host:5432/dbname）").refine(
    url => url.startsWith("postgres://") || url.startsWith("postgresql://"),
    "DATABASE_URL 必須以 postgres:// 或 postgresql:// 開頭"
  ),
  APP_SECRET: z.string().regex(/^[0-9a-fA-F]{64,}$/, "APP_SECRET 需 ≥64 hex 字元；用 `openssl rand -hex 32` 產生"),
  PUBLIC_URL: z.string().url("PUBLIC_URL 必須是有效的 http/https URL"),
  // Only presence here; pairing, length and format are checked in loadConfig for clearer errors.
  // `.min(1)` makes "" fail the first branch, so the `z.literal("")` branch turns it into undefined.
  ADMIN_EMAIL: z.string().min(1).optional().or(z.literal("").transform(() => undefined)),
  ADMIN_PASSWORD: z.string().min(1).optional().or(z.literal("").transform(() => undefined)),
  TRUST_PROXY: z.string().min(1).optional().or(z.literal("").transform(() => undefined)),
  PASSWORD_LOGIN_FORCE_ENABLE: z.string().optional(),
  DATABASE_POOL_MAX: z.string().min(1).optional().or(z.literal("").transform(() => undefined)),
  DATABASE_POOL_CONNECTION_TIMEOUT_MS: z.string().min(1).optional().or(z.literal("").transform(() => undefined)),
  // Test-only, and only on a loopback PUBLIC_URL; deliberately left out of .env.example and the self-hosting docs.
  KNOTEBOOK_E2E_TEST_HOOKS: z.string().optional(),
});

const TRUST_PROXY_KEYWORDS = new Set(["loopback", "linklocal", "uniquelocal"]);

/**
 * Defaults to false: trusting a client-supplied X-Forwarded-For lets anyone dodge per-IP throttles. Behind a
 * reverse proxy it must be set, or every client shares the proxy's IP and one lockout hits everyone.
 */
export function parseTrustProxy(raw: string | undefined): boolean | number | string[] {
  if (raw === undefined) return false;
  const value = raw.trim();
  if (value === "" || value.toLowerCase() === "false") return false;
  if (value.toLowerCase() === "true") return true;
  // `0` means "off"; normalized so downstream has one less falsy value to handle.
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    return hops === 0 ? false : hops;
  }

  const entries = value.split(",").map(entry => entry.trim()).filter(entry => entry !== "");
  const normalized: string[] = [];
  if (entries.length === 0) {
    throw new Error(`設定錯誤：TRUST_PROXY 的值無法解析：${raw}`);
  }
  for (const entry of entries) {
    // Lowercased: proxy-addr matches range names exactly, and `Loopback` would throw an unhelpful error in fastify.
    const keyword = entry.toLowerCase();
    if (TRUST_PROXY_KEYWORDS.has(keyword)) {
      normalized.push(keyword);
      continue;
    }
    const [address, prefix, ...rest] = entry.split("/");
    const family = isIP(address ?? "");
    if (family === 0 || rest.length > 0) {
      throw new Error(
        `設定錯誤：TRUST_PROXY 的「${entry}」不是合法的 IP／CIDR／具名網段（loopback、linklocal、uniquelocal）`
      );
    }
    if (prefix !== undefined) {
      const bits = Number(prefix);
      const max = family === 4 ? 32 : 128;
      // Minimum 1: proxy-addr rejects `/0`, so catch `0.0.0.0/0` here and point to TRUST_PROXY=true.
      if (!/^\d+$/.test(prefix) || bits < 1 || bits > max) {
        throw new Error(
          `設定錯誤：TRUST_PROXY 的「${entry}」網段長度必須是 1-${max} 的整數（要信任任何來源請直接寫 TRUST_PROXY=true）`
        );
      }
    }
    normalized.push(entry);
  }
  return normalized;
}
/** Unknown values throw: during a rescue, "thought it was on" must not happen silently. */
export function parsePasswordLoginForceEnable(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if (value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`設定錯誤：PASSWORD_LOGIN_FORCE_ENABLE 的值無法解析（只接受 true 或 false，不分大小寫）：${raw}`);
}
export interface AppConfig {
  databaseUrl: string;
  appSecret: string;
  publicUrl: URL;
  cookieSecure: boolean;
  trustProxy: boolean | number | string[];
  databasePoolMax: number;
  databasePoolConnectionTimeoutMs: number;
  insecureHttpWarning: boolean;
  /** Both admin fields are set or both undefined (enforced by loadConfig). */
  adminEmail?: string;
  adminPassword?: string;
  /** Rescue switch; the effective setting is the DB value OR this. */
  passwordLoginForceEnable: boolean;
  testHooks: boolean;
  testHooksIgnored: boolean;
  /** Only limits set by env; effective values come from `SiteLimits`. */
  limitEnv: LimitEnv;
  machine: MachineInfo;
}
export function loadConfig(env: NodeJS.ProcessEnv, cpuProbe?: CpuProbe): AppConfig {
  const r = schema.safeParse(env);
  if (!r.success) throw new Error("設定錯誤：" + r.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  const publicUrl = new URL(r.data.PUBLIC_URL);
  if (!["http:", "https:"].includes(publicUrl.protocol))
    throw new Error("PUBLIC_URL 必須是 http/https URL");
  // Plain http on a LAN is a supported deployment, so warn instead of refusing.
  const isLocalHttp = publicUrl.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(publicUrl.hostname);
  const insecureHttpWarning = publicUrl.protocol === "http:" && !isLocalHttp;

  const adminEmail = r.data.ADMIN_EMAIL;
  const adminPassword = r.data.ADMIN_PASSWORD;
  if ((adminEmail === undefined) !== (adminPassword === undefined)) {
    throw new Error(
      "設定錯誤：ADMIN_EMAIL 與 ADMIN_PASSWORD 必須同時設定，或同時不設定——只設定其中一個視為誤設"
    );
  }
  if (adminEmail !== undefined && adminPassword !== undefined) {
    if (adminPassword.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`設定錯誤：ADMIN_PASSWORD 至少需要 ${MIN_PASSWORD_LENGTH} 字元`);
    }
    const emailCheck = z.string().email().safeParse(adminEmail);
    if (!emailCheck.success) {
      throw new Error("設定錯誤：ADMIN_EMAIL 格式錯誤");
    }
  }

  // Node timers cap at 2^31-1 ms and turn larger values into 1 ms, so timeout settings need a max.
  const positiveInt = (name: string, raw: string | undefined, fallback: number, max = Infinity): number => {
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0 || value > max) throw new Error(`設定錯誤：${name} 必須是正整數${max === Infinity ? "" : `（最大 ${max}）`}：${raw}`);
    return value;
  };
  const databasePoolMax = positiveInt("DATABASE_POOL_MAX", r.data.DATABASE_POOL_MAX, 10);
  const databasePoolConnectionTimeoutMs = positiveInt("DATABASE_POOL_CONNECTION_TIMEOUT_MS", r.data.DATABASE_POOL_CONNECTION_TIMEOUT_MS, 10_000, 2_147_483_647);

  const testHooksRequested = r.data.KNOTEBOOK_E2E_TEST_HOOKS === "1";
  const testHooksLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(publicUrl.hostname);
  const testHooks = testHooksRequested && testHooksLoopback;
  const testHooksIgnored = testHooksRequested && !testHooksLoopback;
  const noteMaxBytes = positiveInt("NOTE_MAX_BYTES", env.NOTE_MAX_BYTES === "" ? undefined : env.NOTE_MAX_BYTES, DEFAULT_NOTE_MAX_BYTES, NOTE_MAX_BYTES_MAX);
  const limitEnv: LimitEnv = { ...parseEnvLimits(env) };
  if (env.NOTE_MAX_BYTES !== undefined && env.NOTE_MAX_BYTES !== "") limitEnv.noteMaxBytes = noteMaxBytes;
  const machine = detectMachine(cpuProbe);

  return { databaseUrl: r.data.DATABASE_URL, appSecret: r.data.APP_SECRET, publicUrl,
           cookieSecure: publicUrl.protocol === "https:", insecureHttpWarning,
           trustProxy: parseTrustProxy(r.data.TRUST_PROXY),
           passwordLoginForceEnable: parsePasswordLoginForceEnable(r.data.PASSWORD_LOGIN_FORCE_ENABLE),
           databasePoolMax, databasePoolConnectionTimeoutMs,
           adminEmail, adminPassword, testHooks, testHooksIgnored, limitEnv, machine };
}

/**
 * The only place the issuer comes from (`.href` would add a trailing slash). Origin only: RFC 8414 issuers with
 * a path need path-suffixed well-known URLs, which the root-level well-known routes don't serve.
 */
export function publicUrlIssuer(publicUrl: URL): string {
  return publicUrl.origin;
}

/**
 * Warns rather than fails, like `insecureHttpWarning`. Lives here, not in index.ts, so tests cover the wording;
 * keep it a constant so log aggregation and alerts can key on `msg`. The wording must not say the path is kept: the server drops the sub-path when deriving the origin and the OIDC redirect URIs.
 */
export function publicUrlPathWarning(publicUrl: URL): string | null {
  const isBareOrigin =
    publicUrl.pathname === "/" &&
    publicUrl.search === "" &&
    publicUrl.hash === "" &&
    publicUrl.username === "" &&
    publicUrl.password === "";
  if (isBareOrigin) return null;
  return "PUBLIC_URL should be a bare origin (scheme://host:port). Anything past the origin is dropped when deriving the OAuth issuer, and a sub-path is dropped from the OIDC redirect URIs too — so if PUBLIC_URL has one, the redirect URIs this server sends will not match a <PUBLIC_URL>/api/auth/oidc/callback… URI registered with the identity provider";
}

/** Constant messages, for the same reason as `publicUrlPathWarning`. */
export function testHooksStartupWarning(config: Pick<AppConfig, "testHooks" | "testHooksIgnored">): string | null {
  if (config.testHooks) return "e2e 測試縫已開啟（KNOTEBOOK_E2E_TEST_HOOKS=1）：已註冊測試專用路由、自動切版每秒掃描一次——只能用在 e2e 測試疊";
  if (config.testHooksIgnored) return "KNOTEBOOK_E2E_TEST_HOOKS=1 已忽略：PUBLIC_URL 不是 localhost／127.0.0.1／[::1]，測試專用路由不註冊";
  return null;
}

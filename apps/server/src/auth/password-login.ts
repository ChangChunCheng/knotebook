import { eq, sql } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { DbOrTx } from "../db/tx.js";
import { authProviders, siteSettings } from "../db/schema.js";

// The DB value drives the lock-out guards; the effective value (DB OR env `PASSWORD_LOGIN_FORCE_ENABLE`) drives whether
// password is accepted, and `effectivePasswordLogin` is the only place that expression exists. A missing row counts as ON
// plus log.error (opposite of registration): disabling password is policy, not a security boundary, and failing open
// avoids locking the whole site.

export const PASSWORD_LOGIN_DISABLED_MESSAGE = "This site only allows signing in through a sign-in service.";
export const PASSWORD_LOGIN_SETTINGS_MISSING_LOG = "site_settings 讀不到列：帳密登入視同開啟（#187）";

export const PASSWORD_LOGIN_FORCED_LOG =
  "PASSWORD_LOGIN_FORCE_ENABLE is set: password sign-in is on regardless of the Site admin setting. Remove it once recovery is done.";
export const PASSWORD_LOGIN_FORCED_NOOP_LOG =
  "PASSWORD_LOGIN_FORCE_ENABLE is set but has no effect while the Site admin setting is on. Remove it once recovery is done.";
export const PASSWORD_LOGIN_LOCKOUT_LOG =
  "Password sign-in is disabled and no sign-in provider is enabled: nobody can sign in. Set PASSWORD_LOGIN_FORCE_ENABLE=true and restart.";

export function effectivePasswordLogin(dbValue: boolean | null, forced: boolean): boolean {
  return forced || (dbValue ?? true);
}

export async function readPasswordLoginSetting(q: DbOrTx): Promise<boolean | null> {
  const [row] = await q.select({ enabled: siteSettings.passwordLoginEnabled }).from(siteSettings).where(eq(siteSettings.singleton, true)).limit(1);
  return row?.enabled ?? null;
}

export async function isPasswordLoginAccepted(
  db: Db,
  config: Pick<AppConfig, "passwordLoginForceEnable">,
  log: { error(obj: object, msg: string): void },
): Promise<boolean> {
  if (config.passwordLoginForceEnable) return true;
  const dbValue = await readPasswordLoginSetting(db);
  if (dbValue === null) log.error({ table: "site_settings" }, PASSWORD_LOGIN_SETTINGS_MISSING_LOG);
  return effectivePasswordLogin(dbValue, false);
}

/** Boot check, after the backfills and before listen (structural guard in `test/unit/config.test.ts`). Only logs, never blocks startup: env force warns (worded "has no effect" when the DB value is on); effective off with zero enabled providers (only possible by editing the DB) errors; a missing row errors and counts as on. */
export async function warnPasswordLoginAtBoot(
  db: Db,
  config: Pick<AppConfig, "passwordLoginForceEnable">,
  logger: { warn(msg: string): void; error(msg: string): void },
): Promise<void> {
  const dbValue = await readPasswordLoginSetting(db);
  if (dbValue === null) logger.error(PASSWORD_LOGIN_SETTINGS_MISSING_LOG);
  if (config.passwordLoginForceEnable) {
    logger.warn(dbValue === false ? PASSWORD_LOGIN_FORCED_LOG : PASSWORD_LOGIN_FORCED_NOOP_LOG);
    return;
  }
  if (effectivePasswordLogin(dbValue, false)) return;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(authProviders)
    .where(eq(authProviders.enabled, true));
  if (row!.n === 0) logger.error(PASSWORD_LOGIN_LOCKOUT_LOG);
}

import { eq } from "drizzle-orm";
import type { DbOrTx } from "../db/tx.js";
import { siteSettings } from "../db/schema.js";

export const REGISTRATION_DISABLED_MESSAGE = "This site doesn't allow signing up with an email and password. Contact the site admin.";

/** null = missing row: callers treat registration as closed (fail closed) and log an error. The in-transaction read (`FOR SHARE`) is in `auth/tx/register.ts`. */
export async function readRegistrationEnabled(db: DbOrTx): Promise<boolean | null> {
  const [row] = await db.select({ enabled: siteSettings.registrationEnabled }).from(siteSettings).where(eq(siteSettings.singleton, true)).limit(1);
  return row?.enabled ?? null;
}

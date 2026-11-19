import { eq } from "drizzle-orm";
import type { DbOrTx } from "../db/tx.js";
import { siteSettings } from "../db/schema.js";

export const REGISTRATION_DISABLED_MESSAGE = "This site doesn't allow signing up with an email and password. Contact the site admin.";

export async function readRegistrationEnabled(db: DbOrTx): Promise<boolean | null> {
  const [row] = await db.select({ enabled: siteSettings.registrationEnabled }).from(siteSettings).where(eq(siteSettings.singleton, true)).limit(1);
  return row?.enabled ?? null;
}

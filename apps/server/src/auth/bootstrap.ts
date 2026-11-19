import { randomUUID } from "node:crypto";
import { normalizeEmail } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { handles, instanceSetup, users } from "../db/schema.js";
import { deriveHandle } from "./handle.js";
import { hashPassword } from "./password.js";
import { redactDbError } from "../lib/redact-db-error.js";

export const INSTANCE_NOT_INITIALIZED = "InstanceNotInitializedError";

/** drizzle wraps any driver error with the admin email and argon2 hash in `message`/`params`, so only the known value-free "not initialized" error is logged raw. */
export function logInitFailure(log: { error(obj: object, msg: string): void }, err: unknown): void {
  if (err instanceof Error && err.name === INSTANCE_NOT_INITIALIZED) log.error({ err }, "instance initialization failed");
  else redactDbError(log, err, "實例初始化");
}

/** `loadConfig` already guarantees the pair and its format/length, so nothing is re-validated here. */
export interface EnvAdminBootstrap {
  email: string;
  password: string;
}

/**
 * Already initialized: no-op (`envAdmin` only applies on first init). `INSERT instance_setup ON CONFLICT DO NOTHING` is the
 * concurrency/retry guard (no row means someone else finished). `mustChangePassword` is false: the deployer set the password in .env themselves.
 * Throws instead of `process.exit` (exit would kill the vitest runner); production prints and exits in `index.ts`.
 */
export async function initializeInstance(db: Db, envAdmin?: EnvAdminBootstrap): Promise<void> {
  const rows = await db.select().from(instanceSetup).limit(1);
  if (rows.length > 0) return;

  if (!envAdmin) {
    const notInitialized = new Error(
      "此實例尚未初始化：請在 .env 設定 ADMIN_EMAIL 與 ADMIN_PASSWORD 後重啟（首次啟動會自動建立該管理員帳號）"
    );
    notInitialized.name = INSTANCE_NOT_INITIALIZED;
    throw notInitialized;
  }

  // Same normalization as routes/account.ts and routes/auth.ts, and displayName derives from it so an upper-case env email doesn't linger in the display name.
  const email = normalizeEmail(envAdmin.email);
  const passwordHash = await hashPassword(envAdmin.password);
  const displayName = email.split("@")[0] || email;
  const id = randomUUID();
  await db.transaction(async tx => {
    const [setupRow] = await tx.insert(instanceSetup).values({ singleton: true }).onConflictDoNothing().returning();
    if (!setupRow) return;
    // The registry insert must come AFTER the setupRow early return: that return is a normal COMMIT, so a concurrent loser
    // would commit a live row for a nonexistent user, burning the name and making the next boot hit the PK. No bare retry in the tx (aborted
    // transaction): a PK collision after probing is a real race, so startup fails closed (a restart retries).
    const handle = await deriveHandle(tx, [email.split("@")[0]], id);
    await tx.insert(handles).values({ handle, userId: id, state: "live" });
    await tx.insert(users).values({ id, email, passwordHash, displayName, isAdmin: true, mustChangePassword: false, handle });
  });
}

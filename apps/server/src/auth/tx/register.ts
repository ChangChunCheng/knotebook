import { eq, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { handles, siteSettings, users } from "../../db/schema.js";
import { TxAbort } from "../../http/tx-abort.js";
import { deriveHandle } from "../handle.js";
import { effectivePasswordLogin, PASSWORD_LOGIN_DISABLED_MESSAGE } from "../password-login.js";
import { REGISTRATION_DISABLED_MESSAGE } from "../site-settings.js";

export interface PasswordUserInput {
  id: string;
  /** Already normalizeEmail'd: the duplicate check compares `lower(email)` against it as-is. */
  email: string;
  displayName: string;
  passwordHash: string;
  useFallbackHandle: boolean;
}

export interface RegisterUserInput extends PasswordUserInput {
  passwordLoginForced: boolean;
}

export interface RegisteredUser {
  id: string;
  email: string;
  handle: string;
  displayName: string;
  tokenVersion: number;
}

/** Re-reads both switches under `FOR SHARE` (excludes the closing `FOR NO KEY UPDATE`); a missing row means registration is closed. */
export async function registerUserInTx(tx: Tx, input: RegisterUserInput): Promise<RegisteredUser> {
  const [settings] = await tx
    .select({ registrationEnabled: siteSettings.registrationEnabled, passwordLoginEnabled: siteSettings.passwordLoginEnabled })
    .from(siteSettings)
    .where(eq(siteSettings.singleton, true))
    .for("share");
  if (settings?.registrationEnabled !== true) throw new TxAbort(403, "registration_disabled", REGISTRATION_DISABLED_MESSAGE);
  if (!effectivePasswordLogin(settings.passwordLoginEnabled, input.passwordLoginForced)) {
    throw new TxAbort(403, "password_login_disabled", PASSWORD_LOGIN_DISABLED_MESSAGE);
  }
  return insertPasswordUserInTx(tx, input);
}

/** The lowercased email is checked first because `users_email_unique` is case-sensitive and can't stop pre-v0.1 mixed-case rows; the unique key is the final guard against races (callers map the constraint outside the tx). `must_change_password=false` (own password); `isAdmin` takes the DB default (false). The switches are the caller's job (registration re-checks in the tx, accept-invite outside). */
export async function insertPasswordUserInTx(tx: Tx, input: PasswordUserInput): Promise<RegisteredUser> {
  const [taken] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${input.email}`).limit(1);
  if (taken !== undefined) throw new TxAbort(409, "email_taken", "That email is already in use.");

  const handle = input.useFallbackHandle ? `user-${input.id.slice(0, 8)}` : await deriveHandle(tx, [input.email.split("@")[0]], input.id);
  await tx.insert(handles).values({ handle, userId: input.id, state: "live" });
  const [row] = await tx
    .insert(users)
    .values({ id: input.id, email: input.email, displayName: input.displayName, passwordHash: input.passwordHash, mustChangePassword: false, handle })
    .returning({ id: users.id, email: users.email, handle: users.handle, displayName: users.displayName, tokenVersion: users.tokenVersion });
  return row!;
}

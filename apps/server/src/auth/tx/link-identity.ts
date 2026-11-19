import { and, eq, ne, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { userIdentities, users } from "../../db/schema.js";
import { TxAbort } from "../../http/tx-abort.js";
import type { OidcTestHook } from "../oidc-test-hook.js";

export const LINK_EXPIRED_MESSAGE = "This link request has expired. Sign in again.";

export type LinkProof = { kind: "password"; passwordHash: string } | { kind: "sso"; issuer: string; sub: string };

export interface LinkPendingInput {
  targetUserId: string;
  /** From the pending cookie, already normalized. */
  pendingEmail: string;
  /** The new identity to link: always from the pending cookie, never from the SSO proof's second round trip. */
  issuer: string;
  sub: string;
  proof: LinkProof;
}

export interface LinkedUser {
  id: string;
  email: string;
  handle: string;
  displayName: string;
  isAdmin: boolean;
  mustChangePassword: boolean;
  hasPassword: boolean;
  tokenVersion: number;
  autoVersions: boolean;
}

/**
 * The first statement locks the target account row (`FOR NO KEY UPDATE`, compatible with the FK's KEY SHARE) before any identity row (the
 * create branch and the boot backfill excepted): the serialization point for "one sub per issuer". lower(email) must equal `pendingEmail`
 * (else `oidc_link_expired`); a password proof needs `password_hash` to still be the verified string. A proof mismatch doesn't reveal whose
 * identity it was, and `account_disabled` is disclosed only after proof. `must_change_password` is untouched; an SSO proof also updates
 * the proving identity's `last_login_at` (after the users lock). Password verification (argon2) and the session happen in the caller.
 */
export async function linkPendingIdentityInTx(tx: Tx, input: LinkPendingInput, hook?: OidcTestHook): Promise<LinkedUser> {
  const [row] = await tx
    .select({
      id: users.id,
      email: users.email,
      emailLower: sql<string>`lower(${users.email})`,
      handle: users.handle,
      displayName: users.displayName,
      isAdmin: users.isAdmin,
      mustChangePassword: users.mustChangePassword,
      passwordHash: users.passwordHash,
      disabledAt: users.disabledAt,
      tokenVersion: users.tokenVersion,
      autoVersions: users.autoVersions,
    })
    .from(users)
    .where(eq(users.id, input.targetUserId))
    .for("no key update");
  await hook?.("link-locked", { userId: input.targetUserId });

  if (row === undefined || row.emailLower !== input.pendingEmail) throw new TxAbort(409, "oidc_link_expired", LINK_EXPIRED_MESSAGE);

  if (input.proof.kind === "password") {
    if (row.passwordHash === null || row.passwordHash !== input.proof.passwordHash) {
      throw new TxAbort(401, "invalid_credentials", "Wrong email or password.");
    }
  } else {
    const [owner] = await tx
      .select({ userId: userIdentities.userId })
      .from(userIdentities)
      .where(and(eq(userIdentities.issuer, input.proof.issuer), eq(userIdentities.sub, input.proof.sub)))
      .limit(1);
    if (owner?.userId !== input.targetUserId) throw new TxAbort(409, "oidc_link_proof_mismatch", "You signed in with a different identity from the one this account is linked to.");
  }

  if (row.disabledAt !== null) throw new TxAbort(403, "account_disabled", "This account is disabled.");

  // "One sub per issuer" uses exact eq(issuer), not the loose `issuerKey`: both strings come verbatim from the IdP. The
  // exclusion is loose (over-exclude rather than leak), this check exact (miss rather than wrongly block): don't unify.
  const [sameIssuer] = await tx
    .select({ id: userIdentities.id })
    .from(userIdentities)
    .where(and(eq(userIdentities.userId, input.targetUserId), eq(userIdentities.issuer, input.issuer), ne(userIdentities.sub, input.sub)))
    .limit(1);
  if (sameIssuer !== undefined) throw new TxAbort(409, "identity_already_linked", "This account is already linked to another identity on the same sign-in service.");

  const inserted = await tx
    .insert(userIdentities)
    .values({ userId: input.targetUserId, issuer: input.issuer, sub: input.sub, lastLoginAt: sql`now()` })
    .onConflictDoNothing({ target: [userIdentities.issuer, userIdentities.sub] })
    .returning({ id: userIdentities.id });
  if (inserted.length === 0) {
    // ON CONFLICT waited for the other transaction; this new statement's snapshot sees its committed row.
    const [owner] = await tx
      .select({ userId: userIdentities.userId })
      .from(userIdentities)
      .where(and(eq(userIdentities.issuer, input.issuer), eq(userIdentities.sub, input.sub)))
      .limit(1);
    if (owner?.userId !== input.targetUserId) throw new TxAbort(409, "identity_taken", "This sign-in identity is already linked to another account.");
  }

  if (input.proof.kind === "sso") {
    await tx
      .update(userIdentities)
      .set({ lastLoginAt: sql`now()` })
      .where(and(eq(userIdentities.issuer, input.proof.issuer), eq(userIdentities.sub, input.proof.sub)));
  }

  return {
    id: row.id,
    email: row.email,
    handle: row.handle,
    displayName: row.displayName,
    isAdmin: row.isAdmin,
    mustChangePassword: row.mustChangePassword,
    hasPassword: row.passwordHash !== null,
    tokenVersion: row.tokenVersion,
    autoVersions: row.autoVersions,
  };
}

/** Holding both the session and the IdP login is the proof, so the email needn't match. Exact eq(issuer), as above. */
export async function linkIdentityToUserInTx(tx: Tx, input: { userId: string; issuer: string; sub: string }): Promise<void> {
  const [row] = await tx.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, input.userId)).for("no key update");
  if (row === undefined) throw new TxAbort(409, "oidc_link_session_mismatch", "The account that started this link no longer exists.");
  if (row.disabledAt !== null) throw new TxAbort(403, "account_disabled", "This account is disabled.");

  const ownerOf = async () =>
    (
      await tx
        .select({ userId: userIdentities.userId })
        .from(userIdentities)
        .where(and(eq(userIdentities.issuer, input.issuer), eq(userIdentities.sub, input.sub)))
        .limit(1)
    )[0];
  const owner = await ownerOf();
  if (owner !== undefined) {
    if (owner.userId === input.userId) return;
    throw new TxAbort(409, "identity_taken", "This sign-in identity is already linked to another account.");
  }

  const [sameIssuer] = await tx
    .select({ id: userIdentities.id })
    .from(userIdentities)
    .where(and(eq(userIdentities.userId, input.userId), eq(userIdentities.issuer, input.issuer), ne(userIdentities.sub, input.sub)))
    .limit(1);
  if (sameIssuer !== undefined) throw new TxAbort(409, "identity_already_linked", "This account is already linked to another identity on the same sign-in service.");

  const inserted = await tx
    .insert(userIdentities)
    .values({ userId: input.userId, issuer: input.issuer, sub: input.sub, lastLoginAt: sql`now()` })
    .onConflictDoNothing({ target: [userIdentities.issuer, userIdentities.sub] })
    .returning({ id: userIdentities.id });
  if (inserted.length === 0) {
    const winner = await ownerOf();
    if (winner?.userId !== input.userId) throw new TxAbort(409, "identity_taken", "This sign-in identity is already linked to another account.");
  }
}

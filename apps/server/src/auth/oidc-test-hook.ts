/** Test seam, not injected in production: each point lets a test interleave another request at that spot. */
export type OidcRacePoint =
  | "pending-confirm-verified"
  | "link-locked"
    /** After the identity lookup missed, before the email query. READ COMMITTED snapshots per statement: another first login for the same identity committing here makes the email query hit the account it just created. */
  | "login-identity-missed";

export type OidcTestHook = (
  point: OidcRacePoint,
  ctx: { userId: string } | { issuer: string; sub: string },
) => Promise<void>;

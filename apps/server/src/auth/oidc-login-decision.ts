import type { AuthProviderPublicDto } from "@knotebook/shared";
import { excludeSameIssuerProviders } from "./issuer.js";

// Pure decision, no DB. The IdP's email-confirmation flag plays no part and isn't in the claims type: identity is only
// (issuer, sub), and taking over an existing account requires proof.
// Before proof, "disabled" and "one sub per issuer" are not judged; both are deferred to the lock in `auth/tx/link-identity.ts`.

/** `email` is already normalizeEmail'd by the callback. `preferredUsername` is only a handle candidate at account creation. */
export interface OidcClaims {
  issuer: string;
  sub: string;
  email: string | null;
  name: string | null;
  preferredUsername: string | null;
}

export type LinkedProviderCandidate = AuthProviderPublicDto & { effectiveIssuer: string };

export interface OidcCandidateRow {
  id: string;
  disabledAt: Date | null;
  hasPassword: boolean;
  linkedProviders: LinkedProviderCandidate[];
}

export interface ProofMethods {
  password: boolean;
  providers: AuthProviderPublicDto[];
}

export type OidcRejectCode = "account_disabled" | "oidc_email_missing" | "oidc_conflict" | "oidc_link_no_proof_method" | "registration_disabled";

export type OidcDecision =
  | { kind: "login"; userId: string }
  | { kind: "create"; email: string; displayName: string; preferredUsername: string | null }
  | { kind: "confirm_link"; userId: string; methods: ProofMethods }
  | { kind: "reject"; code: OidcRejectCode };

export function decideOidcLogin(
  claims: OidcClaims,
  byIdentityUser: OidcCandidateRow | null,
  byEmailUsers: OidcCandidateRow[],
  autoCreateEnabled: boolean,
): OidcDecision {
  if (byIdentityUser !== null) {
    return byIdentityUser.disabledAt !== null ? { kind: "reject", code: "account_disabled" } : { kind: "login", userId: byIdentityUser.id };
  }
  if (claims.email === null) return { kind: "reject", code: "oidc_email_missing" };
  if (byEmailUsers.length > 1) return { kind: "reject", code: "oidc_conflict" };
  const existing = byEmailUsers[0];
  if (existing !== undefined) {
    // Exclude providers with this login's issuer: listing one would tell the caller "this account already linked that IdP"
    // before proof (proving through it always ends in identity_already_linked). Same function as GET pending and the SSO proof start.
    const providers = excludeSameIssuerProviders(existing.linkedProviders, claims.issuer);
    const methods: ProofMethods = { password: existing.hasPassword, providers };
    if (!methods.password && methods.providers.length === 0) return { kind: "reject", code: "oidc_link_no_proof_method" };
    return { kind: "confirm_link", userId: existing.id, methods };
  }
  if (!autoCreateEnabled) return { kind: "reject", code: "registration_disabled" };
  // `||`: an IdP may return `name: ""`, and an empty display name has no way to be fixed afterwards.
  const displayName = claims.name || claims.email.split("@")[0] || claims.email;
  return { kind: "create", email: claims.email, displayName, preferredUsername: claims.preferredUsername };
}

import type { AuthProviderPublicDto } from "@knotebook/shared";

// `issuerKey` is only for same-issuer EXCLUSION: over-exclude rather than miss, since a miss leaks "this account already
// linked that IdP" before proof. href alone would miss `.../realms/x` vs `.../realms/x/`. The link transaction
// (`auth/tx/link-identity.ts`) compares the stored issuer strings exactly instead.

export function issuerKey(issuer: string): string {
  try {
    return new URL(issuer).href.replace(/\/$/, "");
  } catch {
    return issuer;
  }
}

export function excludeSameIssuerProviders(
  providers: ReadonlyArray<AuthProviderPublicDto & { effectiveIssuer: string }>,
  pendingIssuer: string,
): AuthProviderPublicDto[] {
  const key = issuerKey(pendingIssuer);
  return providers.filter(p => issuerKey(p.effectiveIssuer) !== key).map(({ id, displayName, icon }) => ({ id, displayName, icon }));
}

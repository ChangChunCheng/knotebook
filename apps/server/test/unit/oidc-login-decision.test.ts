import { describe, expect, it } from "vitest";
import { decideOidcLogin, type OidcCandidateRow, type OidcClaims } from "../../src/auth/oidc-login-decision.js";

const claims = (over: Partial<OidcClaims> = {}): OidcClaims => ({
  issuer: "https://idp.example", sub: "s1", email: "u@example.com", name: "U Name", preferredUsername: null, ...over,
});
const row = (over: Partial<OidcCandidateRow> = {}): OidcCandidateRow => ({
  id: "u1", disabledAt: null, hasPassword: true, linkedProviders: [], ...over,
});
const P = { id: "p1", displayName: "GitLab", icon: null, effectiveIssuer: "https://gitlab.example" };
const PDto = { id: "p1", displayName: "GitLab", icon: null };
/** A provider of the same IdP as the issuer in claims() (this login necessarily comes through it). */
const SELF = (effectiveIssuer = "https://idp.example") => ({ id: "self", displayName: "IdP", icon: null, effectiveIssuer });

describe("decideOidcLogin (#187)", () => {
  it("identity matches -> login (ignores the auto-create switch and the email rows)", () => {
    expect(decideOidcLogin(claims(), row(), [row({ id: "x" }), row({ id: "y" })], false)).toEqual({ kind: "login", userId: "u1" });
  });
  it("identity matches but disabled -> account_disabled", () => {
    expect(decideOidcLogin(claims(), row({ disabledAt: new Date() }), [], true)).toEqual({ kind: "reject", code: "account_disabled" });
  });
  it("no match and email is null -> oidc_email_missing (regardless of the switch and email rows)", () => {
    expect(decideOidcLogin(claims({ email: null }), null, [], true)).toEqual({ kind: "reject", code: "oidc_email_missing" });
  });
  it("lower(email) matches several rows -> oidc_conflict (no guessing)", () => {
    expect(decideOidcLogin(claims(), null, [row({ id: "a" }), row({ id: "b" })], true)).toEqual({ kind: "reject", code: "oidc_conflict" });
  });
  it("exactly one row, with a password -> confirm_link, methods.password=true", () => {
    expect(decideOidcLogin(claims(), null, [row()], true)).toEqual({ kind: "confirm_link", userId: "u1", methods: { password: true, providers: [] } });
  });
  it("exactly one row, SSO only, a linked provider enabled -> confirm_link, methods has only providers", () => {
    expect(decideOidcLogin(claims(), null, [row({ hasPassword: false, linkedProviders: [P] })], true)).toEqual({
      kind: "confirm_link", userId: "u1", methods: { password: false, providers: [PDto] },
    });
  });
  it("a linked provider with the same issuer as this login is not listed in methods (listing it would leak 'already linked to this IdP' before proof)", () => {
    expect(decideOidcLogin(claims(), null, [row({ hasPassword: false, linkedProviders: [SELF(), P] })], true)).toEqual({
      kind: "confirm_link", userId: "u1", methods: { password: false, providers: [PDto] },
    });
    expect(decideOidcLogin(claims(), null, [row({ linkedProviders: [SELF()] })], true)).toEqual({
      kind: "confirm_link", userId: "u1", methods: { password: true, providers: [] },
    });
  });
  it("only linked to the same issuer and no password -> oidc_link_no_proof_method; a trailing-slash form counts as the same issuer (both directions)", () => {
    expect(decideOidcLogin(claims(), null, [row({ hasPassword: false, linkedProviders: [SELF()] })], true)).toEqual({ kind: "reject", code: "oidc_link_no_proof_method" });
    expect(decideOidcLogin(claims(), null, [row({ hasPassword: false, linkedProviders: [SELF("https://idp.example/")] })], true)).toEqual({ kind: "reject", code: "oidc_link_no_proof_method" });
    expect(decideOidcLogin(claims({ issuer: "https://idp.example/" }), null, [row({ hasPassword: false, linkedProviders: [SELF()] })], true)).toEqual({ kind: "reject", code: "oidc_link_no_proof_method" });
    expect(decideOidcLogin(claims({ issuer: "https://idp.example/realms/x" }), null, [row({ hasPassword: false, linkedProviders: [SELF("https://idp.example/realms/x/")] })], true)).toEqual({ kind: "reject", code: "oidc_link_no_proof_method" });
  });
  it("both empty -> oidc_link_no_proof_method", () => {
    expect(decideOidcLogin(claims(), null, [row({ hasPassword: false })], true)).toEqual({ kind: "reject", code: "oidc_link_no_proof_method" });
  });
  it("a disabled account still returns confirm_link before proof (disabled status isn't leaked)", () => {
    expect(decideOidcLogin(claims(), null, [row({ disabledAt: new Date() })], true).kind).toBe("confirm_link");
  });
  it("confirm_link ignores the auto-create switch (no new account is created)", () => {
    expect(decideOidcLogin(claims(), null, [row()], false).kind).toBe("confirm_link");
  });
  it("no row, the service has auto-create off -> registration_disabled", () => {
    expect(decideOidcLogin(claims(), null, [], false)).toEqual({ kind: "reject", code: "registration_disabled" });
  });
  it("no row, the service has auto-create on -> create; displayName takes name, falling back to the email local-part for an empty string", () => {
    expect(decideOidcLogin(claims({ preferredUsername: "Cool" }), null, [], true)).toEqual({
      kind: "create", email: "u@example.com", displayName: "U Name", preferredUsername: "Cool",
    });
    expect(decideOidcLogin(claims({ name: "" }), null, [], true)).toMatchObject({ kind: "create", displayName: "u" });
    expect(decideOidcLogin(claims({ name: null }), null, [], true)).toMatchObject({ kind: "create", displayName: "u" });
  });
});

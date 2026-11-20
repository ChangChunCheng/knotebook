import { createHash, randomBytes } from "node:crypto";
import { expect } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { testConfig } from "../helpers.js";

export const ISSUER = testConfig.publicUrl.origin;
export const RESOURCE = `${ISSUER}/api/mcp`;

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/**
 * `scope` is the authorize request's scope and `grant` is the decision body's scope (the consent page's checkboxes); don't mix them. Defaults to the widest of the five shapes
 * (the top of the grid since #181), which the server's narrowerScope (intersection) clamps down to pending - equivalent to the behaviour before #239; narrow-grant tests pass `grant` explicitly.
 */
export async function authorizeAndConsent(
  app: FastifyInstance,
  cookie: string,
  clientId: string,
  redirectUri: string,
  scope?: string,
  grant: string = "notes:read notes:write notes:move notes:delete"
): Promise<{ code: string; verifier: string }> {
  const { verifier, challenge } = pkce();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
    ...(scope === undefined ? {} : { scope }),
  });
  const authorized = await app.inject({ method: "GET", url: `/oauth/authorize?${params.toString()}` });
  expect(authorized.statusCode, "authorize 應 302").toBe(302);
  const req = new URL(authorized.headers.location as string, "http://x").searchParams.get("req")!;
  const decided = await app.inject({
    method: "POST",
    url: "/api/oauth/decision",
    headers: { cookie },
    payload: { req, decision: "allow", scope: grant },
  });
  expect(decided.statusCode, "decision 應 200").toBe(200);
  const code = new URL(decided.json().redirectTo as string).searchParams.get("code")!;
  return { code, verifier };
}

export async function obtainCode(
  app: FastifyInstance,
  cookie: string,
  options: { scope?: string; grant?: string } = {}
): Promise<{ clientId: string; redirectUri: string; code: string; verifier: string }> {
  const registered = await app.inject({
    method: "POST",
    url: "/oauth/register",
    payload: { client_name: "Test client", redirect_uris: ["http://127.0.0.1:1234/cb"] },
  });
  const clientId = registered.json().client_id as string;
  const redirectUri = "http://127.0.0.1:5678/cb";
  const { code, verifier } = await authorizeAndConsent(app, cookie, clientId, redirectUri, options.scope, options.grant);
  return { clientId, redirectUri, code, verifier };
}

export function exchange(app: FastifyInstance, fields: Record<string, string>): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(fields).toString(),
  });
}

export function codeGrant(c: { clientId: string; redirectUri: string; code: string; verifier: string }): Record<string, string> {
  return {
    grant_type: "authorization_code",
    code: c.code,
    code_verifier: c.verifier,
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    resource: RESOURCE,
  };
}

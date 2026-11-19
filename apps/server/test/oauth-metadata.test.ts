import { describe, expect, it } from "vitest";
import { buildTestApp, testConfig } from "./helpers.js";

describe("OAuth metadata endpoints", () => {
  it("PRM: resource and authorization_servers are derived from the PUBLIC_URL origin", async () => {
    const { app, close } = await buildTestApp();
    try {
      const res = await app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource/api/mcp" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("public, max-age=3600");
      const body = res.json();
      // Absolute values: a self-referential assertion can't catch a `.href` mutation (a trailing slash would propagate and be consistent everywhere)
      expect(body.resource).toBe(`${testConfig.publicUrl.origin}/api/mcp`);
      expect(body.authorization_servers).toEqual([testConfig.publicUrl.origin]);
      // order: read, write, move, delete (#181)
      expect(body.scopes_supported).toEqual(["notes:read", "notes:write", "notes:move", "notes:delete"]);
      expect(body.bearer_methods_supported).toEqual(["header"]);
      expect(body.resource_name).toBe("Knotebook");
    } finally {
      await close();
    }
  });

  it("AS metadata: endpoints complete and CIMD not declared", async () => {
    const { app, close } = await buildTestApp();
    try {
      const res = await app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(res.headers["cache-control"]).toBe("public, max-age=3600");
      // Absolute values, same reason as the PRM case
      expect(body.issuer).toBe(testConfig.publicUrl.origin);
      expect(body.scopes_supported).toEqual(["notes:read", "notes:write", "notes:move", "notes:delete"]);
      expect(body.authorization_endpoint).toBe(`${body.issuer}/oauth/authorize`);
      expect(body.token_endpoint).toBe(`${body.issuer}/oauth/token`);
      expect(body.registration_endpoint).toBe(`${body.issuer}/oauth/register`);
      expect(body.response_types_supported).toEqual(["code"]);
      expect(body.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
      expect(body.code_challenge_methods_supported).toEqual(["S256"]);
      expect(body.token_endpoint_auth_methods_supported).toEqual(["none"]);
      expect(body.authorization_response_iss_parameter_supported).toBe(true);
      // CIMD isn't declared so that clients fall back to registration_endpoint
      expect(body).not.toHaveProperty("client_id_metadata_document_supported");
    } finally {
      await close();
    }
  });

  // Root-form PRM and any unregistered /.well-known path must not return index.html
  it("root-form PRM and unknown well-known paths get an RFC-shaped 404, even with Accept: text/html", async () => {
    const { app, close } = await buildTestApp();
    try {
      for (const url of ["/.well-known/oauth-protected-resource", "/.well-known/bogus"]) {
        const res = await app.inject({ method: "GET", url, headers: { accept: "text/html" } });
        expect(res.statusCode, url).toBe(404);
        expect(res.json(), url).toEqual({ error: "invalid_request", error_description: expect.any(String) });
        expect(res.headers["cache-control"], url).toBe("no-store");
        expect(res.headers.pragma, url).toBe("no-cache");
      }
    } finally {
      await close();
    }
  });

  it("unmatched paths under the /oauth prefix get an RFC-shaped 404, bare path too", async () => {
    const { app, close } = await buildTestApp();
    try {
      for (const url of ["/oauth/bogus", "/oauth"]) {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode, url).toBe(404);
        expect(res.json().error, url).toBe("invalid_request");
      }
    } finally {
      await close();
    }
  });

  // The global guard's 415 under the /oauth prefix must also be RFC-shaped (bare path included)
  it("/oauth prefix with a form body on a non-exempt route -> 415 RFC-shaped", async () => {
    const { app, close } = await buildTestApp();
    try {
      for (const url of ["/oauth/bogus", "/oauth"]) {
        const res = await app.inject({
          method: "POST",
          url,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          payload: "a=1",
        });
        expect(res.statusCode, url).toBe(415);
        expect(res.json().error, url).toBe("invalid_request");
      }
    } finally {
      await close();
    }
  });

  // Reverse discrimination: the guard isn't "always 415 under the OAuth prefix": correct JSON must get through (then 404).
  // Without this case, making the check always true would stay green.
  it("/oauth prefix with correct JSON passes the guard (lands on 404, not 415)", async () => {
    const { app, close } = await buildTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/oauth/bogus",
        headers: { "content-type": "application/json" },
        payload: "{}",
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("invalid_request");
    } finally {
      await close();
    }
  });

  // Wiring guard for the segment boundary: /oauthx isn't an OAuth prefix and gets the in-site shape. GET never reaches the
  // CHANGE_METHODS guard, so this case must be a POST with a body.
  it("POST /oauthx with a form body -> in-site 415 shape (the guard uses a segment boundary, not a bare startsWith)", async () => {
    const { app, close } = await buildTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/oauthx",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "a=1",
      });
      expect(res.statusCode).toBe(415);
      expect(res.json()).toEqual({ error: { code: "unsupported_media_type", message: expect.any(String) } });
    } finally {
      await close();
    }
  });

  it("in-site route with a form body still gets our own 415 shape", async () => {
    const { app, close } = await buildTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "a=1",
      });
      expect(res.statusCode).toBe(415);
      expect(res.json()).toEqual({ error: { code: "unsupported_media_type", message: expect.any(String) } });
    } finally {
      await close();
    }
  });
});

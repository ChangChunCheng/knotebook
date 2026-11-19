// e2e/stubs/fake-idp.mjs
//
// Zero-dependency OIDC IdP stub in its own compose container (see the fake-idp service in ../../docker-compose.e2e.yml).
//
// #187: one process serves two issuers, the root `http://fake-idp:9400` and the path form `http://fake-idp:9400/b`.
// Each has its own discovery document, iss, authorize/token/userinfo/jwks paths, **signing key** and one-shot state, and its own
// control endpoint (`/control/next-login`, `/b/control/next-login`); both **share** one client id/secret.
// The reported issuer must equal the provider's configured string exactly (with a path, a trailing-slash mismatch throws).
//
// Unlike apps/server/test/helpers/fake-idp.ts, which intercepts fetch in-process, this opens a real socket and speaks real HTTP,
// and it does not check the redirect_uri binding.
// Deliberately not fastify: it shares no build context with the app (Dockerfile.stub has no install layer).

import { createServer } from "node:http";
import { generateKeyPairSync, createHash, randomBytes, sign as cryptoSign } from "node:crypto";
import { deflateSync } from "node:zlib";

const PORT = 9400;
const ORIGIN = "http://fake-idp:9400";
const EXPECTED_CLIENT_ID = "knotebook-e2e";
const EXPECTED_CLIENT_SECRET = "e2e-oidc-secret";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function makeAvatarPng() {
  const size = 64;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = buf => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = 0x2e;
    row[2 + x * 3] = 0x8b;
    row[3 + x * 3] = 0x57;
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const AVATAR_PNG = makeAvatarPng();

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString("base64url");
}

/** `prefix` is the path prefix (root = ""); `handle` returns true once it has responded. */
function createIssuer(prefix, kid) {
  const issuer = `${ORIGIN}${prefix}`;
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  /** Identity for the next `/authorize`; set by the control endpoint, cleared when used. */
  let nextLogin;
  const authorizedCodes = new Map();
  const accessTokenClaims = new Map();

  /** Hand-assembled compact JWT (RS256): jose is not available in the stub's build context. */
  function signIdToken(claims) {
    const header = { alg: "RS256", kid };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
    const signature = cryptoSign("RSA-SHA256", Buffer.from(signingInput), privateKey);
    return `${signingInput}.${base64url(signature)}`;
  }

  async function handle(req, res, url, path) {
    if (req.method === "GET" && path === "/.well-known/openid-configuration") {
      sendJson(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        id_token_signing_alg_values_supported: ["RS256"],
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        code_challenge_methods_supported: ["S256"],
        // #187: advertise client_secret_post (the only method Knotebook uses); otherwise "test connection" warns client_secret_post_not_advertised.
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      });
      return true;
    }

    if (req.method === "PUT" && path === "/control/next-login") {
      const body = await readBody(req);
      let claims;
      try {
        claims = JSON.parse(body || "{}");
      } catch {
        sendJson(res, 400, { error: "invalid_json" });
        return true;
      }
      if (typeof claims.sub !== "string" || claims.sub === "") {
        sendJson(res, 400, { error: "sub 為必要欄位" });
        return true;
      }
      nextLogin = claims;
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (req.method === "GET" && path === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const codeChallenge = url.searchParams.get("code_challenge");
      const scope = url.searchParams.get("scope") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const nonce = url.searchParams.get("nonce") ?? "";
      if (!redirectUri || !codeChallenge) {
        sendJson(res, 400, { error: "invalid_request", error_description: "缺 redirect_uri 或 code_challenge" });
        return true;
      }
      if (!scope.split(" ").includes("email")) {
        sendJson(res, 400, { error: "invalid_scope", error_description: "scope 必須含 email" });
        return true;
      }
      if (!nextLogin) {
        sendJson(res, 500, { error: "server_error", error_description: `未預置身分：測試須先 PUT ${prefix}/control/next-login` });
        return true;
      }
      const code = randomBytes(16).toString("hex");
      authorizedCodes.set(code, { claims: nextLogin, nonce, codeChallenge });
      nextLogin = undefined;
      const location = new URL(redirectUri);
      location.searchParams.set("code", code);
      location.searchParams.set("state", state);
      res.writeHead(302, { location: location.href });
      res.end();
      return true;
    }

    if (req.method === "POST" && path === "/token") {
      const params = new URLSearchParams(await readBody(req));
      const code = params.get("code");
      const clientId = params.get("client_id");
      const clientSecret = params.get("client_secret");
      const codeVerifier = params.get("code_verifier");
      const record = code ? authorizedCodes.get(code) : undefined;
      if (!code || !record) {
        sendJson(res, 400, { error: "invalid_grant", error_description: "code 不存在或已使用" });
        return true;
      }
      authorizedCodes.delete(code);
      if (clientId !== EXPECTED_CLIENT_ID || clientSecret !== EXPECTED_CLIENT_SECRET) {
        sendJson(res, 400, { error: "invalid_client" });
        return true;
      }
      const expectedChallenge = codeVerifier ? createHash("sha256").update(codeVerifier).digest("base64url") : undefined;
      if (!expectedChallenge || expectedChallenge !== record.codeChallenge) {
        sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE code_verifier mismatch" });
        return true;
      }
      const nowSeconds = Math.floor(Date.now() / 1000);
      const idTokenClaims = { iss: issuer, aud: clientId, sub: record.claims.sub, iat: nowSeconds, exp: nowSeconds + 300 };
      if (record.claims.email !== undefined) idTokenClaims.email = record.claims.email;
      if (record.claims.email_verified !== undefined) idTokenClaims.email_verified = record.claims.email_verified;
      if (record.claims.name !== undefined) idTokenClaims.name = record.claims.name;
      if (record.claims.picture !== undefined) idTokenClaims.picture = record.claims.picture;
      idTokenClaims.nonce = record.nonce;
      const accessToken = randomBytes(16).toString("hex");
      accessTokenClaims.set(accessToken, record.claims);
      sendJson(res, 200, { access_token: accessToken, token_type: "bearer", id_token: signIdToken(idTokenClaims) });
      return true;
    }

    if (req.method === "GET" && path === "/jwks") {
      const jwk = publicKey.export({ format: "jwk" });
      sendJson(res, 200, { keys: [{ ...jwk, kid, use: "sig", alg: "RS256" }] });
      return true;
    }

    if (req.method === "GET" && path === "/userinfo") {
      const authHeader = req.headers.authorization;
      const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
      const claims = accessToken ? accessTokenClaims.get(accessToken) : undefined;
      if (!claims) {
        sendJson(res, 401, { error: "invalid_token" });
        return true;
      }
      const body = { sub: claims.sub };
      if (claims.email !== undefined) body.email = claims.email;
      if (claims.email_verified !== undefined) body.email_verified = claims.email_verified;
      if (claims.name !== undefined) body.name = claims.name;
      if (claims.picture !== undefined) body.picture = claims.picture;
      sendJson(res, 200, body);
      return true;
    }

    return false;
  }

  return { prefix, handle };
}

// Path-form issuers go first: the root issuer's prefix is "" and would match every path.
const ISSUERS = [createIssuer("/b", "e2e-key-b"), createIssuer("", "e2e-key")];

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "fake-idp"}`);
    // Same hostname and port as the issuer, so the app's downloader treats it as the issuer's own host (the exemption looks at hostname only; container-network addresses are still blocked).
    if (req.method === "GET" && url.pathname === "/avatar.png") {
      res.writeHead(200, { "content-type": "image/png", "content-length": AVATAR_PNG.length });
      res.end(AVATAR_PNG);
      return;
    }
    for (const iss of ISSUERS) {
      if (iss.prefix !== "" && !url.pathname.startsWith(`${iss.prefix}/`)) continue;
      if (await iss.handle(req, res, url, url.pathname.slice(iss.prefix.length))) return;
      if (iss.prefix !== "") break; // a miss under `/b/` must not fall through to the root issuer, or a mistyped `/b/token` would hit the root's same-named route
    }
    if (!res.headersSent) sendJson(res, 404, { error: "not_found" });
  } catch (err) {
    console.error("[fake-idp] unhandled error", err);
    if (!res.headersSent) sendJson(res, 500, { error: "server_error" });
  }
});

// Must bind 0.0.0.0: reachable both from the app container on the compose network (issuer host `fake-idp`) and from the published
// `127.0.0.1:<E2E_IDP_PORT>` (the browser reaches it via host-resolver-rules).
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[fake-idp] listening on 0.0.0.0:${PORT} (issuers: ${ISSUERS.map(i => `${ORIGIN}${i.prefix}`).join(", ")})`);
});

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp } from "./helpers.js";

// Verbatim contract:
//   - the fallback is GET/HEAD only; decided on the pathname (query stripped)
//   - excluded prefixes match at a segment boundary: /api, /collab, /healthz, /assets, plus /oauth and /.well-known since #131
//     (`/x` itself or `/x/...`; `/collaborators` is not caught by `/collab`)
//   - Accept counts only if it contains text/html as a substring (`*/*` does not)
//   - a missing /assets/* file -> 404 (with no webDist, or none passed, every path is the JSON 404, as before)
describe("SPA fallback", () => {
  let webDist: string;

  beforeAll(() => {
    webDist = mkdtempSync(path.join(tmpdir(), "knotebook-spa-"));
    writeFileSync(path.join(webDist, "index.html"), "<!doctype html><title>knotebook spa</title>");
    mkdirSync(path.join(webDist, "assets"));
    writeFileSync(path.join(webDist, "assets", "app.js"), "console.log('app');");
    writeFileSync(path.join(webDist, "favicon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(path.join(webDist, "manifest.webmanifest"), '{"name":"Knotebook","display":"standalone"}');
  });

  it("GET /manifest.webmanifest -> 200 application/manifest+json (#336; sent by static, not swallowed into index.html by the SPA fallback)", async () => {
    const { app } = await buildTestApp({}, { webDist });
    // Browsers fetch the manifest with Accept */*; text/html is also tried to prove it does not fall into the fallback even then.
    for (const accept of ["*/*", "text/html"]) {
      const res = await app.inject({ method: "GET", url: "/manifest.webmanifest", headers: { accept } });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/manifest+json");
      expect(res.json()).toMatchObject({ name: "Knotebook", display: "standalone" });
      expect(res.body).not.toContain("knotebook spa");
      expect(res.headers["cache-control"]).toBe("no-cache");
    }
  });

  afterAll(() => {
    rmSync(webDist, { recursive: true, force: true });
  });

  const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

  it("GET /nope + Accept: text/html -> index.html 200", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/nope", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("knotebook spa");
    // index.html decides which /assets/* set loads, so it must be revalidated every time.
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("real browser Accept string (contains the text/html substring) -> index.html", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/nope", headers: { accept: BROWSER_ACCEPT } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("knotebook spa");
  });

  it("Accept: */* -> JSON 404 (*/* does not count as a text/html substring)", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/nope", headers: { accept: "*/*" } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("no Accept header (curl/fetch/app.inject default) -> JSON 404", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("POST /nope (even with Accept: text/html) -> the existing JSON 404 (fallback is GET/HEAD only)", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "POST", url: "/nope", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("GET /assets/missing.js -> 404 (/assets is excluded from the SPA fallback; any JSON body is fine, the status code is the point)", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/assets/missing.js", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(404);
  });

  it("GET /assets/app.js -> 200 with correct content (served by @fastify/static, not the fallback)", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("console.log('app');");
    // The file name carries a content hash: cache for a year, no revalidation.
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("GET /favicon.svg -> 200 image/svg+xml (a file at the dist root is served by static, not swallowed into index.html by the SPA fallback)", async () => {
    const { app } = await buildTestApp({}, { webDist });
    // Browsers fetch the icon with Accept image/*; text/html is also tried to prove it does not fall into the fallback even then.
    for (const accept of ["image/avif,image/webp,image/*,*/*;q=0.8", "text/html"]) {
      const res = await app.inject({ method: "GET", url: "/favicon.svg", headers: { accept } });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("image/svg+xml");
      expect(res.body).toContain("<svg");
      expect(res.headers["cache-control"]).toBe("no-cache");
      expect(res.body).not.toContain("knotebook spa");
    }
  });

  it("GET /collaborators + text/html -> index.html (segment boundary: not caught by the /collab exclusion)", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/collaborators", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("knotebook spa");
  });

  it("GET /api/nope + text/html -> JSON 404 (/api is excluded from the SPA fallback)", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/api/nope", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("GET /api/nope?x=1 + text/html -> JSON 404 (the pathname is used, the query string does not affect the excluded-prefix match)", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/api/nope?x=1", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  // #131 put /oauth and /.well-known on the exclusion list. Their own 404s are not tested here: since #132 they are handled by
  // each prefix plugin's notFound (RFC shape), which duplicates oauth-metadata.test.ts. This file keeps the two positive controls
  // below, which check that the prefix match stops at a segment boundary (`/oauthx` and `/.well-knownx` still get index.html).
  it("#131 positive control: GET /oauthx + text/html -> index.html (segment boundary)", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/oauthx", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("knotebook spa");
  });

  it("#131 positive control: GET /.well-knownx + text/html -> index.html", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/.well-knownx", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("knotebook spa");
  });

  // Guards two things: `/authorize` is not swallowed by EXCLUDED_PREFIXES or a server route (else JSON 404), and the SPA
  // fallback's HTML exit really goes through securityHeaders (confirming `/authorize` uses the same header-adding exit). The
  // server does not know SPA routes, so removing the route from App.tsx does not go red here - AuthorizePage.test.tsx guards that half.
  it("/authorize is served by the SPA fallback with frame-ancestors 'none'", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/authorize?req=abc", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("knotebook spa");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  it("GET /nope?foo=bar + text/html -> index.html (the query string does not affect fallback matching)", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/nope?foo=bar", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("knotebook spa");
  });

  // #101: CSP is attached on this path (where index.html is returned by hand) - CSP only matters for HTML documents. The policy
  // content is pinned clause by clause in test/unit/security-headers.test.ts; this guards that it is really attached and that
  // the hash is computed from the body actually sent this time.
  it("index.html response carries CSP, and the script-src hash is the sha256 of the inline script in this very body", async () => {
    const inline = 'document.documentElement.classList.add("dark");';
    const dist = mkdtempSync(path.join(tmpdir(), "knotebook-csp-"));
    writeFileSync(
      path.join(dist, "index.html"),
      `<!doctype html><head><script>${inline}</script></head><body></body>`,
    );
    try {
      const { app } = await buildTestApp({}, { webDist: dist });
      const res = await app.inject({ method: "GET", url: "/nope", headers: { accept: "text/html" } });

      expect(res.statusCode).toBe(200);
      const csp = res.headers["content-security-policy"];
      expect(csp, "index.html 回應沒有 CSP").toBeTypeOf("string");
      // Oracle independent of the implementation: sha256 the script text in the body as sent.
      const served = /<script>([\s\S]*?)<\/script>/.exec(res.body)![1]!;
      const hash = createHash("sha256").update(served, "utf8").digest("base64");
      expect(csp).toContain(`'sha256-${hash}'`);
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  // A past serious hole: `@fastify/static` with `wildcard:false` still registers a route for every file that actually exists
  // under root, including `index.html`, so `GET /index.html` was served by static as the same SPA (App.tsx's `/*` route renders
  // the home page, and the lax session cookie is sent = signed in) with no security header at all - the whole policy bypassed
  // with 11 characters. This pins that entry through the header-adding path too.
  it("GET /index.html must also carry CSP - static must not serve index.html directly (bypassing the whole policy)", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/index.html", headers: { accept: "text/html" } });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("knotebook spa");
    expect(res.headers["content-security-policy"], "/index.html 沒有 CSP＝整份政策可被繞過").toBeTypeOf(
      "string",
    );
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("JSON 404 carries no CSP (that path is not an HTML document)", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/api/nope", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-security-policy"]).toBeUndefined();
  });

  // CSP only matters for HTML, but `nosniff` is a cheap per-response header that JSON and static JS should have too - so it
  // sits on the global onSend, not only on the SPA path.
  it("nosniff is on every response (JSON and static assets too), not only HTML", async () => {
    const { app } = await buildTestApp({}, { webDist });

    const json = await app.inject({ method: "GET", url: "/api/nope" });
    expect(json.headers["x-content-type-options"], "JSON 回應缺 nosniff").toBe("nosniff");

    const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["x-content-type-options"], "靜態資產缺 nosniff").toBe("nosniff");
  });

  it("#72: HTML fallback under the /p/ prefix carries X-Robots-Tag: noindex (token links stay out of search engines)", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/p/whatever-token", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-robots-tag"]).toBe("noindex");
  });

  it("#72: /p itself and the //p/ and /P/ variants are noindex too (the check shares normalization with log masking - fixing only one side would miss these variants)", async () => {
    const { app } = await buildTestApp({}, { webDist });
    for (const url of ["/p", "//p/some-token", "/P/some-token"]) {
      const res = await app.inject({ method: "GET", url, headers: { accept: "text/html" } });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["x-robots-tag"], url).toBe("noindex");
    }
  });

  it("#72 reverse: HTML fallback on other paths must NOT carry X-Robots-Tag - a conditional header on the wrong layer would noindex the whole site", async () => {
    const { app } = await buildTestApp({}, { webDist });
    for (const url of ["/", "/nope", "/notes/some-ref", "/pnot-a-prefix"]) {
      const res = await app.inject({ method: "GET", url, headers: { accept: "text/html" } });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["x-robots-tag"], url).toBeUndefined();
    }
  });
  it("webDist not passed -> GET /nope is still the existing JSON 404 (existing behaviour unaffected)", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/nope", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  IMMUTABLE_CACHE_CONTROL,
  REVALIDATE_CACHE_CONTROL,
  registerSpaFallback,
  staticCacheControl,
} from "../../src/http/spa.js";

// registerSpaFallback needs only a Fastify instance and a dist directory and does not touch the database, so a unit test can mount it directly.
describe("Cache-Control for the SPA and static files", () => {
  let webDist: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    webDist = mkdtempSync(path.join(tmpdir(), "knotebook-spa-cache-"));
    writeFileSync(path.join(webDist, "index.html"), "<!doctype html><title>knotebook spa</title>");
    mkdirSync(path.join(webDist, "assets"));
    writeFileSync(path.join(webDist, "assets", "index-abc123.js"), "console.log('app');");
    writeFileSync(path.join(webDist, "assets", "index-abc123.css"), "body{}");
    writeFileSync(path.join(webDist, "favicon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(path.join(webDist, "manifest.webmanifest"), '{"name":"Knotebook"}');
    writeFileSync(path.join(webDist, "icon-192.png"), "png");
    app = Fastify({ logger: false });
    registerSpaFallback(app, webDist);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(webDist, { recursive: true, force: true });
  });

  it("staticCacheControl: long cache under assets/, no-cache at the dist root", () => {
    expect(staticCacheControl(webDist, path.join(webDist, "assets", "index-abc123.js"))).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(staticCacheControl(webDist, path.join(webDist, "assets", "fonts", "a.woff2"))).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(staticCacheControl(webDist, path.join(webDist, "manifest.webmanifest"))).toBe(REVALIDATE_CACHE_CONTROL);
    // a file whose name starts with assets but is not inside the assets/ directory does not count
    expect(staticCacheControl(webDist, path.join(webDist, "assets-list.json"))).toBe(REVALIDATE_CACHE_CONTROL);
  });

  it("values of the two constants", () => {
    expect(IMMUTABLE_CACHE_CONTROL).toBe("public, max-age=31536000, immutable");
    expect(REVALIDATE_CACHE_CONTROL).toBe("no-cache");
  });

  for (const url of ["/assets/index-abc123.js", "/assets/index-abc123.css"]) {
    it(`GET ${url} -> one year and immutable`, async () => {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe(IMMUTABLE_CACHE_CONTROL);
    });
  }

  for (const url of ["/manifest.webmanifest", "/icon-192.png", "/favicon.svg"]) {
    it(`GET ${url} -> no-cache`, async () => {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe(REVALIDATE_CACHE_CONTROL);
    });
  }

  it("HEAD and GET carry the same value", async () => {
    const res = await app.inject({ method: "HEAD", url: "/assets/index-abc123.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe(IMMUTABLE_CACHE_CONTROL);
  });

  for (const url of ["/", "/notes/abc", "/p/some-token"]) {
    it(`GET ${url} (text/html, returns index.html) -> no-cache`, async () => {
      const res = await app.inject({ method: "GET", url, headers: { accept: "text/html" } });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("knotebook spa");
      expect(res.headers["cache-control"]).toBe(REVALIDATE_CACHE_CONTROL);
    });
  }

  it("a missing /assets/* is still a JSON 404, without long caching", async () => {
    const res = await app.inject({ method: "GET", url: "/assets/missing.js", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(404);
    expect(res.headers["cache-control"]).not.toBe(IMMUTABLE_CACHE_CONTROL);
  });
});

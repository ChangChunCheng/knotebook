import { readFile } from "node:fs/promises";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import { isExcludedPath } from "@knotebook/shared";
import { securityHeaders } from "./security-headers.js";
import { isPublicSharePath } from "../routes/public.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sendError } from "./errors.js";

function acceptsHtml(accept: string | undefined): boolean {
  return accept !== undefined && accept.includes("text/html");
}

const FALLBACK_METHODS = new Set(["GET", "HEAD"]);

export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
// index.html decides which /assets/* loads, so caching it would pin an old version.
export const REVALIDATE_CACHE_CONTROL = "no-cache";

export function staticCacheControl(webDist: string, filePath: string): string {
  const relative = path.relative(webDist, filePath);
  const [first] = relative.split(/[\\/]/);
  return first === "assets" ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL;
}

// wildcard:false and index:false make everything but real asset files fall through to the not-found handler, so index.html has a single path (below) and always gets the security headers.
export function registerSpaFallback(app: FastifyInstance, webDist: string | undefined): void {
  if (webDist !== undefined) {
    void app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
      index: false,
      // ⚠ static must never serve index.html (#101): it would bypass the security-header path below. Only the literal /index.html is excluded because dist has no other .html;
      // if one is added, static would send it without headers (then use `!pathName.endsWith(".html")`).
      allowedPath: (pathName) => pathName !== "/index.html",
      // The plugin default `max-age=0` would revalidate every hashed bundle on each app open.
      setHeaders: (reply, filePath) => {
        reply.header("cache-control", staticCacheControl(webDist, filePath));
      },
    });
  }

  app.setNotFoundHandler(async (request: FastifyRequest, reply: FastifyReply) => {
    if (webDist !== undefined && FALLBACK_METHODS.has(request.method)) {
      const pathname = request.url.split("?")[0];
      if (!isExcludedPath(pathname) && acceptsHtml(request.headers.accept)) {
        try {
          const html = await readFile(path.join(webDist, "index.html"), "utf8");
          reply.header("content-type", "text/html; charset=utf-8");
          reply.header("cache-control", REVALIDATE_CACHE_CONTROL);
          // Token links are capabilities: noindex them (#72). Only this prefix, since securityHeaders() applies to all routes. isPublicSharePath is shared with log masking.
          if (isPublicSharePath(pathname)) {
            reply.header("x-robots-tag", "noindex");
          }
          for (const [name, value] of Object.entries(securityHeaders(html))) {
            reply.header(name, value);
          }
          reply.send(html);
          return;
        } catch {
          // fall through to the JSON 404
        }
      }
    }
    sendError(reply, 404, "not_found", "No endpoint matches this method and path.");
  });
}

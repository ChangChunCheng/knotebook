/**
 * Two reasons for this file, both traps that waste hours if not centralized:
 *
 * 1. **One truth for `Accept`**. The SDK transport requires `Accept` to contain both `application/json` and `text/event-stream`; without that - including none at all,
 *    `application/json` only, or only a wildcard (star/star) - the answer is always `406` (wildcards don't count), with an error message unrelated to the behaviour under test.
 * 2. **If `origin` is given, `host` must be given with it**. `app.inject`'s default Host is `localhost:80` while `testConfig.PUBLIC_URL` is `http://localhost:3000`;
 *    a test that sets only `origin` always gets 403 (the Origin-mismatch guard), again unrelated to the behaviour under test.
 */
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { SESSION_COOKIE } from "@knotebook/shared";

export const MCP_ACCEPT = "application/json, text/event-stream";

/** Host of `testConfig.PUBLIC_URL`: positive cases carrying `Origin` use it as `host`. */
export const PUBLIC_HOST = "localhost:3000";

export interface McpRequestOpts {
  token?: string;
  /** Session cookie value; the helper adds SESSION_COOKIE= itself. */
  cookie?: string;
  /** `null` = no `Accept` at all; omitted = {@link MCP_ACCEPT}. */
  accept?: string | null;
  /** `null` = no `Content-Type` at all; omitted = `application/json`. */
  contentType?: string | null;
  origin?: string;
  host?: string;
  /** Body string sent as is (bad JSON / empty body cases); takes precedence over `body`. */
  raw?: string;
}

function buildHeaders(opts: McpRequestOpts, withContentType: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  const accept = opts.accept === undefined ? MCP_ACCEPT : opts.accept;
  if (accept !== null) headers.accept = accept;
  if (withContentType) {
    const contentType = opts.contentType === undefined ? "application/json" : opts.contentType;
    if (contentType !== null) headers["content-type"] = contentType;
  }
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  if (opts.origin !== undefined) headers.origin = opts.origin;
  if (opts.host !== undefined) headers.host = opts.host;
  return headers;
}

/**
 * `POST /api/mcp`. `body` undefined with no `raw` = **no body at all**.
 * The body is always serialized here rather than left to `inject`, which would add a `content-type` on its own.
 */
export function mcpPost(app: FastifyInstance, body: unknown, opts: McpRequestOpts = {}): Promise<LightMyRequestResponse> {
  const payload = opts.raw !== undefined ? opts.raw : body === undefined ? undefined : JSON.stringify(body);
  const inject: InjectOptions = {
    method: "POST",
    url: "/api/mcp",
    headers: buildHeaders(opts, true),
    ...(payload === undefined ? {} : { payload }),
    ...(opts.cookie === undefined ? {} : { cookies: { [SESSION_COOKIE]: opts.cookie } }),
  };
  return app.inject(inject);
}

/** `GET`/`DELETE /api/mcp` (neither carries a body, so no `Content-Type`). */
export function mcpRequest(
  app: FastifyInstance,
  method: "GET" | "DELETE",
  opts: McpRequestOpts = {}
): Promise<LightMyRequestResponse> {
  const inject: InjectOptions = {
    method,
    url: "/api/mcp",
    headers: buildHeaders(opts, false),
    ...(opts.cookie === undefined ? {} : { cookies: { [SESSION_COOKIE]: opts.cookie } }),
  };
  return app.inject(inject);
}

export const rpc = (method: string, params?: unknown, id: number | string = 1): Record<string, unknown> => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

/** `protocolVersion` is the newest the SDK supports. */
export const INITIALIZE = rpc("initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "plan-test", version: "0" },
});

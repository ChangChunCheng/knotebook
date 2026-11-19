import { expect } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { inject } from "./trash-helpers.js";

export type McpAuth = { token: string } | { cookie: string };
export type ToolCallResult = {
  isError?: true;
  structuredContent?: Record<string, unknown> & { code?: string; message?: string };
  content: Array<{ type: string; text?: string }>;
};

/** One tools/call; the HTTP layer must be 200 (tool errors live in the result). */
export async function callTool(app: FastifyInstance, auth: McpAuth, name: string, args?: unknown): Promise<ToolCallResult> {
  const params = args === undefined ? { name } : { name, arguments: args };
  const res = await mcpPost(app, rpc("tools/call", params), auth);
  expect(res.statusCode, res.body).toBe(200);
  const result = res.json().result as ToolCallResult;
  return { isError: result.isError, structuredContent: result.structuredContent, content: result.content };
}

export function restFolder(
  app: FastifyInstance,
  userId: string,
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT",
  url: string,
  body?: unknown,
): Promise<LightMyRequestResponse> {
  return inject(app, method, url, userId, body);
}

/** Two tool-error results are identical field by field (can't see = doesn't exist): isError, structuredContent and mirror text all equal, and the code is not_found. */
export function expectSameNotFound(a: ToolCallResult, b: ToolCallResult): void {
  expect(a.isError).toBe(true);
  expect(a.structuredContent?.code).toBe("not_found");
  expect(b).toEqual(a);
}

/**
 * Hardcodes `method: "POST"` (only `/api/mcp` POST is served). The body isn't carried: it goes
 * through `handleRequest`'s `parsedBody` because Fastify already consumed the stream. The
 * Response's status/headers/text must be materialized before the server closes.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

export interface MaterializedResponse {
  status: number;
  headers: [string, string][];
  text: string;
}

export function toWebRequest(request: FastifyRequest, endpointUrl: string): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const one of value) headers.append(key, one);
    } else {
      headers.append(key, value);
    }
  }
  return new Request(endpointUrl, { method: "POST", headers });
}

export function sendWebResponse(reply: FastifyReply, res: MaterializedResponse): FastifyReply {
  reply.code(res.status);
  for (const [key, value] of res.headers) reply.header(key, value);
  return reply.send(res.text);
}

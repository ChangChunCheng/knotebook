import type { FastifyReply } from "fastify";
import { SESSION_COOKIE } from "@knotebook/shared";
import type { AppConfig } from "../config.js";

/** The only place the session cookie is written, so its five attributes can't drift. `ttlSeconds` equals the JWT exp and `sessions.expires_at` of the same issuance. Routes go through `auth/sessions.ts` so the `sessions` row exists before signing. */
export function setSessionCookie(reply: FastifyReply, config: AppConfig, jwt: string, ttlSeconds: number): void {
  reply.setCookie(SESSION_COOKIE, jwt, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    path: "/",
    maxAge: ttlSeconds,
  });
}

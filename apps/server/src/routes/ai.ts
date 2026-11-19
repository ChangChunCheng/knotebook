import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { AI_SSE_EVENTS, INSTRUCT_ACTION_ID, aiActionKind, type AiActionDto } from "@knotebook/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { aiActions } from "../db/schema.js";
import { loadAiSnapshot, resolveActionModel } from "../ai/resolve.js";
import { AiKeyDecryptError, decryptApiKey } from "../ai/crypto.js";
import type { AiRuntime } from "../ai/runtime.js";
import Anthropic from "@anthropic-ai/sdk";
import { renderUserTemplate, streamAnthropic, streamOpenAiCompatible, truncateBody, UpstreamError, type UpstreamHandle } from "../ai/upstream.js";
import { checkInstructFields, withInstructGuard, withMarkupGuard, wrapInstructVars } from "../ai/instruct.js";
import { sendError } from "../http/errors.js";
import { safeTarget } from "../lib/safe-target.js";
import { fetchErrorSummary, urlHasCredentials } from "../lib/fetch-error-summary.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { resolveRole, UUID_RE } from "../notes/service.js";

export interface AiRouteDeps {
  db: Db;
  config: AppConfig;
  runtime: AiRuntime;
  limiters: { ai: FixedWindowLimiter };
  /** Test seam: fake timers combined with real SSE I/O are unreliable in CI, so tests inject a short real idle timeout. */
  idleTimeoutMs?: number;
}

// snake_case on purpose. `instruction`/`focus` are validated in checkInstructFields because Instruct detection needs action_id lowercased first.
const postAiBodySchema = z.object({
  action_id: z.string().min(1),
  note_id: z.string().min(1),
  text: z.string().min(1),
  instruction: z.string().optional(),
  focus: z.string().optional(),
});

const AI_UNAVAILABLE_MESSAGE = "This AI service is unavailable right now. Contact the site admin.";
// Exported so a unit test can pin the default.
export const IDLE_TIMEOUT_MS = 60_000;

export function aiRoutes(deps: AiRouteDeps) {
  const idleTimeoutMs = deps.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  return async function register(app: FastifyInstance): Promise<void> {
    // Same resolveActionModel as POST /api/ai, so listed actions are exactly the runnable ones (degraded providers still list: degradation only affects POST). Omits systemPrompt/userTemplate for non-admins.
    app.get("/api/ai/actions", { preHandler: app.authenticate }, async () => {
      const [snapshot, actionRows] = await Promise.all([
        loadAiSnapshot(deps.db),
        deps.db.select().from(aiActions).where(eq(aiActions.enabled, true)).orderBy(asc(aiActions.sortOrder), asc(aiActions.id)),
      ]);

      const actions: AiActionDto[] = [];
      for (const row of actionRows) {
        const resolved = resolveActionModel({ modelId: row.modelId }, snapshot);
        if (resolved === null) continue;
        actions.push({ id: row.id, name: row.name, applyMode: row.applyMode as "direct" | "preview", kind: aiActionKind(row.id) });
      }

      return { actions };
    });

    /** Everything that can fail with a normal HTTP error happens before reply.hijack(); afterwards any exception becomes a fixed-text SSE `error` event and never reaches the global errorHandler. */
    app.post("/api/ai", { preHandler: app.authenticate }, async (request, reply) => {
      const parsed = postAiBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      }
      const { text, instruction, focus } = parsed.data;
      const actionId = parsed.data.action_id.toLowerCase();
      const noteId = parsed.data.note_id.toLowerCase();

      // Decided against the constant, with no DB lookup, before the UUID check, role check and throttle, so these 400s cost no quota.
      const fields = checkInstructFields(actionId === INSTRUCT_ACTION_ID, instruction, focus);
      if (!fields.ok) return sendError(reply, 400, "invalid_body", fields.message);

      // Before resolveRole, so "malformed" isn't mixed with "no access" in one 404 and a non-uuid action_id can't make the aiActions query throw.
      if (!UUID_RE.test(actionId) || !UUID_RE.test(noteId)) {
        return sendError(reply, 400, "invalid_body", "action_id and note_id must be UUIDs.");
      }

      const userId = request.user!.id;

      const role = await resolveRole(deps.db, userId, noteId);
      if (role === "none") return sendError(reply, 404, "not_found", "No note with that id.");
      if (role === "viewer") return sendError(reply, 403, "forbidden", "You don't have edit access to this note.");

      if (!deps.limiters.ai.consume(userId)) {
        return sendError(reply, 429, "too_many_requests", "Too many requests. Wait a moment and try again.");
      }

      const [action] = await deps.db.select().from(aiActions).where(eq(aiActions.id, actionId)).limit(1);
      if (!action || !action.enabled) return sendError(reply, 404, "not_found", "No AI action with that id.");

      const snapshot = await loadAiSnapshot(deps.db);
      const resolved = resolveActionModel({ modelId: action.modelId }, snapshot);
      if (resolved === null) {
        return sendError(reply, 503, "ai_not_configured", "AI isn't set up on this site. Contact the site admin.");
      }

      // A separate check, not via degraded: a NULL key is the legitimate "not configured yet" state (as in checkProviderKeys).
      if (resolved.provider.type === "anthropic" && resolved.provider.apiKeyEncrypted === null) {
        return sendError(reply, 503, "provider_unavailable", AI_UNAVAILABLE_MESSAGE);
      }

      if (deps.runtime.degraded.has(resolved.provider.id)) {
        return sendError(reply, 503, "provider_unavailable", AI_UNAVAILABLE_MESSAGE);
      }

      // Decrypt before hijack (nothing may throw after it). openai_compatible allows a NULL key (local vLLM).
      let apiKey: string | undefined;
      if (resolved.provider.apiKeyEncrypted !== null) {
        try {
          apiKey = decryptApiKey(deps.config.appSecret, resolved.provider.apiKeyEncrypted, resolved.provider.id);
        } catch (err) {
          if (!(err instanceof AiKeyDecryptError)) throw err;
          deps.runtime.degraded.add(resolved.provider.id);
          return sendError(reply, 503, "provider_unavailable", AI_UNAVAILABLE_MESSAGE);
        }
      }

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      raw.on("error", err => request.log.warn({ err }, "sse socket error")); // without a listener, a write to a destroyed socket becomes an unhandled error event
      const send = (event: string, data: unknown): void => {
        if (raw.destroyed || raw.writableEnded) return;
        try {
          raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {
          /* client gone */
        }
      };
      const upstreamAbort = new AbortController();
      // Not `request.raw.on("close")`: it means the request body finished, not that the client left, and with the awaits before hijack it fires ~1 ms after the handler starts (a listener attached before it falsely
      // aborts upstream; one attached after misses it forever). The response's 'close' tracks the real socket; on normal completion it fires after raw.end() when abort() is a no-op.
      raw.on("close", () => upstreamAbort.abort());
      // 'close' may already have fired during the awaits above; both stream functions honour an already-aborted signal.
      if (raw.destroyed) upstreamAbort.abort();
      let idleTimer: NodeJS.Timeout | undefined;
      const resetIdleTimer = (): void => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => upstreamAbort.abort(), idleTimeoutMs);
      };
      // Held outside try and aborted in finally: some upstreams (vLLM-compatible) don't close the connection after [DONE], which would leak a socket.
      let handle: UpstreamHandle | undefined;
      try {
        const isInstruct = action.id === INSTRUCT_ACTION_ID;
        const opts = {
          baseUrl: resolved.provider.baseUrl,
          model: resolved.model.modelId,
          system: withMarkupGuard(isInstruct ? withInstructGuard(action.systemPrompt) : action.systemPrompt),
          user: renderUserTemplate(
            action.userTemplate,
            isInstruct
              ? wrapInstructVars({ text, instruction: fields.instruct?.instruction ?? "", focus: fields.instruct?.focus })
              : { text, instruction: "", focus: "" },
          ),
          signal: upstreamAbort.signal,
        };
        handle =
          resolved.provider.type === "anthropic"
            ? streamAnthropic({ ...opts, apiKey: apiKey! })
            : streamOpenAiCompatible({ ...opts, apiKey });
        resetIdleTimer();
        for await (const delta of handle.stream) {
          resetIdleTimer();
          send(AI_SSE_EVENTS.delta, { text: delta }); // named delta: `text` would shadow the request body's text
        }
        send(AI_SSE_EVENTS.done, {});
      } catch (err) {
        // Don't log err: a base_url with user:pass@ puts the password in fetch's TypeError message (and in the Anthropic SDK's cause). Log fetchErrorSummary, the base URL without
        // userinfo/query, and whether it had credentials, plus, when the upstream answered non-2xx, its status and truncated body (safe: that is the upstream's own response,
        // which doesn't contain our URL).
        const upstreamFields =
          err instanceof UpstreamError
            ? { status: err.status, upstreamBody: err.upstreamBody }
            : err instanceof Anthropic.APIError && typeof err.status === "number"
              ? {
                  status: err.status,
                  ...(err.requestID ? { requestId: err.requestID } : {}),
                  ...(err.error !== undefined
                    ? { upstreamBody: truncateBody(typeof err.error === "string" ? err.error : JSON.stringify(err.error)) }
                    : {}),
                }
              : {};
        request.log.warn(
          {
            providerId: resolved.provider.id,
            target: safeTarget(resolved.provider.baseUrl),
            urlHasCredentials: urlHasCredentials(resolved.provider.baseUrl),
            ...fetchErrorSummary(err),
            ...upstreamFields,
          },
          "ai upstream failed"
        );
        // #53: a key-less openai_compatible provider is legitimate (local vLLM/Ollama), so it can't be refused before streaming, and #46 makes it easy to reach (changing
        // base_url clears the key). So an upstream 401/403 with no stored key maps to provider_unavailable ("ask the admin to re-enter the key"); with a stored key that
        // upstream rejects it stays upstream_error. The condition tests the provider's stored key, not its type (key-less anthropic is already refused before streaming).
        const missingKeyAuthFailure =
          err instanceof UpstreamError &&
          (err.status === 401 || err.status === 403) &&
          resolved.provider.apiKeyEncrypted === null;
        // Fixed text only, never the upstream body (pinned by ai-sse.test.ts).
        if (missingKeyAuthFailure) {
          send(AI_SSE_EVENTS.error, { code: "provider_unavailable", message: AI_UNAVAILABLE_MESSAGE });
        } else {
          send(AI_SSE_EVENTS.error, { code: "upstream_error", message: "The request to the AI provider failed." });
        }
      } finally {
        handle?.abort();
        clearTimeout(idleTimer);
        if (!raw.writableEnded) raw.end();
      }
    });
  };
}

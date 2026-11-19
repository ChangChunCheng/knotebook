import { AI_SSE_EVENTS, type AiActionDto } from "@knotebook/shared";
import { api, ApiFail } from "./client";

export function fetchAiActions(): Promise<AiActionDto[]> {
  return api<{ actions: AiActionDto[] }>("/api/ai/actions").then((body) => body.actions);
}

export interface StreamCallbacks {
  onDelta(text: string): void;
}

interface ApiErrorPayload {
  code: string;
  message: string;
}

/** Separate from client.ts `isApiErrorBody` because this path doesn't use `api()`. */
function parseErrorBody(body: unknown): ApiErrorPayload | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return typeof code === "string" && typeof message === "string" ? { code, message } : null;
}

/** null for frames without an `event:` line (e.g. whitespace keep-alive); callers skip them. */
function parseSseFrame(frame: string): { event: string; data: unknown } | null {
  let event = "";
  let dataLine = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLine = line.slice(5).trim();
  }
  if (!event) return null;
  try {
    return { event, data: JSON.parse(dataLine || "{}") };
  } catch {
    return null;
  }
}

/** Not `api()`: a 2xx response is an event stream. Sets what `api()` would: `Content-Type: application/json`
 * (else the server's CSRF hook answers 415; stubbed-fetch unit tests can't catch it) and `credentials: "include"`.
 * A stream `error` event throws `ApiFail` with status 200: the HTTP status was already sent. */
export async function streamAiAction(
  opts: {
    actionId: string;
    noteId: string;
    text: string;
    instruction?: string;
    focus?: string;
    signal: AbortSignal;
  } & StreamCallbacks,
): Promise<void> {
  const response = await fetch("/api/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    signal: opts.signal,
    body: JSON.stringify({
      action_id: opts.actionId,
      note_id: opts.noteId,
      text: opts.text,
      // Only Instruct sends these; the server answers 400 if any other action sends them, even empty.
      ...(opts.instruction !== undefined ? { instruction: opts.instruction } : {}),
      ...(opts.focus !== undefined ? { focus: opts.focus } : {}),
    }),
  });

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const parsed = parseErrorBody(body);
    if (parsed) throw new ApiFail(response.status, parsed.code, parsed.message);
    throw new ApiFail(response.status, "internal", "Unexpected error response from server");
  }

  const reader = response.body?.getReader();
  // Defensive: the server always sends a stream body.
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) return; // closed without a `done` event: treated as a normal end, not an error
    buffer += decoder.decode(value, { stream: true });

    let separatorIndex: number;
    while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      const parsed = parseSseFrame(frame);
      if (!parsed) continue;

      if (parsed.event === AI_SSE_EVENTS.delta) {
        const payload = parsed.data as { text?: unknown };
        if (typeof payload.text === "string") opts.onDelta(payload.text);
      } else if (parsed.event === AI_SSE_EVENTS.done) {
        return;
      } else if (parsed.event === AI_SSE_EVENTS.error) {
        const payload = parsed.data as { code?: unknown; message?: unknown };
        throw new ApiFail(
          200,
          typeof payload.code === "string" ? payload.code : "internal",
          typeof payload.message === "string" ? payload.message : "AI stream error",
        );
      }
    }
  }
}

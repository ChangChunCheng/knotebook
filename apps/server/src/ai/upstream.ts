import Anthropic from "@anthropic-ai/sdk";

/**
 * `redirect: "manual"`: undici strips only Authorization/Cookie on cross-origin redirects, so
 * our custom `authorization` header would be forwarded to a third party. A 3xx then falls
 * into `!res.ok` and becomes UpstreamError.
 */

/** `upstreamBody` (cut to 2048 chars) is for the caller's log only: never log the whole err (a fetch error message can hold a credentialed URL) and never put it in the SSE error sent to the client. */
export class UpstreamError extends Error {
  constructor(
    public status: number,
    public upstreamBody?: string
  ) {
    super("upstream request failed");
    this.name = "UpstreamError";
  }
}

export interface UpstreamHandle {
  stream: AsyncIterable<string>;
  /** Kept for tests; the route aborts through the shared signal. */
  abort(): void;
}

export interface TemplateVars {
  text: string;
  instruction: string;
  focus: string;
}

const PLACEHOLDER_RE = /\{\{(text|instruction|focus)\}\}/g;

/**
 * A single regex pass, so a substituted value containing `{{instruction}}` isn't expanded
 * again. The replacer is a function because string replacements interpret `$&`, `$$` etc.
 */
export function renderUserTemplate(template: string, vars: TemplateVars): string {
  return template.replace(PLACEHOLDER_RE, (_match, name: keyof TemplateVars) => vars[name]);
}

const MAX_LOGGED_BODY_CHARS = 2048;

export function truncateBody(text: string): string {
  return text.length > MAX_LOGGED_BODY_CHARS ? `${text.slice(0, MAX_LOGGED_BODY_CHARS)}...(truncated)` : text;
}

async function* readSseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const rawLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        yield rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      }
    }
    if (buffer.length > 0) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

interface OpenAiCompatibleOpts {
  baseUrl: string;
  apiKey?: string;
  model: string;
  system: string;
  user: string;
  signal: AbortSignal;
}

interface OpenAiChatCompletionChunk {
  choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown } }>;
}

/** Reasoning/thinking fields are dropped on purpose; `[DONE]` is a normal end. */
export function streamOpenAiCompatible(opts: OpenAiCompatibleOpts): UpstreamHandle {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (opts.signal.aborted) controller.abort();
  else opts.signal.addEventListener("abort", onAbort);

  async function* generate(): AsyncGenerator<string> {
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (opts.apiKey !== undefined) headers.authorization = `Bearer ${opts.apiKey}`;

      const res = await fetch(`${opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: opts.model,
          stream: true,
          messages: [
            { role: "system", content: opts.system },
            { role: "user", content: opts.user },
          ],
        }),
        signal: controller.signal,
        redirect: "manual",
      });

      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        throw new UpstreamError(res.status, truncateBody(bodyText));
      }
      if (res.body === null) {
        throw new UpstreamError(res.status);
      }

      for await (const line of readSseLines(res.body)) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice("data:".length).trim();
        if (payload.length === 0) continue;
        if (payload === "[DONE]") return;

        let parsed: OpenAiChatCompletionChunk;
        try {
          parsed = JSON.parse(payload) as OpenAiChatCompletionChunk;
        } catch {
          continue;
        }
        const delta = parsed.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) yield delta;
      }
    } finally {
      opts.signal.removeEventListener("abort", onAbort);
    }
  }

  return { stream: generate(), abort: () => controller.abort() };
}

interface AnthropicOpts {
  apiKey: string;
  baseUrl?: string;
  model: string;
  system: string;
  user: string;
  signal: AbortSignal;
}

// Required by the Messages API; quick actions are short transforms.
const ANTHROPIC_MAX_TOKENS = 4096;

/**
 * SDK errors propagate as-is (the caller's catch-all treats all error types alike).
 * `redirect: "manual"`: the SDK's `x-api-key` isn't stripped by undici on cross-origin
 * redirects, so a hijacked upstream answering 302 would receive the plaintext key. Only
 * `text_delta` text is forwarded; thinking deltas are dropped on purpose.
 */
export function streamAnthropic(opts: AnthropicOpts): UpstreamHandle {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (opts.signal.aborted) controller.abort();
  else opts.signal.addEventListener("abort", onAbort);

  async function* generate(): AsyncGenerator<string> {
    try {
      // jsdom's window/document on globalThis (notes/editing/runtime.ts) would trigger the SDK's browser detection.
      const client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseUrl, fetchOptions: { redirect: "manual" }, dangerouslyAllowBrowser: true });
      const stream = client.messages.stream(
        {
          model: opts.model,
          max_tokens: ANTHROPIC_MAX_TOKENS,
          system: opts.system,
          messages: [{ role: "user", content: opts.user }],
        },
        { signal: controller.signal }
      );
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield event.delta.text;
        }
      }
    } finally {
      opts.signal.removeEventListener("abort", onAbort);
    }
  }

  return { stream: generate(), abort: () => controller.abort() };
}

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, "__fixtures__", "vllm-sse.txt");

// vi.mock is hoisted above the named imports below, so `streamAnthropic` always gets the mock; no manual import ordering needed.
vi.mock("@anthropic-ai/sdk", () => {
  const streamMock = vi.fn();
  const ctorMock = vi.fn().mockImplementation(() => ({ messages: { stream: streamMock } }));
  return { default: ctorMock, __streamMock: streamMock, __ctorMock: ctorMock };
});

import { renderUserTemplate, streamAnthropic, streamOpenAiCompatible, UpstreamError } from "../../src/ai/upstream.js";

/** Splits text at a byte offset into two chunks, to simulate one SSE event line broken across a chunk boundary. */
function chunkedTextStream(text: string, splitAt: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const first = bytes.slice(0, splitAt);
  const second = bytes.slice(splitAt);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first);
      controller.enqueue(second);
      controller.close();
    },
  });
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const delta of stream) out.push(delta);
  return out;
}

describe("streamOpenAiCompatible", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("vLLM fixture: only content is emitted, reasoning_content is filtered out, and a line split across chunks is reassembled", async () => {
    const fixture = readFileSync(FIXTURE_PATH, "utf8");
    // Deliberately split inside one JSON line (within the "Hello" delta) rather than at a natural chunk line break.
    const splitAt = fixture.indexOf('"content":"Hello"') + 5;
    expect(splitAt).toBeGreaterThan(5); // indexOf -1 would give 4: confirms the anchor exists in the fixture

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(chunkedTextStream(fixture, splitAt), { status: 200, headers: { "content-type": "text/event-stream" } })
    );
    vi.stubGlobal("fetch", fetchMock);

    const handle = streamOpenAiCompatible({
      baseUrl: "http://upstream.local/v1",
      apiKey: "sk-test",
      model: "vllm-model",
      system: "sys",
      user: "usr",
      signal: new AbortController().signal,
    });

    const deltas = await collect(handle.stream);
    expect(deltas.join("")).toBe("Hello, world!");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://upstream.local/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body as string) as { model: string; stream: boolean; messages: unknown[] };
    expect(body.model).toBe("vllm-model");
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "usr" },
    ]);
  });

  it("no authorization header when apiKey is absent (local/unauthenticated vLLM)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(chunkedTextStream("data: [DONE]\n\n", 5), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const handle = streamOpenAiCompatible({
      baseUrl: "http://upstream.local",
      model: "m",
      system: "s",
      user: "u",
      signal: new AbortController().signal,
    });
    await collect(handle.stream);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("non-2xx -> UpstreamError(status), with a fixed message that does not include the upstream body", async () => {
    const sentinelBody = "SENTINEL-UPSTREAM-BODY-should-not-leak-into-message";
    const fetchMock = vi.fn().mockResolvedValue(new Response(sentinelBody, { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    const handle = streamOpenAiCompatible({
      baseUrl: "http://upstream.local",
      model: "m",
      system: "s",
      user: "u",
      signal: new AbortController().signal,
    });

    let caught: unknown;
    try {
      await collect(handle.stream);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(UpstreamError);
    const err = caught as UpstreamError;
    expect(err.status).toBe(502);
    expect(err.message).toBe("upstream request failed");
    expect(err.message).not.toContain(sentinelBody);
    // upstreamBody is an extra field for the caller's log (not the SSE message thrown to the client), so body content is allowed here.
    expect(err.upstreamBody).toContain(sentinelBody);
  });

  it("upstream error body over 2048 chars is truncated with a note", async () => {
    const hugeBody = "x".repeat(3000);
    const fetchMock = vi.fn().mockResolvedValue(new Response(hugeBody, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const handle = streamOpenAiCompatible({
      baseUrl: "http://upstream.local",
      model: "m",
      system: "s",
      user: "u",
      signal: new AbortController().signal,
    });

    let caught: unknown;
    try {
      await collect(handle.stream);
    } catch (err) {
      caught = err;
    }
    const err = caught as UpstreamError;
    expect(err.upstreamBody?.length).toBeLessThan(3000);
    expect(err.upstreamBody).toContain("...(truncated)");
  });

  it("handle can still be created when the signal is already aborted; the stream throws because of the abort (does not hang)", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError"));
    vi.stubGlobal("fetch", fetchMock);

    const handle = streamOpenAiCompatible({
      baseUrl: "http://upstream.local",
      model: "m",
      system: "s",
      user: "u",
      signal: controller.signal,
    });

    await expect(collect(handle.stream)).rejects.toBeTruthy();
  });
});

describe("streamAnthropic", () => {
  beforeEach(async () => {
    const mod = (await import("@anthropic-ai/sdk")) as unknown as {
      __streamMock: ReturnType<typeof vi.fn>;
      __ctorMock: ReturnType<typeof vi.fn>;
    };
    mod.__streamMock.mockReset();
    mod.__ctorMock.mockClear();
  });

  it("forwards only text_delta of content_block_delta; other events such as thinking_delta are filtered", async () => {
    const mod = (await import("@anthropic-ai/sdk")) as unknown as { __streamMock: ReturnType<typeof vi.fn> };
    async function* fakeEvents() {
      yield { type: "message_start" };
      yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } };
      yield { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "secret reasoning, never forward" } };
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } };
      yield { type: "content_block_stop", index: 0 };
      yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
      yield { type: "message_stop" };
    }
    mod.__streamMock.mockReturnValue(fakeEvents());

    const handle = streamAnthropic({
      apiKey: "sk-ant-test",
      model: "claude-x",
      system: "sys",
      user: "usr",
      signal: new AbortController().signal,
    });

    const deltas = await collect(handle.stream);
    expect(deltas.join("")).toBe("Hello");
    for (const d of deltas) expect(d).not.toContain("secret reasoning");
  });

  it("constructs the SDK client from apiKey/baseUrl; stream() receives model/max_tokens/system/messages", async () => {
    const mod = (await import("@anthropic-ai/sdk")) as unknown as {
      __streamMock: ReturnType<typeof vi.fn>;
      __ctorMock: ReturnType<typeof vi.fn>;
    };
    async function* fakeEvents() {
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } };
    }
    mod.__streamMock.mockReturnValue(fakeEvents());

    const handle = streamAnthropic({
      apiKey: "sk-ant-test",
      baseUrl: "https://custom.anthropic.example",
      model: "claude-x",
      system: "sys",
      user: "usr",
      signal: new AbortController().signal,
    });
    await collect(handle.stream);

    // The ctor must get `fetchOptions: { redirect: "manual" }`: the SDK's own `x-api-key` header is not in undici's redirect-strip
    // list, so a 302 would send the plaintext key to a third-party host.
    // `dangerouslyAllowBrowser: true` (#136): once `notes/editing/runtime.ts` attaches jsdom's window/document to globalThis, the SDK's
    // browser sniffing misfires and throws (pinned by editing-runtime.test.ts).
    expect(mod.__ctorMock).toHaveBeenCalledWith({
      apiKey: "sk-ant-test",
      baseURL: "https://custom.anthropic.example",
      fetchOptions: { redirect: "manual" },
      dangerouslyAllowBrowser: true,
    });
    const [params, options] = mod.__streamMock.mock.calls[0] as [
      { model: string; max_tokens: number; system: string; messages: unknown[] },
      { signal: AbortSignal },
    ];
    expect(params.model).toBe("claude-x");
    expect(params.system).toBe("sys");
    expect(params.messages).toEqual([{ role: "user", content: "usr" }]);
    expect(typeof params.max_tokens).toBe("number");
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("renderUserTemplate (#263: three placeholders, single-pass replacement)", () => {
  const vars = { text: "T", instruction: "I", focus: "F" };

  it("each of the three placeholders is substituted and may repeat", () => {
    expect(renderUserTemplate("{{instruction}}|{{focus}}|{{text}}|{{text}}", vars)).toBe("I|F|T|T");
  });

  it("literal placeholders inside substituted values are not expanded again (single regex pass)", () => {
    const tricky = { text: "{{instruction}}", instruction: "{{focus}}", focus: "{{text}}" };
    expect(renderUserTemplate("{{text}} {{instruction}} {{focus}}", tricky)).toBe("{{instruction}} {{focus}} {{text}}");
  });

  it("other {{name}} placeholders stay as-is; text without placeholders is returned unchanged", () => {
    expect(renderUserTemplate("{{other}} {{text}}", vars)).toBe("{{other}} T");
    expect(renderUserTemplate("no placeholder here", vars)).toBe("no placeholder here");
  });

  it("replacement values containing $ specials are pasted verbatim (no replace-pattern parsing: $$, $&, backtick variants, $')", () => {
    const weird = "$$ and $& and $` and $' and ${template literal} and $<name>";
    expect(renderUserTemplate("before {{text}} after", { ...vars, text: weird })).toBe(`before ${weird} after`);
  });

  it("empty replacement value: the placeholder is removed, the rest of the text is unchanged", () => {
    expect(renderUserTemplate("[{{instruction}}][{{text}}]", { text: "", instruction: "", focus: "" })).toBe("[][]");
  });
});

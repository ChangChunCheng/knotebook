import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiFail } from "./client";
import { streamAiAction } from "./ai";

/**
 * Hand-written SSE client of `POST /api/ai`. `fetch` is stubbed entirely; a real `ReadableStream<Uint8Array>` simulates the byte stream of the server's `raw.write("event: ...\ndata: ...\n\n")`, including lines broken across chunks (the core risk: `event: delta\n` and `data: {...}\n\n` split over two `reader.read()` calls).
 */

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encode(chunk));
      controller.close();
    },
  });
}

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  body?: ReadableStream<Uint8Array> | null;
}

function fakeResponse({ ok, status, json, body }: FakeResponseInit): Response {
  return {
    ok,
    status,
    json: json ?? (() => Promise.reject(new Error("no body"))),
    body: body ?? null,
  } as unknown as Response;
}

describe("streamAiAction (hand-written SSE client)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reassembles lines broken across chunks: event/data split over different chunks are recombined and delta is called back for each", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        fakeResponse({
          ok: true,
          status: 200,
          body: sseBody([
            "event: delta\n",
            'data: {"text":"你好"}\n\n',
            'event: delta\ndata: {"text":"，世界"}',
            "\n\n",
            "event: done\ndata: {}\n\n",
          ]),
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const deltas: string[] = [];
    await streamAiAction({
      actionId: "a1",
      noteId: "n1",
      text: "hi",
      signal: new AbortController().signal,
      onDelta: (text) => deltas.push(text),
    });

    expect(deltas).toEqual(["你好", "，世界"]);
  });

  it("delta callbacks one by one: three delta events trigger onDelta three times in order", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        fakeResponse({
          ok: true,
          status: 200,
          body: sseBody([
            'event: delta\ndata: {"text":"A"}\n\n',
            'event: delta\ndata: {"text":"B"}\n\n',
            'event: delta\ndata: {"text":"C"}\n\n',
            "event: done\ndata: {}\n\n",
          ]),
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const deltas: string[] = [];
    await streamAiAction({
      actionId: "a1",
      noteId: "n1",
      text: "hi",
      signal: new AbortController().signal,
      onDelta: (text) => deltas.push(text),
    });

    expect(deltas).toEqual(["A", "B", "C"]);
  });

  it("error event -> throws ApiFail(code, message), stops reading", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        fakeResponse({
          ok: true,
          status: 200,
          body: sseBody(['event: error\ndata: {"code":"upstream_error","message":"The request to the AI provider failed."}\n\n']),
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const onDelta = vi.fn();
    await expect(
      streamAiAction({ actionId: "a1", noteId: "n1", text: "hi", signal: new AbortController().signal, onDelta }),
    ).rejects.toMatchObject(new ApiFail(200, "upstream_error", "The request to the AI provider failed."));
    expect(onDelta).not.toHaveBeenCalled();
  });

  it("pre-stream 503 JSON -> ApiFail('ai_not_configured')", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        fakeResponse({
          ok: false,
          status: 503,
          json: () => Promise.resolve({ error: { code: "ai_not_configured", message: "AI isn't set up on this site. Contact the site admin." } }),
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      streamAiAction({
        actionId: "a1",
        noteId: "n1",
        text: "hi",
        signal: new AbortController().signal,
        onDelta: vi.fn(),
      }),
    ).rejects.toMatchObject(new ApiFail(503, "ai_not_configured", "AI isn't set up on this site. Contact the site admin."));
  });

  it("abort: the given AbortSignal is passed to fetch unchanged", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(fakeResponse({ ok: true, status: 200, body: sseBody(["event: done\ndata: {}\n\n"]) })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await streamAiAction({ actionId: "a1", noteId: "n1", text: "hi", signal: controller.signal, onDelta: vi.fn() });

    const [, init] = fetchMock.mock.calls[0] as [RequestInfo, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });

  it("the init sent has Content-Type: application/json and credentials: include", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(fakeResponse({ ok: true, status: 200, body: sseBody(["event: done\ndata: {}\n\n"]) })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await streamAiAction({
      actionId: "a1",
      noteId: "n1",
      text: "hi",
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });

    const [url, init] = fetchMock.mock.calls[0] as [RequestInfo, RequestInit];
    expect(url).toBe("/api/ai");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ action_id: "a1", note_id: "n1", text: "hi" });
  });

  it("#263: instruction/focus are in the body only when passed", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(fakeResponse({ ok: true, status: 200, body: sseBody(["event: done\ndata: {}\n\n"]) })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;

    await streamAiAction({ actionId: "a1", noteId: "n1", text: "hi", instruction: "shorter", focus: "h", signal, onDelta: vi.fn() });
    await streamAiAction({ actionId: "a1", noteId: "n1", text: "hi", instruction: "shorter", signal, onDelta: vi.fn() });

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init!.body)));
    expect(bodies).toEqual([
      { action_id: "a1", note_id: "n1", text: "hi", instruction: "shorter", focus: "h" },
      { action_id: "a1", note_id: "n1", text: "hi", instruction: "shorter" },
    ]);
  });
});

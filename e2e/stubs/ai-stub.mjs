// e2e/stubs/ai-stub.mjs
//
// Zero-dependency vLLM-compatible chat completions stub in its own compose container (not published to the host).
// The SSE shape follows apps/server/test/unit/__fixtures__/vllm-sse.txt, but every delta also carries
// `reasoning_content`, so e2e checks that thinking text does not reach the visible output.
// `/fast` and `/slow` ignore the request and return FINAL_CONTENT; `/echo` returns the last user message with the first
// `Original` replaced by `Rewritten` (used by 37-columns-rw).

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = 9500;
const FINAL_CONTENT = "E2E rewritten text";

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function splitIntoChunks(text, n) {
  const chars = Array.from(text);
  const chunks = [];
  const base = Math.max(1, Math.floor(chars.length / n));
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const isLast = i === n - 1;
    const size = isLast ? chars.length - idx : base;
    chunks.push(chars.slice(idx, idx + size).join(""));
    idx += size;
  }
  return chunks;
}

async function streamCompletions(res, { content, chunkCount, intervalMs }) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const id = randomUUID();
  const contentChunks = splitIntoChunks(content, chunkCount);

  for (let i = 0; i < contentChunks.length; i++) {
    if (intervalMs > 0 && i > 0) await delay(intervalMs);
    const delta = { content: contentChunks[i], reasoning_content: `(internal reasoning chunk ${i})` };
    const event = { id, choices: [{ delta, index: 0 }] };
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  res.write("data: [DONE]\n\n");
  res.end();
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function echoContent(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  const messages = body && typeof body === "object" ? body.messages : undefined;
  if (!Array.isArray(messages)) return null;
  const lastUser = messages.filter(m => m && typeof m === "object" && m.role === "user").at(-1);
  if (!lastUser || typeof lastUser.content !== "string") return null;
  return lastUser.content.replace("Original", "Rewritten");
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/fast/chat/completions") {
      return await streamCompletions(res, { content: FINAL_CONTENT, chunkCount: 8, intervalMs: 0 });
    }
    if (req.method === "POST" && req.url === "/slow/chat/completions") {
      // 1s interval x 12 deltas (~11s) stays well under the server's IDLE_TIMEOUT_MS (60s): activity must not count as idle.
      return await streamCompletions(res, { content: FINAL_CONTENT, chunkCount: 12, intervalMs: 1000 });
    }
    if (req.method === "POST" && req.url === "/echo/chat/completions") {
      const content = echoContent(await readBody(req));
      if (content === null) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad_request" }));
        return;
      }
      return await streamCompletions(res, { content, chunkCount: 4, intervalMs: 0 });
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  } catch (err) {
    console.error("[ai-stub] unhandled error", err);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "server_error" }));
    }
  }
});

// Must bind 0.0.0.0 (same reason as fake-idp.mjs). Only the app container calls this, but both stubs share one Dockerfile.stub,
// so identical behaviour is less likely to drift.
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[ai-stub] listening on 0.0.0.0:${PORT}`);
});

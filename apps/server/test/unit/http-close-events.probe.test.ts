/**
 * Bulk transfer probe, not a product guard: when `request.raw`'s `close` fires on a PUT (with body) decides that disconnect detection on the
 * write-back route (PUT /api/transfer/notes) may only hook `reply.raw`'s `close`. The whole file is `describe.skipIf(!process.env.KN_PROBE)`:
 * CI's `test:unit` collects the file but doesn't run it (avoids a flake on "red if 10 runs disagree"). Sequences go to `KN_PROBE_LOG` (UTF-8; stdout only if unset).
 *
 * Real `Fastify()` (not `buildApp`), top-level `text/markdown` parser, `PUT /p` and `GET /g`; event listeners are attached in onRequest (the earliest
 * point, before the body is read), and the handler awaits an external gate before replying 200. Four scenarios x keep-alive/non-keep-alive x 10 runs.
 */
import { appendFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

const LOG = process.env.KN_PROBE_LOG;
const out = (line: string) => {
  if (LOG) appendFileSync(LOG, line + "\n", "utf8");
  console.log(line);
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe.skipIf(!process.env.KN_PROBE)("probe: timing of HTTP close events", () => {
  it("P1-P4 x keep-alive/non-keep-alive x 10 runs: event sequences are consistent", async () => {
    const app = Fastify();
    app.addContentTypeParser("text/markdown", { parseAs: "buffer" }, (_r, body, done) => done(null, body));
    const events = new Map<string, string[]>();
    let gateOpen: () => void = () => {};
    let handlerStarted: () => void = () => {};
    const track = (req: FastifyRequest) => {
      const id = String(req.headers["x-probe"]);
      const ev: string[] = [];
      events.set(id, ev);
      req.raw.once("close", () => ev.push("req.close"));
      req.raw.once("aborted", () => ev.push("req.aborted"));
      req.raw.socket.once("close", () => ev.push("socket.close"));
      return ev;
    };
    app.addHook("onRequest", async (req, reply) => {
      const ev = track(req);
      reply.raw.once("close", () => ev.push("reply.close"));
    });
    const handler = async (req: FastifyRequest) => {
      const ev = events.get(String(req.headers["x-probe"]))!;
      ev.push("handler");
      const g = new Promise<void>(r => (gateOpen = r));
      handlerStarted();
      await g;
      ev.push("send");
      return "ok";
    };
    app.put("/p", handler);
    app.get("/g", handler);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;

    type Mode = "keepalive" | "close";
    const run = async (scenario: string, mode: Mode, i: number): Promise<string> => {
      const id = `${scenario}-${mode}-${i}`;
      const agent = new http.Agent({ keepAlive: mode === "keepalive", maxSockets: 1 });
      const started = new Promise<void>(r => (handlerStarted = r));
      const isGet = scenario.startsWith("P4");
      const body = "x".repeat(2048);
      const req = http.request({
        host: "127.0.0.1",
        port,
        method: isGet ? "GET" : "PUT",
        path: isGet ? "/g" : "/p",
        agent,
        headers: isGet
          ? { "x-probe": id }
          : { "x-probe": id, "content-type": "text/markdown", "content-length": String(scenario === "P3" ? body.length * 2 : body.length) },
      });
      req.on("error", () => {});
      const done = new Promise<void>(r => {
        req.on("response", res => {
          res.resume();
          res.on("end", () => r());
          res.on("close", () => r());
        });
        req.on("close", () => r());
      });
      if (!isGet) req.write(body);
      if (scenario !== "P3") req.end();
      if (scenario === "P1" || scenario === "P4-wait") {
        await started;
        await sleep(30);
        gateOpen();
        await done;
      } else if (scenario === "P2" || scenario === "P4-destroy") {
        await started;
        await sleep(30);
        req.destroy();
        await sleep(30);
        gateOpen();
      } else {
        // P3: the body is cut off halfway - the handler is never entered
        await sleep(30);
        req.destroy();
      }
      await sleep(60);
      agent.destroy();
      await sleep(20);
      return (events.get(id) ?? ["(no onRequest)"]).join(" → ");
    };

    const results: Record<string, string[]> = {};
    for (const scenario of ["P1", "P2", "P3", "P4-wait", "P4-destroy"]) {
      for (const mode of ["keepalive", "close"] as const) {
        const seqs: string[] = [];
        for (let i = 0; i < 10; i++) seqs.push(await run(scenario, mode, i));
        results[`${scenario}/${mode}`] = seqs;
      }
    }
    await app.close();
    out(`== node ${process.version} ${process.platform}`);
    for (const [k, seqs] of Object.entries(results)) out(`${k}: ${[...new Set(seqs)].join(" ｜ ")}${new Set(seqs).size > 1 ? `  (不一致：${seqs.length} 次)` : ""}`);
    for (const [k, seqs] of Object.entries(results)) expect(new Set(seqs).size, `${k}: ${seqs.join(" ｜ ")}`).toBe(1);
  }, 120_000);
});

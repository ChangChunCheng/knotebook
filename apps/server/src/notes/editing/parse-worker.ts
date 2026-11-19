import { getHeapStatistics } from "node:v8";
import { parentPort, workerData } from "node:worker_threads";
import { executeDocOp, type DocAsk } from "./doc-jobs.js";
import { createParserEditor, runOpenFenceLine, runParse, type ParserEditor } from "./parse-core.js";
import { EditingRuntime } from "./runtime.js";
import type { WorkerInbound, WorkerOutbound, WorkerData } from "./parse-pool.js";

const port = parentPort;
if (port === null) throw new Error("parse-worker：只能當 worker 執行");
const { baseUrl } = workerData as WorkerData;
const runtime = new EditingRuntime({ baseUrl });
runtime.installGlobals();
let editor: ParserEditor = createParserEditor(baseUrl);
let editorBuiltAt = runtime.rebuilds;
const send = (m: WorkerOutbound) => port.postMessage(m);
const heapMb = () => Math.round(getHeapStatistics().used_heap_size / 1048576);
const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();

/** Only class name and frames, never the message: it may carry content fragments. */
function failed(id: number, err: unknown): WorkerOutbound {
  const frames = err instanceof Error ? (err.stack ?? "").split("\n").slice(err.message.split("\n").length).filter(l => /^\s+at /.test(l)) : [];
  return { type: "failed", id, name: err instanceof Error ? err.name : typeof err, frames };
}

async function runDocJob(m: Extract<WorkerInbound, { kind: "doc" }>): Promise<void> {
  const ask = (q: DocAsk) =>
    new Promise<unknown>((resolve, reject) => {
      pending.set(m.id, { resolve, reject });
      send({ type: "ask", id: m.id, q });
    });
  let out: WorkerOutbound;
  try {
    out = { type: "doc", id: m.id, result: await executeDocOp(runtime, m.op, ask), heapMb: 0 };
  } catch (err) {
    out = failed(m.id, err);
  } finally {
    pending.delete(m.id);
  }
  runtime.settleAfterJob();
  if (out.type === "doc") out.heapMb = heapMb();
  send(out);
}

port.on("message", (m: WorkerInbound) => {
  if (m.kind === "answer") {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (p) {
      if (m.ok) p.resolve(m.value);
      else p.reject(new Error("parse worker: the main thread could not answer"));
    }
    return;
  }
  if (m.kind === "doc") return void runDocJob(m);
  let out: WorkerOutbound;
  try {
    if (m.kind === "fence") out = { type: "fence", id: m.id, line: runOpenFenceLine(m.lines), heapMb: heapMb() };
    else {
      if (editorBuiltAt !== runtime.rebuilds) {
        editor = createParserEditor(baseUrl);
        editorBuiltAt = runtime.rebuilds;
      }
      out = { type: "result", id: m.id, result: runParse(editor, m), heapMb: heapMb() };
    }
  } catch (err) {
    out = failed(m.id, err);
  }
  send(out);
});
send({ type: "ready" });

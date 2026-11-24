/**
 * Bulk transfer: duration and event-loop stalls of the single-note exporter. **Not in CI.**
 * Usage (apps/server): `pnpm exec tsx test/bench/transfer-export.bench.ts > <out.txt>`
 *
 * Matrix: realistic mixed notes of 20/200/1 000/2 000 blocks x RUNS runs; two groups:
 * - yield: default yielding (once after mount and once after the whole export; per-block export every 50 blocks or >= 20 ms since the last;
 *   each yield = two consecutive `setImmediate`, reason in `defaultYield` of `export-note.ts`)
 * - noyield: `yieldFn` replaced by a no-op that only awaits a microtask (~ no yielding)
 * Measures: total `exportNoteForTransfer` time p50/p95; longest event-loop stall (max gap of a 1 ms timer) and `monitorEventLoopDelay` p99; RSS.
 */
import { DEFAULT_KNOWLEDGE_FIELD_VIEW } from "@knotebook/shared";
import { monitorEventLoopDelay, performance as perf } from "node:perf_hooks";
import * as Y from "yjs";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession, forkFrom } from "../../src/notes/editing/session.js";
import { exportNoteForTransfer } from "../../src/transfer/export-note.js";

const RUNS = Number(process.env.RUNS ?? 30);
const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();

type Block = Record<string, unknown>;
const P_ = (t: string): Block => ({ type: "paragraph", content: t });
const B = (t: string): Block => ({ type: "bulletListItem", content: t });
const N = (t: string): Block => ({ type: "numberedListItem", content: t });
const H = (t: string): Block => ({ type: "heading", content: t, props: { level: 2 } });
const CODE = (t: string): Block => ({ type: "codeBlock", props: { language: "js" }, content: t });
const TBL = (rows: unknown[]): Block => ({ type: "table", content: { type: "tableContent", rows } });

/** Realistic mix: a heading every 10 blocks, the rest alternating paragraph/bullet/numbered, occasionally code and table. */
function mixed(n: number): Block[] {
  return Array.from({ length: n }, (_, i) => {
    if (i % 10 === 0) return H(`Section ${i / 10}`);
    if (i % 37 === 5) return CODE(`const x${i} = ${i};\nconsole.log(x${i});`);
    if (i % 53 === 7) return TBL([{ cells: ["k", "v"] }, { cells: [`r${i}`, "value"] }]);
    switch (i % 4) {
      case 0:
        return P_(`Paragraph ${i} with some words to make it realistic, 中文也有一些字。`);
      case 1:
        return B(`bullet item ${i} text`);
      case 2:
        return N(`numbered item ${i}`);
      default:
        return P_(`Another paragraph ${i}: lorem ipsum dolor sit amet.`);
    }
  });
}

async function docFromBlocks(blocks: Block[]): Promise<Uint8Array> {
  const doc = new Y.Doc();
  const s = await EditorSession.open(rt, doc);
  try {
    s.editor.replaceBlocks(s.editor.document, blocks as never);
  } finally {
    s.close();
  }
  return Y.encodeStateAsUpdate(doc);
}

const pct = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
};
const fmt = (a: number[]) => `p50 ${pct(a, 50).toFixed(0)} / p95 ${pct(a, 95).toFixed(0)} / max ${Math.max(...a).toFixed(0)} ms`;

async function withLoopMonitor<T>(fn: () => Promise<T>) {
  const h = monitorEventLoopDelay({ resolution: 1 });
  h.enable();
  let maxGap = 0;
  let last = perf.now();
  let running = true;
  const tick = () => {
    const n = perf.now();
    maxGap = Math.max(maxGap, n - last);
    last = n;
    if (running) setTimeout(tick, 1);
  };
  setTimeout(tick, 1);
  const t0 = perf.now();
  const r = await fn();
  const ms = perf.now() - t0;
  running = false;
  await new Promise(r2 => setTimeout(r2, 3));
  h.disable();
  return { r, ms, maxGap, p99: h.percentile(99) / 1e6 };
}

const lines: string[] = [];
const out = (s: string) => {
  lines.push(s);
  process.stdout.write(s + "\n");
};
out(`# transfer export bench  node=${process.version}  RUNS=${RUNS}`);
for (const n of [20, 200, 1000, 2000]) {
  const bytes = await docFromBlocks(mixed(n));
  for (const mode of ["yield", "noyield"] as const) {
    const tot: number[] = [];
    const gaps: number[] = [];
    const p99s: number[] = [];
    let yields = 0;
    let aligned = true;
    for (let k = 0; k < RUNS; k++) {
      const doc = forkFrom(bytes).fork;
      const m = await withLoopMonitor(() =>
        exportNoteForTransfer(rt, doc, new Map(), { fields: DEFAULT_KNOWLEDGE_FIELD_VIEW, ...(mode === "noyield" ? { yieldFn: async () => {} } : {}) }),
      );
      tot.push(m.ms);
      gaps.push(m.maxGap);
      p99s.push(m.p99);
      yields = m.r.stats.yields;
      aligned &&= m.r.segments !== null;
    }
    const rss = (process.memoryUsage().rss / 1024 / 1024).toFixed(0);
    out(`## ${n} 顆 ${mode}：總 ${fmt(tot)}｜最長停頓 ${fmt(gaps)}｜ELD p99 ${fmt(p99s)}｜yields ${yields}｜aligned ${aligned}｜RSS ${rss} MiB`);
  }
}

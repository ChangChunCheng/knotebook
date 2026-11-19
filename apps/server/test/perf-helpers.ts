/**
 * Scale-based perf measurement: absolute milliseconds are not compared (busy machine or slow CI would go red); instead the ratio when size grows and the idle noise of the same machine.
 * - expectLinear: measures N/8 and N; asserts t(N) / t(N/8) < 24 (linear is about 8-16, GC and cache make the larger a bit slower; quadratic is about 64, eight times
 *   apart: a quadratic term taking half of the time at N already exceeds 24; more discriminating than N/4 vs N ("4 vs 16"), and does not false-fail when the full suite runs in parallel on a busy machine).
 *   One warm-up run of N/8 (JIT), then three interleaved rounds (N/8, N, N/8, N, N/8, N), taking the minimum on each side (an occasional GC pause or parallel test does not land on the same side every round).
 *   If t(N) is below floorMs (at least 250 ms) it passes outright: these shapes are seconds to tens of seconds when quadratic; a loose absolute cap maxMs catches blow-ups.
 * - yieldToLoop: yield the event loop before every measurement. Awaiting a synchronous value yields only microtasks; the vitest worker's RPC
 *   (onTaskUpdate, 60 s timeout) is a macrotask: a run of measurements that never yields can hold the worker synchronously for over 60 s on a 2-vCPU CI and fail the whole suite with
 *   `Timeout calling "onTaskUpdate"` (CI of PR #400). Keep each synchronous stretch under about 5 s (on slow machines).
 * - loopStall / idleStall / stallLimit: main-thread stalls. Threshold = max(floor, 3 x the stall measured while idle over the same period): idle
 *   stalls are this machine's current GC and scheduling noise; when work runs back on the main thread the stall is the whole conversion (seconds), which still far exceeds it.
 */
import { monitorEventLoopDelay } from "node:perf_hooks";
import { expect } from "vitest";

export const yieldToLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

export async function timeIt(f: () => unknown): Promise<number> {
  await yieldToLoop();
  const t = performance.now();
  await f();
  return performance.now() - t;
}

export interface LinearOpts {
  /** Below this `t(N)` the ratio is not checked (default and minimum 250 ms). */
  floorMs?: number;
  /** Absolute cap on `t(N)` (default 30 s; on a 2x over-provisioned machine even a linear shape can be 4-5x slower); a quadratic shape still exceeds it or trips the ratio first. */
  maxMs?: number;
}
/** `run(n)` returns the milliseconds it measured itself (e.g. via timeIt); N must be divisible by 8. */
export async function expectLinear(name: string, run: (n: number) => Promise<number> | number, N: number, opts: LinearOpts = {}): Promise<[number, number]> {
  if (N % 8 !== 0) throw new Error(`expectLinear: N=${N} 要能被 8 整除`);
  const small = N / 8;
  const floorMs = Math.max(250, opts.floorMs ?? 250);
  const maxMs = opts.maxMs ?? 30_000;
  await yieldToLoop();
  await run(small); // warm-up
  let t1 = Infinity;
  let t2 = Infinity;
  for (let round = 0; round < 3; round++) {
    // Yield between measurements: the run must not hold the vitest worker synchronously (see yieldToLoop).
    await yieldToLoop();
    t1 = Math.min(t1, await run(small));
    await yieldToLoop();
    t2 = Math.min(t2, await run(N));
    if (t2 > maxMs) break; // a quadratic shape needs no more rounds
  }
  console.log(`[perf] ${name}: N/8=${small} ${Math.round(t1)} ms, N=${N} ${Math.round(t2)} ms, ratio ${(t2 / Math.max(t1, 0.001)).toFixed(2)}`);
  expect(t2, `${name}: t(N) 的絕對上限`).toBeLessThan(maxMs);
  if (t2 >= floorMs) expect(t2 / t1, `${name}: t(N)/t(N/8)（線性約 8–16、平方約 64）`).toBeLessThan(24);
  return [t1, t2];
}

export function loopStall(): { stop(): number } {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  let last = performance.now();
  let maxGap = 0;
  const iv = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 10);
  return {
    /** `stop()` returns the largest stall in ms. */
    stop(): number {
      clearInterval(iv);
      h.disable();
      return Math.round(Math.max(maxGap, h.max / 1e6));
    },
  };
}

export async function idleStall(ms = 500): Promise<number> {
  const m = loopStall();
  await new Promise(r => setTimeout(r, ms));
  return m.stop();
}

export const stallLimit = (baseline: number, floorMs: number): number => Math.max(floorMs, 3 * baseline);

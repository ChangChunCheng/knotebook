import { defaultParseWorkers, memoryParseWorkers } from "@knotebook/shared";
import { QUEUE_WAIT_SLACK_MS, QUEUE_WAIT_TIMEOUT_FACTOR } from "../notes/editing/parse-settings.js";
import type { MachineInfo } from "./types.js";

/** `memory` only when strictly smaller than the CPU count (same rule as parse-settings). */
export function autoParseWorkers(machine: MachineInfo, workerMemoryMb: number): { value: number; source: "cpu" | "memory" } {
  const byCpu = defaultParseWorkers(machine.cpus);
  const byMemory = memoryParseWorkers(machine.memoryBytes, workerMemoryMb);
  return byMemory < byCpu ? { value: byMemory, source: "memory" } : { value: byCpu, source: "cpu" };
}

/** Capped at 2^31-1 (setTimeout's limit), not bound by the admin page's range. */
export function autoQueueWaitMs(timeoutMs: number): number {
  return Math.min(2 ** 31 - 1, QUEUE_WAIT_TIMEOUT_FACTOR * timeoutMs + QUEUE_WAIT_SLACK_MS);
}

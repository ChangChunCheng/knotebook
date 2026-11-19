import type { SiteLimitItemDto, SiteLimitKey, SiteLimitSource } from "@knotebook/shared";
import type { CpuSource, MemorySource, ParseLimits } from "../notes/editing/parse-settings.js";
import type { SiteLimits } from "./store.js";

// Field names stay identical to the older boot log of the same name, for log consumers.
export interface ParseSettingsLogFields extends ParseLimits {
  workersSource: "env" | "admin" | "cpu" | "memory";
  from: Record<keyof ParseLimits, SiteLimitSource>;
  cpus: number;
  cpuSource: CpuSource;
  memoryMb: number;
  memorySource: MemorySource;
}

export function parseSettingsLogFields(siteLimits: Pick<SiteLimits, "view" | "parseLimits">): ParseSettingsLogFields {
  const { workers, workerMemoryMb, timeoutMs, queueWaitMs } = siteLimits.parseLimits();
  const { items, machine } = siteLimits.view();
  const item = (key: SiteLimitKey): SiteLimitItemDto => {
    const found = items.find(i => i.key === key);
    if (found === undefined) throw new Error(`parseSettingsLogFields: view() has no item ${key}`);
    return found;
  };
  const w = item("parseWorkers");
  const workersSource: ParseSettingsLogFields["workersSource"] = w.source === "env" || w.source === "admin" ? w.source : (w.autoSource ?? "cpu");
  return {
    workers,
    workersSource,
    workerMemoryMb,
    timeoutMs,
    queueWaitMs,
    from: {
      workers: w.source,
      workerMemoryMb: item("parseWorkerMemoryMb").source,
      timeoutMs: item("parseTimeoutMs").source,
      queueWaitMs: item("parseQueueWaitMs").source,
    },
    cpus: machine.cpus,
    cpuSource: machine.cpuSource,
    memoryMb: Math.round(machine.memoryBytes / 2 ** 20),
    memorySource: machine.memorySource,
  };
}

import { SITE_LIMIT_KEYS, SITE_LIMITS, siteLimitDef, siteLimitStep, type SiteLimitKey, type SiteLimitSource } from "@knotebook/shared";
import { autoParseWorkers, autoQueueWaitMs } from "./auto.js";
import type { LimitEnv, MachineInfo } from "./types.js";

export function checkStorable(key: SiteLimitKey, value: number): "ok" | "range" | "step" {
  const { min, max } = siteLimitDef(key);
  if (!Number.isInteger(value) || value < min || value > max) return "range";
  return value % siteLimitStep(key) === 0 ? "ok" : "step";
}

export interface Snapshot {
  values: Record<SiteLimitKey, number>;
  source: Record<SiteLimitKey, SiteLimitSource>;
  autoValue: { parseWorkers: number; parseQueueWaitMs: number };
  autoSource: "cpu" | "memory";
  ignored: Array<{ key: string; value: number }>;
}

const KEY_SET: ReadonlySet<string> = new Set(SITE_LIMIT_KEYS);

export function resolveSnapshot(rows: ReadonlyMap<string, number>, limitEnv: LimitEnv, machine: MachineInfo): Snapshot {
  const values = {} as Record<SiteLimitKey, number>;
  const source = {} as Record<SiteLimitKey, SiteLimitSource>;
  const ignored: Snapshot["ignored"] = [];
  for (const [key, value] of rows) {
    if (!KEY_SET.has(key) || checkStorable(key as SiteLimitKey, value) !== "ok") ignored.push({ key, value });
  }
  const bad = new Set(ignored.map(i => i.key));

  const pending: SiteLimitKey[] = [];
  for (const key of SITE_LIMIT_KEYS) {
    const envValue = limitEnv[key];
    const row = rows.get(key);
    if (envValue !== undefined) {
      values[key] = envValue;
      source[key] = "env";
    } else if (row !== undefined && !bad.has(key)) {
      values[key] = row;
      source[key] = "admin";
    } else {
      const def = SITE_LIMITS[key].default;
      if (def === "auto") {
        pending.push(key);
        source[key] = "auto";
      } else {
        values[key] = def;
        source[key] = "default";
      }
    }
  }

  const workers = autoParseWorkers(machine, values.parseWorkerMemoryMb);
  const queueWait = autoQueueWaitMs(values.parseTimeoutMs);
  for (const key of pending) values[key] = key === "parseWorkers" ? workers.value : queueWait;

  return {
    values,
    source,
    autoValue: { parseWorkers: workers.value, parseQueueWaitMs: queueWait },
    autoSource: workers.source,
    ignored,
  };
}

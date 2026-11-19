import type { SiteLimitKey } from "@knotebook/shared";
import type { CpuSource, MemorySource } from "../notes/editing/parse-settings.js";

/** The range follows config.ts's validation, not the admin page's. */
export type LimitEnv = Partial<Record<SiteLimitKey, number>>;

export interface MachineInfo {
  cpus: number;
  cpuSource: CpuSource;
  memoryBytes: number;
  memorySource: MemorySource;
}

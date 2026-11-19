import { readFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { AUTO_PARSE_WORKERS_MAX, PARSE_MEMORY_SHARE, SITE_LIMITS, defaultParseWorkers, memoryParseWorkers, siteLimitDef, type SiteLimitKey } from "@knotebook/shared";
import type { LimitEnv, MachineInfo } from "../../site-limits/types.js";

export { AUTO_PARSE_WORKERS_MAX, PARSE_MEMORY_SHARE, defaultParseWorkers, memoryParseWorkers };

export interface ParseLimits {
  workers: number;
  workerMemoryMb: number;
  timeoutMs: number;
  queueWaitMs: number;
}

/** 256 KiB ordinary notes parse in 256 MiB; dense one-paragraph formats need most: `<br>`-separated 640, interleaved `**bold** _italic_` 768. 1024 leaves ~1.3× for the latter. */
export const DEFAULT_PARSE_WORKER_MEMORY_MB = SITE_LIMITS.parseWorkerMemoryMb.default;
/** The slowest case, a 256 KiB `<br>`-dense paragraph, takes ~5–6 s; 10 s keeps pre-v0.15 content writable (~1.7×) and bounds how long others wait behind one user. */
export const DEFAULT_PARSE_TIMEOUT_MS = SITE_LIMITS.parseTimeoutMs.default;
/** Default = `QUEUE_WAIT_TIMEOUT_FACTOR` × time limit + `QUEUE_WAIT_SLACK_MS` (follows `PARSE_TIMEOUT_MS` unless `PARSE_QUEUE_WAIT_MS` is set; 45 s by default). A job can run up to 4× the time limit (bulk write-back planning: 3× file budget + 1× whole-note comparison; read/apply conversions are 3×), and someone queued behind it must still get a turn rather than a 503. With one worker, only two or more full-length jobs ahead make a waiter time out. */
export const QUEUE_WAIT_TIMEOUT_FACTOR = 4;
export const QUEUE_WAIT_SLACK_MS = 5_000;
export const DEFAULT_PARSE_QUEUE_WAIT_MS = QUEUE_WAIT_TIMEOUT_FACTOR * DEFAULT_PARSE_TIMEOUT_MS + QUEUE_WAIT_SLACK_MS;

/** The timeout upper bound is the Node timer limit 2^31−1 ms. */
export const PARSE_LIMIT_RANGES: Record<keyof ParseLimits, { min: number; max: number }> = {
  workers: { min: 1, max: 32 },
  workerMemoryMb: { min: 128, max: 16_384 },
  timeoutMs: { min: 100, max: 2_147_483_647 },
  queueWaitMs: { min: 100, max: 2_147_483_647 },
};

export type CpuSource = "cgroup-v2" | "cgroup-v1" | "os";
export type MemorySource = CpuSource;
export interface CpuProbe {
  readFile?: (path: string) => string | null;
  availableParallelism?: () => number;
  totalmem?: () => number;
}

/** A cgroup v1 reports ~2^63 when unlimited. */
const CGROUP_V1_UNLIMITED = 2 ** 60;

const readOrNull = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** `availableParallelism()` is unreliable under cgroup v1 (Node 22.23 in `docker run --cpus=2` returned the host's 24), so take the smaller of it and the cgroup quota (rounded up); without a quota (`max`, -1) or off Linux, `availableParallelism()` alone. */
export function detectCpuCount(probe: CpuProbe = {}): { cpus: number; source: CpuSource } {
  const read = probe.readFile ?? readOrNull;
  const ap = Math.max(1, (probe.availableParallelism ?? availableParallelism)());
  const quota = (q: number, p: number): number | null => (Number.isFinite(q) && Number.isFinite(p) && q > 0 && p > 0 ? Math.max(1, Math.ceil(q / p)) : null);
  const v2 = read("/sys/fs/cgroup/cpu.max");
  if (v2 !== null) {
    const [q, p] = v2.trim().split(/\s+/);
    const n = q === "max" ? null : quota(Number(q), Number(p));
    return n === null ? { cpus: ap, source: "os" } : { cpus: Math.min(ap, n), source: "cgroup-v2" };
  }
  for (const dir of ["/sys/fs/cgroup/cpu", "/sys/fs/cgroup/cpu,cpuacct"]) {
    const q = read(`${dir}/cpu.cfs_quota_us`);
    const p = read(`${dir}/cpu.cfs_period_us`);
    if (q === null || p === null) continue;
    const n = quota(Number(q.trim()), Number(p.trim()));
    return n === null ? { cpus: ap, source: "os" } : { cpus: Math.min(ap, n), source: "cgroup-v1" };
  }
  return { cpus: ap, source: "os" };
}

/** In a container `os.totalmem()` returns the host's memory, so cgroup limits come first. */
export function detectMemoryLimit(probe: CpuProbe = {}): { bytes: number; source: MemorySource } {
  const read = probe.readFile ?? readOrNull;
  const asBytes = (raw: string | null): number | null => {
    if (raw === null) return null;
    const t = raw.trim();
    if (!/^\d+$/.test(t)) return null;
    const n = Number(t);
    return n > 0 && n < CGROUP_V1_UNLIMITED ? n : null;
  };
  const v2 = asBytes(read("/sys/fs/cgroup/memory.max"));
  if (v2 !== null) return { bytes: v2, source: "cgroup-v2" };
  const v1 = asBytes(read("/sys/fs/cgroup/memory/memory.limit_in_bytes"));
  if (v1 !== null) return { bytes: v1, source: "cgroup-v1" };
  return { bytes: (probe.totalmem ?? totalmem)(), source: "os" };
}

const ENV_LIMIT_KEYS = { workers: "parseWorkers", workerMemoryMb: "parseWorkerMemoryMb", timeoutMs: "parseTimeoutMs", queueWaitMs: "parseQueueWaitMs" } as const satisfies Record<keyof ParseLimits, SiteLimitKey>;
type ParseLimitKey = (typeof ENV_LIMIT_KEYS)[keyof ParseLimits];

export const PARSE_LIMIT_KEYS: readonly ParseLimitKey[] = Object.freeze(Object.values(ENV_LIMIT_KEYS));

const ENV_NAMES = Object.fromEntries(
  (Object.keys(ENV_LIMIT_KEYS) as Array<keyof ParseLimits>).map(key => {
    const env = siteLimitDef(ENV_LIMIT_KEYS[key]).env;
    if (env === undefined) throw new Error(`parse-settings: registry entry ${ENV_LIMIT_KEYS[key]} has no env`);
    return [key, env];
  })
) as Record<keyof ParseLimits, string>;

export function parseEnvLimits(env: NodeJS.ProcessEnv): Pick<LimitEnv, ParseLimitKey> {
  const out: Pick<LimitEnv, ParseLimitKey> = {};
  for (const key of Object.keys(ENV_NAMES) as Array<keyof ParseLimits>) {
    const raw = env[ENV_NAMES[key]];
    if (raw === undefined || raw === "") continue;
    const { min, max } = PARSE_LIMIT_RANGES[key];
    const value = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`設定錯誤：${ENV_NAMES[key]} 必須是 ${min} 到 ${max} 的整數：${raw}`);
    out[ENV_LIMIT_KEYS[key]] = value;
  }
  return out;
}

export function detectMachine(probe?: CpuProbe): MachineInfo {
  const { cpus, source } = detectCpuCount(probe);
  const memory = detectMemoryLimit(probe);
  return { cpus, cpuSource: source, memoryBytes: memory.bytes, memorySource: memory.source };
}

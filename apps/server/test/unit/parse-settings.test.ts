/** #398: effective values (env > admin page > default/auto) are derived in `site-limits-resolve.test.ts`; here only one wiring test from `loadConfig` to `SiteLimits.parseLimits()`. */
import { SITE_LIMITS, siteLimitDef } from "@knotebook/shared";
import { PARSE_FILE_BUDGET_FACTOR } from "../../src/notes/editing/parse-core.js";
import { DOC_TIMEOUT_FACTOR } from "../../src/notes/editing/doc-jobs.js";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { SiteLimits } from "../../src/site-limits/store.js";
import {
  AUTO_PARSE_WORKERS_MAX,
  DEFAULT_PARSE_QUEUE_WAIT_MS,
  DEFAULT_PARSE_TIMEOUT_MS,
  DEFAULT_PARSE_WORKER_MEMORY_MB,
  PARSE_LIMIT_RANGES,
  defaultParseWorkers,
  detectCpuCount,
  detectMachine,
  detectMemoryLimit,
  memoryParseWorkers,
  parseEnvLimits,
  type CpuProbe,
} from "../../src/notes/editing/parse-settings.js";

const GiB = 1024 ** 3;
const files = (m: Record<string, string>, ap = 24, mem = 64 * GiB): CpuProbe => ({ readFile: p => m[p] ?? null, availableParallelism: () => ap, totalmem: () => mem });
const valid = { DATABASE_URL: "postgres://u:p@localhost:5432/db", APP_SECRET: "a".repeat(64), PUBLIC_URL: "https://notes.example.com" };

describe("detectCpuCount", () => {
  it("cgroup v2 `cpu.max` with a quota -> quota rounded up, capped by availableParallelism", () => {
    expect(detectCpuCount(files({ "/sys/fs/cgroup/cpu.max": "200000 100000\n" }))).toEqual({ cpus: 2, source: "cgroup-v2" });
    expect(detectCpuCount(files({ "/sys/fs/cgroup/cpu.max": "150000 100000\n" }))).toEqual({ cpus: 2, source: "cgroup-v2" });
    expect(detectCpuCount(files({ "/sys/fs/cgroup/cpu.max": "50000 100000\n" }))).toEqual({ cpus: 1, source: "cgroup-v2" });
    expect(detectCpuCount(files({ "/sys/fs/cgroup/cpu.max": "800000 100000\n" }, 4))).toEqual({ cpus: 4, source: "cgroup-v2" });
  });
  it("cgroup v2 without a quota (max) -> availableParallelism", () => {
    expect(detectCpuCount(files({ "/sys/fs/cgroup/cpu.max": "max 100000\n" }, 6))).toEqual({ cpus: 6, source: "os" });
  });
  it("cgroup v1 (`cpu/` or `cpu,cpuacct/`): quota / period; -1 means no quota", () => {
    expect(detectCpuCount(files({ "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "200000\n", "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n" }))).toEqual({ cpus: 2, source: "cgroup-v1" });
    expect(detectCpuCount(files({ "/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us": "300000", "/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us": "100000" }))).toEqual({ cpus: 3, source: "cgroup-v1" });
    expect(detectCpuCount(files({ "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "-1\n", "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n" }, 8))).toEqual({ cpus: 8, source: "os" });
  });
  it("unreadable cgroup (non-Linux) -> availableParallelism; corrupt content falls back to it too", () => {
    expect(detectCpuCount(files({}, 12))).toEqual({ cpus: 12, source: "os" });
    expect(detectCpuCount(files({ "/sys/fs/cgroup/cpu.max": "garbage" }, 3))).toEqual({ cpus: 3, source: "os" });
  });
});

describe("defaultParseWorkers", () => {
  it(`max(1, min(${AUTO_PARSE_WORKERS_MAX}, CPU - 1))`, () => {
    expect([1, 2, 3, 4, 5, 8, 64].map(defaultParseWorkers)).toEqual([1, 1, 2, 3, 4, 4, 4]);
  });
});

describe("detectMemoryLimit", () => {
  it("cgroup v2 `memory.max` with a value -> that value; `max` -> look further up", () => {
    expect(detectMemoryLimit(files({ "/sys/fs/cgroup/memory.max": "4294967296" }))).toEqual({ bytes: 4 * GiB, source: "cgroup-v2" });
    expect(detectMemoryLimit(files({ "/sys/fs/cgroup/memory.max": "max" }, 24, 16 * GiB))).toEqual({ bytes: 16 * GiB, source: "os" });
  });
  it("cgroup v1 `memory.limit_in_bytes`; the huge no-limit value (~2^63) does not count", () => {
    expect(detectMemoryLimit(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "2147483648" }))).toEqual({ bytes: 2 * GiB, source: "cgroup-v1" });
    expect(detectMemoryLimit(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712" }, 24, 8 * GiB))).toEqual({ bytes: 8 * GiB, source: "os" });
    expect(detectMemoryLimit(files({ "/sys/fs/cgroup/memory.max": "max", "/sys/fs/cgroup/memory/memory.limit_in_bytes": "1073741824" }))).toEqual({ bytes: GiB, source: "cgroup-v1" });
  });
  it("unreadable or corrupt cgroup -> os.totalmem()", () => {
    expect(detectMemoryLimit(files({}, 24, 32 * GiB))).toEqual({ bytes: 32 * GiB, source: "os" });
    expect(detectMemoryLimit(files({ "/sys/fs/cgroup/memory.max": "garbage" }, 24, 3 * GiB))).toEqual({ bytes: 3 * GiB, source: "os" });
  });
});

describe("memoryParseWorkers", () => {
  it("floor(memory x 0.5 / per-worker cap), at least 1", () => {
    expect(memoryParseWorkers(2 * GiB, 1024)).toBe(1);
    expect(memoryParseWorkers(4 * GiB, 1024)).toBe(2);
    expect(memoryParseWorkers(8 * GiB, 1024)).toBe(4);
    expect(memoryParseWorkers(3 * GiB, 1024)).toBe(1);
    expect(memoryParseWorkers(1 * GiB, 1024)).toBe(1);
    expect(memoryParseWorkers(16 * GiB, 2048)).toBe(4);
  });
});

describe("parseEnvLimits / detectMachine (#397)", () => {
  it("keeps only what is set; empty string means unset; surrounding whitespace is tolerated", () => {
    expect(parseEnvLimits({})).toEqual({});
    expect(parseEnvLimits({ PARSE_WORKERS: "", PARSE_TIMEOUT_MS: "20000" })).toEqual({ parseTimeoutMs: 20000 });
    expect(parseEnvLimits({ PARSE_WORKER_MEMORY_MB: "2048", PARSE_QUEUE_WAIT_MS: "7000", PARSE_WORKERS: "3" })).toEqual({ parseWorkers: 3, parseWorkerMemoryMb: 2048, parseQueueWaitMs: 7000 });
    expect(parseEnvLimits({ PARSE_WORKERS: "3", PARSE_WORKER_MEMORY_MB: " 768 ", PARSE_TIMEOUT_MS: "4000", PARSE_QUEUE_WAIT_MS: "" })).toEqual({ parseWorkers: 3, parseWorkerMemoryMb: 768, parseTimeoutMs: 4000 });
  });
  it("env names come from the registry: every PARSE_* maps to the entry with the same env name", () => {
    for (const [key, value] of [["parseWorkers", 3], ["parseWorkerMemoryMb", 768], ["parseTimeoutMs", 4000], ["parseQueueWaitMs", 7000]] as const) {
      expect(parseEnvLimits({ [siteLimitDef(key).env!]: String(value) }), key).toEqual({ [key]: value });
    }
  });
  it("range ends are accepted, one step beyond throws (message carries variable name, range and original value)", () => {
    const names = { workers: ["PARSE_WORKERS", "parseWorkers"], workerMemoryMb: ["PARSE_WORKER_MEMORY_MB", "parseWorkerMemoryMb"], timeoutMs: ["PARSE_TIMEOUT_MS", "parseTimeoutMs"], queueWaitMs: ["PARSE_QUEUE_WAIT_MS", "parseQueueWaitMs"] } as const;
    for (const [key, [name, siteKey]] of Object.entries(names) as Array<[keyof typeof names, (typeof names)[keyof typeof names]]>) {
      const { min, max } = PARSE_LIMIT_RANGES[key];
      expect(parseEnvLimits({ [name]: String(min) })[siteKey]).toBe(min);
      expect(parseEnvLimits({ [name]: String(max) })[siteKey]).toBe(max);
      for (const bad of [String(min - 1), String(max + 1), "1.5", "abc", "-3", "1e3", "0x10"]) {
        expect(() => parseEnvLimits({ [name]: bad }), `${name}=${bad}`).toThrow(`設定錯誤：${name} 必須是 ${min} 到 ${max} 的整數：${bad}`);
      }
    }
  });
  it("detectMachine reuses the cpu/memory detection", () => {
    expect(detectMachine(files({ "/sys/fs/cgroup/cpu.max": "200000 100000", "/sys/fs/cgroup/memory.max": String(2 * GiB) }))).toEqual({ cpus: 2, cpuSource: "cgroup-v2", memoryBytes: 2 * GiB, memorySource: "cgroup-v2" });
    expect(detectMachine(files({}, 8, 16 * GiB))).toEqual({ cpus: 8, cpuSource: "os", memoryBytes: 16 * GiB, memorySource: "os" });
  });
  it("loadConfig exposes limitEnv and machine (including injected detection); SiteLimits derives effective values from them; an illegal value makes loadConfig throw (fail fast at boot)", () => {
    const c = loadConfig({ ...valid, PARSE_TIMEOUT_MS: "3000" }, files({}, 5));
    expect(c.limitEnv).toEqual({ parseTimeoutMs: 3000 });
    expect(c.machine).toEqual({ cpus: 5, cpuSource: "os", memoryBytes: 64 * GiB, memorySource: "os" });
    // an env timeout below the admin-page range is used as is; queue wait follows it automatically (4 x 3000 + 5000); worker count follows CPU (5 - 1)
    expect(SiteLimits.defaults({ limitEnv: c.limitEnv, machine: c.machine }).parseLimits()).toEqual({ workers: 4, workerMemoryMb: DEFAULT_PARSE_WORKER_MEMORY_MB, timeoutMs: 3000, queueWaitMs: 17_000 });
    // 2 GiB: memory only fits 1 worker of 1024 MiB
    const small = loadConfig(valid, files({}, 5, 2 * GiB));
    expect(SiteLimits.defaults({ limitEnv: small.limitEnv, machine: small.machine }).parseLimits().workers).toBe(1);
    expect(() => loadConfig({ ...valid, PARSE_WORKERS: "0" })).toThrow(/設定錯誤：PARSE_WORKERS/);
  });
});

describe("queue wait default", () => {
  it("without PARSE_QUEUE_WAIT_MS: 4 x PARSE_TIMEOUT_MS + 5 s (default 45 s), not shorter than the longest single job (batch write-back plans 3x budget + 1x, transfer 3x)", () => {
    expect(DEFAULT_PARSE_QUEUE_WAIT_MS).toBe(45_000);
    expect(DEFAULT_PARSE_QUEUE_WAIT_MS).toBeGreaterThan((PARSE_FILE_BUDGET_FACTOR + 1) * DEFAULT_PARSE_TIMEOUT_MS);
    expect(DEFAULT_PARSE_QUEUE_WAIT_MS).toBeGreaterThan(DOC_TIMEOUT_FACTOR * DEFAULT_PARSE_TIMEOUT_MS);
    expect(DEFAULT_PARSE_TIMEOUT_MS).toBe(SITE_LIMITS.parseTimeoutMs.default);
    const machine = detectMachine(files({}, 8));
    expect(SiteLimits.defaults({ limitEnv: { parseTimeoutMs: 30_000 }, machine }).parseLimits().queueWaitMs).toBe(125_000);
    expect(SiteLimits.defaults({ limitEnv: { parseTimeoutMs: 30_000, parseQueueWaitMs: 1000 }, machine }).parseLimits().queueWaitMs).toBe(1000);
  });
});

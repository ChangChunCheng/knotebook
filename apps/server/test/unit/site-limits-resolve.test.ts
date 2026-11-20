import { SITE_LIMIT_KEYS, defaultParseWorkers, memoryParseWorkers } from "@knotebook/shared";
import { describe, expect, it } from "vitest";
import { autoParseWorkers, autoQueueWaitMs } from "../../src/site-limits/auto.js";
import { checkStorable, resolveSnapshot } from "../../src/site-limits/resolve.js";
import type { MachineInfo } from "../../src/site-limits/types.js";

const machine: MachineInfo = { cpus: 8, cpuSource: "os", memoryBytes: 16 * 2 ** 30, memorySource: "os" };
const GIB2: MachineInfo = { ...machine, memoryBytes: 2 * 2 ** 30 };

describe("resolveSnapshot precedence", () => {
  it("env > admin > default", () => {
    const a = resolveSnapshot(new Map([["rateEdit", 10]]), {}, machine);
    expect(a.values.rateEdit).toBe(10);
    expect(a.source.rateEdit).toBe("admin");
    expect(a.source.rateSearch).toBe("default");
    expect(a.values.rateSearch).toBe(60);
    const b = resolveSnapshot(new Map([["noteMaxBytes", 1048576]]), { noteMaxBytes: 2097152 }, machine);
    expect(b.values.noteMaxBytes).toBe(2097152);
    expect(b.source.noteMaxBytes).toBe("env");
  });

  it("env outside the admin page range or not aligned to the step is used as is", () => {
    for (const v of [104857600, 5242881, 3145729]) {
      const s = resolveSnapshot(new Map(), { noteMaxBytes: v }, machine);
      expect(s.values.noteMaxBytes).toBe(v);
      expect(s.source.noteMaxBytes).toBe("env");
      expect(s.ignored).toEqual([]);
    }
  });

  it("rows that are out of range, not aligned, or have an unknown key are ignored", () => {
    const s = resolveSnapshot(new Map([["noteMaxBytes", 6291456], ["parseTimeoutMs", 4500], ["bogusKey", 1]]), {}, machine);
    expect(s.values.noteMaxBytes).toBe(5242880);
    expect(s.source.noteMaxBytes).toBe("default");
    expect(s.values.parseTimeoutMs).toBe(10000);
    expect(s.source.parseTimeoutMs).toBe("default");
    expect(s.values.parseQueueWaitMs).toBe(45000);
    expect(s.source.parseQueueWaitMs).toBe("auto");
    expect(s.ignored).toHaveLength(3);
    expect(s.ignored).toEqual(expect.arrayContaining([
      { key: "noteMaxBytes", value: 6291456 }, { key: "parseTimeoutMs", value: 4500 }, { key: "bogusKey", value: 1 },
    ]));
  });
});

describe("resolveSnapshot auto items", () => {
  it("parseWorkers auto follows the memory cap", () => {
    expect(memoryParseWorkers(GIB2.memoryBytes, 512)).toBe(2);
    expect(defaultParseWorkers(8)).toBe(4);
    const a = resolveSnapshot(new Map([["parseWorkerMemoryMb", 512]]), {}, GIB2);
    expect(a.values.parseWorkers).toBe(2);
    expect(a.source.parseWorkers).toBe("auto");
    expect(a.autoSource).toBe("memory");
    expect(a.autoValue.parseWorkers).toBe(2);
    const b = resolveSnapshot(new Map(), {}, GIB2);
    expect(b.values.parseWorkers).toBe(1);
    expect(b.autoSource).toBe("memory");
    const c = resolveSnapshot(new Map(), { parseWorkerMemoryMb: 128 }, GIB2);
    expect(c.values.parseWorkers).toBe(4);
    expect(c.autoSource).toBe("cpu");
  });

  it("with an env or admin value parseWorkers is not auto, but autoValue is still computed", () => {
    const a = resolveSnapshot(new Map([["parseWorkers", 2]]), {}, machine);
    expect(a.values.parseWorkers).toBe(2);
    expect(a.source.parseWorkers).toBe("admin");
    expect(a.autoValue.parseWorkers).toBe(4);
    const b = resolveSnapshot(new Map([["parseWorkers", 2]]), { parseWorkers: 3 }, machine);
    expect(b.values.parseWorkers).toBe(3);
    expect(b.source.parseWorkers).toBe("env");
  });

  it("parseQueueWaitMs auto follows the timeout", () => {
    const a = resolveSnapshot(new Map([["parseTimeoutMs", 5000]]), {}, machine);
    expect(a.values.parseQueueWaitMs).toBe(25000);
    expect(a.source.parseQueueWaitMs).toBe("auto");
    expect(a.autoValue.parseQueueWaitMs).toBe(25000);
    const b = resolveSnapshot(new Map(), { parseTimeoutMs: 60000 }, machine);
    expect(b.values.parseQueueWaitMs).toBe(245000);
    const c = resolveSnapshot(new Map([["parseQueueWaitMs", 6000]]), {}, machine);
    expect(c.values.parseQueueWaitMs).toBe(6000);
    expect(c.source.parseQueueWaitMs).toBe("admin");
    expect(c.autoValue.parseQueueWaitMs).toBe(45000);
  });

  it("an ignored parseQueueWaitMs row falls back to auto", () => {
    const s = resolveSnapshot(new Map([["parseQueueWaitMs", 4500]]), {}, machine);
    expect(s.values.parseQueueWaitMs).toBe(45000);
    expect(s.source.parseQueueWaitMs).toBe("auto");
    expect(s.ignored).toEqual([{ key: "parseQueueWaitMs", value: 4500 }]);
  });

  it("all effective values are integers", () => {
    const s = resolveSnapshot(new Map(), {}, machine);
    for (const k of SITE_LIMIT_KEYS) expect(Number.isInteger(s.values[k])).toBe(true);
  });
});

describe("auto.ts", () => {
  it("autoParseWorkers: memory wins only when strictly smaller", () => {
    expect(autoParseWorkers(GIB2, 512)).toEqual({ value: 2, source: "memory" });
    expect(autoParseWorkers(machine, 1024)).toEqual({ value: 4, source: "cpu" });
    // equal on both sides -> cpu
    expect(autoParseWorkers({ ...machine, cpus: 3, memoryBytes: 2 * 2 ** 30 }, 512)).toEqual({ value: 2, source: "cpu" });
  });
  it("autoQueueWaitMs is capped at 2^31-1", () => {
    expect(autoQueueWaitMs(10000)).toBe(45000);
    expect(autoQueueWaitMs(2 ** 31)).toBe(2 ** 31 - 1);
  });
});

describe("checkStorable", () => {
  it("range first, then step", () => {
    expect(checkStorable("noteMaxBytes", 1048575)).toBe("range");
    expect(checkStorable("noteMaxBytes", 1048577)).toBe("step");
    expect(checkStorable("noteMaxBytes", 1048576)).toBe("ok");
    expect(checkStorable("parseWorkers", 4)).toBe("ok");
    expect(checkStorable("parseWorkers", 5)).toBe("range");
    expect(checkStorable("parseWorkers", 2.5)).toBe("range");
  });
});

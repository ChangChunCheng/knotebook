import { SITE_LIMIT_KEYS, SITE_LIMITS, type SiteLimitChangeDto, type SiteLimitItemDto, type SiteLimitKey, type SiteLimitsDto } from "@knotebook/shared";

/**
 * Site limits fixture: every item present, all at default or auto, shaped like the response of the server's `view()`
 * (auto items carry `source: "auto"` and `autoValue`, `parseWorkers` also carries `autoSource`).
 * `patch` overrides items one by one, `rest` overrides `machine` / `changes`.
 */
export const SITE_LIMITS_MACHINE: SiteLimitsDto["machine"] = { cpus: 8, cpuSource: "os", memoryBytes: 16 * 1024 ** 3, memorySource: "cgroup-v2" };

export function siteLimitChange(o: Partial<SiteLimitChangeDto> = {}): SiteLimitChangeDto {
  return {
    id: "c-1",
    key: "rateEdit",
    oldValue: null,
    newValue: 20,
    oldEffective: 30,
    newEffective: 20,
    actor: { id: "u-admin", email: "admin@example.com", displayName: "Admin" },
    changedAt: "2026-01-01T00:00:00.000Z",
    ...o,
  };
}

export function siteLimitsDto(
  patch: Partial<Record<SiteLimitKey, Partial<SiteLimitItemDto>>> = {},
  rest: Partial<Omit<SiteLimitsDto, "items">> = {},
): SiteLimitsDto {
  const items = SITE_LIMIT_KEYS.map((key): SiteLimitItemDto => {
    const def = SITE_LIMITS[key].default;
    const base: SiteLimitItemDto =
      key === "parseWorkers"
        ? { key, value: 4, source: "auto", locked: false, stored: null, autoValue: 4, autoSource: "cpu" }
        : key === "parseQueueWaitMs"
          ? { key, value: 45_000, source: "auto", locked: false, stored: null, autoValue: 45_000 }
          : { key, value: def as number, source: "default", locked: false, stored: null };
    return { ...base, ...patch[key] };
  });
  return { items, machine: { ...SITE_LIMITS_MACHINE }, changes: [], ...rest };
}

// Messages are English only (HTTP layer).
import { siteLimitDef, siteLimitStep, type SiteLimitKey } from "@knotebook/shared";

/** → 409 limit_locked_by_env */
export class LimitLockedError extends Error {
  constructor(readonly key: SiteLimitKey, readonly env: string) {
    super(`${key} is set by the server's environment variable ${env}. Change it there and restart the server.`);
    this.name = "LimitLockedError";
  }
}

/** → 400 invalid_body */
export class LimitRangeError extends Error {
  readonly min: number;
  readonly max: number;
  constructor(readonly key: SiteLimitKey) {
    const { min, max } = siteLimitDef(key);
    super(`${key} must be a whole number from ${min} to ${max}.`);
    this.name = "LimitRangeError";
    this.min = min;
    this.max = max;
  }
}

/** → 400 invalid_body (step is in API units) */
export class LimitStepError extends Error {
  readonly step: number;
  constructor(readonly key: SiteLimitKey) {
    const step = siteLimitStep(key);
    super(`${key} must be a multiple of ${step}.`);
    this.name = "LimitStepError";
    this.step = step;
  }
}

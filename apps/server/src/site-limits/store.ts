import { SITE_LIMIT_KEYS, siteLimitDef, type SiteLimitItemDto, type SiteLimitKey, type SiteLimitsDto } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { siteLimits } from "../db/schema.js";
import { updateSiteLimitsInTx, type UpdateSiteLimitsInput } from "../auth/tx/admin-site-limits.js";
import type { ParseLimits } from "../notes/editing/parse-settings.js";
import { LimitLockedError, LimitRangeError, LimitStepError } from "./errors.js";
import { checkStorable, resolveSnapshot, type Snapshot } from "./resolve.js";
import type { LimitEnv, MachineInfo } from "./types.js";

export type SiteLimitsView = Pick<SiteLimitsDto, "items" | "machine">;

export type SiteLimitsLog = { warn(obj: object, msg: string): void; error(obj: object, msg: string): void };

type Listener = (keys: ReadonlySet<SiteLimitKey>) => void;
type Changes = Partial<Record<SiteLimitKey, number | null>>;

const KEY_SET: ReadonlySet<string> = new Set(SITE_LIMIT_KEYS);

interface Deps {
  db: Db | null;
  limitEnv: LimitEnv;
  machine: MachineInfo;
  log: SiteLimitsLog | null;
  rows: Map<string, number>;
}

export class SiteLimits {
  private readonly db: Db | null;
  private readonly limitEnv: LimitEnv;
  private readonly machine: MachineInfo;
  private readonly log: SiteLimitsLog | null;
  private rows: Map<string, number>;
  private snapshot: Snapshot;
  private readonly listeners = new Set<Listener>();
  private lockTail: Promise<void> = Promise.resolve();

  private constructor(deps: Deps) {
    this.db = deps.db;
    this.limitEnv = deps.limitEnv;
    this.machine = deps.machine;
    this.log = deps.log;
    this.rows = deps.rows;
    for (const key of Object.keys(this.limitEnv) as SiteLimitKey[]) {
      if (this.limitEnv[key] !== undefined && siteLimitDef(key).env === undefined) {
        throw new Error(`SiteLimits: limitEnv has key ${key} but the registry entry has no env`);
      }
    }
    this.snapshot = resolveSnapshot(this.rows, this.limitEnv, this.machine);
  }

  static async load(db: Db, opts: { limitEnv: LimitEnv; machine: MachineInfo; log: SiteLimitsLog }): Promise<SiteLimits> {
    const rows = await db.select({ key: siteLimits.key, value: siteLimits.value }).from(siteLimits);
    const s = new SiteLimits({ db, limitEnv: opts.limitEnv, machine: opts.machine, log: opts.log, rows: new Map(rows.map(r => [r.key, r.value])) });
    for (const { key, value } of s.snapshot.ignored) {
      const def = KEY_SET.has(key) ? siteLimitDef(key as SiteLimitKey) : undefined;
      opts.log.warn({ key, value, min: def?.min, max: def?.max }, "site limit stored value ignored");
    }
    return s;
  }

  static defaults(opts: { limitEnv?: LimitEnv; machine: MachineInfo }): SiteLimits {
    return new SiteLimits({ db: null, limitEnv: opts.limitEnv ?? {}, machine: opts.machine, log: null, rows: new Map() });
  }

  get(key: SiteLimitKey): number {
    return this.snapshot.values[key];
  }

  envName(key: SiteLimitKey): ReturnType<typeof siteLimitDef>["env"] | undefined {
    return this.limitEnv[key] === undefined ? undefined : siteLimitDef(key).env;
  }

  parseLimits(): ParseLimits {
    const v = this.snapshot.values;
    return { workers: v.parseWorkers, workerMemoryMb: v.parseWorkerMemoryMb, timeoutMs: v.parseTimeoutMs, queueWaitMs: v.parseQueueWaitMs };
  }

  view(): SiteLimitsView {
    const s = this.snapshot;
    const ignoredKeys = new Set(s.ignored.map(i => i.key));
    const items: SiteLimitItemDto[] = SITE_LIMIT_KEYS.map(key => {
      const item: SiteLimitItemDto = {
        key,
        value: s.values[key],
        source: s.source[key],
        locked: this.envName(key) !== undefined,
        stored: this.rows.get(key) ?? null,
      };
      if (ignoredKeys.has(key)) item.storedIgnored = true;
      if (key === "parseWorkers") {
        item.autoValue = s.autoValue.parseWorkers;
        item.autoSource = s.autoSource;
      } else if (key === "parseQueueWaitMs") {
        item.autoValue = s.autoValue.parseQueueWaitMs;
      }
      return item;
    });
    return { items, machine: { ...this.machine } };
  }

    /** Validation runs once before the lock (env lock, range, step; first failure wins, nothing written). On a throw the snapshot is untouched; `finally` releases the lock so the next update isn't stuck. */
  async update(actorUserId: string, changes: Changes): Promise<SiteLimitsView> {
    if (this.db === null) throw new Error("SiteLimits.defaults() is read-only");
    const set = this.validate(changes);

    const release = await this.acquireLock();
    try {
      const next = new Map(this.rows);
      for (const key of Object.keys(set) as SiteLimitKey[]) {
        const v = set[key]!;
        if (v === null) next.delete(key);
        else next.set(key, v);
      }
      const before = resolveSnapshot(this.rows, this.limitEnv, this.machine);
      const after = resolveSnapshot(next, this.limitEnv, this.machine);
      const effective: UpdateSiteLimitsInput["effective"] = {};
      for (const key of Object.keys(set) as SiteLimitKey[]) effective[key] = { old: before.values[key], new: after.values[key] };
      const input: UpdateSiteLimitsInput = { actorUserId, set, effective };

      const rows = await this.db.transaction(tx => updateSiteLimitsInTx(tx, input));

      const newRows = new Map(rows.map(r => [r.key, r.value]));
      const newSnapshot = resolveSnapshot(newRows, this.limitEnv, this.machine);
      const oldValues = this.snapshot.values;
      this.rows = newRows;
      this.snapshot = newSnapshot;
      const changed = new Set<SiteLimitKey>(SITE_LIMIT_KEYS.filter(k => oldValues[k] !== newSnapshot.values[k]));
      if (changed.size > 0) {
        for (const fn of [...this.listeners]) {
          try {
            fn(changed);
          } catch (err) {
            this.log?.error({ err }, "site limits onChange listener failed");
          }
        }
      }
      return this.view();
    } finally {
      release();
    }
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private validate(changes: Changes): Changes {
    for (const key of Object.keys(changes)) {
      if (!KEY_SET.has(key)) throw new Error(`SiteLimits.update: unknown key ${key}`);
    }
    const set: Changes = {};
    for (const key of SITE_LIMIT_KEYS) {
      const v = changes[key];
      if (v === undefined) continue;
      const env = this.envName(key);
      if (env !== undefined) throw new LimitLockedError(key, env);
      if (v !== null) {
        const r = checkStorable(key, v);
        if (r === "range") throw new LimitRangeError(key);
        if (r === "step") throw new LimitStepError(key);
      }
      set[key] = v;
    }
    return set;
  }

  private async acquireLock(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const prev = this.lockTail;
    this.lockTail = prev.then(() => held);
    await prev;
    return release;
  }
}

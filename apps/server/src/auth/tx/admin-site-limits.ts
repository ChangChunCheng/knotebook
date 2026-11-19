import { eq, inArray, sql } from "drizzle-orm";
import type { SiteLimitKey } from "@knotebook/shared";
import type { Tx } from "../../db/tx.js";
import { siteLimitChanges, siteLimits } from "../../db/schema.js";

/** `set` is already validated (env lock, range, step); `effective` is the before/after effective values computed under the in-process lock from in-memory rows, one entry per key in `set`. */
export interface UpdateSiteLimitsInput {
  actorUserId: string;
  set: Partial<Record<SiteLimitKey, number | null>>;
  effective: Partial<Record<SiteLimitKey, { old: number; new: number }>>;
}

/** Serialization is `SiteLimits`' in-process lock. Must NOT take `lockSiteSettingsInTx`: the FK check on `actor_user_id` locks the account row, which a holder of that lock must not do. */
export async function updateSiteLimitsInTx(tx: Tx, input: UpdateSiteLimitsInput): Promise<Array<{ key: string; value: number }>> {
  const keys = (Object.keys(input.set) as SiteLimitKey[]).filter(k => input.set[k] !== undefined);
  const current =
    keys.length === 0
      ? []
      : await tx.select({ key: siteLimits.key, value: siteLimits.value }).from(siteLimits).where(inArray(siteLimits.key, keys));
  const before = new Map(current.map(r => [r.key, r.value]));

  const records: Array<typeof siteLimitChanges.$inferInsert> = [];
  for (const key of keys) {
    const next = input.set[key]!;
    const old = before.get(key) ?? null;
    if (next === null) {
      if (old !== null) await tx.delete(siteLimits).where(eq(siteLimits.key, key));
    } else if (old !== next) {
      await tx
        .insert(siteLimits)
        .values({ key, value: next, updatedAt: sql`now()` })
        .onConflictDoUpdate({ target: siteLimits.key, set: { value: next, updatedAt: sql`now()` } });
    }
    if (old !== next) {
      const eff = input.effective[key];
      if (eff === undefined) throw new Error(`updateSiteLimitsInTx: effective is missing ${key}`);
      records.push({ key, oldValue: old, newValue: next, oldEffective: eff.old, newEffective: eff.new, actorUserId: input.actorUserId });
    }
  }
  if (records.length > 0) await tx.insert(siteLimitChanges).values(records);

  return tx.select({ key: siteLimits.key, value: siteLimits.value }).from(siteLimits);
}

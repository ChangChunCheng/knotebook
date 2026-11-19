import type { Db } from "../db/index.js";
import { aiModels, aiProviders } from "../db/schema.js";
import type { AiProviderRow } from "./runtime.js";

export type AiModelRow = typeof aiModels.$inferSelect;

export interface AiSnapshot {
  models: AiModelRow[];
  providers: AiProviderRow[];
}

/** One snapshot shared by `GET /api/ai/actions` and `POST /api/ai`; no per-action queries. */
export async function loadAiSnapshot(db: Db): Promise<AiSnapshot> {
  const [models, providers] = await Promise.all([db.select().from(aiModels), db.select().from(aiProviders)]);
  return { models, providers };
}

/**
 * `isDefault` is only an ordering preference, not an availability switch: a missing,
 * disabled or deleted default must not make AI silently disappear. Also returns `provider`
 * (consistent with `model.providerId`) so POST doesn't query again and drift from the model
 * it resolved. The degraded set (`AiRuntime.degraded`) doesn't take part: degradation is an
 * actionable error and must not quietly switch models; callers consult it before calling upstream.
 */
export function resolveActionModel(
  action: { modelId: string | null },
  snapshot: AiSnapshot
): { model: AiModelRow; provider: AiProviderRow } | null {
  const providerById = new Map(snapshot.providers.map(p => [p.id, p]));

  if (action.modelId !== null) {
    const bound = snapshot.models.find(m => m.id === action.modelId);
    if (bound?.enabled) {
      const provider = providerById.get(bound.providerId);
      if (provider?.enabled) return { model: bound, provider };
    }
  }

  const candidates: Array<{ model: AiModelRow; provider: AiProviderRow }> = [];
  for (const model of snapshot.models) {
    if (!model.enabled || model.purpose !== "chat") continue;
    const provider = providerById.get(model.providerId);
    if (provider?.enabled) candidates.push({ model, provider });
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.model.isDefault !== b.model.isDefault) return a.model.isDefault ? -1 : 1;
    const byCreatedAt = a.model.createdAt.getTime() - b.model.createdAt.getTime();
    if (byCreatedAt !== 0) return byCreatedAt;
    return a.model.id < b.model.id ? -1 : a.model.id > b.model.id ? 1 : 0;
  });

  return candidates[0];
}

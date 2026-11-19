import { and, eq, sql } from "drizzle-orm";
import type pino from "pino";
import type { Db } from "../db/index.js";
import { aiProviders } from "../db/schema.js";
import { AiKeyDecryptError, decryptApiKey, encryptApiKey } from "./crypto.js";
import { redactDbError } from "../lib/redact-db-error.js";

/** Only grows while the process lives; the admin route removes an id after the key is re-entered. */
export interface AiRuntime {
  degraded: Set<string>;
}

export function createAiRuntime(): AiRuntime {
  return { degraded: new Set() };
}

export type AiProviderRow = typeof aiProviders.$inferSelect;

/**
 * Pure (no DB) so unit tests pass fake rows. Disabled providers are never degraded but are still returned for upgrade: a v1 blob left
 * on a disabled row could be copied into an enabled provider, undoing #14. Returns ids only,
 * so plaintext keys never leave the decrypting line.
 */
export function checkProviderKeys(
  providers: AiProviderRow[],
  appSecret: string,
  runtime: AiRuntime,
  log: pino.BaseLogger
): { upgradableIds: string[] } {
  const upgradableIds: string[] = [];
  for (const provider of providers) {
    // `== null`: don't rely on jsonb never yielding `undefined`.
    if (provider.apiKeyEncrypted == null) continue;

    try {
      decryptApiKey(appSecret, provider.apiKeyEncrypted, provider.id);
      if (provider.apiKeyEncrypted.v === 1) upgradableIds.push(provider.id);
    } catch (err) {
      if (!(err instanceof AiKeyDecryptError)) throw err;
      if (!provider.enabled) continue;
      log.warn(
        { providerId: provider.id, providerName: provider.name, err },
        `AI provider「${provider.name}」的 API key 解密失敗——請至 admin 後台重輸 API key`
      );
      runtime.degraded.add(provider.id);
    }
  }
  return { upgradableIds };
}

export async function selfCheckAiKeys(db: Db, appSecret: string, runtime: AiRuntime, log: pino.BaseLogger): Promise<void> {
  // All providers, not only enabled ones: disabled rows need the upgrade too.
  const providers = await db.select().from(aiProviders);
  const { upgradableIds } = checkProviderKeys(providers, appSecret, runtime, log);
  if (upgradableIds.length === 0) return;

  // Migration for #14. A failed upgrade must not block startup: the old ciphertext still works.
  let upgraded = 0;
  for (const id of upgradableIds) {
    const provider = providers.find(row => row.id === id);
    if (provider?.apiKeyEncrypted == null) continue;
    try {
      const apiKey = decryptApiKey(appSecret, provider.apiKeyEncrypted, id);
      // CAS on v1: an admin PATCH from another instance may have just written a new v2 key; don't roll it back with the stale plaintext.
      await db
        .update(aiProviders)
        .set({ apiKeyEncrypted: encryptApiKey(appSecret, apiKey, id) })
        .where(and(eq(aiProviders.id, id), sql`${aiProviders.apiKeyEncrypted}->>'v' = '1'`));
      upgraded += 1;
    } catch (err) {
      // Don't log err: DrizzleQueryError carries the ct/iv/tag params in its message.
      redactDbError(log, err, "升級 AI provider 密文");
      log.warn(
        { providerId: id },
        "AI provider API key 密文升級為 v2 失敗（AI 功能不受影響，舊格式仍可解密），下次啟動會再試"
      );
    }
  }
  // Lets self-hosters see that the migration finished (the API only returns hasKey).
  log.info({ upgraded, remaining: upgradableIds.length - upgraded }, "AI provider API key 密文升級掃描完成");
}

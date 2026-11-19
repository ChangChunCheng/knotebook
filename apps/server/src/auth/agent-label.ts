import { eq } from "drizzle-orm";
import { AGENT_LABEL_RE, deriveAgentLabel } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { apiTokens } from "../db/schema.js";

/** Re-export so existing imports keep working. `agentLabelOf` is pure because `listEdits` joins up to 100 rows (a per-row query would be N+1). */
export { AGENT_LABEL_RE, deriveAgentLabel };

export function agentLabelOf(row: { agentLabel: string | null; name: string }): string {
  return row.agentLabel ?? deriveAgentLabel(row.name);
}

/** No "skip the query when nobody is online" shortcut: the result is persisted (`note_ai_edits.agent_label`, `notes.last_edited_agent_label`) and a shortcut would record `null`. No test catches that. */
export async function currentAgentLabel(db: Db, tokenId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: apiTokens.name, agentLabel: apiTokens.agentLabel })
    .from(apiTokens)
    .where(eq(apiTokens.id, tokenId))
    .limit(1);
  return row ? agentLabelOf(row) : null;
}

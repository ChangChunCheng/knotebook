import { eq, isNull } from "drizzle-orm";
import {
  KNOWLEDGE_CUSTOM_ENABLED_MAX,
  KNOWLEDGE_CUSTOM_TOTAL_MAX,
  KNOWLEDGE_FIELD_NAME_MAX,
  KNOWLEDGE_OPTIONS_MAX,
  resolveKnowledgeFieldView,
  type AdminKnowledgeFieldsDto,
  type KnowledgeCustomFieldType,
  type KnowledgeFieldDefRow,
  type KnowledgeFieldKey,
  type KnowledgeFieldOverrideRow,
  type KnowledgeFieldView,
} from "@knotebook/shared";
import type { DbOrTx } from "../../db/tx.js";
import { knowledgeFieldDefs, knowledgeFieldOverrides, notes } from "../../db/schema.js";
import { UUID_RE } from "../../notes/service.js";

export interface KnowledgeFieldRows {
  defs: KnowledgeFieldDefRow[];
  site: KnowledgeFieldOverrideRow[];
  group: KnowledgeFieldOverrideRow[];
}

function overrideRow(r: typeof knowledgeFieldOverrides.$inferSelect): KnowledgeFieldOverrideRow {
  return { fieldRef: r.fieldRef as KnowledgeFieldKey, optionKey: r.optionKey, enabled: r.enabled, name: r.name, position: r.position };
}

/** Definitions are not scoped to a level: every space sees all of them. */
export async function loadKnowledgeFieldRows(db: DbOrTx, groupId: string | null): Promise<KnowledgeFieldRows> {
  const defs = await db.select().from(knowledgeFieldDefs);
  const site = await db.select().from(knowledgeFieldOverrides).where(isNull(knowledgeFieldOverrides.groupId));
  const group = groupId === null ? [] : await db.select().from(knowledgeFieldOverrides).where(eq(knowledgeFieldOverrides.groupId, groupId));
  return {
    defs: defs.map((d) => ({
      kind: d.kind as "field" | "option",
      fieldRef: d.fieldRef as KnowledgeFieldKey,
      key: d.key,
      type: d.type as KnowledgeCustomFieldType | null,
      createdAt: d.createdAt.toISOString(),
    })),
    site: site.map(overrideRow),
    group: group.map(overrideRow),
  };
}

/** groupId set: that group's override rows are merged over the site's (none exist in this release). */
export async function loadKnowledgeFieldView(db: DbOrTx, space: { groupId: string | null }): Promise<KnowledgeFieldView> {
  return resolveKnowledgeFieldView(await loadKnowledgeFieldRows(db, space.groupId));
}

/** The note's space; a missing note gets the site view. */
export async function knowledgeFieldViewForNote(db: DbOrTx, noteId: string): Promise<KnowledgeFieldView> {
  if (!UUID_RE.test(noteId)) return loadKnowledgeFieldView(db, { groupId: null });
  const [row] = await db.select({ groupId: notes.groupId }).from(notes).where(eq(notes.id, noteId.toLowerCase()));
  return loadKnowledgeFieldView(db, { groupId: row?.groupId ?? null });
}

export async function loadAdminKnowledgeFields(db: DbOrTx): Promise<AdminKnowledgeFieldsDto> {
  const view = await loadKnowledgeFieldView(db, { groupId: null });
  return {
    fields: view.fields,
    limits: {
      customEnabledMax: KNOWLEDGE_CUSTOM_ENABLED_MAX,
      customTotalMax: KNOWLEDGE_CUSTOM_TOTAL_MAX,
      optionsMax: KNOWLEDGE_OPTIONS_MAX,
      nameMax: KNOWLEDGE_FIELD_NAME_MAX,
    },
  };
}

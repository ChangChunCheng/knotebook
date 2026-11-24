import { createContext, type ReactNode } from "react";
import { DEFAULT_KNOWLEDGE_FIELD_VIEW, type KnowledgeFieldView } from "@knotebook/shared";
import { useKnowledgeFields, type KnowledgeFieldsStatus } from "@/api/knowledge-fields";

export type { KnowledgeFieldsStatus } from "@/api/knowledge-fields";

export interface KnowledgeFieldsValue {
  view: KnowledgeFieldView;
  status: KnowledgeFieldsStatus;
}

export const KnowledgeFieldsContext = createContext<KnowledgeFieldsValue>({ view: DEFAULT_KNOWLEDGE_FIELD_VIEW, status: "loading" });

let statusOnly: KnowledgeFieldView | null = null;

/** Every field but status turned off; used where an unknown setting must not accept field values. */
export function knowledgeStatusOnlyView(): KnowledgeFieldView {
  statusOnly ??= Object.freeze({ fields: Object.freeze(DEFAULT_KNOWLEDGE_FIELD_VIEW.fields.map((f) => Object.freeze({ ...f, enabled: false }))) as KnowledgeFieldView["fields"] });
  return statusOnly;
}

export function KnowledgeFieldsProvider({ noteId, children }: { noteId: string; children: ReactNode }) {
  const value = useKnowledgeFields({ noteId });
  return <KnowledgeFieldsContext.Provider value={value}>{children}</KnowledgeFieldsContext.Provider>;
}

import { useContext } from "react";
import { useTranslation } from "react-i18next";
import { truncateCodePoints, type KnowledgeIgnoredItem } from "@knotebook/shared";
import { KnowledgeFieldsContext } from "@/components/knowledge/fields-context";
import "@/i18n/knowledge-strings";

const SHOWN_MAX = 10;
// Code points; an AI result can hold values of any length.
const TEXT_MAX = 80;

const BUILTIN_LABEL_KEYS: Record<string, string> = {
  when: "knowledge.field.when",
  conclusion: "knowledge.field.conclusion",
  evidence: "knowledge.field.evidence",
  verified: "knowledge.field.verified",
  status: "knowledge.field.status",
  superseded_by: "knowledge.field.supersededBy",
};

const cut = (s: string): string => {
  const short = truncateCodePoints(s, TEXT_MAX);
  return short === s ? s : `${short}…`;
};

export function SelectionAiIgnored({ items }: { items: readonly KnowledgeIgnoredItem[] }) {
  const { t } = useTranslation();
  const { view } = useContext(KnowledgeFieldsContext);
  const fieldName = (key: string): string => {
    const builtin = BUILTIN_LABEL_KEYS[key];
    if (builtin !== undefined) return t(builtin);
    return view.fields.find((f) => f.key === key)?.name ?? key;
  };
  const rest = items.length - SHOWN_MAX;

  return (
    <div data-testid="selection-ai-ignored" className="mx-3 mt-2 rounded-md bg-amber-100 px-3 py-2 text-xs text-amber-900 dark:bg-amber-400/15 dark:text-amber-200">
      <p className="font-semibold">{t("knowledge.aiIgnored.title")}</p>
      <ul className="mt-1 space-y-0.5 break-words">
        {items.slice(0, SHOWN_MAX).map((item, i) => (
          <li key={i}>
            {t("knowledge.aiIgnored.line", {
              heading: cut(item.heading),
              field: cut(fieldName(item.key)),
              value: cut(item.value),
              reason: t(`knowledge.aiIgnored.reason.${item.reason}`),
            })}
          </li>
        ))}
      </ul>
      {rest > 0 && <p className="mt-1">{t("knowledge.aiIgnored.more", { count: rest })}</p>}
    </div>
  );
}

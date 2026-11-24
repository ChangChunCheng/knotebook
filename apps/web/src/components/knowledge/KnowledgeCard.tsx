import { Fragment, useContext, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { KNOWLEDGE_CUSTOM_LINK_MAX, isKnowledgeDate, knowledgeStateOf, safeKnowledgeHref, type KnowledgeChildSummary, type KnowledgeEntry } from "@knotebook/shared";
import { Link } from "react-router";
import { useKnowledgeMemberNames } from "@/api/knowledge-members";
import { Button } from "@/components/ui/button";
import { ROW_ICON_HIT_BORDERED } from "@/components/ui/hit-area";
import { Pencil } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { KnowledgeFieldsContext } from "./fields-context";
import {
  customFieldName,
  customKeyOf,
  customValueOf,
  evidenceLabel,
  isDraftFieldEnabled,
  optionLabel,
  shownCustomFields,
  type CustomField,
  type DraftField,
} from "./form-state";

export interface KnowledgeReplacementView {
  state: "found" | "otherNote" | "missing";
  title: string | null;
  open: (() => void) | null;
}

export interface KnowledgeCardProps {
  entry: KnowledgeEntry;
  /** The note whose access names the members in custom fields; without it member values stay blank. */
  memberNoteId?: string | null;
  parent: KnowledgeEntry | null;
  outdatedAncestor: KnowledgeEntry | null;
  summary: KnowledgeChildSummary | null;
  replacement: KnowledgeReplacementView | null;
  variant: "hover" | "sheet";
  canEdit: boolean;
  onEdit: () => void;
  onJump: (blockId: string) => void;
  footer?: ReactNode;
}

const LINK_CLASS = "rounded-sm font-medium underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function Banner({ tone, children }: { tone: "amber" | "red"; children: ReactNode }) {
  return (
    <div
      data-kb-knowledge-banner={tone}
      className={cn(
        "mt-2 rounded-md px-2 py-1 text-xs",
        tone === "amber" ? "bg-amber-100 text-amber-900 dark:bg-amber-400/15 dark:text-amber-200" : "bg-red-100 text-red-800 dark:bg-red-400/15 dark:text-red-200",
      )}
    >
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="pt-px text-xs text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0 break-words">{children}</dd>
    </>
  );
}

function Banners({ entry, outdatedAncestor, replacement, showDate, onJump }: Pick<KnowledgeCardProps, "entry" | "outdatedAncestor" | "replacement" | "onJump"> & { showDate: boolean }) {
  const { t } = useTranslation();
  const untitled = t("knowledge.card.untitled");
  // The title never goes through the translation string: Trans would parse any markup a heading contains.
  // `<link>` would be parsed as a void HTML element, so the placeholder is `<ref/>`.
  const link = (title: string, action: (() => void) | null) => {
    const text = t("knowledge.card.quotedTitle", { title });
    return action ? (
      <button type="button" className={LINK_CLASS} onClick={action}>
        {text}
      </button>
    ) : (
      <span className="font-medium">{text}</span>
    );
  };

  if (entry.info.status === "outdated") {
    if (!replacement) return <Banner tone="red">{t("knowledge.state.outdated")}</Banner>;
    const title =
      replacement.state === "missing" ? t("knowledge.card.refMissing")
      : replacement.state === "otherNote" && !replacement.title ? t("knowledge.card.refOtherNote")
      : (replacement.title ?? untitled);
    const action = replacement.state === "missing" ? null : replacement.open;
    return (
      <Banner tone="red">
        <Trans i18nKey="knowledge.card.bannerOutdated" components={{ ref: link(title, action) }} />
      </Banner>
    );
  }
  if (outdatedAncestor) {
    return (
      <Banner tone="red">
        <Trans
          i18nKey="knowledge.card.bannerInheritedOutdated"
          components={{ ref: link(outdatedAncestor.heading || untitled, () => onJump(outdatedAncestor.blockId)) }}
        />
      </Banner>
    );
  }
  if (knowledgeStateOf(entry.info) === "needs-verify") {
    return (
      <Banner tone="amber">
        {showDate && isKnowledgeDate(entry.info.verified)
          ? t("knowledge.card.bannerNeedsReview", { date: entry.info.verified })
          : t("knowledge.card.bannerNeedsReviewNoDate")}
      </Banner>
    );
  }
  return null;
}

function CustomValue({ field, value, member }: { field: CustomField; value: string; member: string | undefined }): ReactNode {
  const { t } = useTranslation();
  const { view } = useContext(KnowledgeFieldsContext);
  if (value === "") return t("knowledge.notFilled");
  switch (field.type) {
    case "select":
      return optionLabel(view, field.key, value, t);
    case "member":
      return member;
    case "link": {
      // Collab content is never checked on the way in, so a link is followed only after this check.
      const href = value.length <= KNOWLEDGE_CUSTOM_LINK_MAX ? safeKnowledgeHref(value) : null;
      if (href === null) return value;
      return href.startsWith("/") ? (
        <Link to={href} className={cn(LINK_CLASS, "font-normal")}>
          {value}
        </Link>
      ) : (
        <a href={href} target="_blank" rel="noopener noreferrer" className={cn(LINK_CLASS, "font-normal")}>
          {value}
        </a>
      );
    }
    default:
      return value;
  }
}

/** Only mounted when custom fields are shown: the member lookup needs a query client the built-in card doesn't. */
function CustomRows({ fields, values, memberNoteId, divider }: { fields: CustomField[]; values: Readonly<Record<string, string>>; memberNoteId: string | null; divider: ReactNode }) {
  const { t } = useTranslation();
  const memberIds = fields.filter((f) => f.type === "member").map((f) => customValueOf(values, customKeyOf(f)));
  const names = useKnowledgeMemberNames(memberNoteId, memberIds);
  const memberName = (id: string) => names.get(id)?.displayName ?? (names.answered ? t("knowledge.member.unknown") : "");
  return (
    <>
      {divider}
      {fields.map((field) => {
        const value = customValueOf(values, customKeyOf(field));
        return (
          <Field key={field.key} label={customFieldName(field)}>
            <CustomValue field={field} value={value} member={field.type === "member" && value !== "" ? memberName(value) : undefined} />
          </Field>
        );
      })}
    </>
  );
}

export function KnowledgeCard({ entry, memberNoteId = null, parent, outdatedAncestor, summary, replacement, variant, canEdit, onEdit, onJump, footer }: KnowledgeCardProps): ReactNode {
  const { t } = useTranslation();
  const { view, status } = useContext(KnowledgeFieldsContext);
  const sheet = variant === "sheet";
  const notFilled = t("knowledge.notFilled");
  const { info } = entry;
  const on = (field: DraftField) => status !== "loading" && isDraftFieldEnabled(view, field);
  const valueOf = (field: Exclude<DraftField, "supersededBy">): string => (field === "evidence" ? evidenceLabel(view, info.evidence, t) : info[field] || notFilled);
  const groups = ([["when", "conclusion"], ["evidence"], ["verified"]] as const).map((g) => g.filter(on)).filter((g) => g.length > 0);
  const customFields = status === "loading" ? [] : shownCustomFields(view);
  const divider = <div role="presentation" className="col-span-2 my-1 border-t border-dashed border-border" />;
  const topRow = !sheet && (parent || canEdit);
  return (
    <div data-kb-knowledge-card={variant} className={cn("text-left text-popover-foreground", sheet ? "text-sm" : "text-[13px] leading-snug")}>
      {topRow && (
        <div className="mb-1.5 flex items-center gap-2">
          {parent && (
            <button type="button" className={cn(LINK_CLASS, "min-w-0 truncate text-left text-xs font-normal text-muted-foreground")} onClick={() => onJump(parent.blockId)}>
              {t("knowledge.card.belongsTo", { title: parent.heading || t("knowledge.card.untitled") })}
            </button>
          )}
          <span className="flex-1" />
          {canEdit && (
            <Button type="button" variant="outline" size="sm" className={cn("h-6 gap-1 px-2", ROW_ICON_HIT_BORDERED)} onClick={onEdit}>
              <Pencil className="h-3 w-3" />
              {t("knowledge.card.edit")}
            </Button>
          )}
        </div>
      )}
      {sheet && parent && (
        <button type="button" className={cn(LINK_CLASS, "mb-1 block max-w-full truncate text-left text-xs font-normal text-muted-foreground")} onClick={() => onJump(parent.blockId)}>
          {t("knowledge.card.belongsTo", { title: parent.heading || t("knowledge.card.untitled") })}
        </button>
      )}
      {/* The banner names the replacement and the date only while those fields are on: otherwise it would show values the settings hide. */}
      <Banners entry={entry} outdatedAncestor={outdatedAncestor} replacement={on("supersededBy") ? replacement : null} showDate={on("verified")} onJump={onJump} />
      {(groups.length > 0 || customFields.length > 0) && (
        <dl className={cn("m-0 mt-2 grid gap-x-2 gap-y-0.5", sheet ? "grid-cols-[5.25rem_1fr]" : "grid-cols-[4.875rem_1fr]")}>
          {groups.map((group, i) => (
            <Fragment key={group[0]}>
              {i > 0 && !sheet && divider}
              {group.map((field) => (
                <Field key={field} label={t(`knowledge.field.${field}`)}>
                  {valueOf(field)}
                </Field>
              ))}
            </Fragment>
          ))}
          {customFields.length > 0 && <CustomRows fields={customFields} values={info.custom} memberNoteId={memberNoteId} divider={groups.length > 0 && !sheet ? divider : null} />}
        </dl>
      )}
      {summary && (
        <p className="m-0 mt-2 border-t border-dashed border-border pt-2 text-xs text-muted-foreground">
          {t("knowledge.card.summary", { total: summary.total, verified: summary.verified, review: summary.needsReview })}
          {summary.outdated > 0 ? t("knowledge.card.summaryOutdated", { outdated: summary.outdated }) : ""}
        </p>
      )}
      {sheet && (canEdit || footer) && (
        <div className="mt-3 flex gap-2.5">
          {footer}
          {canEdit && (
            <Button type="button" variant="brandDeep" className="h-11 flex-1 text-[15px]" onClick={onEdit}>
              <Pencil className="h-4 w-4" />
              {t("knowledge.card.edit")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

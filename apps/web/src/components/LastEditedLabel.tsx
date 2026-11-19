import { useTranslation } from "react-i18next";
import type { NoteDto } from "@knotebook/shared";

/**
 * Collapses with `max-sm:sr-only @max-[36rem]:sr-only` (not `hidden`) like `ConnectionBadge`, so it stays in the accessibility tree.
 * The divider shares the label null condition so it hides together. Shrink order in the header: title yields to `min-w-16` (`TitleInput`), then this label truncates, then nothing else shrinks.
 * Absolute date format: the repo has no relative-time helper (`ApiTokensSection.formatDate` is the same).
 */
export function LastEditedLabel({ note, onOpenEdits }: { note: NoteDto; onOpenEdits: () => void }) {
  const { t, i18n } = useTranslation();
  const last = note.lastEdited;
  if (!last) return null;

  const handle = last.byHandle === "" ? t("note.lastEditedDeletedUser") : last.byHandle;
  const who = last.agentLabel === null ? handle : `${handle} (${last.agentLabel})`;
  const at = new Date(last.at);
  const text = t("note.lastEdited", { who, when: at.toLocaleDateString(i18n.language) });
  const full = at.toLocaleString(i18n.language);

  const separator = <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border max-sm:hidden @max-[36rem]:hidden" />;

  if (last.agentLabel === null) {
    return (
      <>
        {separator}
        <span
          data-testid="last-edited"
          title={t("note.lastEditedAt", { who, when: full })}
          className="max-sm:sr-only @max-[36rem]:sr-only min-w-0 truncate text-xs text-muted-foreground"
        >
          {text}
        </span>
      </>
    );
  }

  return (
    <>
      {separator}
      <button
        type="button"
        data-testid="last-edited"
        title={t("note.lastEditedTitle", { who, when: full })}
        onClick={onOpenEdits}
        className="max-sm:sr-only @max-[36rem]:sr-only min-w-0 truncate rounded text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {text}
      </button>
    </>
  );
}

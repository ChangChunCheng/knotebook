import { useTranslation } from "react-i18next";
import { useNotes } from "@/api/notes";
import { EmptyState } from "@/components/EmptyState";
import { NarrowTopBar } from "@/components/NarrowTopBar";
import { cardSurface } from "@/components/ui/card";
import { useIsPhone } from "@/lib/layout-tiers";
import { cn } from "@/lib/utils";

/** `useNotes()` is also called inside `NoteList`; both use the `['notes']` key, so react-query dedupes the request. */
export default function HomePage() {
  const { t } = useTranslation();
  const notesQuery = useNotes();
  const hasNotes = (notesQuery.data?.length ?? 0) > 0;
  const phone = useIsPhone();

  // Phone: the list screen covers the whole window, so this empty-state card and its top bar don't render.
  if (phone) return null;

  return (
    // The sidebar shell comes from AppShellLayout; this is the main slot, styled like NotePage's content card.
    // main doesn't scroll itself (see AppShell.tsx), so `overflow-y-auto` sits on the card.
    <div className={cn(cardSurface, "min-w-0 flex-1 overflow-y-auto max-sm:rounded-none max-sm:border-0 max-sm:pb-[env(safe-area-inset-bottom)]")}>
      <NarrowTopBar />
      <EmptyState
        title={hasNotes ? t("home.selectTitle") : t("home.empty")}
        description={hasNotes ? t("home.selectDescription") : t("home.emptyDescription")}
      />
    </div>
  );
}

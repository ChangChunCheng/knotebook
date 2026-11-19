import { lazy } from "react";
import { useTranslation } from "react-i18next";
import { useSidebarTabState } from "@/lib/sidebar-tab";
import { useWidePointer } from "@/lib/wide-pointer";
import { Button } from "@/components/ui/button";
import { Plus } from "@/components/ui/icons";
import { SidebarLazyBoundary } from "@/components/sidebar/SidebarLazyBoundary";
import { tourTarget } from "@/lib/tour-targets";

const TrashFooter = lazy(() => import("@/components/sidebar/TrashLazy").then((m) => ({ default: m.TrashFooter })));
const SelectActionBar = lazy(() => import("@/components/sidebar/SelectLazy").then((m) => ({ default: m.SelectActionBar })));

/** The body must not call `useTrash()`/`useNotes()`: only the sub-components rendered for their state do, so other tabs don't fetch `GET /api/trash`. */
export function SidebarFooter({
  searching,
  onCreateNote,
  newNotePending,
  phone = false,
}: {
  searching: boolean;
  onCreateNote: () => void;
  newNotePending: boolean;
  phone?: boolean;
}) {
  const { t } = useTranslation();
  const { tab, selection } = useSidebarTabState();
  const wide = useWidePointer();
  const newNote = (
    <div className="m-2">
      <Button variant="brand" className="w-full" onClick={() => onCreateNote()} disabled={newNotePending} {...tourTarget("newNote")}>
        <Plus aria-hidden="true" className="h-4 w-4" />
        {t("home.newNote")}
      </Button>
    </div>
  );
  // While searching always "New note" (the search view isn't any tab's list).
  if (searching) return phone ? null : newNote;
  if (tab !== "trash" && selection.active) {
    // Across the breakpoint each side mounts/unmounts by it, so one instance has at most one `SelectActionBar`.
    if (wide) return null;
    // Placeholder is as tall as the action bar (phone: 57 + bottom safe area); on chunk failure the list's copy (same chunk) shows the error and retry, so this one is hidden.
    return (
      <SidebarLazyBoundary
        chunk="select"
        fallback={<div className={phone ? "h-[calc(57px+env(safe-area-inset-bottom))] shrink-0" : "m-2 h-8"} />}
        errorClassName="hidden"
      >
        <SelectActionBar safeBottom={phone} />
      </SidebarLazyBoundary>
    );
  }
  // New note always creates a personal note, so the Groups and Shared with me tabs don't show it.
  if (tab === "myNotes" || tab === "recent") return phone ? null : newNote;
  if (tab !== "trash") return null;
  // Placeholder as tall as the "loading" retention note so the layout doesn't jump when the chunk arrives. On chunk failure the panel's copy (same chunk)
  // shows error and retry; the bottom error content is hidden to avoid a duplicate retry button.
  return (
    <SidebarLazyBoundary chunk="trash" fallback={<div className="h-7 max-sm:h-[calc(6.375rem+env(safe-area-inset-bottom))]" />} errorClassName="hidden">
      <TrashFooter />
    </SidebarLazyBoundary>
  );
}

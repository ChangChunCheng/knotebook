import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { FROSTED_SURFACE } from "@/components/ui/frosted";
import { PenLine, Search } from "@/components/ui/icons";
import { tourTarget } from "@/lib/tour-targets";
import { isKeyboardOpen, useKeyboardInset } from "@/lib/visual-viewport";

interface PhoneListFabsProps {
  onSearch: () => void;
  showNewNote: boolean;
  onCreateNote: () => void;
  newNotePending: boolean;
}

/** Bottom height taken by the FABs: 1rem + `h-14` above the safe area; change together with the two buttons' classes below. */
export const PHONE_FAB_FOOTPRINT_PX = 72;

const FROSTED = `z-10 h-14 w-14 rounded-full ${FROSTED_SURFACE}`;

export function PhoneListFabs({ onSearch, showNewNote, onCreateNote, newNotePending }: PhoneListFabsProps) {
  const { t } = useTranslation();
  const inset = useKeyboardInset();
  if (isKeyboardOpen(inset)) return null;
  return (
    <div data-phone-list-fabs="">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        data-phone-fab="search"
        {...tourTarget("phoneSearch")}
        aria-label={t("sidebar.searchLabel")}
        onClick={onSearch}
        className={`fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-[calc(1rem+env(safe-area-inset-left))] text-foreground hover:text-foreground ${FROSTED}`}
      >
        <Search aria-hidden="true" className="h-5 w-5" />
      </Button>
      {showNewNote && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-phone-fab="new-note"
          {...tourTarget("phoneNewNote")}
          aria-label={t("home.newNote")}
          onClick={onCreateNote}
          disabled={newNotePending}
          className={`fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-[calc(1rem+env(safe-area-inset-right))] text-brand-on-soft hover:text-brand-on-soft ${FROSTED}`}
        >
          <PenLine aria-hidden="true" className="h-[22px] w-[22px]" />
        </Button>
      )}
    </div>
  );
}

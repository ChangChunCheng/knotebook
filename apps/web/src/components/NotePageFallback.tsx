import { useTranslation } from "react-i18next";
import { NarrowTopBar } from "./NarrowTopBar";
import { cardSurface } from "./ui/card";
import { cn } from "@/lib/utils";

/** Same look and text as NotePage own loading state; rendered inside AppShell so the sidebar survives the first note open (pinned in App.appShellLayout.test.tsx). Own module to avoid an App <-> ErrorBoundary import cycle (#66). */
export function NotePageFallback() {
  const { t } = useTranslation();
  return (
    <div className={cn(cardSurface, "min-w-0 flex-1 overflow-y-auto max-sm:rounded-none max-sm:border-0 max-sm:pb-[env(safe-area-inset-bottom)]")}>
      <NarrowTopBar />
      <p className="p-6 text-sm text-muted-foreground">{t("app.loading")}</p>
    </div>
  );
}

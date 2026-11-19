import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

/** `onReload` exists because jsdom `location.reload` cannot be replaced. */
export function OutdatedClientBanner({ onReload }: { onReload?: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="flex items-center gap-3 border-b border-border bg-muted px-5 py-2 text-sm">
      <p className="min-w-0 flex-1">{t("note.outdated.message")}</p>
      <Button type="button" size="sm" variant="outline" className="shrink-0" onClick={onReload ?? (() => window.location.reload())}>
        {t("note.outdated.reload")}
      </Button>
    </div>
  );
}

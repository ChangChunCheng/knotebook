import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import "@/i18n/management-strings";

/**
 * The link is shown only this once, so the read-only field stays selectable rather than relying on a toast. Not
 * `ManualCopyField`: its fixed text is wrong here and its own `DialogDescription` would put two in the caller's `DialogContent`.
 */
export function OneTimeLinkResult({ title, url, expiresAt }: { title: string; url: string; expiresAt: string }) {
  const { t, i18n } = useTranslation();
  const when = new Date(expiresAt).toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" });
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{t("admin.oneTimeLink.onceWarning", { when })}</DialogDescription>
      </DialogHeader>
      <Input
        readOnly
        value={url}
        aria-label={t("admin.oneTimeLink.linkLabel")}
        className="font-mono"
        autoFocus
        onFocus={(event) => event.currentTarget.select()}
      />
      <DialogFooter>
        <Button
          type="button"
          // not `secondary`: nearly the panel background in light mode, so it reads as a hover highlight, not a button (same as ApiTokensSection)
          variant="outline"
          onClick={() => {
            void copyText(url).then((ok) => {
              toast(
                ok
                  ? { title: t("admin.oneTimeLink.copied") }
                  : { title: t("admin.oneTimeLink.copyFailed"), variant: "destructive" },
              );
            });
          }}
        >
          {t("admin.oneTimeLink.copy")}
        </Button>
        <DialogClose asChild>
          <Button type="button" variant="brandDeep">
            {t("admin.oneTimeLink.done")}
          </Button>
        </DialogClose>
      </DialogFooter>
    </>
  );
}

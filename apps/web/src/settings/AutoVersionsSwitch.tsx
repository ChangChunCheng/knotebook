import { useTranslation } from "react-i18next";
import { Switch } from "@/components/ui/switch";

/** Used by the personal storage page and the group storage section; applies immediately (`ui/switch`). Disabled reasons are visible text: a title doesn't show reliably on a disabled control. */
export function AutoVersionsSwitch({
  id,
  title,
  description,
  checked,
  onCheckedChange,
  siteOff,
  disabledReason,
  pending,
}: {
  id: string;
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  siteOff: boolean;
  disabledReason?: string;
  pending: boolean;
}) {
  const { t } = useTranslation();
  const disabled = siteOff || disabledReason !== undefined || pending;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-3">
        <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
        <label htmlFor={id} className="text-sm font-medium">
          {title}
        </label>
      </div>
      <p className="text-sm text-muted-foreground">{description}</p>
      {siteOff && <p className="text-sm text-muted-foreground">{t("versions.siteOff")}</p>}
      {!siteOff && disabledReason !== undefined && <p className="text-sm text-muted-foreground">{disabledReason}</p>}
      <p className="text-xs text-muted-foreground">{t("versions.takesEffectNote")}</p>
    </div>
  );
}

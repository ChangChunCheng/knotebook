import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "@/components/ui/switch";
import type { ScopeChecks } from "@/lib/token-scope";
import "@/i18n/management-strings";

/**
 * Read is always included, so it isn't listed. The switches' accessible names use
 * `settings.account.apiTokensScopeEdit`/`apiTokensScopeMove`/`apiTokensScopeDelete` verbatim (model-facing strings quote
 * them), shared with `ScopeChecksField` (still used by the OAuth consent page); move and delete also show them as the bold
 * label, followed by an inline description that doesn't repeat the name. Turning off edit disables move/delete and clears them (same direction as
 * `scopeFromChecks(false, …) === "notes:read"`). Move uses `tone="destructive"` (irreversible); delete uses the default
 * tone (trash is restorable). Each shows its consequence hint, linked by aria-describedby, only while on. Toggles in a
 * apply-on-submit create dialog are a deliberate exception (see the ui/switch.tsx header).
 */
export function ScopeTogglesField({
  value,
  onChange,
  disabled = false,
}: {
  value: ScopeChecks;
  onChange: (next: ScopeChecks) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const editId = useId();
  const moveId = useId();
  const hintId = useId();
  const deleteId = useId();
  const deleteHintId = useId();
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <Switch
          id={editId}
          className="mt-1"
          checked={value.write}
          disabled={disabled}
          aria-label={t("settings.account.apiTokensScopeEdit")}
          onCheckedChange={(on) =>
            onChange({ write: on, move: on ? value.move : false, delete: on ? value.delete : false })
          }
        />
        <label htmlFor={editId} className="text-sm">
          <span className="font-medium">{t("settings.authorization.tokens.pillEdit")}</span>{" "}
          <span className="text-muted-foreground">{t("settings.account.apiTokensScopeEdit")}</span>
        </label>
      </div>
      <div className="flex items-start gap-2">
        <Switch
          id={moveId}
          className="mt-1"
          tone="destructive"
          checked={value.move}
          disabled={disabled || !value.write}
          aria-label={t("settings.account.apiTokensScopeMove")}
          aria-describedby={value.move ? hintId : undefined}
          onCheckedChange={(on) => onChange({ ...value, move: on && value.write })}
        />
        <label htmlFor={moveId} className="text-sm">
          <span className="font-medium">{t("settings.account.apiTokensScopeMove")}</span>{" "}
          <span className="text-muted-foreground">{t("settings.account.apiTokensScopeMoveDesc")}</span>
        </label>
      </div>
      {value.move && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {t("settings.account.apiTokensScopeMoveHint")}
        </p>
      )}
      <div className="flex items-start gap-2">
        <Switch
          id={deleteId}
          className="mt-1"
          checked={value.delete}
          disabled={disabled || !value.write}
          aria-label={t("settings.account.apiTokensScopeDelete")}
          aria-describedby={value.delete ? deleteHintId : undefined}
          onCheckedChange={(on) => onChange({ ...value, delete: on && value.write })}
        />
        <label htmlFor={deleteId} className="text-sm">
          <span className="font-medium">{t("settings.account.apiTokensScopeDelete")}</span>{" "}
          <span className="text-muted-foreground">{t("settings.account.apiTokensScopeDeleteDesc")}</span>
        </label>
      </div>
      {value.delete && (
        <p id={deleteHintId} className="text-xs text-muted-foreground">
          {t("settings.account.apiTokensScopeDeleteHintRequiresEdit", {
            hint: t("settings.account.apiTokensScopeDeleteHint"),
          })}
        </p>
      )}
    </div>
  );
}

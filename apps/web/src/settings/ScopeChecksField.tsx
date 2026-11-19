import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/checkbox";
import type { ScopeChecks } from "@/lib/token-scope";
import "@/i18n/management-strings";

/**
 * Only the OAuth consent page uses this; the token dialog and inline edit use `ScopeTogglesField`. Both share the labels
 * (`settings.account.apiTokensScopeEdit`/`apiTokensScopeMove`/`apiTokensScopeDelete`): model-facing strings quote them and
 * the server's `scope-labels-sync.test.ts` compares them verbatim. Both also share the coupling: unchecking edit disables
 * move/delete and clears them.
 */
export function ScopeChecksField({
  value,
  onChange,
  showWrite = true,
  showMove = true,
  showDelete = true,
  granted,
}: {
  value: ScopeChecks;
  onChange: (next: ScopeChecks) => void;
  showWrite?: boolean;
  showMove?: boolean;
  showDelete?: boolean;
  granted?: ScopeChecks;
}) {
  const { t } = useTranslation();
  const writeId = useId();
  const moveId = useId();
  const moveHintId = useId();
  const deleteId = useId();
  const deleteHintId = useId();
  return (
    <div className="space-y-2">
      {showWrite && (
        <div className="flex items-center gap-2">
          <Checkbox
            id={writeId}
            checked={value.write}
            onCheckedChange={c => {
              const on = c === true;
              onChange({ write: on, move: on ? value.move : false, delete: on ? value.delete : false });
            }}
          />
          <label htmlFor={writeId} className="text-sm">
            {t("settings.account.apiTokensScopeEdit")}
          </label>
          {granted?.write && <span className="text-xs text-muted-foreground">{t("authorize.currentlyGranted")}</span>}
        </div>
      )}
      {showMove && (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Checkbox
              id={moveId}
              checked={value.move}
              disabled={!value.write}
              aria-describedby={moveHintId}
              onCheckedChange={c => onChange({ ...value, move: c === true && value.write })}
            />
            {/* The checkbox carries `peer` (ui/checkbox.tsx), so the label dims with it when disabled, matching its disabled:opacity-50. */}
            <label htmlFor={moveId} className="text-sm peer-disabled:cursor-not-allowed peer-disabled:opacity-50">
              {t("settings.account.apiTokensScopeMove")}
            </label>
            {granted?.move && <span className="text-xs text-muted-foreground">{t("authorize.currentlyGranted")}</span>}
          </div>
          <p id={moveHintId} className="text-xs text-muted-foreground">
            {t("settings.account.apiTokensScopeMoveHint")}
          </p>
        </div>
      )}
      {showDelete && (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Checkbox
              id={deleteId}
              checked={value.delete}
              disabled={!value.write}
              aria-describedby={deleteHintId}
              onCheckedChange={c => onChange({ ...value, delete: c === true && value.write })}
            />
            <label htmlFor={deleteId} className="text-sm peer-disabled:cursor-not-allowed peer-disabled:opacity-50">
              {t("settings.account.apiTokensScopeDelete")}
            </label>
            {granted?.delete && <span className="text-xs text-muted-foreground">{t("authorize.currentlyGranted")}</span>}
          </div>
          <p id={deleteHintId} className="text-xs text-muted-foreground">
            {t("settings.account.apiTokensScopeDeleteHintRequiresEdit", {
              hint: t("settings.account.apiTokensScopeDeleteHint"),
            })}
          </p>
        </div>
      )}
    </div>
  );
}

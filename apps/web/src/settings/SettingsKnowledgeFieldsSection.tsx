import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  KNOWLEDGE_FIELD_NAME_MAX,
  KNOWLEDGE_KEY_RE,
  KNOWLEDGE_OPTIONS_MAX,
  KNOWLEDGE_RESERVED_EVIDENCE_KEYS,
  type AdminKnowledgeFieldsDto,
  type KnowledgeFieldKey,
} from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { ADMIN_KNOWLEDGE_FIELDS_QUERY_KEY, fetchAdminKnowledgeFields, useAdminKnowledgeFields, useSaveSiteKnowledgeFields } from "@/api/admin-knowledge-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { RowIconButton } from "@/components/ui/row-icon-button";
import { Plus } from "@/components/ui/icons";
import { ArrowDown, ArrowUp, Lock } from "@/components/ui/icons-extra";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";
import {
  addOption,
  draftFromAdmin,
  inputFromDraft,
  moveOption,
  setFieldEnabled,
  setOptionEnabled,
  setOptionKey,
  setOptionName,
  type KnowledgeFieldsDraft,
  type KnowledgeFieldsDraftField,
} from "./knowledge-fields-draft";
import "@/i18n/management-strings";

const BUILTIN_ORDER: readonly KnowledgeFieldKey[] = ["when", "conclusion", "evidence", "verified", "superseded_by"];
const BUILTIN_OPTION_KEYS: ReadonlySet<string> = new Set(["tested", "docs", "inferred"]);
const RESERVED: ReadonlySet<string> = new Set(KNOWLEDGE_RESERVED_EVIDENCE_KEYS);

interface RowError { field: KnowledgeFieldKey; index: number; message: string; on: "name" | "key" }

function saveErrorMessage(t: TFunction, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/** The server names no row, so the row is found by re-checking the draft the same way the server does. */
function findOffendingOption(draft: KnowledgeFieldsDraft, code: string): { field: KnowledgeFieldKey; index: number } | null {
  for (const field of draft.fields) {
    const seen = new Set<string>();
    for (const [index, option] of field.options.entries()) {
      const bad =
        code === "knowledge_key_invalid"
          ? !KNOWLEDGE_KEY_RE.test(option.key) || (option.isNew && field.key === "evidence" && RESERVED.has(option.key))
          : seen.has(option.key);
      if (bad) return { field: field.key, index };
      seen.add(option.key);
    }
  }
  return null;
}

function OptionRow({
  field,
  index,
  onChange,
  onMove,
  error,
  errorOn,
  canUp,
  canDown,
  busy,
}: {
  field: KnowledgeFieldsDraftField;
  index: number;
  onChange: (apply: (draft: KnowledgeFieldsDraft) => KnowledgeFieldsDraft) => void;
  onMove: (by: -1 | 1) => void;
  error: string | undefined;
  errorOn: "name" | "key" | undefined;
  canUp: boolean;
  canDown: boolean;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const option = field.options[index]!;
  const defaultName = BUILTIN_OPTION_KEYS.has(option.key) && !option.isNew ? t(`admin.knowledgeFields.defaultOption.${option.key}`) : undefined;
  const label = option.name.trim() || defaultName || option.key;
  return (
    <li className={cn("grid grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-2 py-1.5 sm:grid-cols-[auto_auto_minmax(0,1fr)_9.5rem_auto]", option.isNew && "-mx-1.5 rounded-lg bg-brand-soft px-1.5 py-2")}>
      <RowIconButton label={t("admin.knowledgeFields.moveUp")} icon={<ArrowUp className="h-3.5 w-3.5" />} disabled={busy || !canUp} onClick={() => onMove(-1)} />
      <RowIconButton label={t("admin.knowledgeFields.moveDown")} icon={<ArrowDown className="h-3.5 w-3.5" />} disabled={busy || !canDown} onClick={() => onMove(1)} />
      <Input
        aria-label={t("admin.knowledgeFields.optionName")}
        aria-invalid={errorOn === "name" || undefined}
        disabled={busy}
        className={cn(errorOn === "name" && "border-destructive ring-1 ring-destructive")}
        value={option.name}
        placeholder={defaultName ?? t("admin.knowledgeFields.newOptionNamePlaceholder")}
        onChange={(e) => onChange((d) => setOptionName(d, field.key, index, clampName(e.target.value)))}
      />
      <div className="col-start-3 flex min-w-0 items-center gap-3 sm:contents">
        {option.isNew ? (
          <Input
            aria-label={t("admin.knowledgeFields.optionKey")}
            aria-invalid={errorOn === "key" || undefined}
            disabled={busy}
            className={cn("min-w-0 flex-1 font-mono text-[13px] sm:flex-none", errorOn === "key" && "border-destructive ring-1 ring-destructive")}
            value={option.key}
            placeholder={t("admin.knowledgeFields.keyPlaceholder")}
            onChange={(e) => onChange((d) => setOptionKey(d, field.key, index, e.target.value))}
          />
        ) : (
          <Input aria-label={t("admin.knowledgeFields.optionKey")} readOnly className="min-w-0 flex-1 bg-muted font-mono text-[13px] text-muted-foreground sm:flex-none" value={option.key} />
        )}
        <label className="flex shrink-0 items-center justify-end gap-1.5 text-xs text-muted-foreground">
          {t("admin.knowledgeFields.optionShow")}
          <Switch
            aria-label={t("admin.knowledgeFields.optionShowFor", { name: label })}
            disabled={busy}
            checked={option.enabled}
            onCheckedChange={(enabled) => onChange((d) => setOptionEnabled(d, field.key, index, enabled))}
          />
        </label>
      </div>
      {error !== undefined && (
        <p role="alert" className="col-span-full text-sm text-destructive sm:col-start-3">
          {error}
        </p>
      )}
    </li>
  );
}

function EvidenceOptions({
  field,
  onChange,
  rowError,
  busy,
}: {
  field: KnowledgeFieldsDraftField;
  onChange: (apply: (draft: KnowledgeFieldsDraft) => KnowledgeFieldsDraft) => void;
  rowError: RowError | null;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const full = field.options.length >= KNOWLEDGE_OPTIONS_MAX;
  return (
    <div className="my-2 ml-5 border-l-2 border-border pl-4">
      <h3 className="text-xs font-semibold text-muted-foreground">{t("admin.knowledgeFields.optionsHeading")}</h3>
      <ul className="mt-1.5">
        {field.options.map((option, index) => (
          <OptionRow
            key={option.uid ?? option.key}
            field={field}
            index={index}
            busy={busy}
            canUp={index > 0}
            canDown={index < field.options.length - 1}
            error={rowError?.field === field.key && rowError.index === index ? rowError.message : undefined}
            errorOn={rowError?.field === field.key && rowError.index === index ? rowError.on : undefined}
            onChange={onChange}
            onMove={(by) => onChange((d) => moveOption(d, field.key, index, by))}
          />
        ))}
      </ul>
      <p className="mt-1.5 text-xs text-muted-foreground">{t("admin.knowledgeFields.optionsHint")}</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" disabled={busy || full} onClick={() => onChange((d) => addOption(d, field.key))}>
          <Plus className="h-3.5 w-3.5" />
          {t("admin.knowledgeFields.addOption")}
        </Button>
        <span className="text-xs text-muted-foreground">{t("admin.knowledgeFields.optionCount", { count: field.options.length, max: KNOWLEDGE_OPTIONS_MAX })}</span>
        {full && <span className="text-xs text-muted-foreground">{t("admin.knowledgeFields.optionsFull", { max: KNOWLEDGE_OPTIONS_MAX })}</span>}
      </div>
    </div>
  );
}

function clampName(value: string): string {
  const points = [...value];
  return points.length > KNOWLEDGE_FIELD_NAME_MAX ? points.slice(0, KNOWLEDGE_FIELD_NAME_MAX).join("") : value;
}

function FieldsEditor({ initial, onStale }: { initial: AdminKnowledgeFieldsDto; onStale: () => Promise<void> }) {
  const { t } = useTranslation();
  const save = useSaveSiteKnowledgeFields();
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState<KnowledgeFieldsDraft>(() => draftFromAdmin(initial));
  const [rowError, setRowError] = useState<RowError | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const busy = save.isPending || refreshing;

  const dirty = JSON.stringify(inputFromDraft(draft)) !== JSON.stringify(inputFromDraft(draftFromAdmin(saved)));

  function change(apply: (draft: KnowledgeFieldsDraft) => KnowledgeFieldsDraft): void {
    setDraft(apply);
    setRowError(null);
  }

  function discard(): void {
    setDraft(draftFromAdmin(saved));
    setRowError(null);
  }

  async function handleSave(): Promise<void> {
    setRowError(null);
    for (const field of draft.fields) {
      const index = field.options.findIndex((o) => o.isNew && (o.key.trim() === "" || o.name.trim() === ""));
      if (index >= 0) {
        const nameMissing = field.options[index]!.name.trim() === "";
        setRowError({ field: field.key, index, on: nameMissing ? "name" : "key", message: t(nameMissing ? "admin.knowledgeFields.nameMissing" : "admin.knowledgeFields.keyMissing") });
        return;
      }
    }
    try {
      const result = await save.mutateAsync(inputFromDraft(draft));
      setSaved(result);
      setDraft(draftFromAdmin(result));
      toast({ title: t("admin.knowledgeFields.saved") });
    } catch (err) {
      const code = err instanceof ApiFail ? err.code : "";
      const row = code === "knowledge_key_invalid" || code === "knowledge_key_taken" ? findOffendingOption(draft, code) : null;
      if (code === "knowledge_fields_incomplete") {
        setRefreshing(true);
        try {
          await onStale();
          toast({ title: t("admin.knowledgeFields.settingsChanged") });
        } catch {
          toast({ title: t("errors.fallback"), variant: "destructive" });
        } finally {
          setRefreshing(false);
        }
        return;
      }
      if (row !== null) setRowError({ ...row, on: "key", message: t(`errors.${code}`) });
      else toast({ title: saveErrorMessage(t, err), variant: "destructive" });
    }
  }

  const builtin = BUILTIN_ORDER.flatMap((key) => {
    const field = draft.fields.find((f) => f.key === key);
    return field ? [field] : [];
  });

  return (
    <>
      <SettingsGroup title={t("admin.knowledgeFields.systemHeading")} description={t("admin.knowledgeFields.systemDescription")}>
        <div className="flex items-center gap-6 py-1 text-muted-foreground">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{t("admin.knowledgeFields.status")}</div>
            <div className="text-xs">{t("admin.knowledgeFields.statusValues")}</div>
          </div>
          <span className="flex items-center gap-1.5 text-xs">
            <Lock className="h-3.5 w-3.5" aria-hidden="true" />
            {t("admin.knowledgeFields.alwaysOn")}
          </span>
          <Switch checked disabled aria-label={t("admin.knowledgeFields.toggle", { name: t("admin.knowledgeFields.status") })} />
        </div>
      </SettingsGroup>
      <SettingsGroup title={t("admin.knowledgeFields.builtinHeading")} description={t("admin.knowledgeFields.builtinDescription")}>
        <div className="divide-y divide-border">
          {builtin.map((field) => {
            const name = t(`admin.knowledgeFields.field.${field.key}`);
            return (
              <div key={field.key} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-center gap-6">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{name}</div>
                    <div className="text-xs text-muted-foreground">{t(`admin.knowledgeFields.type.${field.type}`)}</div>
                  </div>
                  <Switch
                    aria-label={t("admin.knowledgeFields.toggle", { name })}
                    disabled={busy}
                    checked={field.enabled}
                    onCheckedChange={(enabled) => change((d) => setFieldEnabled(d, field.key, enabled))}
                  />
                </div>
                {field.type === "select" && <EvidenceOptions field={field} onChange={change} rowError={rowError} busy={busy} />}
              </div>
            );
          })}
        </div>
      </SettingsGroup>
      <FooterBar>
        <Button type="button" variant="ghost" disabled={!dirty || busy} onClick={discard}>
          {t("admin.knowledgeFields.discard")}
        </Button>
        <Button type="button" variant="outline" disabled={!dirty || busy} onClick={() => void handleSave()}>
          {save.isPending ? t("admin.knowledgeFields.saving") : t("admin.knowledgeFields.save")}
        </Button>
      </FooterBar>
    </>
  );
}

function FooterBar({ children }: { children: ReactNode }) {
  return <div className="sticky bottom-0 -mx-1 flex justify-end gap-2 bg-card px-1 py-3 max-sm:bg-popover [&>button]:max-sm:flex-1">{children}</div>;
}

export function SettingsKnowledgeFieldsSection() {
  const { t } = useTranslation();
  const query = useAdminKnowledgeFields();
  const queryClient = useQueryClient();
  const [epoch, setEpoch] = useState(0);
  // The editor copies `initial` once, so it is remounted after the fresh data arrives; a failed fetch throws and keeps the draft.
  async function refresh(): Promise<void> {
    await queryClient.fetchQuery({ queryKey: ADMIN_KNOWLEDGE_FIELDS_QUERY_KEY, queryFn: fetchAdminKnowledgeFields, staleTime: 0 });
    setEpoch((e) => e + 1);
  }
  let body: ReactNode;
  if (query.isPending) {
    body = (
      <SettingsGroup>
        <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
      </SettingsGroup>
    );
  } else if (query.data === undefined) {
    body = (
      <SettingsGroup>
        <p role="alert" className="text-sm text-destructive">
          {t("admin.knowledgeFields.loadFailed")}
        </p>
        <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void query.refetch()}>
          {t("admin.knowledgeFields.retry")}
        </Button>
      </SettingsGroup>
    );
  } else {
    body = <FieldsEditor key={epoch} initial={query.data} onStale={refresh} />;
  }
  return (
    <SettingsPage title={t("admin.knowledgeFields.title")} description={t("admin.knowledgeFields.description")}>
      {body}
    </SettingsPage>
  );
}

import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  KNOWLEDGE_CUSTOM_ENABLED_MAX,
  KNOWLEDGE_CUSTOM_FIELD_TYPES,
  KNOWLEDGE_CUSTOM_TOTAL_MAX,
  KNOWLEDGE_FIELD_NAME_MAX,
  KNOWLEDGE_KEY_RE,
  KNOWLEDGE_OPTIONS_MAX,
  KNOWLEDGE_RESERVED_EVIDENCE_KEYS,
  type AdminKnowledgeFieldsDto,
  type KnowledgeCustomFieldType,
  type KnowledgeFieldKey,
} from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { ADMIN_KNOWLEDGE_FIELDS_QUERY_KEY, fetchAdminKnowledgeFields, useAdminKnowledgeFields, useSaveSiteKnowledgeFields } from "@/api/admin-knowledge-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { RowIconButton } from "@/components/ui/row-icon-button";
import { Plus } from "@/components/ui/icons";
import { ArrowDown, ArrowUp, Lock } from "@/components/ui/icons-extra";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";
import {
  addCustomField,
  addOption,
  draftFromAdmin,
  enabledCustomCount,
  fieldSlug,
  inputFromDraft,
  moveField,
  moveOption,
  setCustomKey,
  setCustomName,
  setFieldEnabled,
  setOptionEnabled,
  setOptionKey,
  setOptionName,
  slugFromName,
  takenFieldSlugs,
  type KnowledgeFieldsDraft,
  type KnowledgeFieldsDraftField,
} from "./knowledge-fields-draft";
import "@/i18n/management-strings";

const BUILTIN_ORDER: readonly KnowledgeFieldKey[] = ["when", "conclusion", "evidence", "verified", "superseded_by"];
const BUILTIN_OPTION_KEYS: ReadonlySet<string> = new Set(["tested", "docs", "inferred"]);
const RESERVED: ReadonlySet<string> = new Set(KNOWLEDGE_RESERVED_EVIDENCE_KEYS);

/** `field` is the position in the draft: a new custom field's key is not unique while it is typed. */
interface RowError { field: number; index: number; message: string; on: "name" | "key" }
interface FieldError { index: number; message: string; on: "name" | "key" }

function saveErrorMessage(t: TFunction, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/** The server names no row, so the row is found by re-checking the draft the same way the server does. */
function findOffendingOption(draft: KnowledgeFieldsDraft, code: string): { field: number; index: number } | null {
  for (const [fieldIndex, field] of draft.fields.entries()) {
    const seen = new Set<string>();
    for (const [index, option] of field.options.entries()) {
      const bad =
        code === "knowledge_key_invalid"
          ? !KNOWLEDGE_KEY_RE.test(option.key) || (option.isNew && field.key === "evidence" && RESERVED.has(option.key))
          : seen.has(option.key);
      if (bad) return { field: fieldIndex, index };
      seen.add(option.key);
    }
  }
  return null;
}

function findOffendingField(draft: KnowledgeFieldsDraft, code: string): number | null {
  const seen = new Set<string>();
  for (const [index, field] of draft.fields.entries()) {
    if (field.builtin) continue;
    const slug = fieldSlug(field.key);
    if (code === "knowledge_key_invalid" ? !KNOWLEDGE_KEY_RE.test(slug) : seen.has(slug)) return index;
    seen.add(slug);
  }
  return null;
}

function keyProblem(slug: string, taken: ReadonlySet<string>): "fieldKeyMissing" | "fieldKeyInvalid" | "fieldKeyTaken" | null {
  if (slug === "") return "fieldKeyMissing";
  if (!KNOWLEDGE_KEY_RE.test(slug)) return "fieldKeyInvalid";
  return taken.has(slug) ? "fieldKeyTaken" : null;
}

type Change = (apply: (draft: KnowledgeFieldsDraft) => KnowledgeFieldsDraft) => void;

function OptionRow({
  field,
  fieldIndex,
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
  fieldIndex: number;
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
  const defaultName = field.builtin && BUILTIN_OPTION_KEYS.has(option.key) && !option.isNew ? t(`admin.knowledgeFields.defaultOption.${option.key}`) : undefined;
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
        onChange={(e) => onChange((d) => setOptionName(d, fieldIndex, index, clampName(e.target.value)))}
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
            onChange={(e) => onChange((d) => setOptionKey(d, fieldIndex, index, e.target.value))}
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
            onCheckedChange={(enabled) => onChange((d) => setOptionEnabled(d, fieldIndex, index, enabled))}
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

function OptionsEditor({
  field,
  fieldIndex,
  hint,
  onChange,
  rowError,
  busy,
}: {
  field: KnowledgeFieldsDraftField;
  fieldIndex: number;
  hint: string;
  onChange: Change;
  rowError: RowError | null;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const full = field.options.length >= KNOWLEDGE_OPTIONS_MAX;
  const errorHere = rowError?.field === fieldIndex ? rowError : null;
  return (
    <div className="my-2 ml-5 border-l-2 border-border pl-4">
      <h3 className="text-xs font-semibold text-muted-foreground">{t("admin.knowledgeFields.optionsHeading")}</h3>
      <ul className="mt-1.5">
        {field.options.map((option, index) => (
          <OptionRow
            key={option.uid ?? option.key}
            field={field}
            fieldIndex={fieldIndex}
            index={index}
            busy={busy}
            canUp={index > 0}
            canDown={index < field.options.length - 1}
            error={errorHere?.index === index ? errorHere.message : undefined}
            errorOn={errorHere?.index === index ? errorHere.on : undefined}
            onChange={onChange}
            onMove={(by) => onChange((d) => moveOption(d, fieldIndex, index, by))}
          />
        ))}
      </ul>
      <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" disabled={busy || full} onClick={() => onChange((d) => addOption(d, fieldIndex))}>
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

function CustomFieldRow({
  field,
  index,
  canUp,
  canDown,
  atLimit,
  busy,
  error,
  rowError,
  onChange,
}: {
  field: KnowledgeFieldsDraftField;
  index: number;
  canUp: boolean;
  canDown: boolean;
  atLimit: boolean;
  busy: boolean;
  error: FieldError | null;
  rowError: RowError | null;
  onChange: Change;
}) {
  const { t } = useTranslation();
  const slug = fieldSlug(field.key);
  const label = field.name.trim() || slug;
  const blocked = !field.enabled && atLimit;
  return (
    <div className={cn("py-2.5", field.isNew && "-mx-1.5 rounded-lg bg-brand-soft px-1.5")}>
      <div className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[auto_auto_minmax(0,1fr)_5.5rem_9.5rem_auto]">
        <RowIconButton label={t("admin.knowledgeFields.moveUp")} icon={<ArrowUp className="h-3.5 w-3.5" />} disabled={busy || !canUp} onClick={() => onChange((d) => moveField(d, index, -1))} />
        <RowIconButton label={t("admin.knowledgeFields.moveDown")} icon={<ArrowDown className="h-3.5 w-3.5" />} disabled={busy || !canDown} onClick={() => onChange((d) => moveField(d, index, 1))} />
        <Input
          aria-label={t("admin.knowledgeFields.fieldName")}
          aria-invalid={error?.on === "name" || undefined}
          disabled={busy}
          className={cn(error?.on === "name" && "border-destructive ring-1 ring-destructive")}
          value={field.name}
          onChange={(e) => onChange((d) => setCustomName(d, index, clampName(e.target.value)))}
        />
        <div className="col-start-3 flex min-w-0 items-center gap-3 sm:contents">
          <span className="shrink-0 text-xs text-muted-foreground">{t(`admin.knowledgeFields.type.${field.type}`)}</span>
          {field.isNew ? (
            <Input
              aria-label={t("admin.knowledgeFields.fieldKey")}
              aria-invalid={error?.on === "key" || undefined}
              disabled={busy}
              className={cn("min-w-0 flex-1 font-mono text-[13px] sm:flex-none", error?.on === "key" && "border-destructive ring-1 ring-destructive")}
              value={slug}
              placeholder={t("admin.knowledgeFields.keyPlaceholder")}
              onChange={(e) => onChange((d) => setCustomKey(d, index, e.target.value))}
            />
          ) : (
            <Input aria-label={t("admin.knowledgeFields.fieldKey")} readOnly className="min-w-0 flex-1 bg-muted font-mono text-[13px] text-muted-foreground sm:flex-none" value={slug} />
          )}
          <label className="flex shrink-0 items-center justify-end gap-1.5 text-xs text-muted-foreground">
            {t("admin.knowledgeFields.optionShow")}
            <Switch
              aria-label={t("admin.knowledgeFields.toggle", { name: label })}
              disabled={busy || blocked}
              checked={field.enabled}
              onCheckedChange={(enabled) => onChange((d) => setFieldEnabled(d, index, enabled))}
            />
          </label>
        </div>
      </div>
      {error !== null && (
        <p role="alert" className="mt-1 text-sm text-destructive sm:ml-[4.5rem]">
          {error.message}
        </p>
      )}
      {blocked && <p className="mt-1 text-xs text-amber-700 sm:ml-[4.5rem] dark:text-amber-400">{t("admin.knowledgeFields.limitOffHint", { max: KNOWLEDGE_CUSTOM_ENABLED_MAX })}</p>}
      {field.type === "select" && <OptionsEditor field={field} fieldIndex={index} hint={t("admin.knowledgeFields.formOptionsHint")} onChange={onChange} rowError={rowError} busy={busy} />}
    </div>
  );
}

interface AddFormState {
  name: string;
  type: KnowledgeCustomFieldType;
  key: string;
  keyEdited: boolean;
  /** One select field standing in for the new field's options, so the option editor and draft helpers are reused as they are. */
  options: KnowledgeFieldsDraft;
}

const emptyForm = (): AddFormState => ({
  name: "",
  type: "text",
  key: "",
  keyEdited: false,
  options: { fields: [{ key: "x-new", enabled: true, name: "", type: "select", builtin: false, options: [] }] },
});

interface FormErrors { name?: string; key?: string; options?: string; option: RowError | null }

function AddFieldForm({ draft, busy, onAdd, onCancel }: { draft: KnowledgeFieldsDraft; busy: boolean; onAdd: Change; onCancel: () => void }) {
  const { t } = useTranslation();
  const [form, setForm] = useState<AddFormState>(emptyForm);
  const [errors, setErrors] = useState<FormErrors>({ option: null });
  const typeOptions = KNOWLEDGE_CUSTOM_FIELD_TYPES.map((value) => ({ value, label: t(`admin.knowledgeFields.type.${value}`) }));
  const optionsField = form.options.fields[0]!;

  function setName(name: string): void {
    setErrors({ option: null });
    setForm((f) => ({
      ...f,
      name,
      key: f.keyEdited ? f.key : name.trim() === "" ? "" : slugFromName(name, takenFieldSlugs(draft), f.key),
    }));
  }

  function submit(): void {
    const next: FormErrors = { option: null };
    const name = form.name.trim();
    if (name === "") next.name = t("admin.knowledgeFields.fieldNameMissing");
    const problem = keyProblem(form.key, takenFieldSlugs(draft));
    if (problem !== null) next.key = t(`admin.knowledgeFields.${problem}`);
    if (form.type === "select") {
      const opts = optionsField.options;
      if (opts.length === 0) next.options = t("admin.knowledgeFields.selectNeedsOption");
      const seen = new Set<string>();
      for (const [index, o] of opts.entries()) {
        const nameMissing = o.name.trim() === "";
        const keyIssue = o.key.trim() === "" ? "keyMissing" : !KNOWLEDGE_KEY_RE.test(o.key) ? "knowledge_key_invalid" : seen.has(o.key) ? "knowledge_key_taken" : null;
        seen.add(o.key);
        if (nameMissing || keyIssue !== null) {
          next.option = {
            field: 0,
            index,
            on: nameMissing ? "name" : "key",
            message: nameMissing ? t("admin.knowledgeFields.nameMissing") : keyIssue === "keyMissing" ? t("admin.knowledgeFields.keyMissing") : t(`errors.${keyIssue}`),
          };
          break;
        }
      }
    }
    if (next.name !== undefined || next.key !== undefined || next.options !== undefined || next.option !== null) {
      setErrors(next);
      return;
    }
    onAdd((d) =>
      addCustomField(d, {
        name,
        type: form.type,
        key: form.key,
        options: form.type === "select" ? optionsField.options.map((o) => ({ key: o.key, name: o.name.trim() })) : undefined,
      }),
    );
    onCancel();
  }

  return (
    <div className="mt-4 rounded-lg border border-border bg-muted/30 p-4">
      <h3 className="text-sm font-semibold">{t("admin.knowledgeFields.formTitle")}</h3>
      <div className="mt-3 grid gap-x-4 gap-y-3 sm:grid-cols-[6rem_minmax(0,1fr)]">
        <label htmlFor="kf-new-name" className="text-sm text-muted-foreground sm:pt-1.5">
          {t("admin.knowledgeFields.formName")}
        </label>
        <div>
          <Input
            id="kf-new-name"
            aria-invalid={errors.name !== undefined || undefined}
            disabled={busy}
            className={cn(errors.name !== undefined && "border-destructive ring-1 ring-destructive")}
            value={form.name}
            placeholder={t("admin.knowledgeFields.formNamePlaceholder")}
            onChange={(e) => setName(clampName(e.target.value))}
          />
          {errors.name !== undefined && (
            <p role="alert" className="mt-1 text-sm text-destructive">
              {errors.name}
            </p>
          )}
        </div>
        <label htmlFor="kf-new-type" className="text-sm text-muted-foreground sm:pt-1.5">
          {t("admin.knowledgeFields.formType")}
        </label>
        <div>
          <Select
            id="kf-new-type"
            variant="field"
            className="w-48"
            disabled={busy}
            options={typeOptions}
            value={form.type}
            onValueChange={(type) => {
              setErrors({ option: null });
              setForm((f) => ({ ...f, type: type as KnowledgeCustomFieldType }));
            }}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t("admin.knowledgeFields.formTypeHint")}</p>
        </div>
        <label htmlFor="kf-new-key" className="text-sm text-muted-foreground sm:pt-1.5">
          {t("admin.knowledgeFields.formKey")}
        </label>
        <div>
          <Input
            id="kf-new-key"
            aria-invalid={errors.key !== undefined || undefined}
            disabled={busy}
            className={cn("font-mono text-[13px]", errors.key !== undefined && "border-destructive ring-1 ring-destructive")}
            value={form.key}
            placeholder={t("admin.knowledgeFields.keyPlaceholder")}
            onChange={(e) => {
              setErrors({ option: null });
              setForm((f) => ({ ...f, key: e.target.value, keyEdited: true }));
            }}
          />
          {errors.key !== undefined && (
            <p role="alert" className="mt-1 text-sm text-destructive">
              {errors.key}
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">{t("admin.knowledgeFields.formKeyHint")}</p>
        </div>
        {form.type === "select" && (
          <>
            <span className="text-sm text-muted-foreground sm:pt-1.5">{t("admin.knowledgeFields.formOptions")}</span>
            <div>
              <OptionsEditor
                field={optionsField}
                fieldIndex={0}
                hint={t("admin.knowledgeFields.formOptionsHint")}
                busy={busy}
                rowError={errors.option}
                onChange={(apply) => {
                  setErrors({ option: null });
                  setForm((f) => ({ ...f, options: apply(f.options) }));
                }}
              />
              {errors.options !== undefined && (
                <p role="alert" className="text-sm text-destructive">
                  {errors.options}
                </p>
              )}
            </div>
          </>
        )}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          {t("admin.knowledgeFields.formCancel")}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={submit}>
          {t("admin.knowledgeFields.formAdd")}
        </Button>
      </div>
    </div>
  );
}

function CustomFieldsGroup({ draft, busy, fieldError, rowError, onChange }: { draft: KnowledgeFieldsDraft; busy: boolean; fieldError: FieldError | null; rowError: RowError | null; onChange: Change }) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const custom = draft.fields.flatMap((f, index) => (f.builtin ? [] : [{ field: f, index }]));
  const enabled = enabledCustomCount(draft);
  const atEnabledLimit = enabled >= KNOWLEDGE_CUSTOM_ENABLED_MAX;
  const totalFull = custom.length >= KNOWLEDGE_CUSTOM_TOTAL_MAX;
  return (
    <SettingsGroup
      title={t("admin.knowledgeFields.customHeading")}
      description={t("admin.knowledgeFields.customDescription")}
      action={
        <span className={cn("text-sm tabular-nums text-muted-foreground", atEnabledLimit && "font-semibold text-amber-700 dark:text-amber-400")}>
          {t("admin.knowledgeFields.customCount", { count: enabled, max: KNOWLEDGE_CUSTOM_ENABLED_MAX })}
        </span>
      }
    >
      {custom.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("admin.knowledgeFields.customEmpty")}</p>
      ) : (
        <div className="divide-y divide-border">
          {custom.map(({ field, index }, position) => (
            <CustomFieldRow
              key={field.uid ?? field.key}
              field={field}
              index={index}
              canUp={position > 0}
              canDown={position < custom.length - 1}
              atLimit={atEnabledLimit}
              busy={busy}
              error={fieldError?.index === index ? fieldError : null}
              rowError={rowError}
              onChange={onChange}
            />
          ))}
        </div>
      )}
      {adding ? (
        <AddFieldForm draft={draft} busy={busy} onAdd={onChange} onCancel={() => setAdding(false)} />
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" size="sm" disabled={busy || totalFull} onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" />
            {t("admin.knowledgeFields.addField")}
          </Button>
          {totalFull ? (
            <span className="text-xs text-muted-foreground">{t("admin.knowledgeFields.totalFull", { max: KNOWLEDGE_CUSTOM_TOTAL_MAX })}</span>
          ) : (
            atEnabledLimit && <span className="text-xs text-muted-foreground">{t("admin.knowledgeFields.newFieldOffNote", { max: KNOWLEDGE_CUSTOM_ENABLED_MAX })}</span>
          )}
        </div>
      )}
    </SettingsGroup>
  );
}

function FieldsEditor({ initial, onStale }: { initial: AdminKnowledgeFieldsDto; onStale: () => Promise<void> }) {
  const { t } = useTranslation();
  const save = useSaveSiteKnowledgeFields();
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState<KnowledgeFieldsDraft>(() => draftFromAdmin(initial));
  const [rowError, setRowError] = useState<RowError | null>(null);
  const [fieldError, setFieldError] = useState<FieldError | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const busy = save.isPending || refreshing;

  const dirty = JSON.stringify(inputFromDraft(draft)) !== JSON.stringify(inputFromDraft(draftFromAdmin(saved)));

  function change(apply: (draft: KnowledgeFieldsDraft) => KnowledgeFieldsDraft): void {
    setDraft(apply);
    setRowError(null);
    setFieldError(null);
  }

  function discard(): void {
    setDraft(draftFromAdmin(saved));
    setRowError(null);
    setFieldError(null);
  }

  async function handleSave(): Promise<void> {
    setRowError(null);
    setFieldError(null);
    for (const [fieldIndex, field] of draft.fields.entries()) {
      if (!field.builtin) {
        const nameMissing = field.name.trim() === "";
        const problem = nameMissing ? null : field.isNew ? keyProblem(fieldSlug(field.key), takenFieldSlugs(draft, fieldIndex)) : null;
        if (nameMissing || problem !== null) {
          setFieldError({ index: fieldIndex, on: nameMissing ? "name" : "key", message: t(`admin.knowledgeFields.${nameMissing ? "fieldNameMissing" : problem!}`) });
          return;
        }
      }
      const index = field.options.findIndex((o) => (o.isNew || !field.builtin || !BUILTIN_OPTION_KEYS.has(o.key)) && (o.key.trim() === "" || o.name.trim() === ""));
      if (index >= 0) {
        const nameMissing = field.options[index]!.name.trim() === "";
        setRowError({ field: fieldIndex, index, on: nameMissing ? "name" : "key", message: t(nameMissing ? "admin.knowledgeFields.nameMissing" : "admin.knowledgeFields.keyMissing") });
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
      const keyCode = code === "knowledge_key_invalid" || code === "knowledge_key_taken";
      const fieldRow = keyCode ? findOffendingField(draft, code) : null;
      const row = keyCode && fieldRow === null ? findOffendingOption(draft, code) : null;
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
      if (fieldRow !== null) setFieldError({ index: fieldRow, on: "key", message: t(code === "knowledge_key_invalid" ? "admin.knowledgeFields.fieldKeyInvalid" : "admin.knowledgeFields.fieldKeyTaken") });
      else if (row !== null) setRowError({ ...row, on: "key", message: t(`errors.${code}`) });
      else toast({ title: saveErrorMessage(t, err), variant: "destructive" });
    }
  }

  const builtin = BUILTIN_ORDER.flatMap((key) => {
    const index = draft.fields.findIndex((f) => f.key === key);
    return index >= 0 ? [{ field: draft.fields[index]!, index }] : [];
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
          {builtin.map(({ field, index }) => {
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
                    onCheckedChange={(enabled) => change((d) => setFieldEnabled(d, index, enabled))}
                  />
                </div>
                {field.type === "select" && <OptionsEditor field={field} fieldIndex={index} hint={t("admin.knowledgeFields.optionsHint")} onChange={change} rowError={rowError} busy={busy} />}
              </div>
            );
          })}
        </div>
      </SettingsGroup>
      <CustomFieldsGroup draft={draft} busy={busy} fieldError={fieldError} rowError={rowError} onChange={change} />
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

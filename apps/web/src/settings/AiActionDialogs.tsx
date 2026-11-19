import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { AdminAiActionDto, AdminAiModelDto } from "@knotebook/shared";
import { Select } from "@/components/ui/select";
import { useCreateAiAction, useDeleteAiAction, usePatchAiAction } from "@/api/adminAi";
import { Button } from "@/components/ui/button";
import { Pencil, Trash } from "@/components/ui/icons";
import { ArrowDown, ArrowUp } from "@/components/ui/icons-extra";
import { RowIconButton } from "@/components/ui/row-icon-button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { errorMessage } from "./ai-error-message";
import "@/i18n/management-strings";

const TEXTAREA_CLASS =
  "flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm pointer-coarse:text-base shadow-sm transition-colors " +
  "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring " +
  "disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Empty value is `settings.ai.modelAuto` (automatic, preferring the default model). Don't shorten that label to "default
 * model": the phrase describes the fallback preference, not the option itself.
 */
function ModelSelectField({
  id,
  models,
  value,
  onChange,
}: {
  id: string;
  models: AdminAiModelDto[];
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Select
      variant="field"
      id={id}
      className="w-full"
      value={value}
      onValueChange={onChange}
      options={[
        { value: "", label: t("settings.ai.modelAuto") },
        ...models.map((model) => ({ value: model.id, label: model.displayName })),
      ]}
    />
  );
}

/**
 * New actions append at the end (the caller passes current max + 1): `sortOrder` has no DB unique constraint, and omitting
 * it makes the server use `sortOrder ?? 0`, tying with built-ins such as Rewrite. The move buttons swap neighbours'
 * `sortOrder` values, so swapping equal values does nothing: both PATCHes succeed and the reorder silently fails.
 */
export function CreateActionDialog({ models, nextSortOrder }: { models: AdminAiModelDto[]; nextSortOrder: number }) {
  const { t } = useTranslation();
  const createAction = useCreateAiAction();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [userTemplate, setUserTemplate] = useState("");
  const [modelId, setModelId] = useState("");
  const [applyMode, setApplyMode] = useState<AdminAiActionDto["applyMode"]>("direct");
  const [error, setError] = useState<string | null>(null);

  function resetForm(): void {
    setName("");
    setSystemPrompt("");
    setUserTemplate("");
    setModelId("");
    setApplyMode("direct");
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      await createAction.mutateAsync({
        name,
        systemPrompt,
        userTemplate,
        modelId: modelId.length > 0 ? modelId : null,
        applyMode,
        sortOrder: nextSortOrder,
      });
      resetForm();
      setOpen(false);
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) resetForm();
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          {t("settings.ai.addAction")}
        </Button>
      </DialogTrigger>
      <DialogContent dismissOnOutside={false}>
        <DialogHeader>
          <DialogTitle>{t("settings.ai.addAction")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="ai-action-name" className="text-sm font-medium">
              {t("settings.ai.actionName")}
            </label>
            <Input id="ai-action-name" required value={name} onChange={(event) => setName(event.target.value)} />
          </div>

          <div className="space-y-1">
            <label htmlFor="ai-action-system-prompt" className="text-sm font-medium">
              {t("settings.ai.actionSystemPrompt")}
            </label>
            <textarea
              id="ai-action-system-prompt"
              required
              rows={3}
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              className={TEXTAREA_CLASS}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="ai-action-user-template" className="text-sm font-medium">
              {t("settings.ai.actionUserTemplate")}
            </label>
            <textarea
              id="ai-action-user-template"
              required
              rows={3}
              value={userTemplate}
              onChange={(event) => setUserTemplate(event.target.value)}
              className={TEXTAREA_CLASS}
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.ai.actionUserTemplateHint", { placeholder: "{{text}}" })}
            </p>
          </div>

          <div className="space-y-1">
            <label htmlFor="ai-action-apply-mode" className="text-sm font-medium">
              {t("settings.ai.actionApplyMode")}
            </label>
            <Select
              variant="field"
              id="ai-action-apply-mode"
              className="w-full"
              value={applyMode}
              onValueChange={(next) => setApplyMode(next as AdminAiActionDto["applyMode"])}
              options={[
                { value: "direct", label: t("settings.ai.actionApplyModeDirect") },
                { value: "preview", label: t("settings.ai.actionApplyModePreview") },
              ]}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="ai-action-model" className="text-sm font-medium">
              {t("settings.ai.actionModel")}
            </label>
            <ModelSelectField id="ai-action-model" models={models} value={modelId} onChange={setModelId} />
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="submit" variant="brandDeep" disabled={createAction.isPending}>
              {createAction.isPending ? t("settings.ai.creating") : t("settings.ai.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditActionDialog({ action, models }: { action: AdminAiActionDto; models: AdminAiModelDto[] }) {
  const { t } = useTranslation();
  const patchAction = usePatchAiAction();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(action.name);
  const [systemPrompt, setSystemPrompt] = useState(action.systemPrompt);
  const [userTemplate, setUserTemplate] = useState(action.userTemplate);
  const [modelId, setModelId] = useState(action.modelId ?? "");
  const [applyMode, setApplyMode] = useState<AdminAiActionDto["applyMode"]>(action.applyMode);
  const [error, setError] = useState<string | null>(null);
  // Built-in Instruct is always preview: no apply-mode control, and the PATCH omits applyMode.
  const isInstruct = action.kind === "instruct";

  function handleOpenChange(next: boolean): void {
    setOpen(next);
    if (next) {
      setName(action.name);
      setSystemPrompt(action.systemPrompt);
      setUserTemplate(action.userTemplate);
      setModelId(action.modelId ?? "");
      setApplyMode(action.applyMode);
      setError(null);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      await patchAction.mutateAsync({
        id: action.id,
        body: {
          name,
          systemPrompt,
          userTemplate,
          modelId: modelId.length > 0 ? modelId : null,
          ...(isInstruct ? {} : { applyMode }),
        },
      });
      setOpen(false);
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <RowIconButton label={t("settings.ai.edit")} icon={<Pencil className="h-4 w-4" />} />
      </DialogTrigger>
      <DialogContent dismissOnOutside={false}>
        <DialogHeader>
          <DialogTitle>{t("settings.ai.editAction")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor={`ai-action-edit-name-${action.id}`} className="text-sm font-medium">
              {t("settings.ai.actionName")}
            </label>
            <Input
              id={`ai-action-edit-name-${action.id}`}
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor={`ai-action-edit-system-prompt-${action.id}`} className="text-sm font-medium">
              {t("settings.ai.actionSystemPrompt")}
            </label>
            <textarea
              id={`ai-action-edit-system-prompt-${action.id}`}
              required
              rows={3}
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              className={TEXTAREA_CLASS}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor={`ai-action-edit-user-template-${action.id}`} className="text-sm font-medium">
              {t("settings.ai.actionUserTemplate")}
            </label>
            <textarea
              id={`ai-action-edit-user-template-${action.id}`}
              required
              rows={3}
              value={userTemplate}
              onChange={(event) => setUserTemplate(event.target.value)}
              className={TEXTAREA_CLASS}
            />
            <p data-testid="ai-action-edit-template-hint" className="text-xs text-muted-foreground">
              {isInstruct
                ? t("settings.ai.actionUserTemplateHintInstruct", { instruction: "{{instruction}}", focus: "{{focus}}", text: "{{text}}" })
                : t("settings.ai.actionUserTemplateHint", { placeholder: "{{text}}" })}
            </p>
          </div>

          {!isInstruct && (
            <div className="space-y-1">
              <label htmlFor={`ai-action-edit-apply-mode-${action.id}`} className="text-sm font-medium">
                {t("settings.ai.actionApplyMode")}
              </label>
              <Select
                variant="field"
                id={`ai-action-edit-apply-mode-${action.id}`}
                className="w-full"
                value={applyMode}
                onValueChange={(next) => setApplyMode(next as AdminAiActionDto["applyMode"])}
                options={[
                  { value: "direct", label: t("settings.ai.actionApplyModeDirect") },
                  { value: "preview", label: t("settings.ai.actionApplyModePreview") },
                ]}
              />
            </div>
          )}

          <div className="space-y-1">
            <label htmlFor={`ai-action-edit-model-${action.id}`} className="text-sm font-medium">
              {t("settings.ai.actionModel")}
            </label>
            <ModelSelectField id={`ai-action-edit-model-${action.id}`} models={models} value={modelId} onChange={setModelId} />
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="submit" variant="brandDeep" disabled={patchAction.isPending}>
              {patchAction.isPending ? t("settings.ai.saving") : t("settings.ai.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Mounted only for non-built-in actions; the server enforces it too (`BUILTIN_ACTION_IDS` in `routes/admin-ai.ts`). */
function DeleteActionDialog({ action }: { action: AdminAiActionDto }) {
  const { t } = useTranslation();
  const deleteAction = useDeleteAiAction();
  const [open, setOpen] = useState(false);

  async function handleConfirm(): Promise<void> {
    try {
      await deleteAction.mutateAsync(action.id);
      setOpen(false);
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <RowIconButton label={t("settings.ai.delete")} tone="destructive" icon={<Trash className="h-4 w-4" />} />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings.ai.deleteActionTitle")}</DialogTitle>
          <DialogDescription>{t("settings.ai.deleteActionDescription", { name: action.name })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("home.cancel")}
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" onClick={() => void handleConfirm()} disabled={deleteAction.isPending}>
            {t("settings.ai.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ActionEnabledSwitch({ action, labelledBy }: { action: AdminAiActionDto; labelledBy: string }) {
  const { t } = useTranslation();
  const patchAction = usePatchAiAction();

  async function handleToggle(next: boolean): Promise<void> {
    try {
      await patchAction.mutateAsync({ id: action.id, body: { enabled: next } });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <Switch
      aria-labelledby={labelledBy}
      checked={action.enabled}
      onCheckedChange={(checked) => void handleToggle(checked)}
      disabled={patchAction.isPending}
    />
  );
}

/** Move buttons use native `disabled` (transient) at list edges or while the two PATCHes are in flight. */
export function ActionButtons({
  action,
  models,
  canMoveUp,
  canMoveDown,
  movePending,
  onMove,
}: {
  action: AdminAiActionDto;
  models: AdminAiModelDto[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  movePending: boolean;
  onMove: (direction: "up" | "down") => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <RowIconButton
        label={t("settings.ai.moveUp", { name: action.name })}
        icon={<ArrowUp className="h-4 w-4" />}
        disabled={!canMoveUp || movePending}
        onClick={() => onMove("up")}
      />
      <RowIconButton
        label={t("settings.ai.moveDown", { name: action.name })}
        icon={<ArrowDown className="h-4 w-4" />}
        disabled={!canMoveDown || movePending}
        onClick={() => onMove("down")}
      />
      <EditActionDialog action={action} models={models} />
      {!action.builtin && <DeleteActionDialog action={action} />}
    </>
  );
}

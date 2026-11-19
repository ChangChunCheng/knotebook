import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { AdminAiModelDto, AdminAiProviderDto } from "@knotebook/shared";
import { useCreateAiModel, useDeleteAiModel, usePatchAiModel } from "@/api/adminAi";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Pencil, Trash } from "@/components/ui/icons";
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
import { SettingsTable, type SettingsTableColumn, type SettingsTableRow } from "@/components/management/SettingsTable";
import { errorMessage } from "./ai-error-message";
import "@/i18n/management-strings";

function CreateModelDialog({ providerId }: { providerId: string }) {
  const { t } = useTranslation();
  const createModel = useCreateAiModel();
  const [open, setOpen] = useState(false);
  const [modelId, setModelId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resetForm(): void {
    setModelId("");
    setDisplayName("");
    setIsDefault(false);
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      await createModel.mutateAsync({ providerId, modelId, displayName, isDefault });
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
          {t("settings.ai.addModel")}
        </Button>
      </DialogTrigger>
      <DialogContent dismissOnOutside={false}>
        <DialogHeader>
          <DialogTitle>{t("settings.ai.addModel")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor={`ai-model-id-${providerId}`} className="text-sm font-medium">
              {t("settings.ai.modelIdLabel")}
            </label>
            <Input
              id={`ai-model-id-${providerId}`}
              required
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor={`ai-model-display-name-${providerId}`} className="text-sm font-medium">
              {t("settings.ai.modelDisplayName")}
            </label>
            <Input
              id={`ai-model-display-name-${providerId}`}
              required
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id={`ai-model-is-default-${providerId}`}
              checked={isDefault}
              onCheckedChange={(checked) => setIsDefault(checked === true)}
            />
            <label htmlFor={`ai-model-is-default-${providerId}`} className="text-sm font-medium">
              {t("settings.ai.modelIsDefault")}
            </label>
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="submit" variant="brandDeep" disabled={createModel.isPending}>
              {createModel.isPending ? t("settings.ai.creating") : t("settings.ai.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditModelDialog({ model }: { model: AdminAiModelDto }) {
  const { t } = useTranslation();
  const patchModel = usePatchAiModel();
  const [open, setOpen] = useState(false);
  const [modelId, setModelId] = useState(model.modelId);
  const [displayName, setDisplayName] = useState(model.displayName);
  const [isDefault, setIsDefault] = useState(model.isDefault);
  const [error, setError] = useState<string | null>(null);

  function handleOpenChange(next: boolean): void {
    setOpen(next);
    if (next) {
      setModelId(model.modelId);
      setDisplayName(model.displayName);
      setIsDefault(model.isDefault);
      setError(null);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      await patchModel.mutateAsync({ id: model.id, body: { modelId, displayName, isDefault } });
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
          <DialogTitle>{t("settings.ai.editModel")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor={`ai-model-edit-id-${model.id}`} className="text-sm font-medium">
              {t("settings.ai.modelIdLabel")}
            </label>
            <Input
              id={`ai-model-edit-id-${model.id}`}
              required
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor={`ai-model-edit-display-name-${model.id}`} className="text-sm font-medium">
              {t("settings.ai.modelDisplayName")}
            </label>
            <Input
              id={`ai-model-edit-display-name-${model.id}`}
              required
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id={`ai-model-edit-is-default-${model.id}`}
              checked={isDefault}
              onCheckedChange={(checked) => setIsDefault(checked === true)}
            />
            <label htmlFor={`ai-model-edit-is-default-${model.id}`} className="text-sm font-medium">
              {t("settings.ai.modelIsDefault")}
            </label>
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="submit" variant="brandDeep" disabled={patchModel.isPending}>
              {patchModel.isPending ? t("settings.ai.saving") : t("settings.ai.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteModelDialog({ model }: { model: AdminAiModelDto }) {
  const { t } = useTranslation();
  const deleteModel = useDeleteAiModel();
  const [open, setOpen] = useState(false);

  async function handleConfirm(): Promise<void> {
    try {
      await deleteModel.mutateAsync(model.id);
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
          <DialogTitle>{t("settings.ai.deleteModelTitle")}</DialogTitle>
          <DialogDescription>{t("settings.ai.deleteModelDescription", { name: model.displayName })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("home.cancel")}
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" onClick={() => void handleConfirm()} disabled={deleteModel.isPending}>
            {t("settings.ai.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ModelEnabledSwitch({ model, labelledBy }: { model: AdminAiModelDto; labelledBy: string }) {
  const { t } = useTranslation();
  const patchModel = usePatchAiModel();

  async function handleToggle(next: boolean): Promise<void> {
    try {
      await patchModel.mutateAsync({ id: model.id, body: { enabled: next } });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <Switch
      aria-labelledby={labelledBy}
      checked={model.enabled}
      onCheckedChange={(checked) => void handleToggle(checked)}
      disabled={patchModel.isPending}
    />
  );
}

/**
 * Parent and nested tables share the 56px enable track at the far right; the action track sits left of it with buttons
 * right-aligned (2 buttons here, narrower than the parent's 3), so button right edges and switch centers line up.
 */
export function ModelsTable({ provider, models }: { provider: AdminAiProviderDto; models: AdminAiModelDto[] }) {
  const { t } = useTranslation();
  const columns: SettingsTableColumn[] = [
    { id: "name", header: t("settings.ai.tableName"), kind: "primary" },
    { id: "actions", header: t("settings.ai.tableActions"), kind: "actions", buttons: 2 },
    { id: "enabled", header: t("settings.ai.tableEnabled"), kind: "enabled" },
  ];
  const rows: SettingsTableRow[] = models.map((model) => ({
    id: model.id,
    primary: {
      name: model.displayName,
      weight: "medium",
      badges: model.isDefault ? (
        <span title={t("settings.ai.modelDefaultBadge")} aria-label={t("settings.ai.modelDefaultBadge")}>
          ★
        </span>
      ) : undefined,
      subtitles: [model.modelId],
    },
    actions: (
      <>
        <EditModelDialog model={model} />
        <DeleteModelDialog model={model} />
      </>
    ),
    enabled: (labelledBy) => <ModelEnabledSwitch model={model} labelledBy={labelledBy} />,
  }));
  return (
    <SettingsTable
      nested
      label={`${t("settings.ai.modelsHeading")} – ${provider.name}`}
      title={t("settings.ai.modelsHeading")}
      titleAction={<CreateModelDialog providerId={provider.id} />}
      columns={columns}
      rows={rows}
      empty={t("settings.ai.modelEmpty")}
    />
  );
}

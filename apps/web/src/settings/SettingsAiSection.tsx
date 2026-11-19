import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { AdminAiActionDto, AdminAiModelDto, AdminAiProviderDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { Select } from "@/components/ui/select";
import {
  useAdminAiActions,
  useAdminAiModels,
  useAdminAiProviders,
  useCreateAiAction,
  useCreateAiModel,
  useCreateAiProvider,
  useDeleteAiAction,
  useDeleteAiModel,
  useDeleteAiProvider,
  usePatchAiAction,
  usePatchAiModel,
  usePatchAiProvider,
  useTestAiProvider,
} from "@/api/adminAi";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Pencil, Trash } from "@/components/ui/icons";
import { ArrowDown, ArrowUp, Plug } from "@/components/ui/icons-extra";
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
import { SettingsGroup, SettingsPage } from "./SettingsLayout";
import "@/i18n/management-strings";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

const TEXTAREA_CLASS =
  "flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm pointer-coarse:text-base shadow-sm transition-colors " +
  "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring " +
  "disabled:cursor-not-allowed disabled:opacity-50";

/** anthropic: official origin without `/v1` (test-connection appends `/v1/models`); openai_compatible: `/v1` is part of the path (e.g. ollama). */
function baseUrlPlaceholder(type: AdminAiProviderDto["type"]): string {
  return type === "anthropic" ? "https://api.anthropic.com" : "http://host:11434/v1";
}

/** Client-side pre-check only; the server is authoritative (same code, `base_url_has_credentials`). */
function baseUrlHasCredentials(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return u.username !== "" || u.password !== "";
  } catch {
    return false;
  }
}

function CreateProviderDialog() {
  const { t } = useTranslation();
  const createProvider = useCreateAiProvider();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<AdminAiProviderDto["type"]>("anthropic");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  function resetForm(): void {
    setName("");
    setType("anthropic");
    setBaseUrl("");
    setApiKey("");
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    if (baseUrlHasCredentials(baseUrl)) {
      setError(t("errors.base_url_has_credentials"));
      return;
    }
    const trimmedKey = apiKey.trim();
    try {
      await createProvider.mutateAsync({
        name,
        type,
        baseUrl,
        ...(trimmedKey.length > 0 ? { apiKey: trimmedKey } : {}),
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
          {t("settings.ai.addProvider")}
        </Button>
      </DialogTrigger>
      <DialogContent dismissOnOutside={false}>
        <DialogHeader>
          <DialogTitle>{t("settings.ai.addProvider")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="ai-provider-name" className="text-sm font-medium">
              {t("settings.ai.providerName")}
            </label>
            <Input id="ai-provider-name" required value={name} onChange={(event) => setName(event.target.value)} />
          </div>

          <div className="space-y-1">
            <label htmlFor="ai-provider-type" className="text-sm font-medium">
              {t("settings.ai.providerType")}
            </label>
            <Select
              variant="field"
              id="ai-provider-type"
              className="w-full"
              value={type}
              onValueChange={(next) => setType(next as AdminAiProviderDto["type"])}
              options={[
                { value: "anthropic", label: t("settings.ai.providerTypeAnthropic") },
                { value: "openai_compatible", label: t("settings.ai.providerTypeOpenAiCompatible") },
              ]}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="ai-provider-base-url" className="text-sm font-medium">
              {t("settings.ai.providerBaseUrl")}
            </label>
            <Input
              id="ai-provider-base-url"
              required
              placeholder={baseUrlPlaceholder(type)}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="ai-provider-api-key" className="text-sm font-medium">
              {t("settings.ai.apiKey")}
            </label>
            <Input
              id="ai-provider-api-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="submit" variant="brandDeep" disabled={createProvider.isPending}>
              {createProvider.isPending ? t("settings.ai.creating") : t("settings.ai.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * `apiKey` is write-only: with `hasKey` the placeholder shows `settings.ai.keySet` and never echoes any part of the key (the
 * server never selects the stored key into any response; see `providerListColumns` in `routes/admin-ai.ts`). A blank field
 * omits the key from the PATCH rather than sending "": the server's `z.string().min(1)` rejects it, and "unchanged" differs
 * from "clear", which this form doesn't offer.
 */
function EditProviderDialog({ provider }: { provider: AdminAiProviderDto }) {
  const { t } = useTranslation();
  const patchProvider = usePatchAiProvider();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(provider.name);
  const [type, setType] = useState<AdminAiProviderDto["type"]>(provider.type);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleOpenChange(next: boolean): void {
    setOpen(next);
    if (next) {
      setName(provider.name);
      setType(provider.type);
      setBaseUrl(provider.baseUrl);
      setApiKey("");
      setError(null);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    if (baseUrlHasCredentials(baseUrl)) {
      setError(t("errors.base_url_has_credentials"));
      return;
    }
    const trimmedKey = apiKey.trim();
    try {
      await patchProvider.mutateAsync({
        id: provider.id,
        body: {
          name,
          type,
          baseUrl,
          ...(trimmedKey.length > 0 ? { apiKey: trimmedKey } : {}),
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
          <DialogTitle>{t("settings.ai.editProvider")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor={`ai-provider-edit-name-${provider.id}`} className="text-sm font-medium">
              {t("settings.ai.providerName")}
            </label>
            <Input
              id={`ai-provider-edit-name-${provider.id}`}
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor={`ai-provider-edit-type-${provider.id}`} className="text-sm font-medium">
              {t("settings.ai.providerType")}
            </label>
            <Select
              variant="field"
              id={`ai-provider-edit-type-${provider.id}`}
              className="w-full"
              value={type}
              onValueChange={(next) => setType(next as AdminAiProviderDto["type"])}
              options={[
                { value: "anthropic", label: t("settings.ai.providerTypeAnthropic") },
                { value: "openai_compatible", label: t("settings.ai.providerTypeOpenAiCompatible") },
              ]}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor={`ai-provider-edit-base-url-${provider.id}`} className="text-sm font-medium">
              {t("settings.ai.providerBaseUrl")}
            </label>
            <Input
              id={`ai-provider-edit-base-url-${provider.id}`}
              required
              placeholder={baseUrlPlaceholder(type)}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
            {/* Warn beforehand, not with a toast afterwards: changing the URL invalidates the existing key, and users would first see the provider suddenly fail */}
            {provider.hasKey && baseUrl !== provider.baseUrl && apiKey.trim().length === 0 && (
              <p className="text-sm text-muted-foreground">{t("settings.ai.baseUrlChangeClearsKey")}</p>
            )}
          </div>

          <div className="space-y-1">
            <label htmlFor={`ai-provider-edit-api-key-${provider.id}`} className="text-sm font-medium">
              {t("settings.ai.apiKey")}
            </label>
            <Input
              id={`ai-provider-edit-api-key-${provider.id}`}
              type="password"
              autoComplete="off"
              placeholder={provider.hasKey ? t("settings.ai.keySet") : undefined}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="submit" variant="brandDeep" disabled={patchProvider.isPending}>
              {patchProvider.isPending ? t("settings.ai.saving") : t("settings.ai.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteProviderDialog({ provider }: { provider: AdminAiProviderDto }) {
  const { t } = useTranslation();
  const deleteProvider = useDeleteAiProvider();
  const [open, setOpen] = useState(false);

  async function handleConfirm(): Promise<void> {
    try {
      await deleteProvider.mutateAsync(provider.id);
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
          <DialogTitle>{t("settings.ai.deleteProviderTitle")}</DialogTitle>
          <DialogDescription>{t("settings.ai.deleteProviderDescription", { name: provider.name })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("home.cancel")}
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void handleConfirm()}
            disabled={deleteProvider.isPending}
          >
            {t("settings.ai.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
function ModelsTable({ provider, models }: { provider: AdminAiProviderDto; models: AdminAiModelDto[] }) {
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

/** Keyed by provider id in `SettingsAiSection`: the button and the result live in different cells. */
interface ProviderTestState {
  pending: boolean;
  result: { ok: boolean; message: string } | null;
}

function ProviderEnabledSwitch({ provider, labelledBy }: { provider: AdminAiProviderDto; labelledBy: string }) {
  const { t } = useTranslation();
  const patchProvider = usePatchAiProvider();

  async function handleToggle(next: boolean): Promise<void> {
    try {
      await patchProvider.mutateAsync({ id: provider.id, body: { enabled: next } });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <Switch
      aria-labelledby={labelledBy}
      checked={provider.enabled}
      onCheckedChange={(checked) => void handleToggle(checked)}
      disabled={patchProvider.isPending}
    />
  );
}

function ProviderActions({
  provider,
  onTestStart,
  onTestDone,
}: {
  provider: AdminAiProviderDto;
  onTestStart: () => void;
  onTestDone: (result: { ok: boolean; message: string }) => void;
}) {
  const { t } = useTranslation();
  const testProvider = useTestAiProvider();

  async function handleTest(): Promise<void> {
    onTestStart();
    try {
      await testProvider.mutateAsync(provider.id);
      onTestDone({ ok: true, message: t("settings.ai.testSuccess") });
    } catch (err) {
      onTestDone({ ok: false, message: errorMessage(t, err) });
    }
  }

  return (
    <>
      <RowIconButton
        label={t("settings.ai.test")}
        icon={<Plug className="h-4 w-4" />}
        onClick={() => void handleTest()}
        disabled={testProvider.isPending}
      />
      <EditProviderDialog provider={provider} />
      <DeleteProviderDialog provider={provider} />
    </>
  );
}

/** Laid out across the full table width, so on narrow screens part of it needs scrolling (accepted trade-off). */
function ProviderDetail({
  provider,
  models,
  test,
}: {
  provider: AdminAiProviderDto;
  models: AdminAiModelDto[];
  test: ProviderTestState | undefined;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <div className="space-y-2 px-3 text-xs">
        {provider.degraded && (
          <p role="alert" className="text-destructive">
            {t("settings.ai.degradedBadge")}: {t("settings.ai.degradedNotice")}
          </p>
        )}

        {/* Key status on the card: changing the URL clears the key, which otherwise had no UI trace, and the degraded notice
            disappears at the same moment (no key means nothing fails to decrypt). Neutral wording only: `hasKey` can't tell
            "never had one" (valid for unauthenticated self-hosted services, per `docs/ai.md`) from "just cleared", so it must not
            predict consequences or say "until re-entered", which would be false for a keyless Ollama provider and never go away.
            Hidden when degraded, which already says the same thing. */}
        {!provider.hasKey && !provider.degraded && (
          <p role="status" className="text-muted-foreground">
            {t("settings.ai.noKeyNotice")}
          </p>
        )}

        {test?.pending === true && (
          <p role="status" className="text-muted-foreground">
            {t("settings.ai.testing")}
          </p>
        )}
        {test?.result != null && (
          <p role={test.result.ok ? "status" : "alert"} className={test.result.ok ? "text-muted-foreground" : "text-destructive"}>
            {test.result.message}
          </p>
        )}
      </div>
      <ModelsTable provider={provider} models={models} />
    </div>
  );
}

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
function CreateActionDialog({ models, nextSortOrder }: { models: AdminAiModelDto[]; nextSortOrder: number }) {
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

function ActionEnabledSwitch({ action, labelledBy }: { action: AdminAiActionDto; labelledBy: string }) {
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
function ActionButtons({
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

/**
 * Mutations invalidate the three admin queries plus `["ai-actions"]` (AiSession's list), so the note sidebar in the same tab
 * updates at once. Actions keep the response order: the server already orders by `(sortOrder, id)`.
 * Reordering is two PATCHes swapping `sortOrder` with the neighbour (target first, then neighbour), using the known `actions`
 * array without waiting for a response or refetch; awaited sequentially on purpose to avoid races. The move buttons lock while
 * pending (`movePending`): this layer's `patchAction` is what `handleMove` uses (each row switch has its own instance and
 * `isPending` isn't shared), and a double click would send a second swap from the stale array, cancelling the first and leaving
 * two rows with the same `sortOrder`, which the Edit form (no `sortOrder` in its PATCH) can't repair.
 */
export function SettingsAiSection() {
  const { t } = useTranslation();
  const providersQuery = useAdminAiProviders();
  const modelsQuery = useAdminAiModels();
  const actionsQuery = useAdminAiActions();
  const patchAction = usePatchAiAction();
  const [tests, setTests] = useState<Record<string, ProviderTestState>>({});

  const models = modelsQuery.data ?? [];
  const actions = actionsQuery.data ?? [];

  // "Add action" renders only after the actions load, so this can't be computed as 0 while loading.
  const nextSortOrder = actions.length > 0 ? Math.max(...actions.map((action) => action.sortOrder)) + 1 : 0;

  async function handleMove(action: AdminAiActionDto, direction: "up" | "down"): Promise<void> {
    const index = actions.findIndex((item) => item.id === action.id);
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || targetIndex < 0 || targetIndex >= actions.length) return;
    const target = actions[targetIndex];
    try {
      await patchAction.mutateAsync({ id: action.id, body: { sortOrder: target.sortOrder } });
      await patchAction.mutateAsync({ id: target.id, body: { sortOrder: action.sortOrder } });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  const providerColumns: SettingsTableColumn[] = [
    { id: "name", header: t("settings.ai.tableName"), kind: "primary", grow: 1 },
    { id: "type", header: t("settings.ai.tableType"), kind: "fixed" },
    { id: "baseUrl", header: t("settings.ai.tableBaseUrl"), kind: "url" },
    { id: "models", header: t("settings.ai.tableModels"), kind: "text" },
    { id: "actions", header: t("settings.ai.tableActions"), kind: "actions", buttons: 3 },
    { id: "enabled", header: t("settings.ai.tableEnabled"), kind: "enabled" },
  ];
  const providerRows: SettingsTableRow[] = (providersQuery.data ?? []).map((provider) => {
    const providerModels = models.filter((model) => model.providerId === provider.id);
    return {
      id: provider.id,
      primary: { name: provider.name, weight: "semibold" },
      cells: {
        type: {
          content:
            provider.type === "anthropic" ? t("settings.ai.providerTypeAnthropic") : t("settings.ai.providerTypeOpenAiCompatible"),
          tone: "muted",
        },
        baseUrl: provider.baseUrl,
        models: providerModels.length === 0 ? "—" : providerModels.map((model) => model.displayName).join(", "),
      },
      actions: (
        <ProviderActions
          provider={provider}
          onTestStart={() => setTests((prev) => ({ ...prev, [provider.id]: { pending: true, result: null } }))}
          onTestDone={(result) => setTests((prev) => ({ ...prev, [provider.id]: { pending: false, result } }))}
        />
      ),
      enabled: (labelledBy) => <ProviderEnabledSwitch provider={provider} labelledBy={labelledBy} />,
      detail: <ProviderDetail provider={provider} models={providerModels} test={tests[provider.id]} />,
    };
  });

  const actionColumns: SettingsTableColumn[] = [
    { id: "name", header: t("settings.ai.tableName"), kind: "primary" },
    { id: "applyMode", header: t("settings.ai.actionApplyMode"), kind: "fixed" },
    { id: "model", header: t("settings.ai.actionModel"), kind: "text" },
    { id: "actions", header: t("settings.ai.tableActions"), kind: "actions", buttons: 4 },
    { id: "enabled", header: t("settings.ai.tableEnabled"), kind: "enabled" },
  ];
  const actionRows: SettingsTableRow[] = actions.map((action, index) => ({
    id: action.id,
    primary: {
      name: action.name,
      weight: "medium",
      badges: action.builtin ? (
        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{t("settings.ai.actionBuiltinBadge")}</span>
      ) : undefined,
    },
    cells: {
      applyMode: action.applyMode === "direct" ? t("settings.ai.actionApplyModeDirect") : t("settings.ai.actionApplyModePreview"),
      model: action.modelId
        ? (models.find((model) => model.id === action.modelId)?.displayName ?? action.modelId)
        : t("settings.ai.modelAuto"),
    },
    actions: (
      <ActionButtons
        action={action}
        models={models}
        canMoveUp={index > 0}
        canMoveDown={index < actions.length - 1}
        movePending={patchAction.isPending}
        onMove={(direction) => void handleMove(action, direction)}
      />
    ),
    enabled: (labelledBy) => <ActionEnabledSwitch action={action} labelledBy={labelledBy} />,
  }));

  return (
    <SettingsPage title={t("settings.ai.title")} description={t("settings.ai.description")}>
      <SettingsGroup title={t("settings.ai.providersHeading")} action={<CreateProviderDialog />}>
        {providersQuery.isPending ? (
          <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
        ) : providersQuery.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(t, providersQuery.error)}
          </p>
        ) : (
          <SettingsTable
            label={t("settings.ai.providersHeading")}
            columns={providerColumns}
            rows={providerRows}
            empty={t("settings.ai.providerEmpty")}
          />
        )}
      </SettingsGroup>

      {/* Separators come from the page's `divide-y`. */}
      <SettingsGroup
        title={t("settings.ai.actionsHeading")}
        action={actionsQuery.isSuccess ? <CreateActionDialog models={models} nextSortOrder={nextSortOrder} /> : undefined}
      >
        {actionsQuery.isPending ? (
          <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
        ) : actionsQuery.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(t, actionsQuery.error)}
          </p>
        ) : (
          <SettingsTable label={t("settings.ai.actionsHeading")} columns={actionColumns} rows={actionRows} empty={t("settings.ai.actionEmpty")} />
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}

import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { AdminAiProviderDto } from "@knotebook/shared";
import { Select } from "@/components/ui/select";
import { useCreateAiProvider, useDeleteAiProvider, usePatchAiProvider } from "@/api/adminAi";
import { Button } from "@/components/ui/button";
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
import { toast } from "@/components/ui/toast";
import { errorMessage } from "./ai-error-message";
import "@/i18n/management-strings";

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

export function CreateProviderDialog() {
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
export function EditProviderDialog({ provider }: { provider: AdminAiProviderDto }) {
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

export function DeleteProviderDialog({ provider }: { provider: AdminAiProviderDto }) {
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

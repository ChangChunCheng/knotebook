import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AdminAiActionDto, AdminAiModelDto, AdminAiProviderDto } from "@knotebook/shared";
import {
  useAdminAiActions,
  useAdminAiModels,
  useAdminAiProviders,
  usePatchAiAction,
  usePatchAiProvider,
  useTestAiProvider,
} from "@/api/adminAi";
import { Plug } from "@/components/ui/icons-extra";
import { RowIconButton } from "@/components/ui/row-icon-button";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { SettingsTable, type SettingsTableColumn, type SettingsTableRow } from "@/components/management/SettingsTable";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";
import { errorMessage } from "./ai-error-message";
import { CreateProviderDialog, EditProviderDialog, DeleteProviderDialog } from "./AiProviderDialogs";
import { ModelsTable } from "./AiModelDialogs";
import { CreateActionDialog, ActionEnabledSwitch, ActionButtons } from "./AiActionDialogs";
import "@/i18n/management-strings";

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

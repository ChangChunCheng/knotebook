import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AdminAuthProbeResultDto, AdminAuthProviderDto } from "@knotebook/shared";
import { useSiteLimits } from "@/api/siteLimits";
import {
  useAdminAuthProviders,
  useAuthProviderImpact,
  useDeleteAuthProvider,
  usePatchAuthProvider,
  useTestAuthProvider,
} from "@/api/adminAuth";
import { ProviderIcon } from "@/components/ProviderIcon";
import { SettingsTable, type SettingsTableColumn, type SettingsTableRow } from "@/components/management/SettingsTable";
import { Button } from "@/components/ui/button";
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
import { Copy, Trash } from "@/components/ui/icons";
import { Plug } from "@/components/ui/icons-extra";
import { RowIconButton } from "@/components/ui/row-icon-button";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import { authErrorMessage } from "./auth-error-message";
import { CreateProviderDialog, EditProviderDialog } from "./AuthProviderDialogs";
import { ProviderIconDialog } from "./ProviderIconDialog";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";
import { categoryKeys, serverErrorMessage, SiteLimitsGroup } from "./SettingsLimitsSection";
import { SiteAccessSettings } from "./SiteAccessSettings";
import "@/i18n/management-strings";

function SessionAndTokensGroup() {
  const { t } = useTranslation();
  const query = useSiteLimits();
  const title = t("admin.limits.categories.signIn");
  if (query.isPending) {
    return (
      <SettingsGroup title={title}>
        <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
      </SettingsGroup>
    );
  }
  // Only swap to the error when there's no data: a failed background refetch must not tear down half-typed input.
  if (query.data === undefined) {
    return (
      <SettingsGroup title={title}>
        <p role="alert" className="text-sm text-destructive">
          {serverErrorMessage(t, query.error)}
        </p>
      </SettingsGroup>
    );
  }
  return <SiteLimitsGroup title={title} keys={categoryKeys("signIn")} data={query.data} />;
}

function DisableProviderDialog({
  provider,
  open,
  onOpenChange,
}: {
  provider: AdminAuthProviderDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const impact = useAuthProviderImpact(provider.id, open);
  const patch = usePatchAuthProvider();

  async function handleConfirm(): Promise<void> {
    try {
      await patch.mutateAsync({ id: provider.id, body: { enabled: false } });
      onOpenChange(false);
    } catch (err) {
      toast({ title: authErrorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("admin.auth.disableTitle")}</DialogTitle>
          <DialogDescription>{t("admin.auth.disableDescription")}</DialogDescription>
        </DialogHeader>
        {/* Admin-entered name: own text node, not interpolated into t(). */}
        <p className="text-sm font-medium">{provider.displayName}</p>
        {/* Same query key as the row's linked column, so on open the cache already holds the count from row load (isPending false): show
            loading until the refetch finishes, so it stays a snapshot at open and never flashes a stale count (#247). */}
        {impact.isPending || impact.isFetching ? (
          <p className="text-sm text-muted-foreground">{t("admin.auth.impactLoading")}</p>
        ) : impact.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {authErrorMessage(t, impact.error)}
          </p>
        ) : (
          <div className="space-y-1 text-sm">
            <p>{t("admin.auth.impactLinked", { number: impact.data.linkedUsers })}</p>
            <p>{t("admin.auth.impactLockedOut", { number: impact.data.lockedOutUsers })}</p>
            {!impact.data.issuerResolved && <p className="text-muted-foreground">{t("admin.auth.impactUnresolved")}</p>}
            {impact.data.actingAdminLockedOut && <p className="text-destructive">{t("admin.auth.impactActingAdminLockedOut")}</p>}
          </div>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("admin.auth.cancel")}
            </Button>
          </DialogClose>
          <Button type="button" variant="brandDeep" onClick={() => void handleConfirm()} disabled={patch.isPending}>
            {t("admin.auth.disableConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Delete needs the provider disabled first: soft-disabled (`aria-disabled`) with the reason linked via `aria-describedby`; the server also enforces it (409 `provider_enabled`). */
function DeleteProviderDialog({ provider, disabledHintId }: { provider: AdminAuthProviderDto; disabledHintId: string }) {
  const { t } = useTranslation();
  const deleteProvider = useDeleteAuthProvider();
  const [open, setOpen] = useState(false);

  async function handleConfirm(): Promise<void> {
    try {
      await deleteProvider.mutateAsync(provider.id);
      setOpen(false);
    } catch (err) {
      toast({ title: authErrorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <RowIconButton
          label={t("admin.auth.delete")}
          tone="destructive"
          icon={<Trash className="h-4 w-4" />}
          softDisabled={provider.enabled}
          softDisabledReason={t("admin.auth.deleteDisabledHint")}
          aria-describedby={provider.enabled ? disabledHintId : undefined}
        />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("admin.auth.deleteTitle")}</DialogTitle>
          <DialogDescription>{t("admin.auth.deleteDescription")}</DialogDescription>
        </DialogHeader>
        <p className="text-sm font-medium">{provider.displayName}</p>
        {provider.legacyCallback && <p className="text-sm text-muted-foreground">{t("admin.auth.deleteLegacyNote")}</p>}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("admin.auth.cancel")}
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" onClick={() => void handleConfirm()} disabled={deleteProvider.isPending}>
            {t("admin.auth.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type TestState = { ok: true; result: AdminAuthProbeResultDto } | { ok: false; message: string } | null;

/** Keyed by provider id in the section because the button and the result live in different rows. `configKey` is the issuer/client ID/secret at test time; the result is only valid for it, and if any of the three changes the section root drops the entry during render. */
interface ProviderTest {
  configKey: string;
  pending: boolean;
  state: TestState;
}

function configKeyOf(provider: AdminAuthProviderDto): string {
  return `${provider.issuerUrl}|${provider.clientId ?? ""}|${provider.hasSecret}`;
}

/** `DisableProviderDialog` shares this query key and still refetches on open. */
function LinkedCount({ providerId }: { providerId: string }) {
  const impact = useAuthProviderImpact(providerId, true);
  return <span className="tabular-nums">{impact.data ? impact.data.linkedUsers : "—"}</span>;
}

/** Accessible name "Enabled <name>" comes from the table's aria-labelledby. Turning off always goes through the confirm dialog (with the count); the switch is controlled, so Cancel leaves it unchanged. */
function ProviderEnabledSwitch({ provider, labelledBy }: { provider: AdminAuthProviderDto; labelledBy: string }) {
  const { t } = useTranslation();
  const patch = usePatchAuthProvider();
  const [disableOpen, setDisableOpen] = useState(false);

  async function handleToggle(next: boolean): Promise<void> {
    if (!next) {
      setDisableOpen(true);
      return;
    }
    try {
      await patch.mutateAsync({ id: provider.id, body: { enabled: true } });
    } catch (err) {
      toast({ title: authErrorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <>
      <Switch
        aria-labelledby={labelledBy}
        checked={provider.enabled}
        onCheckedChange={(checked) => void handleToggle(checked)}
        disabled={patch.isPending}
      />
      <DisableProviderDialog provider={provider} open={disableOpen} onOpenChange={setDisableOpen} />
    </>
  );
}

/**
 * First switch in the control column: named via `aria-label`, not the enabled column's `aria-labelledby`. Toggling sends a single-field
 * PATCH without confirmation, and works while the provider is disabled (configure before enabling).
 */
function ProviderAutoCreateSwitch({ provider }: { provider: AdminAuthProviderDto }) {
  const { t } = useTranslation();
  const patch = usePatchAuthProvider();

  async function toggle(next: boolean): Promise<void> {
    try {
      await patch.mutateAsync({ id: provider.id, body: { autoCreateEnabled: next } });
    } catch (err) {
      toast({ title: authErrorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <Switch
      aria-label={t("admin.auth.autoCreateFor", { name: provider.displayName })}
      checked={provider.autoCreateEnabled}
      disabled={patch.isPending}
      onCheckedChange={(checked) => void toggle(checked)}
    />
  );
}

/** Test progress and results are kept by the parent because they show in the detail row. */
function ProviderActions({
  provider,
  deleteHintId,
  onTestStart,
  onTestDone,
}: {
  provider: AdminAuthProviderDto;
  deleteHintId: string;
  onTestStart: (configKey: string) => void;
  onTestDone: (configKey: string, state: TestState) => void;
}) {
  const { t } = useTranslation();
  const testProvider = useTestAuthProvider();

  async function handleTest(): Promise<void> {
    const configKey = configKeyOf(provider);
    onTestStart(configKey);
    try {
      onTestDone(configKey, { ok: true, result: await testProvider.mutateAsync(provider.id) });
    } catch (err) {
      onTestDone(configKey, { ok: false, message: authErrorMessage(t, err) });
    }
  }

  return (
    <>
      <RowIconButton
        label={t("admin.auth.test")}
        icon={<Plug className="h-4 w-4" />}
        onClick={() => void handleTest()}
        disabled={testProvider.isPending}
      />
      <ProviderIconDialog provider={provider} />
      <EditProviderDialog provider={provider} />
      <DeleteProviderDialog provider={provider} disabledHintId={deleteHintId} />
    </>
  );
}

/** Includes `deleteDisabledHint`, the delete button's aria-describedby target. */
function ProviderDetail({
  provider,
  deleteHintId,
  test,
}: {
  provider: AdminAuthProviderDto;
  deleteHintId: string;
  test: ProviderTest | undefined;
}) {
  const { t } = useTranslation();
  const state = test?.state ?? null;

  function handleCopy(): void {
    void copyText(provider.callbackUrl).then((ok) =>
      toast(ok ? { title: t("admin.auth.callbackCopied") } : { title: t("admin.auth.callbackCopyFailed"), variant: "destructive" }),
    );
  }

  return (
    <div className="space-y-2 px-3 text-xs">
      {provider.enabled && (
        <p id={deleteHintId} className="text-muted-foreground">
          {t("admin.auth.deleteDisabledHint")}
        </p>
      )}
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">{t("admin.auth.clientIdLabel")}</dt>
        <dd className={provider.clientId === null ? "text-muted-foreground" : "break-all"}>
          {provider.clientId === null ? t("admin.auth.clientIdMissing") : provider.clientId}
        </dd>
        <dt className="text-muted-foreground">{t("admin.auth.callbackLabel")}</dt>
        <dd className="flex min-w-0 items-center gap-1">
          <code className="min-w-0 break-all">{provider.callbackUrl}</code>
          <RowIconButton label={t("admin.auth.copyCallback")} icon={<Copy className="h-4 w-4" />} onClick={handleCopy} />
        </dd>
      </dl>
      <p className="text-muted-foreground">{provider.hasSecret ? t("admin.auth.secretSaved") : t("admin.auth.secretMissing")}</p>
      {!provider.issuerResolved && (
        <p role="status" className="text-muted-foreground">
          {t("admin.auth.notConnected")}
        </p>
      )}
      {provider.insecureIssuer && <p className="text-destructive">{t("admin.auth.insecureIssuer")}</p>}
      {test?.pending === true && (
        <p role="status" className="text-muted-foreground">
          {t("admin.auth.testing")}
        </p>
      )}
      {state?.ok === true && (
        <div role="status" className="space-y-1">
          <p>{t("admin.auth.testOk", { issuer: state.result.issuer })}</p>
          {state.result.warnings.map((warning) => (
            <p key={warning} className="text-destructive">
              {t(`admin.auth.warnings.${warning}`)}
            </p>
          ))}
          <p className="text-muted-foreground">{t("admin.auth.testScope")}</p>
        </div>
      )}
      {state?.ok === false && (
        <p role="alert" className="text-destructive">
          {state.message}
        </p>
      )}
    </div>
  );
}

export function SettingsAuthSection() {
  const { t } = useTranslation();
  const providersQuery = useAdminAuthProviders();
  const baseId = useId();
  const [tests, setTests] = useState<Record<string, ProviderTest>>({});
  const providers = providersQuery.data ?? [];

  // Test results are valid only for the issuer/client ID/secret at test time: drop an entry once any of them changes. Reset during render
  // (not an effect) so rows aren't remounted, which would unmount an open edit dialog.
  const staleIds = providers
    .filter((provider) => {
      const test = tests[provider.id];
      return test !== undefined && test.configKey !== configKeyOf(provider);
    })
    .map((provider) => provider.id);
  if (staleIds.length > 0) {
    setTests((prev) => {
      const next = { ...prev };
      for (const id of staleIds) delete next[id];
      return next;
    });
  }

  const columns: SettingsTableColumn[] = [
    { id: "service", header: t("admin.auth.tableService"), kind: "primary", grow: 1 },
    { id: "issuer", header: t("admin.auth.tableIssuer"), kind: "url" },
    { id: "linked", header: t("admin.auth.tableLinked"), kind: "fixed" },
    { id: "autoCreate", header: t("admin.auth.tableAutoCreate"), kind: "control" },
    { id: "actions", header: t("admin.auth.tableActions"), kind: "actions", buttons: 4 },
    { id: "enabled", header: t("admin.auth.tableEnabled"), kind: "enabled" },
  ];
  const rows: SettingsTableRow[] = providers.map((provider) => {
    const deleteHintId = `${baseId}-${provider.id}-delete-hint`;
    return {
      id: provider.id,
      primary: {
        name: provider.displayName,
        weight: "semibold",
        icon: <ProviderIcon icon={provider.icon} />,
        subtitles: [
          `${t(`admin.auth.template.${provider.template}`)}${provider.legacyCallback ? ` · ${t("admin.auth.legacyBadge")}` : ""}`,
        ],
      },
      cells: {
        issuer: provider.issuerUrl,
        linked: <LinkedCount providerId={provider.id} />,
        autoCreate: <ProviderAutoCreateSwitch provider={provider} />,
      },
      actions: (
        <ProviderActions
          provider={provider}
          deleteHintId={deleteHintId}
          onTestStart={(configKey) => setTests((prev) => ({ ...prev, [provider.id]: { configKey, pending: true, state: null } }))}
          onTestDone={(configKey, state) => setTests((prev) => ({ ...prev, [provider.id]: { configKey, pending: false, state } }))}
        />
      ),
      enabled: (labelledBy) => <ProviderEnabledSwitch provider={provider} labelledBy={labelledBy} />,
      detail: <ProviderDetail provider={provider} deleteHintId={deleteHintId} test={tests[provider.id]} />,
    };
  });

  return (
    <SettingsPage title={t("admin.auth.title")} description={t("admin.auth.description")}>
      <SiteAccessSettings />
      <SessionAndTokensGroup />
      <SettingsGroup
        title={t("admin.auth.providersHeading")}
        description={t("admin.auth.providersDescription")}
        action={<CreateProviderDialog />}
      >
        {providersQuery.isPending ? (
          <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
        ) : providersQuery.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {authErrorMessage(t, providersQuery.error)}
          </p>
        ) : (
          <SettingsTable label={t("admin.auth.providersHeading")} columns={columns} rows={rows} empty={t("admin.auth.empty")} />
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}

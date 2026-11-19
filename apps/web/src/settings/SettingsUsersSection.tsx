import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ONLINE_WINDOW_MS } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useSession } from "@/auth/useSession";
import {
  useAdminUsers,
  useDemoteAdminUser,
  useDisableAdminUser,
  useEnableAdminUser,
  usePromoteAdminUser,
  useAssignUserPlan,
  type AdminUserDto,
} from "@/api/admin";
import { useAdminStoragePlans } from "@/api/adminStorage";
import { SettingsTable, type SettingsTableColumn, type SettingsTableRow } from "@/components/management/SettingsTable";
import { Avatar } from "@/components/Avatar";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";
import { CreateInviteDialog } from "./CreateInviteDialog";
import { InvitesGroup } from "./InvitesGroup";
import { PasswordResetAction } from "./PasswordResetDialog";
import { PlanSelect, StorageCell } from "./StorageAdminCells";
import "@/i18n/management-strings";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

/**
 * The server records activity at most every `LAST_ACTIVE_WRITE_INTERVAL_MS`, far shorter than `ONLINE_WINDOW_MS`,
 * so continuously active users don't drop out. Older times use the same format as the version panel's
 * `formatVersionTime` (dateStyle/timeStyle short). `now` is the browser clock at render time and there is no
 * timer: a stale "online" persists until the next render (e.g. a list refetch).
 */
function lastActiveLabel(lastActiveAt: string | null, t: (key: string) => string, language: string): string {
  if (lastActiveAt === null) return t("admin.users.lastActiveNone");
  const at = new Date(lastActiveAt);
  if (Date.now() - at.getTime() < ONLINE_WINDOW_MS) return t("admin.users.online");
  return at.toLocaleString(language, { dateStyle: "short", timeStyle: "short" });
}

/**
 * Self row is disabled with a `title` (the server also rejects it with 400 `cannot_demote_self`). While pending
 * it is disabled and shows the just-picked value. A failed change (including 409 `last_site_admin`) snaps back
 * because the value is controlled by row data; the error goes to the parent's error row.
 */
function UserRoleSelect({ row, isSelf, onError }: { row: AdminUserDto; isSelf: boolean; onError: (message: string | null) => void }) {
  const { t } = useTranslation();
  const promote = usePromoteAdminUser();
  const demote = useDemoteAdminUser();
  const [pickedRole, setPickedRole] = useState<"admin" | "user" | null>(null);
  const rolePending = promote.isPending || demote.isPending;
  const roleValue = rolePending && pickedRole !== null ? pickedRole : row.isAdmin ? "admin" : "user";

  async function handleRole(next: "admin" | "user"): Promise<void> {
    if (isSelf || rolePending || next === (row.isAdmin ? "admin" : "user")) return;
    onError(null);
    setPickedRole(next);
    try {
      await (next === "admin" ? promote : demote).mutateAsync(row.id);
    } catch (err) {
      onError(errorMessage(t, err));
    } finally {
      setPickedRole(null);
    }
  }

  return (
    <Select
      variant="inline"
      aria-label={t("admin.users.roleFor", { email: row.email })}
      value={roleValue}
      disabled={isSelf || rolePending}
      title={isSelf ? t("errors.cannot_demote_self") : undefined}
      onValueChange={(next) => void handleRole(next as "admin" | "user")}
      options={[
        { value: "admin", label: t("admin.roleAdmin") },
        { value: "user", label: t("admin.roleUser") },
      ]}
    />
  );
}

/**
 * Disabling confirms first because it kicks online sessions; enabling sends at once. The self row renders,
 * stays on, is `aria-disabled` with a `title` and sends nothing (the server's `cannot_disable_self` is the
 * last defense). A failed toggle snaps back because it is controlled by row data; the error goes to the
 * parent's error row. The accessible name ("Enabled <email>") comes from the table's aria-labelledby.
 */
function UserEnabledSwitch({
  row,
  isSelf,
  labelledBy,
  onError,
}: {
  row: AdminUserDto;
  isSelf: boolean;
  labelledBy: string;
  onError: (message: string | null) => void;
}) {
  const { t } = useTranslation();
  const disableUser = useDisableAdminUser();
  const enableUser = useEnableAdminUser();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const enabled = row.disabledAt === null;

  async function handleEnabled(next: boolean): Promise<void> {
    if (isSelf) return;
    onError(null);
    if (!next) {
      setConfirmOpen(true);
      return;
    }
    try {
      await enableUser.mutateAsync(row.id);
    } catch (err) {
      onError(errorMessage(t, err));
    }
  }

  async function handleDisableConfirm(): Promise<void> {
    try {
      await disableUser.mutateAsync(row.id);
      setConfirmOpen(false);
    } catch (err) {
      setConfirmOpen(false);
      onError(errorMessage(t, err));
    }
  }

  return (
    <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
      <Switch
        aria-labelledby={labelledBy}
        checked={isSelf ? true : enabled}
        aria-disabled={isSelf || undefined}
        title={isSelf ? t("errors.cannot_disable_self") : undefined}
        className={isSelf ? "cursor-not-allowed opacity-50" : undefined}
        disabled={!isSelf && (enableUser.isPending || disableUser.isPending)}
        onCheckedChange={(next) => void handleEnabled(next)}
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("admin.disableTitle")}</DialogTitle>
          <DialogDescription>{t("admin.disableDescription", { email: row.email })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("home.cancel")}
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" onClick={() => void handleDisableConfirm()} disabled={disableUser.isPending}>
            {t("admin.disable")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SettingsUsersSection() {
  const { t, i18n } = useTranslation();
  const { user } = useSession();
  const usersQuery = useAdminUsers();
  const plansQuery = useAdminStoragePlans();
  const assignPlan = useAssignUserPlan();
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const currentUserId = user?.id ?? "";

  function setRowError(id: string, message: string | null): void {
    setRowErrors((prev) => {
      const next = { ...prev };
      if (message === null) delete next[id];
      else next[id] = message;
      return next;
    });
  }

  const columns: SettingsTableColumn[] = [
    { id: "user", header: t("admin.users.user"), kind: "primary", grow: 1 },
    { id: "email", header: t("admin.tableEmail"), kind: "text", grow: 1.5 },
    { id: "storage", header: t("admin.tableStorage"), kind: "fixed" },
    { id: "lastActive", header: t("admin.users.lastActive"), kind: "fixed" },
    { id: "role", header: t("admin.tableRole"), kind: "control" },
    { id: "plan", header: t("admin.tablePlan"), kind: "control" },
    { id: "actions", header: t("admin.users.tableActions"), kind: "actions", buttons: 1 },
    { id: "enabled", header: t("admin.users.enabled"), kind: "enabled" },
  ];
  const rows: SettingsTableRow[] = (usersQuery.data ?? []).map((row) => {
    const isSelf = row.id === currentUserId;
    return {
      id: row.id,
      primary: { name: row.displayName, icon: <Avatar name={row.displayName} avatar={row.avatar ?? null} size={24} />, subtitles: [`@${row.handle}`] },
      cells: {
        email: row.email,
        storage: <StorageCell storage={row.storage} />,
        lastActive: lastActiveLabel(row.lastActiveAt, t, i18n.language),
        role: <UserRoleSelect row={row} isSelf={isSelf} onError={(message) => setRowError(row.id, message)} />,
        // Plans stay assignable for disabled users.
        plan: (
          <PlanSelect
            label={t("admin.planFor", { email: row.email })}
            planId={row.storage.planId}
            planName={row.storage.planName}
            plans={plansQuery.data?.plans}
            onAssign={(planId) => assignPlan.mutateAsync({ userId: row.id, planId })}
          />
        ),
      },
      // renders null when hasPassword is false; the cell still renders
      actions: <PasswordResetAction row={row} onError={(message) => setRowError(row.id, message)} />,
      enabled: (labelledBy) => (
        <UserEnabledSwitch row={row} isSelf={isSelf} labelledBy={labelledBy} onError={(message) => setRowError(row.id, message)} />
      ),
      error: rowErrors[row.id],
    };
  });

  return (
    <SettingsPage
      title={t("admin.title")}
      description={t("admin.description")}
      // In the page header, grouped with the title, rather than floating on its own line above the table.
      action={<CreateInviteDialog />}
    >
      <SettingsGroup>
        {usersQuery.isPending ? (
          <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
        ) : usersQuery.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(t, usersQuery.error)}
          </p>
        ) : (
          <SettingsTable label={t("admin.nav.users")} nameColumn="email" columns={columns} rows={rows} empty={t("admin.empty")} />
        )}
      </SettingsGroup>
      <InvitesGroup />
    </SettingsPage>
  );
}

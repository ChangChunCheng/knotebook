import { useTranslation } from "react-i18next";
import { ApiFail } from "@/api/client";
import { useAdminGroups, useAdminStoragePlans, useAssignGroupPlan } from "@/api/adminStorage";
import { SettingsTable, type SettingsTableColumn, type SettingsTableRow } from "@/components/management/SettingsTable";
import { PlanSelect, StorageCell } from "./StorageAdminCells";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";
import "@/i18n/management-strings";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/**
 * Lists every group on the site, member or not. Exported only through `components/admin/AdminSections` (the site
 * admin sections chunk). Group names are plain text, not links: site admins manage plans without seeing members or details. Names can
 * repeat, so the plan select's `aria-describedby` points at the row's created-time cell (id from the group id) to tell rows apart.
 */
export function SettingsAdminGroupsSection() {
  const { t, i18n } = useTranslation();
  const groupsQuery = useAdminGroups();
  const plansQuery = useAdminStoragePlans();
  const assignPlan = useAssignGroupPlan();

  const columns: SettingsTableColumn[] = [
    { id: "name", header: t("admin.groups.tableName"), kind: "primary" },
    { id: "members", header: t("admin.groups.tableMembers"), kind: "fixed" },
    { id: "created", header: t("admin.groups.tableCreated"), kind: "fixed" },
    { id: "storage", header: t("admin.tableStorage"), kind: "fixed" },
    { id: "plan", header: t("admin.tablePlan"), kind: "control" },
  ];
  const rows: SettingsTableRow[] = (groupsQuery.data ?? []).map((row) => ({
    id: row.id,
    primary: { name: row.name },
    cells: {
      members: row.memberCount,
      created: <span id={`group-created-${row.id}`}>{new Date(row.createdAt).toLocaleDateString(i18n.language)}</span>,
      storage: <StorageCell storage={row.storage} />,
      plan: (
        <PlanSelect
          label={t("admin.groups.planFor", { name: row.name })}
          describedBy={`group-created-${row.id}`}
          planId={row.storage.planId}
          planName={row.storage.planName}
          plans={plansQuery.data?.plans}
          onAssign={(planId) => assignPlan.mutateAsync({ groupId: row.id, planId })}
        />
      ),
    },
  }));

  return (
    <SettingsPage title={t("admin.groups.title")} description={t("admin.groups.description")}>
      <SettingsGroup>
        {groupsQuery.isPending ? (
          <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
        ) : groupsQuery.isError ? (
          <p role="alert" className="text-sm text-destructive">{errorMessage(t, groupsQuery.error)}</p>
        ) : (
          <SettingsTable label={t("admin.groups.title")} columns={columns} rows={rows} empty={t("admin.groups.empty")} />
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}

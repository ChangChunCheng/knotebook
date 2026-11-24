import { Suspense } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation, useNavigate, type Location } from "react-router";
import { ChunkLoadBeacon, LazyRouteErrorBoundary, LazyRouteLoading } from "@/components/ErrorBoundary";
import { ManagementShell } from "@/components/management/ManagementShell";

/**
 * Guards live in `App.tsx` (`RequireAuth → ChangePasswordGate → RequireAdmin`). The redirects for `/admin`, `/admin/auth`,
 * `/admin/versions` and unknown subpaths sit outside this component (under `RequireAdmin`), so the modal never flashes
 * and non-admins go straight to `/`. In the main tree `/admin/*` falls to `HomePage` at `/*` (the background for deep links).
 * The lazy error boundary matches `SettingsModal`: inline frame, `chunk="admin"`, `resetKey` from the real pathname.
 */
export function AdminModal() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const backgroundLocation = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation;

  function handleOpenChange(open: boolean): void {
    if (open) return;
    navigate(backgroundLocation ?? "/");
  }

  const items = [
    { to: "/admin/users", label: t("admin.nav.users") },
    { to: "/admin/groups", label: t("admin.nav.groups") },
    { to: "/admin/login", label: t("admin.nav.auth") },
    { to: "/admin/storage", label: t("admin.nav.storage") },
    { to: "/admin/ai", label: t("admin.nav.ai") },
    { to: "/admin/knowledge-fields", label: t("admin.nav.knowledgeFields") },
    { to: "/admin/limits", label: t("admin.nav.limits") },
  ];

  return (
    <ManagementShell title={t("admin.nav.label")} items={items} onOpenChange={handleOpenChange}>
      <LazyRouteErrorBoundary resetKey={location.pathname} chunk="admin" frame="inline">
        <Suspense fallback={<LazyRouteLoading frame="inline" />}>
          <Outlet />
          <ChunkLoadBeacon chunk="admin" />
        </Suspense>
      </LazyRouteErrorBoundary>
    </ManagementShell>
  );
}

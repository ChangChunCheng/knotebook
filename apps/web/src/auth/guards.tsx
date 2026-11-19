import { SAFE_PAGE_PADDING } from "@/components/ui/safe-area";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, Outlet, useLocation } from "react-router";
import { Button } from "@/components/ui/button";
import { useSession } from "./useSession";

function FullScreenLoading() {
  const { t } = useTranslation();
  return (
    <div className={`flex min-h-screen items-center justify-center ${SAFE_PAGE_PADDING}`}>
      <p className="text-muted-foreground">{t("app.loading")}</p>
    </div>
  );
}

// Non-401 session failure. Without it `user` stays undefined and every gate spins on "loading" forever.
function SessionError({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className={`flex min-h-screen flex-col items-center justify-center gap-4 ${SAFE_PAGE_PADDING}`}>
      <p className="text-muted-foreground" role="alert">
        {t("app.sessionError")}
      </p>
      {/* Full-page state: its only action gets the page-level brandSolid (see ui/button.tsx). */}
      <Button type="button" variant="brandSolid" onClick={onRetry}>
        {t("app.retry")}
      </Button>
    </div>
  );
}

function useSessionGate(): { screen: ReactElement | null; user: NonNullable<ReturnType<typeof useSession>["user"]> | null } {
  const { user, query } = useSession();
  const location = useLocation();

  // Error only without a cached user: after a failed refetch, swapping out the logged-in tree would unmount
  // NotePage, destroy the collab doc and lose unsynced edits.
  if (query.isError && user === undefined) {
    return { screen: <SessionError onRetry={() => void query.refetch()} />, user: null };
  }
  if (user === undefined) return { screen: <FullScreenLoading />, user: null };
  if (user === null) {
    // Encode pathname+search once so its `?`/`&` aren't read as /login's own params. The hash is left out on purpose
    // (keeps password and SSO logins alike), though safeNextPath would accept one. Under a settings modal this
    // is the background location; the second Routes tree in App.tsx supplies the real one.
    const next = `${location.pathname}${location.search}`;
    return { screen: <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />, user: null };
  }
  return { screen: null, user };
}

/** Not every logged-out path carries `next`: NotePage.handleUnauthorized navigates to a bare /login before this
 * renders, and the logout paths omit it on purpose (see UserMenu.handleLogout). */
export function RequireAuth() {
  const { screen } = useSessionGate();

  return screen ?? <Outlet />;
}

// Also handles logged-out users, so it is safe even if mounted outside RequireAuth.
export function RequireAdmin() {
  const { screen, user } = useSessionGate();

  if (screen) return screen;
  if (!user!.isAdmin) return <Navigate to="/" replace />;
  return <Outlet />;
}

// No "already on /change-password" check needed: App.tsx mounts that route outside this gate.
// Like RequireAdmin, also handles logged-out users, so it is safe even if mounted outside RequireAuth.
export function ChangePasswordGate() {
  const { screen, user } = useSessionGate();

  if (screen) return screen;
  if (user!.mustChangePassword) return <Navigate to="/change-password" replace />;
  return <Outlet />;
}

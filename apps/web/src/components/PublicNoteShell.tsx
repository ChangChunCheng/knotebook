import { SAFE_INSETS } from "@/components/ui/safe-area";
import { Component, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useCardPage } from "@/theme";
import { useOnline } from "./ErrorBoundary";
import { Button } from "./ui/button";

/** Deliberately does not reuse `NotePageFallback`/`NoteRouteErrorBoundary`: they need `AppShellLayout`, whose AppShell calls `/api/auth/me` and shows the sidebar to anonymous visitors. The public route has zero auth dependency (pinned in App.publicRoute.test.tsx). Stays in the entry bundle because the fallback renders before the lazy chunk arrives. */

/** `flex flex-col` + `overflow-hidden` are load-bearing (body container `min-h-0 flex-1 overflow-y-auto`, page must not scroll as a whole). Background is bg-card, not bg-background: the BlockNote background is coupled to `--color-card`, so a darker page would make the article column look like a floating card. `inert` while the presentation shell is mounted (#229). */
export function PublicPageFrame({ children, inert }: { children: ReactNode; inert?: boolean }) {
  useCardPage();
  return (
    <div inert={inert} className={`flex h-dvh flex-col overflow-hidden bg-card ${SAFE_INSETS}`}>
      {children}
    </div>
  );
}

export function PublicNoteFallback() {
  const { t } = useTranslation();
  return (
    <PublicPageFrame>
      <p className="p-6 text-sm text-muted-foreground">{t("app.loading")}</p>
    </PublicPageFrame>
  );
}

interface PublicNoteErrorBoundaryProps {
  reload?: () => void;
  children: ReactNode;
}

function defaultReload() {
  location.reload();
}

/** No automatic reload and no ChunkLoadBeacon: that flag budget is NotePage-specific; an anonymous visitor has no unsaved state, so a manual reload button suffices. */
export class PublicNoteErrorBoundary extends Component<PublicNoteErrorBoundaryProps, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  private handleRetry = () => {
    (this.props.reload ?? defaultReload)();
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    return <PublicNoteErrorFallback onRetry={this.handleRetry} />;
  }
}

function PublicNoteErrorFallback({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  // Offline, reload would show the browser error page: grey the button out and re-enable on the online event.
  const online = useOnline();
  return (
    <PublicPageFrame>
      <div role="alert" className="flex flex-col items-start gap-3 p-6">
        <p className="text-sm text-muted-foreground">{t("public.loadError")}</p>
        <Button type="button" variant="outline" disabled={!online} onClick={onRetry}>
          {t("app.retry")}
        </Button>
        {!online && <p className="text-sm text-muted-foreground">{t("app.offlineHint")}</p>}
      </div>
    </PublicPageFrame>
  );
}

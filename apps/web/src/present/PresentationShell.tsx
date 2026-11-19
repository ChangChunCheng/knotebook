import { SAFE_INSETS } from "@/components/ui/safe-area";
import {
  Component, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type MouseEvent as ReactMouseEvent, type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { useOnline } from "@/components/ErrorBoundary";
import { Button } from "@/components/ui/button";
import { X } from "@/components/ui/icons";
import { Maximize, Minimize } from "@/components/ui/icons-extra";
import { useHistoryLocationKey, useRealLocation } from "@/lib/real-location";
import { cn } from "@/lib/utils";
import {
  enterPresentationFullscreen, exitOwnedFullscreen, isOwnedFullscreen, msSinceFullscreenExit, subscribeFullscreen,
} from "./fullscreen";
import {
  exitFullscreenIfLeftPresentation, isPresentingSearch, PRESENT_SEARCH, searchWithoutPresent, wasPresentPushed,
} from "./present-url";

/**
 * #229: does **not** import reveal (entry side).
 * - `z-[60]`: above the drawer and dialogs (z-50), below toasts (z-[100]); AppShell's Ctrl+K backs off while `[role="dialog"]` exists.
 * - One Esc entry at a time: the shell's document listener until reveal is ready, then reveal's keyboard[27] calls the same
 *   onEsc; leaving is idempotent (leftRef).
 * - Query normalization is deferred while a navigation is in flight (same guard as NotePage's convergence).
 */
export const ESC_AFTER_FULLSCREEN_EXIT_MS = 300;
const TOOLBAR_IDLE_MS = 2000;

export interface PresentationShellContextValue {
  onRevealReady(ready: boolean): void;
  onEsc(): void;
  onFatal(messageKey: string): void;
  toggleFullscreen(): void;
}

const PresentationShellContext = createContext<PresentationShellContextValue | null>(null);

export function usePresentationShell(): PresentationShellContextValue {
  const value = useContext(PresentationShellContext);
  if (!value) throw new Error("PresentationOverlay must be rendered inside PresentationShell");
  return value;
}

export type PresentationShellStatus = "loading" | "error" | "ready";

export interface PresentationShellProps {
  title: string;
  status: PresentationShellStatus;
  errorMessage?: string;
  toolbarExtra?: ReactNode;
  children?: ReactNode;
}

export function PresentationShell({ title, status, errorMessage, toolbarExtra, children }: PresentationShellProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const realLocation = useRealLocation();
  const navigate = useNavigate();
  const readHistoryKey = useHistoryLocationKey();
  const rootRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef(false);
  const [revealReady, setRevealReady] = useState(false);
  const [fatalKey, setFatalKey] = useState<string | null>(null);
  const [idle, setIdle] = useState(false);

  // Written on every render: leaving must read the latest location, not the one from when the callback was created.
  const latestRef = useRef({ location, navigate });
  latestRef.current = { location, navigate };

  const leave = useCallback(() => {
    if (leftRef.current) return;
    leftRef.current = true;
    exitOwnedFullscreen(); // before navigating
    const { location: latest, navigate: go } = latestRef.current;
    if (wasPresentPushed(latest.state)) void go(-1);
    else void go({ pathname: latest.pathname, search: searchWithoutPresent(latest.search), hash: "" }, { replace: true });
  }, []);

  const onEsc = useCallback(() => {
    if (document.fullscreenElement) return; // the browser is using this Esc to leave fullscreen
    if (msSinceFullscreenExit() < ESC_AFTER_FULLSCREEN_EXIT_MS) return; // with either event order only one level is left
    leave();
  }, [leave]);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenEnabled) return;
    if (isOwnedFullscreen()) exitOwnedFullscreen();
    else enterPresentationFullscreen();
  }, []);

  const context = useMemo<PresentationShellContextValue>(
    () => ({ onRevealReady: setRevealReady, onEsc, onFatal: setFatalKey, toggleFullscreen }),
    [onEsc, toggleFullscreen],
  );

  useEffect(() => {
    if (revealReady) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onEsc();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [revealReady, onEsc]);

  const lastNormalizeRef = useRef<string | null>(null);
  useEffect(() => {
    if (leftRef.current) return;
    if (!isPresentingSearch(location.search) || location.search === PRESENT_SEARCH) return;
    const historyKey = readHistoryKey();
    if (historyKey !== undefined && historyKey !== (realLocation ?? location).key) return; // a navigation is in flight; wait for the next render
    const write = `${location.key}\n${location.pathname}`;
    if (lastNormalizeRef.current === write) return;
    lastNormalizeRef.current = write;
    void navigate(
      { pathname: location.pathname, search: PRESENT_SEARCH, hash: location.hash },
      { replace: true, state: location.state },
    );
  }, [location, navigate, readHistoryKey, realLocation]);

  useEffect(() => () => exitFullscreenIfLeftPresentation(), []);

  // While presenting the document behind does not scroll (on phones swiping past a slide's end would move the note and collapse the browser toolbar).
  // After leaving, scroll back only if still on the same note; another page decides its own position.
  // Layout effect: unlocking and restoring must happen before AppShell's list-position restore, and must not overwrite it.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const y = window.scrollY;
    const pathname = window.location.pathname;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = previous;
      if (window.location.pathname === pathname && window.scrollY !== y) window.scrollTo(0, y);
    };
  }, []);

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wake = useCallback(() => {
    setIdle(false);
    clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => setIdle(true), TOOLBAR_IDLE_MS);
  }, []);
  useEffect(() => {
    wake();
    return () => clearTimeout(idleTimerRef.current);
  }, [wake]);

  const ownedFullscreen = useSyncExternalStore(subscribeFullscreen, isOwnedFullscreen, () => false);
  const fullscreenEnabled = document.fullscreenEnabled === true;
  const keepFocus = (event: ReactMouseEvent) => event.preventDefault(); // a mouse click does not move focus
  const label = title.trim() === "" ? t("note.titlePlaceholder") : title;
  const errorText = fatalKey !== null ? t(fatalKey) : status === "error" ? errorMessage : undefined;

  return (
    <PresentationShellContext.Provider value={context}>
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("present.dialogLabel", { title: label })}
        tabIndex={-1}
        onMouseMove={wake}
        className="fixed inset-0 z-[60] flex flex-col bg-card text-foreground outline-none"
      >
        {/* Idle fade-out uses focus-within, not focus-visible: keyboard focus on any button reveals the whole row. */}
        <div
          className={cn(
            "absolute right-[max(0.75rem,env(safe-area-inset-right))] top-[max(0.75rem,env(safe-area-inset-top))] z-10 flex items-center gap-2 transition-opacity hover:opacity-100 focus-within:opacity-100",
            idle ? "opacity-0" : "opacity-100",
          )}
        >
          {toolbarExtra}
          {fullscreenEnabled && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={ownedFullscreen ? t("present.exitFullscreen") : t("present.enterFullscreen")}
              onMouseDown={keepFocus}
              onClick={() => {
                toggleFullscreen();
                rootRef.current?.focus();
              }}
            >
              {ownedFullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
            </Button>
          )}
          <Button type="button" variant="ghost" size="icon" aria-label={t("present.close")} onMouseDown={keepFocus} onClick={leave}>
            <X aria-hidden="true" className="h-4 w-4" />
          </Button>
        </div>
        {errorText !== undefined ? (
          <p role="alert" className="m-auto px-6 text-sm text-destructive">
            {errorText}
          </p>
        ) : status === "loading" ? (
          <p className="m-auto text-sm text-muted-foreground">{t("app.loading")}</p>
        ) : (
          <div className={`relative min-h-0 flex-1 ${SAFE_INSETS}`}>{children}</div>
        )}
      </div>
    </PresentationShellContext.Provider>
  );
}

interface PresentationErrorBoundaryProps {
  /** Test seam: jsdom's location.reload cannot be spied on. */
  reload?: () => void;
  children: ReactNode;
}

/** Public pages do not use the chunk auto-reload allowance, so this offers a manual retry (reloads the whole page). */
export class PresentationErrorBoundary extends Component<PresentationErrorBoundaryProps, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  private handleRetry = () => {
    (this.props.reload ?? (() => window.location.reload()))();
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    return <PresentationErrorFallback onRetry={this.handleRetry} />;
  }
}

function PresentationErrorFallback({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  // Offline, reload would only show the browser's network error page: disable the button with a text explanation until the online event.
  const online = useOnline();
  return (
    <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6">
      <p className="text-sm text-muted-foreground">{t("public.loadError")}</p>
      <Button type="button" variant="outline" disabled={!online} onClick={onRetry}>
        {t("app.retry")}
      </Button>
      {!online && <p className="text-sm text-muted-foreground">{t("app.offlineHint")}</p>}
    </div>
  );
}

import { Component, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import i18n from "@/i18n";
import { toast } from "@/components/ui/toast";
import { TourContext, type TourApi, type TourStartOptions } from "@/lib/tour-context";
import type { TourLazyProps } from "./TourLazy";

/** Only `import type` from `./TourLazy` is allowed here: any static import of tour modules pulls the whole chain into the first bundle (`scripts/check-bundle-size.mjs` fails). */

export const START_TIMEOUT_MS = 15_000;

type TourLazyComponent = ComponentType<TourLazyProps>;

let loadedTourLazy: TourLazyComponent | null = null;
let loadingTourLazy: Promise<TourLazyComponent> | null = null;

function loadTourLazy(): Promise<TourLazyComponent> {
  loadingTourLazy ??= import("./TourLazy").then(
    (m) => {
      loadedTourLazy = m.TourLazy;
      return m.TourLazy;
    },
    (err: unknown) => {
      // Retry the download on the next start.
      loadingTourLazy = null;
      throw err;
    },
  );
  return loadingTourLazy;
}

/** A render error ends the round with a toast instead of reaching `AppErrorBoundary` (which would replace the whole app). Keyed by `session.id`, so the next round gets a fresh boundary. The sample note is kept, as for any early end. */
class TourErrorBoundary extends Component<{ onCrash: () => void; children: ReactNode }, { crashed: boolean }> {
  state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(error);
    toast({ title: i18n.t("tourGuide.crashed"), variant: "destructive" });
    this.props.onCrash();
  }

  render() {
    return this.state.crashed ? null : this.props.children;
  }
}

interface Session extends TourStartOptions {
  id: number;
  timedOut: boolean;
}

/** One round at a time: `start` does nothing while a round is active (including while the sample note is still being prepared) and works again after it ends or aborts. The 15 s limit runs from the press until step 1 appears; on timeout the chunk's flow cleans up (toast, moves a blank sample note to trash). If the chunk failed to load or hadn't arrived at timeout, the tour's own strings are unavailable, so the first bundle's load-failure message is used. */
export function TourProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [TourLazy, setTourLazy] = useState<TourLazyComponent | null>(() => loadedTourLazy);
  const activeRef = useRef<number | null>(null);
  const nextIdRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const end = useCallback((id: number) => {
    if (activeRef.current !== id) return;
    activeRef.current = null;
    clearTimeout(timerRef.current);
    setSession(null);
  }, []);

  const api = useMemo<TourApi>(() => {
    const chunkFailed = (id: number) => {
      if (activeRef.current !== id) return;
      toast({ title: i18n.t("app.chunkLoadError"), variant: "destructive" });
      end(id);
    };
    return {
      start: (options) => {
        if (activeRef.current !== null) return;
        nextIdRef.current += 1;
        const id = nextIdRef.current;
        activeRef.current = id;
        setSession({ returnTo: options.returnTo, returnFocus: options.returnFocus, id, timedOut: false });
        timerRef.current = setTimeout(() => {
          if (activeRef.current !== id) return;
          if (loadedTourLazy === null) {
            chunkFailed(id);
            return;
          }
          setSession((s) => (s !== null && s.id === id ? { ...s, timedOut: true } : s));
        }, START_TIMEOUT_MS);
        loadTourLazy().then(
          (component) => {
            if (activeRef.current === id) setTourLazy(() => component);
          },
          (err: unknown) => {
            console.error(err);
            chunkFailed(id);
          },
        );
      },
    };
  }, [end]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <TourContext.Provider value={api}>
      {children}
      {session !== null && TourLazy !== null && (
        <TourErrorBoundary key={session.id} onCrash={() => end(session.id)}>
          <TourLazy
            returnTo={session.returnTo}
            returnFocus={session.returnFocus}
            timedOut={session.timedOut}
            onStarted={() => {
              // Only stops the timer (cleanup): after step 1 appears nothing aborts; TourLazy decides by `started`.
              if (activeRef.current === session.id) clearTimeout(timerRef.current);
            }}
            onDone={() => end(session.id)}
          />
        </TourErrorBoundary>
      )}
    </TourContext.Provider>
  );
}

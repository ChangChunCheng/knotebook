import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router";
import { useCloseSidebarDrawer } from "@/lib/sidebar-drawer";
import { enterPresentationFullscreen } from "./fullscreen";
import { PRESENT_SEARCH, presentPushedState } from "./present-url";

/**
 * Must be called synchronously inside a user event handler (requestFullscreen works only in the gesture's synchronous part).
 * presentHere pushes the current pathname (not the canonical one) + `?present` with state holding only the flag: existing
 * state is not spread (openEdits would reopen a dialog, knotebookCanonicalizedFrom would mislead AppShell's drawer decision).
 * presentNote pushes that note's canonical path with no flag (on close, replace drops present and lands on its normal page).
 */
export function usePresentEntry(): { presentHere: () => void; presentNote: (pathname: string) => void } {
  const navigate = useNavigate();
  const location = useLocation();
  const closeDrawer = useCloseSidebarDrawer();

  const presentHere = useCallback(() => {
    closeDrawer();
    enterPresentationFullscreen();
    void navigate({ pathname: location.pathname, search: PRESENT_SEARCH, hash: "" }, { state: presentPushedState() });
  }, [closeDrawer, location.pathname, navigate]);

  const presentNote = useCallback(
    (pathname: string) => {
      closeDrawer();
      enterPresentationFullscreen();
      void navigate({ pathname, search: PRESENT_SEARCH });
    },
    [closeDrawer, navigate],
  );

  return { presentHere, presentNote };
}

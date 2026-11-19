import type { Location, NavigateFunction } from "react-router";
import { panelEntryState } from "@/lib/panel-return";

/**
 * Passes the current location as `backgroundLocation`: omitting it would land on `/` at close and
 * tear down the background note page and its collab connection. UserMenu and AppShell both go
 * through here; do not duplicate it.
 */
export function openSettings(navigate: NavigateFunction, location: Location, reopenMenu?: () => void): void {
  navigate("/settings/account", { state: panelEntryState(location, reopenMenu) });
}

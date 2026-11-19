import type { Location } from "react-router";

/**
 * Phone panel back stack: the first-level ‹ closes the sheet and reopens the menu it was opened
 * from, if any (deep links, buttons and shortcuts only close).
 * Only one panel exists at a time, so only the latest callback is remembered; history state holds
 * only serializable values, hence the token. `forgetPanelReturn` on close so a later navigation
 * with the same token (e.g. a reload) only closes without reopening.
 */
export interface PanelLocationState {
  backgroundLocation?: Location;
  panelStart?: "list";
  panelReturn?: string;
}

let pending: { token: string; reopen: () => void } | null = null;
let seq = 0;

export function rememberPanelReturn(reopen: () => void): string {
  seq += 1;
  const token = `panel-return-${seq}`;
  pending = { token, reopen };
  return token;
}

export function panelReturnFor(token: unknown): (() => void) | null {
  return pending !== null && pending.token === token ? pending.reopen : null;
}

export function forgetPanelReturn(token: unknown): void {
  if (pending !== null && pending.token === token) pending = null;
}

export function panelEntryState(backgroundLocation: Location | undefined, reopen?: () => void): PanelLocationState {
  return {
    ...(backgroundLocation ? { backgroundLocation } : {}),
    panelStart: "list",
    ...(reopen ? { panelReturn: rememberPanelReturn(reopen) } : {}),
  };
}

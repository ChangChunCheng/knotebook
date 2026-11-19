import { describe, expect, it, vi } from "vitest";
import { forgetPanelReturn, panelReturnFor } from "./panel-return";
import type { Location } from "react-router";
import { openSettings } from "./open-settings";

describe("openSettings", () => {
  it("navigates to /settings/account with the current location as backgroundLocation; on phone starts from the item list (panelStart)", () => {
    const navigate = vi.fn();
    const location = { pathname: "/n/tester/my-note", search: "?x=1", hash: "#b-1", state: null, key: "k" } as Location;
    openSettings(navigate, location);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/settings/account", { state: { backgroundLocation: location, panelStart: "list" } });
  });

  it("opening from the menu (reopenMenu): state carries a token, with which the panel finds the callback that reopens the menu; after forgetting (forget) it can no longer be found", () => {
    const navigate = vi.fn();
    const location = { pathname: "/", search: "", hash: "", state: null, key: "k" } as Location;
    const reopen = vi.fn();
    openSettings(navigate, location, reopen);
    const state = navigate.mock.calls[0]![1].state as { panelReturn?: string; panelStart?: string };
    expect(state.panelStart).toBe("list");
    expect(typeof state.panelReturn).toBe("string");
    expect(panelReturnFor(state.panelReturn)).toBe(reopen);
    expect(panelReturnFor("someone-else")).toBeNull();
    forgetPanelReturn(state.panelReturn);
    expect(panelReturnFor(state.panelReturn)).toBeNull();
  });
});

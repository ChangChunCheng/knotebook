import { describe, expect, it, vi } from "vitest";
import { forgetPanelReturn, panelReturnFor } from "./panel-return";
import type { Location } from "react-router";
import { openSettings } from "./open-settings";

describe("openSettings", () => {
  it("導到 /settings/account，並帶目前 location 當 backgroundLocation；手機從項次清單開始（panelStart）", () => {
    const navigate = vi.fn();
    const location = { pathname: "/n/tester/my-note", search: "?x=1", hash: "#b-1", state: null, key: "k" } as Location;
    openSettings(navigate, location);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/settings/account", { state: { backgroundLocation: location, panelStart: "list" } });
  });

  it("從選單開（reopenMenu）：state 帶 token，面板用它找得回重開選單的 callback；關掉（forget）後就找不到", () => {
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

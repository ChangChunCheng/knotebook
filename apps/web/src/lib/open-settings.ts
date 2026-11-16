import type { Location, NavigateFunction } from "react-router";
import { panelEntryState } from "@/lib/panel-return";

/**
 * 打開個人設定 modal 的唯一一條路：導到 `/settings/account`，帶目前 location 當 `backgroundLocation`（設定總 modal）——
 * 關閉時 `SettingsModal` 才找得回原本的背景頁。使用者選單的「設定」項（`UserMenu`）與 Ctrl/Cmd+,（`AppShell`）都走這裡，
 * 不得各寫一份（少帶 backgroundLocation 會讓關閉時落回 `/`、靜默扯掉背景的筆記頁與共編連線）。
 * 手機從項次清單開始（`panelStart`）；從選單開的傳 `reopenMenu`，項次清單的「‹」關掉設定後重開那個選單（`lib/panel-return.ts`）。
 */
export function openSettings(navigate: NavigateFunction, location: Location, reopenMenu?: () => void): void {
  navigate("/settings/account", { state: panelEntryState(location, reopenMenu) });
}

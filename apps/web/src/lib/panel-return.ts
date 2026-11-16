import type { Location } from "react-router";

/**
 * 手機（< 640）管理面板 sheet 的返回堆疊：第一層（項次清單）的「‹」關掉 sheet；面板是從選單打開的，就在 sheet 收下去之後
 * 把那個選單重新打開（帳號選單的「設定」「站台管理」、群組列 ⋮ 的「成員與設定」）。不是從選單開的（深連結、按鈕、快捷鍵），只關掉。
 *
 * 選單打開面板時用 `panelEntryState` 產生導覽 state：`panelStart: "list"`（手機從項次清單開始，而不是直接進某一頁）與一個 token；
 * 「怎麼重開選單」的 callback 留在這裡（history state 只能放可序列化的值）。同一時間只有一個面板，所以只記最後一次；
 * 面板關掉時 `forgetPanelReturn` 清掉，之後用同一個 token 的導覽（例如重新整理）就找不到它，只關不重開。
 */
export interface PanelLocationState {
  backgroundLocation?: Location;
  /** 手機上從項次清單（第一層）開始；沒有＝直接顯示網址指的那一頁（深連結）。 */
  panelStart?: "list";
  /** 第一層「‹」要重開的選單（`rememberPanelReturn` 的 token）。 */
  panelReturn?: string;
}

let pending: { token: string; reopen: () => void } | null = null;
let seq = 0;

/** 登記「怎麼重開開啟面板的那個選單」，回傳要放進導覽 state 的 token。 */
export function rememberPanelReturn(reopen: () => void): string {
  seq += 1;
  const token = `panel-return-${seq}`;
  pending = { token, reopen };
  return token;
}

/** token 對得上目前登記的選單就回傳重開它的 callback，否則 null（不是從選單開的、或已經關過）。 */
export function panelReturnFor(token: unknown): (() => void) | null {
  return pending !== null && pending.token === token ? pending.reopen : null;
}

/** 面板關掉時清掉這個 token 的登記。 */
export function forgetPanelReturn(token: unknown): void {
  if (pending !== null && pending.token === token) pending = null;
}

/** 從選單打開面板的導覽 state：手機從項次清單開始；給了 `reopen`，第一層的「‹」會重開那個選單。 */
export function panelEntryState(backgroundLocation: Location | undefined, reopen?: () => void): PanelLocationState {
  return {
    ...(backgroundLocation ? { backgroundLocation } : {}),
    panelStart: "list",
    ...(reopen ? { panelReturn: rememberPanelReturn(reopen) } : {}),
  };
}

import { useSyncExternalStore } from "react";

/** 沒有記錄過鍵盤高度時，色盤用的高度（px）：介於常見手機直拿鍵盤高度的低端。 */
export const DEFAULT_PANEL_HEIGHT_PX = 280;

let rememberedKeyboardInset = 0;

/** 記下鍵盤穩定開著時的高度，之後鍵盤收起、色盤取代它的位置時用。 */
export function rememberKeyboardInset(inset: number): void {
  rememberedKeyboardInset = inset;
}

/** 色盤的高度：上一次記下的鍵盤高度，沒有就用預設值。 */
export function panelHeightPx(): number {
  return rememberedKeyboardInset > 0 ? rememberedKeyboardInset : DEFAULT_PANEL_HEIGHT_PX;
}

export function resetRememberedKeyboardInsetForTest(): void {
  rememberedKeyboardInset = 0;
  setColorPanelHeight(0);
}

let colorPanelHeight = 0;
const listeners = new Set<() => void>();

/** 色盤開著時佔掉的高度；工具列以外的元件（文件尾端的空白）靠它讓游標所在行不被色盤蓋住。 */
export function setColorPanelHeight(height: number): void {
  if (colorPanelHeight === height) return;
  colorPanelHeight = height;
  listeners.forEach((listener) => listener());
}

export function useColorPanelHeight(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => colorPanelHeight,
    () => 0,
  );
}

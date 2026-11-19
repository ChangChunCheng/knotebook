import { useSyncExternalStore } from "react";

/** Fallback colour-panel height (px) when no keyboard height was recorded: low end of common portrait phone keyboards. */
export const DEFAULT_PANEL_HEIGHT_PX = 280;

let rememberedKeyboardInset = 0;

export function rememberKeyboardInset(inset: number): void {
  rememberedKeyboardInset = inset;
}

export function panelHeightPx(): number {
  return rememberedKeyboardInset > 0 ? rememberedKeyboardInset : DEFAULT_PANEL_HEIGHT_PX;
}

export function resetRememberedKeyboardInsetForTest(): void {
  rememberedKeyboardInset = 0;
  setColorPanelHeight(0);
}

let colorPanelHeight = 0;
const listeners = new Set<() => void>();

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

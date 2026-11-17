import type { TFunction } from "i18next";
import { tourLayout, type TourLayout } from "@/lib/tour-find";
import type { StopDef, StopId } from "./stops";

/** 至少一站：最後一站固定是完整導覽的最後一站（「忘了去哪裡找」）。 */
export type NonEmptyStops = readonly [StopId, ...StopId[]];

export interface SequenceEntry {
  id: StopId;
}

/** 組出一次導覽要走的站：完整導覽，照 `FULL_TOUR` 的順序。 */
export function buildSequence(full: NonEmptyStops): SequenceEntry[] {
  return full.map((id): SequenceEntry => ({ id }));
}

/** 標題：手機有自己的標題就用它（手機沒有側欄，清單是另一個畫面）。 */
export function stopTitle(t: TFunction, stop: StopDef, layout: TourLayout = tourLayout()): string {
  return t(layout === "phone" && stop.phoneTitleKey !== undefined ? stop.phoneTitleKey : stop.titleKey);
}

import type { TFunction } from "i18next";
import { tourLayout, type TourLayout } from "@/lib/tour-find";
import type { StopDef, StopId } from "./stops";

export type NonEmptyStops = readonly [StopId, ...StopId[]];

export interface SequenceEntry {
  id: StopId;
}

export function buildSequence(full: NonEmptyStops): SequenceEntry[] {
  return full.map((id): SequenceEntry => ({ id }));
}

export function stopTitle(t: TFunction, stop: StopDef, layout: TourLayout = tourLayout()): string {
  return t(layout === "phone" && stop.phoneTitleKey !== undefined ? stop.phoneTitleKey : stop.titleKey);
}

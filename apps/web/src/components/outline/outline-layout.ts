import { CORNER_STACK_FOOTPRINT_PX } from "@/components/corner-stack-geometry";

/** 右側標題大綱的版面幾何。所有座標以捲動容器的左緣為原點。 */

export const OUTLINE_PANEL_WIDTH = 240;
export const OUTLINE_GAP = 16;
export const OUTLINE_RAIL_WIDTH = 24;
/** 釘住時，內文欄右緣與面板之間再多留的餘量。 */
export const OUTLINE_PIN_SLACK = 24;
export const OUTLINE_MIN_PINNED_COLUMN = 640;
export const OUTLINE_TOP_OFFSET = 12;
/** 細線與浮動面板離容器右緣至少這麼多（釘住的面板貼齊右緣，不受此限）。 */
export const OUTLINE_EDGE_INSET = 4;
/** 面板底部離版本泡泡（或容器底）的距離。 */
export const OUTLINE_BOTTOM_GAP = 12;

/** 容器夠寬，扣掉面板、間距與餘量後，內文欄仍有 640px 以上。 */
export function canPinOutline(containerWidth: number): boolean {
  return containerWidth - OUTLINE_PANEL_WIDTH - OUTLINE_GAP - OUTLINE_PIN_SLACK >= OUTLINE_MIN_PINNED_COLUMN;
}

export interface OutlinePlacement {
  /** 細線區塊的左緣。 */
  railLeft: number;
  /** 浮動面板的左緣。 */
  panelLeft: number;
  /** 釘住時面板的左緣（貼容器右緣）。 */
  pinnedPanelLeft: number;
}

/** 細線與浮動面板緊貼內文欄右緣外側；放不下時退到容器右緣內側（浮動面板會蓋在內文上）。 */
export function outlinePlacement(containerWidth: number, columnRight: number): OutlinePlacement {
  const W = containerWidth;
  const next = columnRight + OUTLINE_GAP;
  const railLeft = next + OUTLINE_RAIL_WIDTH > W - OUTLINE_EDGE_INSET ? W - OUTLINE_EDGE_INSET - OUTLINE_RAIL_WIDTH : next;
  const panelLeft = next + OUTLINE_PANEL_WIDTH > W - OUTLINE_EDGE_INSET ? Math.max(0, W - OUTLINE_EDGE_INSET - OUTLINE_PANEL_WIDTH) : next;
  return { railLeft, panelLeft, pinnedPanelLeft: W - OUTLINE_PANEL_WIDTH };
}

/** 面板可用的最大高度；版本泡泡顯示時底部要停在泡泡上方。 */
export function outlineMaxHeight(containerHeight: number, bubbleShown: boolean): number {
  const bottom = bubbleShown ? CORNER_STACK_FOOTPRINT_PX + OUTLINE_BOTTOM_GAP : OUTLINE_BOTTOM_GAP;
  return Math.max(0, containerHeight - OUTLINE_TOP_OFFSET - bottom);
}

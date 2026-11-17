import { CORNER_STACK_FOOTPRINT_PX, CORNER_STACK_RIGHT_INSET_PX, CORNER_STACK_SIZE_PX } from "@/components/corner-stack-geometry";

/** 右側標題大綱的版面幾何。所有座標以捲動容器的左緣為原點。 */

export const OUTLINE_PANEL_WIDTH = 240;
export const OUTLINE_GAP = 16;
export const OUTLINE_RAIL_WIDTH = 24;
/** 釘住時，內文欄右緣與面板之間再多留的餘量。 */
export const OUTLINE_PIN_SLACK = 24;
export const OUTLINE_MIN_PINNED_COLUMN = 640;
/** 細線區塊離容器上緣的距離。 */
export const OUTLINE_TOP_OFFSET = 28;
/** 細線與浮動面板離容器右緣至少這麼多（釘住的面板離右緣半份 `OUTLINE_PIN_SLACK`，見 `outlinePlacement`）。 */
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
  /** 釘住時面板的左緣（內文欄右側，右緣至少離容器右緣半份餘量）。 */
  pinnedPanelLeft: number;
}

/**
 * 細線固定在版本泡泡正上方的直欄（見 `railLeft`）；浮動面板緊貼內文欄右緣外側，放不下時退到容器右緣內側（會蓋在內文上）。
 *
 * 釘住的面板同樣在欄右側一個間距處，但右緣不超過「容器右緣 − 半份餘量」。釘住的欄
 * （`ui/article-column.ts` 的 `standard-pinned`）右緣離容器右緣至少 面板＋間距＋半份餘量，
 * 所以停下來時兩條規則落在同一點：欄本來就讓得出位置時面板就在浮動面板的位置（釘住不跳），
 * 欄要往左讓時面板一開始就停在終點，不跟著過場中還沒量到的欄右緣移動。
 */
export function outlinePlacement(containerWidth: number, columnRight: number): OutlinePlacement {
  const W = containerWidth;
  const next = columnRight + OUTLINE_GAP;
  // 細線的水平中心與版本泡泡同一直欄：泡泡右緣離可視寬度 `CORNER_STACK_RIGHT_INSET_PX`、寬 `CORNER_STACK_SIZE_PX`
  // （捲軸槽已不在可視寬度內）。與泡泡是否顯示、版本面板與大綱面板是否開著都無關。
  const bubbleCenter = W - CORNER_STACK_RIGHT_INSET_PX - CORNER_STACK_SIZE_PX / 2;
  const railLeft = Math.min(bubbleCenter - OUTLINE_RAIL_WIDTH / 2, W - OUTLINE_EDGE_INSET - OUTLINE_RAIL_WIDTH);
  const panelLeft = next + OUTLINE_PANEL_WIDTH > W - OUTLINE_EDGE_INSET ? Math.max(0, W - OUTLINE_EDGE_INSET - OUTLINE_PANEL_WIDTH) : next;
  const pinnedPanelLeft = Math.min(next, W - OUTLINE_PIN_SLACK / 2 - OUTLINE_PANEL_WIDTH);
  return { railLeft, panelLeft, pinnedPanelLeft };
}

/** 面板可用的最大高度；版本泡泡顯示時底部要停在泡泡上方。 */
export function outlineMaxHeight(containerHeight: number, bubbleShown: boolean): number {
  const bottom = bubbleShown ? CORNER_STACK_FOOTPRINT_PX + OUTLINE_BOTTOM_GAP : OUTLINE_BOTTOM_GAP;
  return Math.max(0, containerHeight - OUTLINE_TOP_OFFSET - bottom);
}

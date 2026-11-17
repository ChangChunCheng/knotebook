import { CORNER_STACK_FOOTPRINT_PX, CORNER_STACK_RIGHT_INSET_PX, CORNER_STACK_SIZE_PX } from "@/components/corner-stack-geometry";

/** 右側標題大綱的版面幾何。所有座標以捲動容器的左緣為原點。 */

export const OUTLINE_PANEL_WIDTH = 240;
export const OUTLINE_GAP = 16;
export const OUTLINE_RAIL_WIDTH = 24;
export const OUTLINE_MIN_PINNED_COLUMN = 640;
/** 量不到第一個區塊（文件還沒有內容）時，大綱離容器上緣的距離。 */
export const OUTLINE_TOP_OFFSET = 28;
/** 面板底部離版本泡泡（或容器底）的距離。 */
export const OUTLINE_BOTTOM_GAP = 12;
/** 面板（浮動與釘住同位置）的高度上限占捲動容器可視高度的比例。 */
export const OUTLINE_MAX_HEIGHT_RATIO = 2 / 3;

/**
 * 面板右緣與細線右緣對齊，離容器右緣的距離：泡泡右緣的內縮，加上泡泡與細線的寬度差的一半
 * （細線的水平中心與泡泡同一直欄）。
 */
export const OUTLINE_PANEL_RIGHT_INSET = CORNER_STACK_RIGHT_INSET_PX + (CORNER_STACK_SIZE_PX - OUTLINE_RAIL_WIDTH) / 2;

/**
 * 釘住時內文欄右緣離容器右緣至少這麼多：面板寬、與欄之間的間距、面板右緣離容器右緣的距離。
 * `ui/article-column.ts` 的 `standard-pinned` 讓出同一個寬度（`article-column.guard.test.ts` (f) 綁在一起）。
 */
export const OUTLINE_PIN_RESERVED_WIDTH = OUTLINE_PANEL_WIDTH + OUTLINE_GAP + OUTLINE_PANEL_RIGHT_INSET;

/** 容器夠寬，扣掉保留的寬度後，內文欄仍有 640px 以上。 */
export function canPinOutline(containerWidth: number): boolean {
  return containerWidth - OUTLINE_PIN_RESERVED_WIDTH >= OUTLINE_MIN_PINNED_COLUMN;
}

export interface OutlinePlacement {
  /** 細線區塊的左緣。 */
  railLeft: number;
  /** 面板的左緣：浮動與釘住同一個位置。 */
  panelLeft: number;
}

/**
 * 細線固定在版本泡泡正上方的直欄（見 `railLeft`）：跟著捲動區可視寬度的右緣走（版本面板靠右展開時卡片變窄、細線隨之左移），
 * 除此之外沒有任何面板的開關會移動它。
 *
 * 面板的右緣與細線的右緣對齊（浮動與釘住同一個位置，釘住時面板不動）：它蓋住細線，指標從細線進面板不會經過空隙。
 * 釘住時內文欄讓出 `OUTLINE_PIN_RESERVED_WIDTH`，與面板之間留 `OUTLINE_GAP`。
 */
export function outlinePlacement(containerWidth: number): OutlinePlacement {
  const W = containerWidth;
  // 細線的水平中心與版本泡泡同一直欄：泡泡右緣離可視寬度 `CORNER_STACK_RIGHT_INSET_PX`、寬 `CORNER_STACK_SIZE_PX`
  // （捲軸槽已不在可視寬度內）。與泡泡是否顯示、版本面板與大綱面板是否開著都無關。
  const bubbleCenter = W - CORNER_STACK_RIGHT_INSET_PX - CORNER_STACK_SIZE_PX / 2;
  const railLeft = bubbleCenter - OUTLINE_RAIL_WIDTH / 2;
  const panelLeft = Math.max(0, railLeft + OUTLINE_RAIL_WIDTH - OUTLINE_PANEL_WIDTH);
  return { railLeft, panelLeft };
}

/** 大綱上緣離容器上緣的距離：第一行內文的頂端；量不到時退回 `OUTLINE_TOP_OFFSET`。 */
export function outlineTop(box: { firstLineTop: number | null }): number {
  return box.firstLineTop ?? OUTLINE_TOP_OFFSET;
}

/**
 * 面板與細線可用的最大高度（`top` 為大綱上緣離容器上緣的距離）：容器可視高度的 2/3 與
 * 「版本泡泡顯示時底部停在泡泡上方」兩者取小，超過的部分在面板內捲動。
 */
export function outlineMaxHeight(containerHeight: number, bubbleShown: boolean, top: number = OUTLINE_TOP_OFFSET): number {
  const bottom = bubbleShown ? CORNER_STACK_FOOTPRINT_PX + OUTLINE_BOTTOM_GAP : OUTLINE_BOTTOM_GAP;
  return Math.max(0, Math.min(containerHeight * OUTLINE_MAX_HEIGHT_RATIO, containerHeight - top - bottom));
}

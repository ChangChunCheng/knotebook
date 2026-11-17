import type { NoteWidth } from "@knotebook/shared";

/**
 * 內文卡的**文章欄**：BlockNote 置中 wrapper 的寬度鏈與內距（消費端
 * `NoteEditor.tsx`、`PublicNotePage.tsx`（#72 起公開唯讀頁沿用同一條欄）與
 * `VersionPreview.tsx` 的單欄 diff）。
 *
 * #297 起欄寬分三段（標準／寬／全寬），消費端一律經 `articleColumn(width)` 取 class；
 * 三段 class 的單一真相在這個檔（Tailwind 掃這裡的字面字串）。站內寬度見
 * `components/note-width.ts`，公開頁寬度來自公開端點的 `width`。
 *
 * 歷史：#88 曾讓頁首（標題列）／頁尾（backlinks strip）也套這條欄做三線對齊；
 * #115 版面改版改成「頁首/頁尾回滿卡寬（置左置右）」，對齊機制連同
 * `ARTICLE_COLUMN_INSET` 一併拆除——把欄加回頁首/頁尾是刻意拆掉的行為，
 * `article-column.guard.test.ts` (d) 有反向守衛。
 *
 * 釘住（#465）：標準寬的筆記把標題大綱釘在右側時，欄改用 `standard-pinned` 這一態，
 * 它是寬度鏈的一個狀態，欄寬與位移只寫在這個檔（`articleColumnState(width, pinned)` 取態）。
 * 能不能釘（容器夠不夠寬）由 `outline/outline-layout.ts` 的 `canPinOutline` 判斷；兩邊的
 * 保留寬度由 `article-column.guard.test.ts` (f) 綁在一起。
 */

/** 欄的寬度狀態：三段寬度，加上標準寬釘住大綱時的那一態。 */
export type ArticleColumnState = NoteWidth | "standard-pinned";

/** 置中與撐滿：各態共用。 */
export const ARTICLE_COLUMN_BASE = "mx-auto w-full";

/**
 * 三段的 max-width。
 *
 * - 標準：容器的 85%，下限 42.5rem（680px＝改版前寫死的欄寬）、上限 66rem（1056px）。
 *   **下限承重、不得改成 `min()`**：中等視窗（捲動容器約 730px）的 85% 只有 620px，
 *   比舊版還窄——clamp 的下限把這一段拉回舊行為。
 * - 寬：同一個下限、92.5%、上限 88rem（1408px）；父層寬約 735px 以下時兩者都落在下限、與標準相同。
 * - 全寬：不設上限。
 *
 * - 標準＋釘住：欄寬＝min(標準欄寬, 容器 − 17.875rem)。17.875rem＝286px＝面板 240＋間距 16＋
 *   面板右緣離容器右緣 30（與浮動面板同一個位置，釘住時面板不動）。位移＝min(0, 置中後右側空白 − 17.875rem)：
 *   欄右緣離容器右緣至少 286px，與面板之間留 16px。置中後右側空白本來就夠，`left` 是 0、內文不動；
 *   不夠時只往左讓到剛好。欄被壓窄時欄左緣恰好貼著容器左緣。
 *   位移用 `left`（欄本身是 `relative`）：margin 的 `auto` 不能過場；transform 會讓欄成為
 *   裡面 fixed 浮層的 containing block。
 *
 * 視窗更窄時 `w-full` 讓欄縮到滿版（max-width 不會撐出橫向捲動）。百分比對
 * max-width 與 `left` 都以父層（捲動容器）寬度解析。
 */
export const ARTICLE_COLUMN_MAX: Record<ArticleColumnState, string> = {
  standard: "max-w-[clamp(42.5rem,85%,66rem)]",
  wide: "max-w-[clamp(42.5rem,92.5%,88rem)]",
  full: "max-w-none",
  "standard-pinned":
    "max-w-[min(clamp(42.5rem,85%,66rem),calc(100%_-_17.875rem))] left-[min(0px,calc((100%_-_min(clamp(42.5rem,85%,66rem),calc(100%_-_17.875rem)))/2_-_17.875rem))]",
};

/** 釘住／取消釘住時欄寬與位移的過場（約 150ms；減少動態時不過場）。 */
export const ARTICLE_COLUMN_PIN_MOTION = "transition-[max-width,left] duration-150 ease-out motion-reduce:transition-none";

/** 釘住只對標準寬有效：寬版、全寬是使用者要內文寬，照原寬度。 */
export function articleColumnState(width: NoteWidth, pinned: boolean): ArticleColumnState {
  return pinned && width === "standard" ? "standard-pinned" : width;
}

/**
 * 文章欄的置中寬度鏈（指定狀態）。
 *
 * `pinMotion`：給能切換釘住的消費端用。標準寬的兩態加上過場，未釘住那態明寫 `left-0`
 * （`left: auto` 不能過場）；寬版、全寬不會釘住，忽略。不帶時輸出只有寬度鏈本身。
 */
export function articleColumn(state: ArticleColumnState = "standard", options?: { pinMotion?: boolean }): string {
  const column = `${ARTICLE_COLUMN_BASE} ${ARTICLE_COLUMN_MAX[state]}`;
  if (options?.pinMotion !== true) return column;
  if (state === "standard") return `${column} left-0 ${ARTICLE_COLUMN_PIN_MOTION}`;
  if (state === "standard-pinned") return `${column} ${ARTICLE_COLUMN_PIN_MOTION}`;
  return column;
}

/** 舊名保留＝標準。 */
export const ARTICLE_COLUMN = articleColumn("standard");

/**
 * 置中 wrapper 自己那層左右內距。
 *
 * - `md+`：`px-4`（16px）＋ BlockNote `.bn-editor` 內建的 54px ＝ 文字左緣 70px。
 * - `<md`：`px-0`＋ index.css 的 `.bn-editor.bn-editor{padding-inline:1.25rem}`
 *   覆寫 ＝ 文字左緣 20px（與頁首/頁尾的 `px-5` 共線）。`max-md:` 實編
 *   `@media (width < 48rem)`，與 index.css 那條媒體查詢同界——兩邊必須一起動，
 *   否則 767–768px 間會出現 wrapper 已 px-0 而 54px 仍在的縫。
 */
export const ARTICLE_COLUMN_PADDING = "px-4 max-md:px-0";

/**
 * BlockNote `.bn-editor` 內建的 `padding-inline`（側選單／拖曳把手的落點）。
 *
 * 54 已無生產端消費者（#115 拆掉頁首/頁尾的 70px 推導後），留著是**升版哨兵**：
 * `<md` 的 20px 覆寫是以「原值 54」為前提設計的，BlockNote 升版改掉這個值時
 * `article-column.guard.test.ts` (c) 會紅，逼人重新評估兩個斷點的內距，而不是
 * 靜默錯開。
 */
export const BN_EDITOR_INLINE_PADDING_PX = 54;

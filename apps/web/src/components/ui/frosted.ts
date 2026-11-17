/**
 * 毛玻璃面：半透明卡片底加背景模糊與飽和、明暗各一條細框、陰影；hover 與按下只微調透明度，不換成實心色。
 * 不支援 `backdrop-filter` 的瀏覽器退回幾乎不透明的底（沒有模糊，透明就會讓下面的字干擾圖示）。
 * 用 `ghost` 鈕當底（沒有自帶的底色與框）。尺寸、定位與層級由使用處自己加。
 */
export const FROSTED_SURFACE =
  "border border-black/10 bg-card/95 dark:border-white/20 shadow-lg " +
  "supports-[backdrop-filter]:bg-card/25 supports-[backdrop-filter]:backdrop-blur-xs supports-[backdrop-filter]:backdrop-saturate-150 " +
  "hover:bg-card/95 supports-[backdrop-filter]:hover:bg-card/30 " +
  "active:bg-card/95 supports-[backdrop-filter]:active:bg-card/40";

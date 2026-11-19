/** Falls back to an almost opaque background without `backdrop-filter` (no blur, and translucency would let text underneath interfere with the icon). Built on a `ghost` button (no own fill or border); size, position and layer are added by the caller. */
export const FROSTED_SURFACE =
  "border border-black/10 bg-card/95 dark:border-white/20 shadow-lg " +
  "supports-[backdrop-filter]:bg-card/25 supports-[backdrop-filter]:backdrop-blur-xs supports-[backdrop-filter]:backdrop-saturate-150 " +
  "hover:bg-card/95 supports-[backdrop-filter]:hover:bg-card/30 " +
  "active:bg-card/95 supports-[backdrop-filter]:active:bg-card/40";

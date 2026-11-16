/**
 * 手機（< 640）換畫面時文件要捲到哪。手機上清單、全螢幕搜尋層與筆記共用同一條文件捲動（見 `page-scroll.ts`），
 * 所以各畫面的位置要自己記、自己還：
 * - 回到清單（「‹」、系統返回、搜尋層 Cancel）：回到離開清單時的位置；
 * - 打開搜尋層：從頂端開始；
 * - 打開一篇筆記：從頂端開始；同一篇換網址（改標題後的網址收斂）不動；
 * - 搜尋層蓋在筆記上、Cancel（或點到同一篇）：回到打開搜尋層時那篇的位置。
 */
export type PhoneScreen = { kind: "list" } | { kind: "search" } | { kind: "note"; path: string };

export interface PhoneScrollMemory {
  /** 清單最後的捲動位置。 */
  list: number;
  /** 目前這篇筆記最後的捲動位置。 */
  note: number;
  /** 搜尋層是從哪篇筆記上打開的、那時的位置；從清單打開時 null。 */
  underSearch: { path: string; y: number } | null;
}

export function createPhoneScrollMemory(): PhoneScrollMemory {
  return { list: 0, note: 0, underSearch: null };
}

/** 給 effect 當依賴用的畫面識別字串。 */
export function phoneScreenKey(screen: PhoneScreen | null): string {
  if (screen === null) return "";
  return screen.kind === "note" ? `note:${screen.path}` : screen.kind;
}

/** 記下目前畫面的捲動位置（搜尋層不記：關掉後回到的是清單或筆記自己的位置）。 */
export function rememberPhoneScroll(memory: PhoneScrollMemory, screen: PhoneScreen, y: number): void {
  if (screen.kind === "list") memory.list = y;
  else if (screen.kind === "note") memory.note = y;
}

/**
 * 從 `prev` 換到 `next` 時文件要捲到的位置；null＝不動（同一個畫面、剛進手機寬度）。
 * `canonicalFrom`：這一格網址是哪個舊網址收斂來的（同一篇改了網址），沒有就 null。
 */
export function enterPhoneScreen(memory: PhoneScrollMemory, prev: PhoneScreen | null, next: PhoneScreen, canonicalFrom: string | null): number | null {
  const sameNoteAs = (path: string) => next.kind === "note" && (next.path === path || canonicalFrom === path);
  if (prev === null) {
    if (next.kind === "search") memory.underSearch = null;
    return null;
  }
  switch (next.kind) {
    case "list":
      return prev.kind === "list" ? null : memory.list;
    case "search":
      if (prev.kind === "search") return null;
      memory.underSearch = prev.kind === "note" ? { path: prev.path, y: memory.note } : null;
      return 0;
    case "note": {
      if (prev.kind === "note") return sameNoteAs(prev.path) ? null : 0;
      const under = prev.kind === "search" ? memory.underSearch : null;
      memory.underSearch = null;
      return under !== null && sameNoteAs(under.path) ? under.y : 0;
    }
  }
}

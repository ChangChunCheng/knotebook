import type { AiActionDto } from "@knotebook/shared";
import type { TFunction } from "i18next";
import "@/i18n/tour-strings";
import { isMacPlatform } from "@/lib/platform";
import { getShellControls, getTourNoteEditor } from "@/lib/tour-bridge";
import { findDrawerButton, findTourTarget, findUserMenuTrigger, tourLayout, type TourLayout } from "@/lib/tour-find";
import {
  findInSampleEditor,
  liveSelectionTarget,
  liveTriggerTarget,
  startLiveSelection,
  startLiveTrigger,
  stopLiveSelection,
  stopLiveTrigger,
} from "./live-stops";

/**
 * 功能導覽的站點表。每站說明要指哪裡（`target`）、要先做什麼（`prepare`）、什麼情況下整站不跑（`precondition`）。
 *
 * - 目標一律靠元件上的 `data-kb-tour-target` 屬性找（`lib/tour-targets.ts`），不比名稱：側欄裡到處是使用者自己取的名字。
 *   每次都重新查 DOM：AppShell 會隨首頁↔筆記頁、筆記頁整頁載入換殼，先前查到的元素可能已經卸載。
 * - 現場演示站（`live`）在示範筆記的編輯器裡叫出真的選單，細節見 `live-stops.ts`；它們的 `leave` 負責收掉選單與過濾。
 * - 三種版面（`lib/tour-find.ts` 的 `tourLayout`）各有自己的目標與說明：
 *   - 側欄浮動（640～1279）時側欄收在抽屜裡。抽屜是會鎖焦點、把外面標成 `aria-hidden` 的 modal，開著時導覽卡片按不到，
 *     所以側欄裡的站改指頁首的側欄鈕（`narrowTarget`、`narrowBodyKey`），也不跑 `prepare`（切 tab 會順便打開抽屜）。
 *   - 手機（比 640 窄）的清單與筆記是兩個畫面。清單上的站（`phoneScreen: "list"`：分頁、新增筆記、資料夾、搜尋、頭像）
 *     先回到清單再指真的東西，其餘的站在示範筆記上；換畫面由引擎在進站前呼叫 `StopContext.showScreen`。
 *     新增筆記與搜尋在手機上是畫面底部的圓形鈕，版本歷史在 ⋮ 裡（`phoneTarget`、`phoneBodyKey`、`phoneTitleKey`）。
 *     手機上沒有的東西（浮出的格式工具列）整站立刻跳過，不等目標（`skipOnPhone`）。手機沒有抽屜，`prepare` 照跑。
 */

/** 手機上一站在哪個畫面：清單（首頁）或示範筆記。 */
export type TourScreen = "list" | "note";

export type StopId = "tabs" | "newNote" | "folders" | "search" | "header" | "versions" | "wikilink" | "ai" | "slash" | "userMenu";

export interface StopContext {
  /** 側欄搜尋框目前的字。 */
  searchQuery: string;
  /**
   * 開始時向 server 讀到的 AI 動作（`GET /api/ai/actions`；讀取失敗是空陣列）。不讀查詢快取：
   * 從首頁打開時快取還沒有資料，看快取會把站台有設定 AI 誤判成沒有。
   */
  aiActions: readonly AiActionDto[];
  /** 示範筆記的 id：現場演示只動這一篇的編輯器。 */
  sampleNoteId: string;
  /**
   * 開始時算一次：能不能在示範筆記上現場演示（編輯器可編輯、最後一段是空段落，見 `canRunLiveStop`）。
   * 不能的演示站改指筆記裡現成的成品，靜態說明。
   */
  liveStops: boolean;
  /**
   * 換到這一站要在的畫面，畫面出來（或等太久放棄）才 resolve；已經在那個畫面就馬上 resolve。由 `TourRunner` 提供，
   * 引擎在跑 `prepare` 之前呼叫。手機以外一律是示範筆記。沒有提供（單元測試）就不換畫面。
   */
  showScreen?: (screen: TourScreen, signal: AbortSignal) => Promise<void>;
}

export interface StopDef {
  id: StopId;
  titleKey: string;
  bodyKey: string;
  /** 側欄浮動（640～1279）時改用的說明；沒有就沿用 `bodyKey`。 */
  narrowBodyKey?: string;
  /** 手機改用的標題；沒有就沿用 `titleKey`。 */
  phoneTitleKey?: string;
  /** 手機改用的說明；沒有就沿用 `bodyKey`（不沿用 `narrowBodyKey`：那一句講的是抽屜）。 */
  phoneBodyKey?: string;
  /** 要挖亮的元素；多個時挖洞取它們的聯集。找不到回空陣列。 */
  target: (ctx: StopContext) => Element[];
  /** 側欄浮動時改指的元素；沒有就沿用 `target`。 */
  narrowTarget?: (ctx: StopContext) => Element[];
  /** 手機改指的元素；沒有就沿用 `target`（不沿用 `narrowTarget`：手機沒有側欄鈕）。 */
  phoneTarget?: (ctx: StopContext) => Element[];
  /** 手機上沒有這一站要指的東西：手機版面下整站立刻跳過（不等目標、不跑 `prepare`），也不算進「n / N」。 */
  skipOnPhone?: boolean;
  /** 手機上這一站在清單畫面；沒有就是在示範筆記上。 */
  phoneScreen?: "list";
  /** 找目標之前要做的事（側欄浮動時不跑，見 `prepareStop`）。 */
  prepare?: (ctx: StopContext) => void;
  /** 開始時算一次；不成立的站整站不跑、不算進總站數。 */
  precondition?: (ctx: StopContext) => boolean;
  /**
   * 離開這一站時要收拾的東西（例如演示開的選單）。引擎開始進這一站就會呼叫恰好一次：
   * 下一步、上一步、等不到目標而跳過、結束、卸載、位置離開示範筆記都算。側欄浮動時多半不跑 `prepare`，
   * 但 `leave` 照樣會被呼叫，所以它要能在 `prepare` 沒跑過時安全執行。拋錯只記到 console，不擋換站。
   */
  leave?: (ctx: StopContext) => void;
  /**
   * 這一站在這一輪是不是現場演示。是的話：卡片不搶焦點（焦點留在編輯器，選單才不會關）、導覽攔鍵盤與選單上的點擊，
   * `→`／`Enter` 下一步、`←` 上一步。沒有這個欄位＝一般靜態站。
   */
  live?: (ctx: StopContext) => boolean;
  /** 側欄浮動時也跑 `prepare`。預設不跑（理由見檔頭）；演示站在編輯器裡、不碰側欄，所以跑。 */
  prepareInNarrow?: boolean;
}

/** 全部都找到才算找到：只挖亮其中一部分會讓說明對不上。 */
function all(...els: (Element | null)[]): Element[] {
  return els.every((el) => el !== null) ? (els as Element[]) : [];
}

const drawerButton = () => all(findDrawerButton());
const noteMenu = () => findTourTarget("noteMenu");

/** 搜尋中側欄的 tab 列與標題列都不渲染（換成搜尋結果）；不替使用者清掉搜尋字，所以整站不跑。空白也算搜尋中。 */
const searchIsEmpty = (ctx: StopContext) => ctx.searchQuery === "";

/** 「新增筆記」只在我的筆記／最近 tab 出現，「新增資料夾」在我的筆記標題列；選取模式中兩者都會被換掉。 */
function showMyNotes(): void {
  const shell = getShellControls();
  // 只換 tab：手機上預設會把畫面帶回清單（可能是上一頁），那會被導覽當成離開；畫面由導覽自己換。
  shell?.showTab("myNotes", { reveal: false });
  shell?.endSelectionIfActive();
}

export const STOPS: Readonly<Record<StopId, StopDef>> = {
  tabs: {
    id: "tabs",
    titleKey: "tourGuide.stops.tabs.title",
    bodyKey: "tourGuide.stops.tabs.body",
    narrowBodyKey: "tourGuide.stops.tabs.narrowBody",
    phoneTitleKey: "tourGuide.stops.tabs.phoneTitle",
    phoneBodyKey: "tourGuide.stops.tabs.phoneBody",
    target: () => all(findTourTarget("tabs")),
    narrowTarget: drawerButton,
    phoneScreen: "list",
    precondition: searchIsEmpty,
  },
  newNote: {
    id: "newNote",
    titleKey: "tourGuide.stops.newNote.title",
    bodyKey: "tourGuide.stops.newNote.body",
    narrowBodyKey: "tourGuide.stops.newNote.narrowBody",
    phoneBodyKey: "tourGuide.stops.newNote.phoneBody",
    target: () => all(findTourTarget("newNote")),
    narrowTarget: drawerButton,
    // 清單右下的圓形鈕（垃圾桶 tab 沒有它；`prepare` 先切到我的筆記）。
    phoneTarget: () => all(findTourTarget("phoneNewNote")),
    phoneScreen: "list",
    prepare: showMyNotes,
  },
  folders: {
    id: "folders",
    titleKey: "tourGuide.stops.folders.title",
    bodyKey: "tourGuide.stops.folders.body",
    narrowBodyKey: "tourGuide.stops.folders.narrowBody",
    phoneBodyKey: "tourGuide.stops.folders.phoneBody",
    target: () => all(findTourTarget("newFolder")),
    narrowTarget: drawerButton,
    phoneScreen: "list",
    prepare: showMyNotes,
    precondition: searchIsEmpty,
  },
  search: {
    id: "search",
    titleKey: "tourGuide.stops.search.title",
    bodyKey: "tourGuide.stops.search.body",
    narrowBodyKey: "tourGuide.stops.search.narrowBody",
    phoneBodyKey: "tourGuide.stops.search.phoneBody",
    target: () => all(findTourTarget("search")),
    narrowTarget: drawerButton,
    // 清單左下的圓形鈕；選取模式中它不在，前兩站的 `prepare` 已經結束選取。
    phoneTarget: () => all(findTourTarget("phoneSearch")),
    phoneScreen: "list",
    precondition: searchIsEmpty,
  },
  header: {
    id: "header",
    titleKey: "tourGuide.stops.header.title",
    bodyKey: "tourGuide.stops.header.body",
    // 手機的 ⋮ 沒有「寬度」（手機上筆記一律滿寬），說明不提它。
    phoneBodyKey: "tourGuide.stops.header.phoneBody",
    target: () => {
      const base = all(findTourTarget("share"), noteMenu());
      if (base.length === 0) return base;
      // 分享與 ⋮ 之間的寬度鈕：頁首夠寬才顯示（容器查詢），收起時 display:none、量不到尺寸，就只挖亮分享與 ⋮（寬度改在 ⋮ 裡）。
      const width = findTourTarget("noteWidth");
      const rect = width?.getBoundingClientRect();
      return width && rect !== undefined && rect.width > 0 && rect.height > 0 ? [base[0]!, width, base[1]!] : base;
    },
  },
  versions: {
    id: "versions",
    titleKey: "tourGuide.stops.versions.title",
    bodyKey: "tourGuide.stops.versions.body",
    phoneBodyKey: "tourGuide.stops.versions.phoneBody",
    // 右下角的泡泡在 640 以上都在（側欄浮動時也一樣），所以沒有 `narrowTarget`；手機沒有泡泡，「版本歷史」是頁首 ⋮ 裡的一項。
    target: () => all(findTourTarget("versions")),
    phoneTarget: () => all(noteMenu()),
  },
  wikilink: {
    id: "wikilink",
    titleKey: "tourGuide.stops.wikilink.title",
    bodyKey: "tourGuide.stops.wikilink.body",
    target: (ctx) => liveTriggerTarget(ctx.sampleNoteId, "[[", "wikilinkMenu", "wikilink"),
    prepare: (ctx) => {
      if (ctx.liveStops) startLiveTrigger(ctx.sampleNoteId, "[[");
    },
    prepareInNarrow: true,
    leave: (ctx) => stopLiveTrigger(ctx.sampleNoteId),
    live: (ctx) => ctx.liveStops,
  },
  ai: {
    id: "ai",
    titleKey: "tourGuide.stops.ai.title",
    bodyKey: "tourGuide.stops.ai.body",
    target: () => liveSelectionTarget(),
    prepare: (ctx) => startLiveSelection(ctx.sampleNoteId),
    prepareInNarrow: true,
    leave: (ctx) => stopLiveSelection(ctx.sampleNoteId),
    // 站台沒有設定 AI 就整站略過（格式工具列上不會有 AI 鈕）。
    precondition: (ctx) => ctx.aiActions.length > 0,
    // 手機選取文字時不浮出格式工具列；AI 鈕在編輯時鍵盤上方那條工具列裡，要演示就得先叫出鍵盤蓋住半個畫面，所以手機不停這一站。
    skipOnPhone: true,
    // 只選取、不需要空段落，所以不看 `liveStops`；拿不到示範筆記的編輯器就不是演示。
    live: (ctx) => getTourNoteEditor(ctx.sampleNoteId) !== null,
  },
  slash: {
    id: "slash",
    titleKey: "tourGuide.stops.slash.title",
    bodyKey: "tourGuide.stops.slash.body",
    phoneBodyKey: "tourGuide.stops.slash.phoneBody",
    target: (ctx) => {
      const base = liveTriggerTarget(ctx.sampleNoteId, "/", "slashMenu", "flowchart");
      if (base.length === 0) return base;
      // 選單旁邊一起挖亮筆記裡用 `/` 插的流程圖；筆記裡沒有流程圖就只挖亮選單。
      const chart = findInSampleEditor(ctx.sampleNoteId, "flowchart");
      return chart === null || base.includes(chart) ? base : [...base, chart];
    },
    prepare: (ctx) => {
      if (ctx.liveStops) startLiveTrigger(ctx.sampleNoteId, "/");
    },
    prepareInNarrow: true,
    leave: (ctx) => stopLiveTrigger(ctx.sampleNoteId),
    live: (ctx) => ctx.liveStops,
  },
  userMenu: {
    id: "userMenu",
    titleKey: "tourGuide.stops.userMenu.title",
    bodyKey: "tourGuide.stops.userMenu.body",
    narrowBodyKey: "tourGuide.stops.userMenu.narrowBody",
    phoneBodyKey: "tourGuide.stops.userMenu.phoneBody",
    // 手機上是清單頂列的頭像，同一個屬性。
    target: () => all(findUserMenuTrigger()),
    narrowTarget: drawerButton,
    phoneScreen: "list",
  },
};

/** 完整導覽的站序；最後一站固定是 userMenu。 */
export const FULL_TOUR: readonly [StopId, ...StopId[]] = ["tabs", "newNote", "folders", "search", "header", "versions", "wikilink", "ai", "slash", "userMenu"];

/** 這一站在 `layout` 這種版面上有沒有東西可指；沒有的話引擎立刻跳過、卡片上的「n / N」也不數它。 */
export function stopShownIn(stop: StopDef, layout: TourLayout = tourLayout()): boolean {
  return !(layout === "phone" && stop.skipOnPhone === true);
}

/** 這一站要在哪個畫面：只有手機分清單與示範筆記，其他版面一律在示範筆記上。 */
export function stopScreen(stop: StopDef, layout: TourLayout = tourLayout()): TourScreen {
  return layout === "phone" && stop.phoneScreen === "list" ? "list" : "note";
}

/** 依目前的版面找目標；這個版面上沒有這一站就回空陣列。 */
export function stopTarget(stop: StopDef, ctx: StopContext, layout: TourLayout = tourLayout()): Element[] {
  if (!stopShownIn(stop, layout)) return [];
  if (layout === "phone") return (stop.phoneTarget ?? stop.target)(ctx);
  if (layout === "floating") return (stop.narrowTarget ?? stop.target)(ctx);
  return stop.target(ctx);
}

/** `layout` 預設當下讀一次；元件訂閱版面變化時把訂閱到的值傳進來。不 export：呼叫端一律走 `stopBody`，才不會漏帶 `{{mod}}`。 */
function stopBodyKey(stop: StopDef, layout: TourLayout): string {
  if (layout === "phone") return stop.phoneBodyKey ?? stop.bodyKey;
  if (layout === "floating") return stop.narrowBodyKey ?? stop.bodyKey;
  return stop.bodyKey;
}

/** 說明文字：快捷鍵的修飾鍵由 `{{mod}}` 帶入（Mac 是 `⌘`，其他是 `Ctrl+`）。 */
export function stopBody(t: TFunction, stop: StopDef, layout: TourLayout = tourLayout()): string {
  return t(stopBodyKey(stop, layout), { mod: isMacPlatform() ? "⌘" : "Ctrl+" });
}

/** 跑站點的前置動作；側欄浮動時不跑，除非站點自己說要跑（見檔頭）。這個版面上沒有的站一律不跑。 */
export function prepareStop(stop: StopDef, ctx: StopContext): void {
  const layout = tourLayout();
  if (!stopShownIn(stop, layout)) return;
  if (layout === "floating" && stop.prepareInNarrow !== true) return;
  stop.prepare?.(ctx);
}

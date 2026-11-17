import type { QueryClient } from "@tanstack/react-query";
import type { AiActionDto } from "@knotebook/shared";
import { fetchAiActions } from "@/api/ai";
import { listStickyTopInset, stickyTopInset } from "@/lib/page-scroll";
import { tourLayout, type TourLayout } from "@/lib/tour-find";
import { readKeyboardInset } from "@/lib/visual-viewport";
import { NO_INSETS, unionRect, type Insets, type Rect } from "./geometry";
import { buildSequence } from "./sequence";
import { FULL_TOUR, prepareStop, STOPS, stopScreen, stopShownIn, stopTarget, type StopContext, type StopDef } from "./stops";

/**
 * 功能導覽的引擎：站序、換站、等目標、結束後找回焦點。不碰 React，畫面與導頁由 `TourRunner` 處理。
 */

/** 進站後等目標出現（而且有尺寸）的上限；等不到就跳過這一站。 */
export const TARGET_TIMEOUT_MS = 3000;
/**
 * 手機換畫面（清單與示範筆記之間）之後等它出來的上限。清單等不到照樣進站（目標由引擎去等）；示範筆記等不到
 * （例如它在別處被移到垃圾桶，頁面換成「在垃圾桶裡」的卡片）就當成離開示範筆記，結束導覽。
 */
export const SCREEN_TIMEOUT_MS = 5000;
/** 結束後找使用者選單觸發鈕的上限；導回原頁後新的側欄要一兩格畫面才掛上。 */
export const RETURN_FOCUS_TIMEOUT_MS = 1000;

// 型別住在首包的 context 那支（打開導覽的元件只 import 它）；這裡轉出給導覽內部用。
export type { TourStartOptions } from "@/lib/tour-context";

export interface TourStopEntry {
  stop: StopDef;
}

/** 完整導覽要走的站。 */
export function fullTourStops(): TourStopEntry[] {
  return buildSequence(FULL_TOUR).map((e) => ({ stop: STOPS[e.id] }));
}

/** 開始時算一次前置條件：不成立的站整站拿掉，總站數只算留下的，中途不會跳號。 */
export function planStops(entries: readonly TourStopEntry[], ctx: StopContext): TourStopEntry[] {
  return entries.filter((e) => e.stop.precondition?.(ctx) ?? true);
}

/**
 * 向 server 讀一次 AI 動作（與 AI 工具列共用 `["ai-actions"]` 這個查詢）。`staleTime: 0` 讓快取裡已經有的資料也重抓：
 * 從首頁打開時快取可能還沒有資料或是舊的。讀取失敗當成沒有 AI；不重試，失敗時不讓使用者多等。
 */
export function fetchTourAiActions(queryClient: QueryClient): Promise<AiActionDto[]> {
  return queryClient
    .fetchQuery({ queryKey: ["ai-actions"], queryFn: fetchAiActions, staleTime: 0, retry: false })
    .catch(() => []);
}

/** 全部元素都有寬高才回它們的聯集；只挖亮其中一部分會讓說明對不上。 */
export function measureTargets(els: readonly Element[]): Rect | null {
  if (els.length === 0) return null;
  const rects = els.map((el) => el.getBoundingClientRect());
  if (rects.some((r) => r.width <= 0 || r.height <= 0)) return null;
  return unionRect(rects.map((r) => ({ left: r.left, top: r.top, width: r.width, height: r.height })));
}

/**
 * 卡片上的「n / N」：只數在 `layout` 這種版面上會出現的站（手機上沒有的站立刻跳過，不佔號，中途不跳號）。
 * 畫面上那一站一定算進去：導覽中換到沒有它的版面時，卡片還停在那一站。
 */
export function tourProgress(stops: readonly TourStopEntry[], index: number, layout: TourLayout): { step: number; total: number } {
  const counted = stops.map((e, i) => i === index || stopShownIn(e.stop, layout));
  return {
    step: counted.slice(0, index + 1).filter(Boolean).length,
    total: counted.filter(Boolean).length,
  };
}

export interface CardBands {
  /** 卡片最好讓開的邊帶：釘住的頂列或頁首、底部的圓形鈕。畫面太小時可以疊上去（見 `cardInsets`）。 */
  keepOut: Insets;
  /** 畫面被蓋住、卡片放進去就看不到的部分：螢幕鍵盤、鍵盤上方的編輯工具列。一律讓開。 */
  blocked: Insets;
}

const NO_BANDS: CardBands = { keepOut: NO_INSETS, blocked: NO_INSETS };

/** 看得到、不在 inert 範圍內的 `selector` 元素裡，最高的上緣；沒有就回 `fallback`。 */
function highestTop(selector: string, fallback: number): number {
  let top = fallback;
  for (const el of document.querySelectorAll(selector)) {
    if (el.closest("[inert]") !== null) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) top = Math.min(top, r.top);
  }
  return top;
}

/**
 * 鍵盤升起時 iOS 會把版面往上推（視覺視窗的 `offsetTop` 變大）：版面最上面那一段被推出畫面外，卡片放在那裡看不到。
 * 雙指放大時 `offsetTop` 也會變，但那不是鍵盤，不算。
 */
function keyboardPanTop(): number {
  const viewport = window.visualViewport;
  if (!viewport || Math.abs(viewport.scale - 1) > 0.01) return 0;
  return Math.max(0, viewport.offsetTop);
}

/**
 * 卡片要避開的畫面邊帶（px，從視窗各邊量起；瀏海等 safe area 由卡片自己另外讀）。其他版面沒有這類東西，回全 0。手機上：
 * - `keepOut` 上：清單畫面是釘住的頂列與清單標題列，筆記畫面是釘住的筆記頁首。下：看得到的圓形鈕（搜尋、新增筆記）。
 * - `blocked` 下：螢幕鍵盤與鍵盤上方的編輯工具列，取高的那個。鍵盤升起時 `window.innerHeight` 不會變小，
 *   只有視覺視窗變矮（`readKeyboardInset`），不扣掉的話卡片會落在鍵盤後面。`blocked` 上：鍵盤把版面往上推出畫面的那一段。
 */
export function measureCardBands(layout: TourLayout): CardBands {
  if (layout !== "phone") return NO_BANDS;
  const height = window.innerHeight;
  const blockedEdge = highestTop("[data-mobile-edit-toolbar]", height - readKeyboardInset());
  const fabEdge = highestTop("[data-phone-fab]", height);
  let top: number;
  if (document.querySelector("[data-phone-list-shown]") !== null) {
    const bar = document.querySelector("[data-phone-top-bar]")?.getBoundingClientRect();
    top = Math.max(listStickyTopInset(), bar !== undefined && bar.height > 0 ? bar.bottom : 0);
  } else {
    top = stickyTopInset();
  }
  return {
    keepOut: { top, right: 0, bottom: Math.max(0, height - fabEdge), left: 0 },
    blocked: { top: keyboardPanTop(), right: 0, bottom: Math.max(0, height - blockedEdge), left: 0 },
  };
}

/**
 * 每格畫面呼叫 `check`，回非 null 就 resolve 那個值；超過 `timeoutMs` 或中止就 resolve null。
 * 第一次在呼叫當下就查。`check` 拋錯當成還沒好。
 */
export function waitForFrames<T>(check: () => T | null, signal: AbortSignal, timeoutMs = Infinity): Promise<T | null> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(null);
      return;
    }
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: T | null) => {
      cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(null);
    const tick = () => {
      let value: T | null = null;
      try {
        value = check();
      } catch {
        value = null;
      }
      if (value !== null) finish(value);
      else frame = requestAnimationFrame(tick);
    };
    signal.addEventListener("abort", onAbort);
    if (Number.isFinite(timeoutMs)) timer = setTimeout(() => finish(null), timeoutMs);
    tick();
  });
}

/**
 * 等側欄抽屜從 DOM 消失。抽屜是會鎖焦點、把外面標成 `aria-hidden` 的 modal：開著時導覽卡片按不到，
 * 要指的目標也全都查不到。沒有上限：開始流程整體的逾時由呼叫端處理。
 */
export async function waitForDrawerClosed(signal: AbortSignal): Promise<void> {
  await waitForFrames(() => (document.querySelector("[data-sidebar-drawer]") === null ? true : null), signal);
}

/** 路徑比對：瀏覽器的 pathname 對非 ASCII 的 slug 是百分比編碼形，`canonicalNotePath` 回的是未編碼的字。 */
export function samePath(pathname: string, path: string): boolean {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // 畸形的 % 序列：照原字串比。
  }
  return decoded === path;
}

function interactive(el: Element | null): el is HTMLElement {
  return el instanceof HTMLElement && el.isConnected && el.closest('[aria-hidden="true"], [inert]') === null;
}

/**
 * 結束後的焦點：每格畫面呼叫一次 `returnFocus()`，查到還掛在 DOM 上的元素就聚焦它（最多 `RETURN_FOCUS_TIMEOUT_MS`）；
 * 查不到退到筆記標題框，再退到主內容區（`<main>` 本來不能聚焦，補 `tabindex="-1"`）。回傳聚焦的元素。
 * 手機不退到標題框（聚焦文字框會叫出鍵盤），改退到筆記頁首回清單的「‹」。
 */
export async function focusReturnTarget(returnFocus: () => Element | null, signal: AbortSignal): Promise<HTMLElement | null> {
  const found = await waitForFrames(() => {
    const el = returnFocus();
    return interactive(el) ? el : null;
  }, signal, RETURN_FOCUS_TIMEOUT_MS);
  if (signal.aborted) return null;
  const fallback = tourLayout() === "phone" ? '[data-kb-tour-target="backToList"]' : "input[data-note-title-input]";
  const target =
    found ??
    Array.from(document.querySelectorAll(fallback)).find(interactive) ??
    Array.from(document.querySelectorAll("main")).find(interactive) ??
    null;
  if (target === null) return null;
  if (target.tagName === "MAIN" && !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus();
  return target;
}

function runLeave(entry: TourStopEntry, ctx: StopContext): void {
  try {
    entry.stop.leave?.(ctx);
  } catch (err) {
    console.error(err);
  }
}

function runPrepare(entry: TourStopEntry, ctx: StopContext): void {
  try {
    prepareStop(entry.stop, ctx);
  } catch (err) {
    console.error(err);
  }
}

/**
 * 等這一站的目標出現而且有尺寸，最多 `TARGET_TIMEOUT_MS`。目標每格畫面重查（prepare 切 tab 之後要下一格才畫出來）。
 * 目前的版面上沒有這一站（例如手機上的 AI 站）就不等，立刻回 false。
 */
export async function waitForStopTarget(entry: TourStopEntry, ctx: StopContext, signal: AbortSignal): Promise<boolean> {
  if (!stopShownIn(entry.stop)) return false;
  return (await waitForFrames(() => measureTargets(stopTarget(entry.stop, ctx)), signal, TARGET_TIMEOUT_MS)) !== null;
}

export type EndReason =
  /** 最後一站〔保留示範筆記〕。 */
  | "keep"
  /** 最後一站〔刪除〕。 */
  | "delete"
  /** ✕、Esc、第 1 站的「跳過」。 */
  | "close"
  /** 位置離開了示範筆記（上一頁、重新整理、被導到登入頁、筆記在別處被刪）。 */
  | "left"
  /** 導覽元件卸載。 */
  | "unmount";

export interface EngineSnapshot {
  phase: "idle" | "running" | "ended";
  /** 畫面上那一站在站序裡的位置；還沒進第一站是 -1。 */
  index: number;
  total: number;
  /** 畫面上那一站；換站等目標的期間仍是上一站。 */
  entry: TourStopEntry | null;
  /** 正在換站（等下一站的目標）：這段期間的下一步、上一步不動作。 */
  pending: boolean;
  /** 換站中、已經跑過 `prepare` 正在等目標的那一站；沒有在換站是 null。 */
  preparing: TourStopEntry | null;
  endReason: EndReason | null;
}

export type WaitForTarget = (entry: TourStopEntry, ctx: StopContext, signal: AbortSignal) => Promise<boolean>;

/**
 * 導覽的狀態機。站序在建立時就定好（`planStops` 濾過）；`ctx` 也是開始時那一份。
 *
 * - 進站：先換到這一站的畫面（`StopContext.showScreen`，手機的清單／示範筆記），再 `prepare`，再等目標（`waitForTarget`），
 *   等到才算進站；等不到就往同一個方向跳下一站。
 *   往回走一路都等不到，就從原本那站往後找。最後一站不跳：它帶著〔保留示範筆記〕〔刪除〕，等不到目標也照樣進站（卡片置中）。
 * - 離站：先呼叫畫面上那站的 `leave`，再 `prepare` 下一站——演示站開的選單要先收掉，下一站才開得了自己的。
 *   開始進一站（呼叫 `prepareStop`）就一定會再呼叫一次 `leave`，跳過的、等目標等到一半就結束的也一樣。
 *   寬視窗以外 `prepareStop` 多半不跑站點的 `prepare`，`leave` 仍會被呼叫，所以站點的 `leave` 要能在 `prepare` 沒跑過時安全執行。
 */
export class TourEngine {
  private snapshot: EngineSnapshot;
  private readonly listeners = new Set<() => void>();
  /** 每次換站或結束都加一：換站等目標時被結束打斷，等到的結果就不算數。 */
  private generation = 0;
  private waiting: AbortController | null = null;
  /** 畫面上、還沒呼叫過 `leave` 的那一站。 */
  private shown: TourStopEntry | null = null;

  constructor(
    private readonly stops: readonly TourStopEntry[],
    private readonly ctx: StopContext,
    private readonly waitForTarget: WaitForTarget = waitForStopTarget,
  ) {
    this.snapshot = { phase: "idle", index: -1, total: stops.length, entry: null, pending: false, preparing: null, endReason: null };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): EngineSnapshot => this.snapshot;

  private set(patch: Partial<EngineSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  /** 進第一站。 */
  begin(): Promise<void> {
    if (this.snapshot.phase !== "idle") return Promise.resolve();
    if (this.stops.length === 0) {
      this.end("close");
      return Promise.resolve();
    }
    this.set({ phase: "running" });
    return this.seek(0, 1, 0);
  }

  next(): void {
    const { phase, pending, index, total } = this.snapshot;
    if (phase !== "running" || pending || index < 0 || index >= total - 1) return;
    void this.seek(index + 1, 1, index);
  }

  back(): void {
    const { phase, pending, index } = this.snapshot;
    if (phase !== "running" || pending || index <= 0) return;
    void this.seek(index - 1, -1, index);
  }

  end(reason: EndReason): void {
    if (this.snapshot.phase === "ended") return;
    this.generation += 1;
    this.waiting?.abort();
    this.waiting = null;
    this.leaveShown();
    this.set({ phase: "ended", pending: false, preparing: null, endReason: reason });
  }

  private leaveShown(): void {
    const shown = this.shown;
    this.shown = null;
    if (shown !== null) runLeave(shown, this.ctx);
  }

  /**
   * 換到這一站的畫面；這個版面上沒有的站不換（它會立刻被跳過）。換畫面失敗只記 console，照樣往下等目標。
   * 不用換（沒有 `showScreen`）時回 null，進站的其餘步驟同步接著跑。
   */
  private enterScreen(entry: TourStopEntry, signal: AbortSignal): Promise<void> | null {
    const show = this.ctx.showScreen;
    if (show === undefined || !stopShownIn(entry.stop)) return null;
    return show(stopScreen(entry.stop), signal).catch((err: unknown) => console.error(err));
  }

  private async seek(start: number, direction: 1 | -1, from: number): Promise<void> {
    const generation = ++this.generation;
    const waiting = new AbortController();
    this.waiting = waiting;
    this.leaveShown();
    this.set({ pending: true });
    let i = start;
    let dir = direction;
    for (;;) {
      if (i < 0) {
        i = from;
        dir = 1;
      }
      const entry = this.stops[i]!;
      this.set({ preparing: entry });
      const entering = this.enterScreen(entry, waiting.signal);
      if (entering !== null) {
        await entering;
        if (generation !== this.generation) {
          runLeave(entry, this.ctx);
          return;
        }
      }
      runPrepare(entry, this.ctx);
      const found = await this.waitForTarget(entry, this.ctx, waiting.signal);
      if (generation !== this.generation) {
        runLeave(entry, this.ctx);
        return;
      }
      if (found || i === this.stops.length - 1) {
        this.waiting = null;
        this.shown = entry;
        this.set({ index: i, entry, pending: false, preparing: null });
        return;
      }
      runLeave(entry, this.ctx);
      i += dir;
    }
  }
}

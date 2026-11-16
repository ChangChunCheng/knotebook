import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { isPhone, useIsPhone } from "@/lib/layout-tiers";

/**
 * 手機（< 640）上的捲動：`AppShell` 的外框不鎖高度，清單與筆記都是**文件**本身在捲（瀏覽器的工具列才會隨捲動收起，
 * 內容也才能延伸到半透明的底部工具列後面）。640 起照舊：外框鎖在視窗高、各區自己的 `overflow-y-auto` 容器在捲。
 *
 * 外框帶 `PHONE_PAGE_SCROLL_ATTR`。原本對「捲動容器」下指令的程式（捲回頂端、算可視高度、捲到協作者的游標）先問
 * `scrollsPage(root)`：成立時改對視窗做，因為那個容器在手機上不會捲。公開頁不在外框裡，手機上仍是自己的容器在捲。
 */
export const PHONE_PAGE_SCROLL_ATTR = "data-phone-page-scroll";

/**
 * `<html>` 上的 CSS 變數：手機上釘在頁面頂端的筆記頁首有多高（px，含瀏海的 safe area）。`index.css` 拿它當筆記區塊的
 * `scroll-margin-top`，捲到段落時才不會把區塊捲到頁首底下。
 */
export const STICKY_TOP_VAR = "--kb-sticky-top";

/**
 * `<html>` 上的 CSS 變數：手機清單畫面釘在頂端的部分（頂列＋標題列，含瀏海的 safe area）下緣離視窗頂多遠（px）。
 * `index.css` 拿它當清單列的 `scroll-margin-top`，鍵盤或螢幕閱讀器把焦點移到某一列時，那一列不會停在頂列底下。
 */
export const LIST_STICKY_TOP_VAR = "--kb-list-sticky-top";

/** `root` 在手機上是不是讓文件代為捲動（在帶 `PHONE_PAGE_SCROLL_ATTR` 的外框裡、而且是手機寬度）。 */
export function scrollsPage(root: Element | null | undefined): boolean {
  return root !== null && root !== undefined && isPhone() && root.closest(`[${PHONE_PAGE_SCROLL_ATTR}]`) !== null;
}

/** `<html>` 上某個 px 變數的值；沒有設定時 0。 */
function readTopVar(name: string): number {
  if (typeof document === "undefined") return 0;
  const value = parseFloat(document.documentElement.style.getPropertyValue(name));
  return Number.isFinite(value) ? value : 0;
}

/** 頁面頂端釘住的筆記頁首高度（px）；沒有設定時 0。 */
export function stickyTopInset(): number {
  return readTopVar(STICKY_TOP_VAR);
}

/** 手機清單釘在頂端的部分的下緣（px）；沒有設定時 0。 */
export function listStickyTopInset(): number {
  return readTopVar(LIST_STICKY_TOP_VAR);
}

const stickyListeners = new Set<() => void>();

function subscribeSticky(listener: () => void): () => void {
  stickyListeners.add(listener);
  return () => stickyListeners.delete(listener);
}

/** 讀筆記頁首高度並在它變動時重繪（頁首換行、橫幅出現時，依它算的捲動邊界要跟著換）。 */
export function useStickyTopInset(): number {
  return useSyncExternalStore(subscribeSticky, stickyTopInset, () => 0);
}

/** 捲回頂端：手機上捲文件，其他情形捲 `root` 自己。 */
export function scrollToTopOf(root: HTMLElement): void {
  if (scrollsPage(root)) {
    window.scrollTo({ top: 0 });
    return;
  }
  if (typeof root.scrollTo === "function") root.scrollTo({ top: 0 });
  else root.scrollTop = 0;
}

/** `root` 的內容實際能被看到的高度：手機上是視窗扣掉頂端的頁首，其他情形是 `root` 自己的可視高度。 */
export function visibleHeightOf(root: HTMLElement): number {
  return scrollsPage(root) ? Math.max(0, window.innerHeight - stickyTopInset()) : root.clientHeight;
}

/** `el` 在不在文件代為捲動的外框裡（手機上的清單與筆記；抽屜、公開頁不在）。 */
function inPageScrollFrame(el: Element): boolean {
  return el.closest(`[${PHONE_PAGE_SCROLL_ATTR}]`) !== null;
}

/**
 * 量 `ref` 那個釘在頂端的元素，把它釘住時的下緣（`top` 加上外框高，含上方 safe area 的內距）寫進 `<html>` 的 `name` 變數，
 * 直接寫 DOM；`useStickyTopInset` 的使用者會重繪。`enabled` 為 false 或卸載時移除——只移除自己寫的值，
 * 同名變數已被別的實例改寫時不動它。元素不在文件代為捲動的外框裡（例如抽屜裡的清單）時不寫。
 * 元素被藏起來（`display: none`）時量到 0。
 */
export function useStickyTopVar(ref: RefObject<HTMLElement | null>, enabled: boolean, name: string = STICKY_TOP_VAR): void {
  useEffect(() => {
    const element = ref.current;
    if (!enabled || element === null || !inPageScrollFrame(element)) return;
    const root = document.documentElement;
    const notify = () => stickyListeners.forEach((listener) => listener());
    let written: string | null = null;
    const write = () => {
      const rect = element.getBoundingClientRect();
      const top = parseFloat(getComputedStyle(element).top);
      const value = `${Math.round((rect.height > 0 && Number.isFinite(top) ? top : 0) + rect.height)}px`;
      written = value;
      if (root.style.getPropertyValue(name) === value) return;
      root.style.setProperty(name, value);
      notify();
    };
    write();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(write) : null;
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      if (written === null || root.style.getPropertyValue(name) !== written) return;
      root.style.removeProperty(name);
      notify();
    };
  }, [ref, enabled, name]);
}

// ── 跨 640 時保住閱讀位置 ────────────────────────────────────────────────────────

/** 閱讀位置：畫面頂端（頁首之下）第一個看得到的項目、它離那條線多遠（負數＝上緣已捲過那條線），以及當時它的高度。 */
export interface ScrollAnchor {
  id: string;
  offset: number;
  height: number;
}

export interface AnchorItems {
  /** 項目（筆記的區塊、清單的列）。 */
  itemSelector: string;
  /** 項目上的識別屬性。 */
  idAttr: string;
  /** 量哪一個元素的位置（預設項目本身；區塊量它自己那一行，不含巢狀子區塊）。 */
  measure?: (item: HTMLElement) => Element;
}

function visibleBox(el: Element): DOMRect | null {
  const rect = el.getBoundingClientRect();
  return rect.width === 0 && rect.height === 0 ? null : rect;
}

/** `container` 裡下緣在 `top` 之下的第一個項目（文件順序）；沒有就 null。 */
export function captureScrollAnchor(container: Element, items: AnchorItems, top: number): ScrollAnchor | null {
  for (const item of container.querySelectorAll<HTMLElement>(items.itemSelector)) {
    const rect = visibleBox(items.measure?.(item) ?? item);
    if (rect === null || rect.bottom <= top) continue;
    const id = item.getAttribute(items.idAttr);
    if (id !== null && id !== "") return { id, offset: rect.top - top, height: rect.height };
  }
  return null;
}

/**
 * 把 `anchor` 那一項捲回離 `top` 同樣的距離（`scrollBy` 收正數＝往下捲）；找不到那一項回 false。
 * 那一項的上緣已捲過那條線時，換段後排版的寬度不同、它的高度也不同：捲過的部分照高度比例換算，停在同一段文字附近。
 */
export function restoreScrollAnchor(container: Element, items: AnchorItems, anchor: ScrollAnchor, top: number, scrollBy: (dy: number) => void): boolean {
  const item = Array.from(container.querySelectorAll<HTMLElement>(items.itemSelector)).find((el) => el.getAttribute(items.idAttr) === anchor.id);
  if (item === undefined) return false;
  const rect = visibleBox(items.measure?.(item) ?? item);
  if (rect === null) return false;
  const offset = anchor.offset < 0 && anchor.height > 0 ? (anchor.offset * rect.height) / anchor.height : anchor.offset;
  const dy = rect.top - top - offset;
  if (Math.abs(dy) >= 1) scrollBy(dy);
  return true;
}

/** 捲動停下多久之後才記位置（ms）：捲動中不逐 frame 量版面。 */
export const ANCHOR_IDLE_MS = 150;

export interface TierScrollAnchorOptions extends AnchorItems {
  /** 項目所在的容器；640 起它就是自己捲動的那一層。 */
  containerRef: RefObject<HTMLElement | null>;
  /** 手機上（文件在捲）可視範圍的上緣：釘在頂端的頁首下緣。 */
  phoneTop: () => number;
}

/**
 * 跨 640（例如 iPhone 轉橫拿，橫拿的寬度超過 640）時保住閱讀位置：手機上捲的是文件、640 起捲的是容器，切換時兩邊都從 0 開始，
 * 而且兩種寬度的排版不同，所以記的不是捲動量，而是「頂端第一個看得到的項目＋離頂端多遠」，換段之後把同一項捲回同一處。
 *
 * - 只看這一份自己的捲動：手機上是文件的 scroll，640 起是容器的 scroll；其他元素（表格、選單）的捲動不理。
 * - 捲動停下 `ANCHOR_IDLE_MS` 之後（或瀏覽器的 `scrollend`）才量一次位置，捲動中只記捲動量（不讀版面）。
 *   換段時若還有一次沒量，換段後的版面已經不是原來的，不能補量；改用上次量的位置，扣掉之後又捲了多少（同一種排版下捲動量就是位移）。
 * - 媒體查詢已經翻過去、React 還沒換段的那段時間（文件此刻被夾回 0）不記：`isPhone()` 與目前排版所屬的段不一致就跳過。
 * - 容器看不到（例如 640–1279 的清單在收起的抽屜裡）時不記也不還，位置留到下次看得到時再還。
 * - 容器不在文件代為捲動的外框裡（例如抽屜裡那份清單）時整個不作用。
 */
export function useTierScrollAnchor(options: TierScrollAnchorOptions): void {
  const phone = useIsPhone();
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const tierRef = useRef(phone);
  /** 上次量到的位置，與量的當下的捲動量。 */
  const savedRef = useRef<{ container: HTMLElement; anchor: ScrollAnchor; scroll: number } | null>(null);
  /** 量過之後又捲到哪（還沒量的那一段）；null＝沒有待量的捲動。 */
  const pendingRef = useRef<number | null>(null);

  const scrollOf = (container: HTMLElement, onPhone: boolean) => (onPhone ? window.scrollY : container.scrollTop);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const usable = () => {
      const container = optionsRef.current.containerRef.current;
      if (container === null || !inPageScrollFrame(container) || isPhone() !== tierRef.current || container.getClientRects().length === 0) return null;
      return container;
    };
    const capture = () => {
      clearTimeout(timer);
      timer = undefined;
      pendingRef.current = null;
      const container = usable();
      if (container === null) return;
      const { containerRef: _containerRef, phoneTop, ...items } = optionsRef.current;
      const top = tierRef.current ? phoneTop() : container.getBoundingClientRect().top;
      const anchor = captureScrollAnchor(container, items, top);
      savedRef.current = anchor === null ? null : { container, anchor, scroll: scrollOf(container, tierRef.current) };
    };
    const ours = (event: Event) => {
      const container = optionsRef.current.containerRef.current;
      return tierRef.current ? event.target === document : container !== null && event.target === container;
    };
    const onScroll = (event: Event) => {
      if (!ours(event)) return;
      // 捲動中不讀版面（看不看得到等停下來量的時候再看）。
      const container = optionsRef.current.containerRef.current;
      if (container === null || !inPageScrollFrame(container) || isPhone() !== tierRef.current) return;
      pendingRef.current = scrollOf(container, tierRef.current);
      clearTimeout(timer);
      timer = setTimeout(capture, ANCHOR_IDLE_MS);
    };
    const onScrollEnd = (event: Event) => {
      if (ours(event) && pendingRef.current !== null) capture();
    };
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("scrollend", onScrollEnd, { capture: true, passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("scrollend", onScrollEnd, { capture: true });
      clearTimeout(timer);
    };
  }, []);

  useLayoutEffect(() => {
    if (tierRef.current === phone) return;
    tierRef.current = phone;
    const saved = savedRef.current;
    const pending = pendingRef.current;
    pendingRef.current = null;
    const { containerRef, phoneTop, ...items } = optionsRef.current;
    const container = containerRef.current;
    if (saved === null || container === null || saved.container !== container || !inPageScrollFrame(container) || container.getClientRects().length === 0) return;
    // 換段前還沒量的那段捲動：同一種排版下，捲了多少項目就往上移多少。
    const anchor = pending === null ? saved.anchor : { ...saved.anchor, offset: saved.anchor.offset - (pending - saved.scroll) };
    savedRef.current = { ...saved, anchor };
    const restore = () => {
      if (phone) restoreScrollAnchor(container, items, anchor, phoneTop(), (dy) => window.scrollTo(0, window.scrollY + dy));
      else restoreScrollAnchor(container, items, anchor, container.getBoundingClientRect().top, (dy) => (container.scrollTop += dy));
    };
    restore();
    // 換段那次 render 之後還有元件在 effect 裡改版面（換段時才掛上的東西），下一個 frame 用同一個位置再對一次；
    // 這期間捲動記下的位置可能量自過渡中的版面，所以用的是換段前記的那一份。
    let frame = requestAnimationFrame(() => {
      frame = 0;
      if (isPhone() === phone && container.isConnected) restore();
    });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [phone]);
}

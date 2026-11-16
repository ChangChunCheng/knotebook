import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { PHONE_QUERY } from "@/lib/layout-tiers";
import { stubLayoutTier } from "@/test/layout-tier";
import {
  PHONE_PAGE_SCROLL_ATTR,
  STICKY_TOP_VAR,
  captureScrollAnchor,
  restoreScrollAnchor,
  scrollToTopOf,
  scrollsPage,
  stickyTopInset,
  useStickyTopInset,
  useStickyTopVar,
  useTierScrollAnchor,
  visibleHeightOf,
} from "./page-scroll";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  document.documentElement.style.removeProperty(STICKY_TOP_VAR);
});

/** 外框（帶屬性）裡的一個容器；`framed: false` 時容器不在外框裡（例如公開頁）。 */
function makeRoot(framed = true): HTMLDivElement {
  const root = document.createElement("div");
  Object.defineProperty(root, "clientHeight", { value: 5000, configurable: true });
  root.scrollTo = vi.fn() as never;
  if (framed) {
    const frame = document.createElement("div");
    frame.setAttribute(PHONE_PAGE_SCROLL_ATTR, "");
    frame.appendChild(root);
    document.body.appendChild(frame);
  } else {
    document.body.appendChild(root);
  }
  return root;
}

describe("page-scroll：手機上文件代替內層容器捲動", () => {
  it("scrollsPage：手機寬度且在外框裡才成立；不在外框裡（公開頁）或 640 起都不成立", () => {
    stubLayoutTier("phone");
    expect(scrollsPage(makeRoot())).toBe(true);
    expect(scrollsPage(makeRoot(false))).toBe(false);
    expect(scrollsPage(null)).toBe(false);
    stubLayoutTier("overlay");
    expect(scrollsPage(makeRoot())).toBe(false);
    stubLayoutTier("docked");
    expect(scrollsPage(makeRoot())).toBe(false);
  });

  it("scrollToTopOf：手機捲文件、容器不動；其他情形捲容器", () => {
    const windowScroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    stubLayoutTier("phone");
    const phoneRoot = makeRoot();
    scrollToTopOf(phoneRoot);
    expect(windowScroll).toHaveBeenCalledWith({ top: 0 });
    expect(phoneRoot.scrollTo).not.toHaveBeenCalled();

    windowScroll.mockClear();
    const publicRoot = makeRoot(false);
    scrollToTopOf(publicRoot);
    expect(publicRoot.scrollTo).toHaveBeenCalledWith({ top: 0 });
    expect(windowScroll).not.toHaveBeenCalled();

    stubLayoutTier("overlay");
    const wideRoot = makeRoot();
    scrollToTopOf(wideRoot);
    expect(wideRoot.scrollTo).toHaveBeenCalledWith({ top: 0 });
    expect(windowScroll).not.toHaveBeenCalled();
  });

  it("visibleHeightOf：手機是視窗高扣掉頁首，其他是容器自己的可視高度", () => {
    stubLayoutTier("phone");
    vi.stubGlobal("innerHeight", 844);
    document.documentElement.style.setProperty(STICKY_TOP_VAR, "120px");
    expect(stickyTopInset()).toBe(120);
    expect(visibleHeightOf(makeRoot())).toBe(724);
    expect(visibleHeightOf(makeRoot(false))).toBe(5000);
    stubLayoutTier("docked");
    expect(visibleHeightOf(makeRoot())).toBe(5000);
  });

  it("stickyTopInset：沒有設定時 0", () => {
    expect(stickyTopInset()).toBe(0);
  });

  function Header({ enabled, height }: { enabled: boolean; height: number }) {
    const ref = useRef<HTMLDivElement>(null);
    useStickyTopVar(ref, enabled);
    return <div ref={ref} data-height={height} />;
  }

  it("useStickyTopVar：開著時把頁首外框的高度（四捨五入）寫進 <html>，關掉或卸載時移除", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return new DOMRect(0, 0, 390, Number(this.getAttribute("data-height") ?? 0));
    });
    const view = render(<Header enabled height={88.6} />);
    expect(document.documentElement.style.getPropertyValue(STICKY_TOP_VAR)).toBe("89px");
    view.rerender(<Header enabled={false} height={88.6} />);
    expect(document.documentElement.style.getPropertyValue(STICKY_TOP_VAR)).toBe("");
    view.rerender(<Header enabled height={60} />);
    expect(document.documentElement.style.getPropertyValue(STICKY_TOP_VAR)).toBe("60px");
    view.unmount();
    expect(document.documentElement.style.getPropertyValue(STICKY_TOP_VAR)).toBe("");
  });
});

describe("useStickyTopInset：頁首高度變了就重繪", () => {
  function Header({ height }: { height: number }) {
    const ref = useRef<HTMLDivElement>(null);
    useStickyTopVar(ref, height > 0);
    return <div ref={ref} data-height={height} />;
  }
  function Reader() {
    return <p data-testid="inset">{useStickyTopInset()}</p>;
  }

  it("頁首量到新的高度時，讀它的元件跟著重繪（不用等別的原因重繪）", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return new DOMRect(0, 0, 390, Number(this.getAttribute("data-height") ?? 0));
    });
    const reader = render(<Reader />);
    expect(reader.getByTestId("inset").textContent).toBe("0");
    const header = render(<Header height={80} />);
    expect(reader.getByTestId("inset").textContent).toBe("80");
    header.rerender(<Header height={0} />);
    expect(reader.getByTestId("inset").textContent).toBe("0");
    header.rerender(<Header height={112} />);
    expect(reader.getByTestId("inset").textContent).toBe("112");
  });
});

describe("captureScrollAnchor／restoreScrollAnchor", () => {
  const ITEMS = { itemSelector: "[data-i]", idAttr: "data-i" };
  function list(tops: number[], height: number): HTMLElement {
    const container = document.createElement("div");
    tops.forEach((_, i) => {
      const item = document.createElement("div");
      item.setAttribute("data-i", String(i));
      container.append(item);
    });
    document.body.append(container);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const i = this.getAttribute("data-i");
      return i === null ? new DOMRect(0, 0, 0, 0) : new DOMRect(0, tops[Number(i)]!, 390, height);
    });
    return container;
  }

  it("取下緣在那條線之下的第一項，記下它離線多遠與高度", () => {
    const container = list([-200, -100, -20, 80, 180], 100);
    expect(captureScrollAnchor(container, ITEMS, 50)).toEqual({ id: "2", offset: -70, height: 100 });
  });

  it("還原：同一項回到離線同樣的距離；捲過線的部分照新高度比例換算；找不到回 false", () => {
    const container = list([0, 40, 80, 120], 40);
    const scrollBy = vi.fn();
    // 項 2 現在上緣在 80，線在 60：原本捲過 70／100，新高度 40 → 捲過 28 → 上緣應在 32 → 往下捲 48
    expect(restoreScrollAnchor(container, ITEMS, { id: "2", offset: -70, height: 100 }, 60, scrollBy)).toBe(true);
    expect(scrollBy).toHaveBeenCalledWith(48);
    scrollBy.mockClear();
    // 沒捲過線：照原距離
    expect(restoreScrollAnchor(container, ITEMS, { id: "1", offset: 10, height: 100 }, 20, scrollBy)).toBe(true);
    expect(scrollBy).toHaveBeenCalledWith(10);
    expect(restoreScrollAnchor(container, ITEMS, { id: "9", offset: 0, height: 10 }, 0, scrollBy)).toBe(false);
  });
});

describe("useTierScrollAnchor：跨 640 保住閱讀位置", () => {
  // 兩種排版：手機（文件在捲，項高 100、文件裡從 100 開始）與 640 起（容器在捲，容器頂在 60、項高 40）。
  let layout: "phone" | "wide" = "phone";
  let pageY = 0;
  let boxTop = 0;
  let hidden = false;
  let frames: FrameRequestCallback[] = [];
  const PHONE_TOP = 50;

  function Host() {
    const ref = useRef<HTMLDivElement>(null);
    useTierScrollAnchor({ containerRef: ref, itemSelector: "[data-i]", idAttr: "data-i", phoneTop: () => PHONE_TOP });
    return (
      <div ref={ref} data-container="">
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} data-i={i} />
        ))}
      </div>
    );
  }

  function setup(): { container: HTMLElement; tier: ReturnType<typeof stubLayoutTier>; beforeReact: (fn: () => void) => void } {
    layout = "phone";
    pageY = 0;
    boxTop = 0;
    hidden = false;
    const tier = stubLayoutTier("phone");
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(window, "scrollTo").mockImplementation(((x: number, y: number) => {
      pageY = y;
    }) as typeof window.scrollTo);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.hasAttribute("data-container")) return new DOMRect(0, layout === "phone" ? 100 - pageY : 60, 390, 400);
      const i = Number(this.getAttribute("data-i"));
      return layout === "phone" ? new DOMRect(0, 100 + i * 100 - pageY, 390, 100) : new DOMRect(0, 60 + i * 40 - boxTop, 844, 40);
    });
    vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
      return (hidden ? [] : [this.getBoundingClientRect()]) as unknown as DOMRectList;
    });
    // 媒體查詢翻轉後、React 收到通知前要做的事（排版換掉、文件被夾回 0 並發出 scroll）：比 React 先登記監聽，先跑。
    const pending: Array<() => void> = [];
    window.matchMedia(PHONE_QUERY).addEventListener("change", () => pending.splice(0).forEach((fn) => fn()));
    const { container } = render(<Host />);
    const box = container.querySelector<HTMLElement>("[data-container]")!;
    Object.defineProperty(box, "scrollTop", {
      configurable: true,
      get: () => boxTop,
      set: (v: number) => {
        boxTop = v;
      },
    });
    return { container: box, tier, beforeReact: (fn) => pending.push(fn) };
  }

  // scroll 事件，接著跑掉排進下一個 frame 的記錄。
  const scrollEvent = () =>
    act(() => {
      window.dispatchEvent(new Event("scroll"));
      frames.splice(0).forEach((cb) => cb(0));
    });

  it("手機 → 640 起 → 手機：同一項停在頂端附近；換段途中被夾回 0 的那次 scroll 不記", () => {
    const { tier, beforeReact } = setup();
    pageY = 320; // 項 2 上緣在 -20，離線（50）-70
    scrollEvent();
    beforeReact(() => {
      layout = "wide";
      pageY = 0;
      scrollEvent();
    });
    act(() => tier.setLayoutTier("overlay"));
    // 640 起：項 2 捲過 70／100 → 新高度 40 捲過 28 → 上緣在 60 − 28 = 32 → 容器 scrollTop = 60 + 80 − 32 = 108
    expect(boxTop).toBe(108);
    beforeReact(() => {
      layout = "phone";
    });
    act(() => tier.setLayoutTier("phone"));
    expect(pageY).toBe(320);
  });

  it("容器看不到（例如收起的抽屜）時不記也不還；位置留到回來時再還", () => {
    const { tier, beforeReact } = setup();
    pageY = 520;
    scrollEvent();
    beforeReact(() => {
      layout = "wide";
      hidden = true;
      pageY = 0;
    });
    act(() => tier.setLayoutTier("overlay"));
    expect(boxTop).toBe(0);
    scrollEvent();
    beforeReact(() => {
      layout = "phone";
      hidden = false;
    });
    act(() => tier.setLayoutTier("phone"));
    expect(pageY).toBe(520);
  });
});

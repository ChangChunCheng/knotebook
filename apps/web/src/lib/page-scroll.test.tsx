import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { PHONE_QUERY } from "@/lib/layout-tiers";
import { stubLayoutTier } from "@/test/layout-tier";
import {
  PHONE_PAGE_SCROLL_ATTR,
  ROOT_FLAGS,
  STICKY_TOP_VAR,
  captureScrollAnchor,
  mayCrossTiersByDefault,
  restoreScrollAnchor,
  scrollToTopOf,
  scrollsPage,
  stickyTopInset,
  useStickyTopInset,
  useStickyTopVar,
  useRootFlag,
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

  function Header({ enabled, height, framed = true, name = STICKY_TOP_VAR }: { enabled: boolean; height: number; framed?: boolean; name?: string }) {
    const ref = useRef<HTMLDivElement>(null);
    useStickyTopVar(ref, enabled, name);
    const header = <div ref={ref} data-height={height} />;
    return framed ? <div {...{ [PHONE_PAGE_SCROLL_ATTR]: "" }}>{header}</div> : header;
  }

  it("useStickyTopVar：不在文件代為捲動的外框裡（抽屜裡的清單）就不寫", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return new DOMRect(0, 0, 390, Number(this.getAttribute("data-height") ?? 0));
    });
    render(<Header enabled height={70} framed={false} />);
    expect(document.documentElement.style.getPropertyValue(STICKY_TOP_VAR)).toBe("");
  });

  it("useStickyTopVar：卸載時只移除自己寫的值；同名變數已被另一份改寫就不動", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return new DOMRect(0, 0, 390, Number(this.getAttribute("data-height") ?? 0));
    });
    const first = render(<Header enabled height={88} />);
    const second = render(<Header enabled height={100} />);
    expect(document.documentElement.style.getPropertyValue(STICKY_TOP_VAR)).toBe("100px");
    first.unmount();
    expect(document.documentElement.style.getPropertyValue(STICKY_TOP_VAR)).toBe("100px");
    second.unmount();
    expect(document.documentElement.style.getPropertyValue(STICKY_TOP_VAR)).toBe("");
  });

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
    return (
      <div {...{ [PHONE_PAGE_SCROLL_ATTR]: "" }}>
        <div ref={ref} data-height={height} />
      </div>
    );
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

describe("captureScrollAnchor：並排欄位", () => {
  type Box = { id: string; top: number; height: number };
  /** 照文件順序放好項目，每一條線都要拿到文件順序裡第一個下緣在線之下的那一項。 */
  function expectDocumentOrder(boxes: Box[], lines: number[]): void {
    const container = document.createElement("div");
    for (const box of boxes) {
      const item = document.createElement("div");
      item.setAttribute("data-id", box.id);
      container.append(item);
    }
    document.body.append(container);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const box = boxes.find((b) => b.id === this.getAttribute("data-id"));
      return box ? new DOMRect(0, box.top, 180, box.height) : new DOMRect(0, 0, 0, 0);
    });
    const items = { itemSelector: "[data-id]", idAttr: "data-id" };
    for (const line of lines) {
      const expected = boxes.find((b) => b.top + b.height > line)!;
      expect(captureScrollAnchor(container, items, line), `線在 ${line}`).toEqual({ id: expected.id, offset: expected.top - line, height: expected.height });
    }
  }
  const linesUpTo = (end: number, step: number) => Array.from({ length: Math.ceil(end / step) }, (_, i) => i * step);

  it("兩欄長短不一（第二欄的區塊在文件裡排在第一欄之後、位置從上面重新開始）：整段範圍內都取到文件順序裡第一個下緣在線之下的區塊", () => {
    // 文件順序：第一欄 c1-0…c1-3（各高 100，從 0 起）、第二欄 c2-0…c2-3（各高 60，從 0 起）、欄位之後 b0…b29（各高 50，從 400 起）
    expectDocumentOrder(
      [
        ...Array.from({ length: 4 }, (_, i) => ({ id: `c1-${i}`, top: i * 100, height: 100 })),
        ...Array.from({ length: 4 }, (_, i) => ({ id: `c2-${i}`, top: i * 60, height: 60 })),
        ...Array.from({ length: 30 }, (_, i) => ({ id: `b${i}`, top: 400 + i * 50, height: 50 })),
      ],
      linesUpTo(1900, 23),
    );
  });

  it("第二欄比較長：線過了第一欄的底、還在第二欄裡時，取到第二欄的那一塊", () => {
    // 第一欄 c1-0、c1-1（各高 100，到 200）、第二欄 c2-0…c2-5（各高 60，到 360）、欄位之後 b0…b9（各高 50，從 360 起）
    const boxes = [
      ...Array.from({ length: 2 }, (_, i) => ({ id: `c1-${i}`, top: i * 100, height: 100 })),
      ...Array.from({ length: 6 }, (_, i) => ({ id: `c2-${i}`, top: i * 60, height: 60 })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, top: 360 + i * 50, height: 50 })),
    ];
    expectDocumentOrder(boxes, linesUpTo(800, 17));
    // 明確：線在 250（第一欄已結束）→ 第二欄的 c2-4（240～300）
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    expectDocumentOrder(boxes, [250]);
    expect(boxes.find((b) => b.top + b.height > 250)!.id).toBe("c2-4");
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

  let phoneSized: boolean | "default" = true;
  function Host({ framed = true }: { framed?: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    useTierScrollAnchor({
      containerRef: ref,
      itemSelector: "[data-i]",
      idAttr: "data-i",
      phoneTop: () => PHONE_TOP,
      mayCrossTiers: phoneSized === "default" ? undefined : () => phoneSized === true,
    });
    const list = (
      <div ref={ref} data-container="">
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} data-i={i} />
        ))}
      </div>
    );
    return framed ? <div {...{ [PHONE_PAGE_SCROLL_ATTR]: "" }}>{list}</div> : list;
  }

  function setup(
    framed = true,
    start: { tier: "phone" | "overlay"; phoneSized: boolean | "default"; others?: (query: string) => boolean } = { tier: "phone", phoneSized: true },
  ): { container: HTMLElement; tier: ReturnType<typeof stubLayoutTier>; beforeReact: (fn: () => void) => void } {
    layout = start.tier === "phone" ? "phone" : "wide";
    phoneSized = start.phoneSized;
    pageY = 0;
    boxTop = 0;
    hidden = false;
    const tier = stubLayoutTier(start.tier, start.others);
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
    const { container } = render(<Host framed={framed} />);
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

  /** `target`（預設文件）發出一次 scroll，接著跑下一個 frame（記位置在那裡）。 */
  const scrollOn = (target: EventTarget = document) =>
    act(() => {
      target.dispatchEvent(new Event("scroll"));
      frames.splice(0).forEach((cb) => cb(0));
    });

  it("手機 → 640 起 → 手機：同一項停在頂端附近；換段途中被夾回 0 的那次 scroll 不記", () => {
    const { tier, beforeReact } = setup();
    pageY = 320; // 項 2 上緣在 -20，離線（50）-70
    scrollOn();
    beforeReact(() => {
      layout = "wide";
      pageY = 0;
      scrollOn();
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

  it("捲完緊接著轉向（只隔一個 frame、沒有停頓）：還的是最後捲到的那一項", () => {
    const { tier, beforeReact } = setup();
    pageY = 320;
    scrollOn();
    pageY = 650; // 項 5 下緣在 50（剛好在線上，不算）→ 項 6 上緣在 50
    scrollOn();
    beforeReact(() => {
      layout = "wide";
      pageY = 0;
    });
    act(() => tier.setLayoutTier("overlay"));
    // 項 6 離線 0 → 640 起上緣在 60 → scrollTop = 60 + 240 − 60 = 240
    expect(boxTop).toBe(240);
  });

  it("別的元素（表格、選單）的捲動不理", () => {
    const { tier, beforeReact } = setup();
    const other = document.createElement("div");
    document.body.append(other);
    pageY = 320;
    scrollOn(other);
    beforeReact(() => {
      layout = "wide";
      pageY = 0;
    });
    act(() => tier.setLayoutTier("overlay"));
    expect(boxTop).toBe(0);
  });

  it("容器不在文件代為捲動的外框裡（抽屜裡那份清單）：不記也不還", () => {
    const { tier, beforeReact } = setup(false);
    pageY = 320;
    scrollOn();
    beforeReact(() => {
      layout = "wide";
      pageY = 0;
    });
    act(() => tier.setLayoutTier("overlay"));
    expect(boxTop).toBe(0);
  });

  it("容器看不到（筆記頁時藏起來的清單、收起的抽屜）時不記也不還；位置留到回來時再還", () => {
    const { container, tier, beforeReact } = setup();
    pageY = 520;
    scrollOn();
    // 清單藏起來時文件的捲動（例如在筆記頁）不改它記的位置
    hidden = true;
    pageY = 900;
    scrollOn();
    beforeReact(() => {
      layout = "wide";
      pageY = 0;
    });
    act(() => tier.setLayoutTier("overlay"));
    expect(boxTop).toBe(0);
    scrollOn(container);
    beforeReact(() => {
      layout = "phone";
      hidden = false;
    });
    act(() => tier.setLayoutTier("phone"));
    expect(pageY).toBe(520);
  });
  it("每個 frame 最多量一次：同一個 frame 內的多次 scroll 只排一次", () => {
    setup();
    pageY = 320;
    act(() => {
      for (let i = 0; i < 5; i++) document.dispatchEvent(new Event("scroll"));
    });
    expect(frames).toHaveLength(1);
  });

  it("640 起、螢幕短邊不比 640 窄（桌機、平板）：捲動時不排、不量", () => {
    const { container } = setup(true, { tier: "overlay", phoneSized: false });
    const rects = vi.mocked(Element.prototype.getBoundingClientRect);
    rects.mockClear();
    boxTop = 100;
    scrollOn(container);
    expect(frames).toHaveLength(0);
    expect(rects).not.toHaveBeenCalled();
  });

  it("桌機視窗從手機寬度拉寬：還原手機寬度時記的位置，之後作廢；再拉窄回手機寬度時不跳回那裡", () => {
    const { tier, beforeReact } = setup(true, { tier: "phone", phoneSized: false });
    pageY = 320;
    scrollOn();
    beforeReact(() => {
      layout = "wide";
      pageY = 0;
    });
    act(() => tier.setLayoutTier("overlay"));
    expect(boxTop).toBe(108);
    beforeReact(() => {
      layout = "phone";
    });
    act(() => tier.setLayoutTier("phone"));
    expect(pageY).toBe(0);
  });

  it("640 起、螢幕短邊比 640 窄（轉橫拿的手機）：照樣記，轉回直拿還原", () => {
    const { container, tier, beforeReact } = setup(true, { tier: "overlay", phoneSized: true });
    boxTop = 80; // 項 2 上緣在 60 + 80 − 80 = 60＝容器頂，離線 0
    scrollOn(container);
    beforeReact(() => {
      layout = "phone";
    });
    act(() => tier.setLayoutTier("phone"));
    // 手機：項 2 上緣 300 − pageY 要在 50 → pageY = 250
    expect(pageY).toBe(250);
  });
  it("預設判斷：640 起、短邊不比 640 窄、但主要指標是手指（平板分割畫面、摺疊機）→ 照樣記；滑鼠的桌機視窗不記", () => {
    vi.stubGlobal("screen", { width: 1024, height: 768 });
    const touch = setup(true, { tier: "overlay", phoneSized: "default", others: (query) => query === "(pointer: coarse)" });
    boxTop = 80;
    scrollOn(touch.container);
    expect(mayCrossTiersByDefault()).toBe(true);
    touch.beforeReact(() => {
      layout = "phone";
    });
    act(() => touch.tier.setLayoutTier("phone"));
    expect(pageY).toBe(250);
  });

  it("預設判斷：滑鼠的桌機（短邊 ≥ 640、指標精確）不記；手機尺寸的螢幕記", () => {
    stubLayoutTier("overlay");
    vi.stubGlobal("screen", { width: 1440, height: 900 });
    expect(mayCrossTiersByDefault()).toBe(false);
    vi.stubGlobal("screen", { width: 390, height: 844 });
    expect(mayCrossTiersByDefault()).toBe(true);
    stubLayoutTier("overlay", (query) => query === "(pointer: coarse)");
    vi.stubGlobal("screen", { width: 1180, height: 820 });
    expect(mayCrossTiersByDefault()).toBe(true);
  });
});

describe("useRootFlag", () => {
  function Flag({ on = true }: { on?: boolean }) {
    useRootFlag(ROOT_FLAGS.listShown, on);
    return null;
  }

  it("active 時在 <html> 上掛旗標，關掉或卸載就拿掉", () => {
    const view = render(<Flag />);
    expect(document.documentElement).toHaveAttribute(ROOT_FLAGS.listShown, "");
    view.rerender(<Flag on={false} />);
    expect(document.documentElement).not.toHaveAttribute(ROOT_FLAGS.listShown);
    view.rerender(<Flag />);
    expect(document.documentElement).toHaveAttribute(ROOT_FLAGS.listShown, "");
    view.unmount();
    expect(document.documentElement).not.toHaveAttribute(ROOT_FLAGS.listShown);
  });

  it("兩個元件同時要同一個旗標：先離開的那個不會把它拿掉，最後一個離開才拿掉", () => {
    const first = render(<Flag />);
    const second = render(<Flag />);
    first.unmount();
    expect(document.documentElement).toHaveAttribute(ROOT_FLAGS.listShown, "");
    second.unmount();
    expect(document.documentElement).not.toHaveAttribute(ROOT_FLAGS.listShown);
  });
});

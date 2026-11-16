import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { stubLayoutTier } from "@/test/layout-tier";
import { PHONE_PAGE_SCROLL_ATTR, STICKY_TOP_VAR, scrollToTopOf, scrollsPage, stickyTopInset, useStickyTopVar, visibleHeightOf } from "./page-scroll";

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

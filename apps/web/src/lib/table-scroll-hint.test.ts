import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { TABLE_MORE_RIGHT_ATTR, supportsScrollTimeline, syncTableScrollHint, useTableScrollHint } from "./table-scroll-hint";

function scroller(metrics: { scrollWidth: number; clientWidth: number; scrollLeft: number }): HTMLElement {
  const el = document.createElement("div");
  el.className = "tableWrapper";
  for (const [key, value] of Object.entries(metrics)) Object.defineProperty(el, key, { value, configurable: true, writable: true });
  return el;
}

function setup(...tables: HTMLElement[]) {
  const root = document.createElement("div");
  for (const table of tables) root.appendChild(table);
  document.body.appendChild(root);
  return { root, ref: { current: root } };
}

describe("syncTableScrollHint", () => {
  it("右邊還有內容沒看到才帶屬性；差不到 1px 或剛好捲到底不帶", () => {
    const el = scroller({ scrollWidth: 600, clientWidth: 300, scrollLeft: 0 });
    syncTableScrollHint(el);
    expect(el).toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
    Object.defineProperty(el, "scrollLeft", { value: 300 });
    syncTableScrollHint(el);
    expect(el).not.toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
    Object.defineProperty(el, "scrollLeft", { value: 299.5 });
    syncTableScrollHint(el);
    expect(el).not.toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
  });
});

describe("useTableScrollHint", () => {
  beforeEach(() => {
    vi.stubGlobal("CSS", { supports: () => false });
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      cb();
      return 1;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("支援判斷看 CSS.supports；沒有 CSS.supports 視為不支援", () => {
    expect(supportsScrollTimeline()).toBe(false);
    vi.stubGlobal("CSS", { supports: (query: string) => query === "animation-timeline: scroll(self inline)" });
    expect(supportsScrollTimeline()).toBe(true);
    vi.stubGlobal("CSS", {});
    expect(supportsScrollTimeline()).toBe(false);
  });

  it("支援捲動驅動動畫的瀏覽器：純 CSS，hook 不掛監聽、不標屬性", () => {
    vi.stubGlobal("CSS", { supports: () => true });
    const wide = scroller({ scrollWidth: 800, clientWidth: 300, scrollLeft: 0 });
    const { root, ref } = setup(wide);
    const add = vi.spyOn(root, "addEventListener");
    renderHook(() => useTableScrollHint(ref, true));
    expect(add).not.toHaveBeenCalled();
    expect(wide).not.toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
  });

  it("開始時就依溢出與否標好：溢出的有、沒溢出的沒有", () => {
    const wide = scroller({ scrollWidth: 800, clientWidth: 300, scrollLeft: 0 });
    const narrow = scroller({ scrollWidth: 300, clientWidth: 300, scrollLeft: 0 });
    const { ref } = setup(wide, narrow);
    renderHook(() => useTableScrollHint(ref, true));
    expect(wide).toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
    expect(narrow).not.toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
  });

  it("scroll 不冒泡：容器用 capture 接到表格自己的 scroll，捲到底就拿掉", () => {
    const wide = scroller({ scrollWidth: 800, clientWidth: 300, scrollLeft: 0 });
    const { ref } = setup(wide);
    renderHook(() => useTableScrollHint(ref, true));
    expect(wide).toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
    Object.defineProperty(wide, "scrollLeft", { value: 500 });
    wide.dispatchEvent(new Event("scroll", { bubbles: false }));
    expect(wide).not.toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
    Object.defineProperty(wide, "scrollLeft", { value: 100 });
    wide.dispatchEvent(new Event("scroll", { bubbles: false }));
    expect(wide).toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
  });

  it("摺疊區塊展開（只改 data-show-children）後，裡面的寬表格也標得到", async () => {
    const wide = scroller({ scrollWidth: 800, clientWidth: 300, scrollLeft: 0 });
    const toggle = document.createElement("div");
    toggle.appendChild(wide);
    const { ref } = setup(toggle);
    // 摺疊時表格沒有寬度。
    Object.defineProperty(wide, "clientWidth", { value: 800, configurable: true });
    renderHook(() => useTableScrollHint(ref, true));
    expect(wide).not.toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
    Object.defineProperty(wide, "clientWidth", { value: 300, configurable: true });
    toggle.setAttribute("data-show-children", "true");
    await waitFor(() => expect(wide).toHaveAttribute(TABLE_MORE_RIGHT_ATTR));
  });

  it("狀態沒變的重掃不寫屬性（不產生屬性變動，也不會自己觸發自己）", async () => {
    const wide = scroller({ scrollWidth: 800, clientWidth: 300, scrollLeft: 0 });
    const narrow = scroller({ scrollWidth: 300, clientWidth: 300, scrollLeft: 0 });
    const { root, ref } = setup(wide, narrow);
    renderHook(() => useTableScrollHint(ref, true));
    const seen: MutationRecord[] = [];
    const watcher = new MutationObserver((records) => seen.push(...records));
    watcher.observe(root, { attributes: true, subtree: true });
    root.appendChild(document.createElement("p")); // 觸發重掃
    await new Promise((resolve) => setTimeout(resolve, 20));
    const attributeRecords = [...seen, ...watcher.takeRecords()].filter((record) => record.type === "attributes");
    watcher.disconnect();
    expect(attributeRecords).toHaveLength(0);
    expect(wide).toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
  });

  it("只在容器上掛一份監聽，不逐表掛", () => {
    const tables = [1, 2, 3].map(() => scroller({ scrollWidth: 800, clientWidth: 300, scrollLeft: 0 }));
    const { root, ref } = setup(...tables);
    const rootAdd = vi.spyOn(root, "addEventListener");
    const tableAdds = tables.map((table) => vi.spyOn(table, "addEventListener"));
    renderHook(() => useTableScrollHint(ref, true));
    expect(rootAdd).toHaveBeenCalledWith("scroll", expect.any(Function), true);
    for (const add of tableAdds) expect(add).not.toHaveBeenCalled();
  });

  it("不是手機（enabled=false）：不掛監聽、不標屬性", () => {
    const wide = scroller({ scrollWidth: 800, clientWidth: 300, scrollLeft: 0 });
    const { root, ref } = setup(wide);
    const add = vi.spyOn(root, "addEventListener");
    renderHook(() => useTableScrollHint(ref, false));
    expect(add).not.toHaveBeenCalled();
    expect(wide).not.toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
  });

  it("卸載時拿掉監聽與屬性", () => {
    const wide = scroller({ scrollWidth: 800, clientWidth: 300, scrollLeft: 0 });
    const { root, ref } = setup(wide);
    const remove = vi.spyOn(root, "removeEventListener");
    const view = renderHook(() => useTableScrollHint(ref, true));
    view.unmount();
    expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function), true);
    expect(wide).not.toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import i18n from "@/i18n";
import { FROSTED_SURFACE } from "@/components/ui/frosted";
import { VersionsProvider, useVersions, useVersionsController } from "@/lib/versions-context";
import { stubLayoutTier, type LayoutTier } from "@/test/layout-tier";
import { CornerStack } from "./CornerStack";

/** 探針：印出版本面板狀態，並提供「從 ⋮ 開版本面板」的外部按鈕。 */
function Probe() {
  const v = useVersions();
  return (
    <div>
      <span data-testid="panel-open">{String(v.panelOpen)}</span>
      <button type="button" onClick={() => v.open()}>
        probe-open-versions
      </button>
    </div>
  );
}

function Host({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const versions = useVersionsController({ noteId: "n1", enabled });
  return <VersionsProvider value={versions}>{children}</VersionsProvider>;
}

function renderStack(enabled: boolean) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Host enabled={enabled}>
        <Probe />
        <CornerStack />
      </Host>
    </QueryClientProvider>,
  );
}

describe("CornerStack（筆記右下角的歷史泡泡）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("容器：零高度錨點（relative、h-0）貼在捲動區下緣，堆疊 absolute 在錨點上方右側；不是 fixed、不吃 safe area；唯一子項是歷史泡泡", async () => {
    renderStack(true);
    const stack = await screen.findByTestId("corner-stack");
    expect(Array.from(stack.children).map((el) => el.getAttribute("data-testid"))).toEqual(["versions-bubble"]);
    expect(screen.queryByTestId("ai-bubble")).not.toBeInTheDocument();
    expect(stack).toHaveClass("absolute", "bottom-[18px]", "right-[calc(18px+var(--bubble-gutter,var(--scrollbar-size)))]", "flex", "flex-col-reverse", "gap-3");
    expect(stack).not.toHaveClass("fixed");
    expect(stack.className).not.toMatch(/safe-area|sm:right|sm:bottom/);
    const anchor = screen.getByTestId("corner-anchor");
    expect(anchor).toContainElement(stack);
    expect(anchor).toHaveClass("relative", "h-0", "shrink-0", "z-20");
  });

  function installTier(tier: LayoutTier): (next: LayoutTier) => void {
    const handle = stubLayoutTier(tier);
    return (next) => act(() => handle.setLayoutTier(next));
  }

  it("手機（< 640）：沒有歷史泡泡（整個容器不渲染）；浮動與固定段都有；跨斷點跟著變", async () => {
    const setTier = installTier("phone");
    renderStack(true);
    expect(screen.queryByTestId("versions-bubble")).not.toBeInTheDocument();
    expect(screen.queryByTestId("corner-stack")).not.toBeInTheDocument();
    expect(screen.queryByTestId("corner-anchor")).not.toBeInTheDocument();
    setTier("overlay");
    expect(await screen.findByTestId("versions-bubble")).toBeInTheDocument();
    setTier("docked");
    expect(screen.getByTestId("versions-bubble")).toBeInTheDocument();
    setTier("phone");
    expect(screen.queryByTestId("versions-bubble")).not.toBeInTheDocument();
  });

  it("viewer（versions enabled=false）→ 整個容器不渲染", () => {
    renderStack(false);
    expect(screen.queryByTestId("corner-stack")).not.toBeInTheDocument();
    expect(screen.queryByTestId("corner-anchor")).not.toBeInTheDocument();
  });

  it("歷史泡泡：毛玻璃面（與手機浮動鈕同一份）、brand 圖示色、aria-label；點了開面板，開著時整個容器消失", async () => {
    renderStack(true);
    const bubble = await screen.findByTestId("versions-bubble");
    expect(bubble).toHaveAttribute("aria-label", "Version history");
    expect(bubble).toHaveClass("h-12", "w-12", "rounded-full", "text-brand-on-soft");
    // 共用面的 token 都在（hover／按下的透明度由泡泡自己加深，見下）。
    for (const token of FROSTED_SURFACE.split(" ").filter((c) => !/hover:bg-card|active:bg-card/.test(c))) expect(bubble).toHaveClass(token);
    expect(bubble).toHaveClass("supports-[backdrop-filter]:backdrop-blur-xs", "supports-[backdrop-filter]:backdrop-saturate-150", "bg-card/95", "shadow-lg");
    expect(bubble).not.toHaveClass("bg-brand-soft");
    // hover 是淺品牌色底、按下深一階、游標手指；毛玻璃的 hover／按下透明度被合併掉。
    expect(bubble).toHaveClass("cursor-pointer", "hover:bg-brand-soft", "supports-[backdrop-filter]:hover:bg-brand-soft", "active:bg-brand-soft-strong", "supports-[backdrop-filter]:active:bg-brand-soft-strong");
    expect(bubble).not.toHaveClass("hover:shadow-xl", "hover:bg-card/95", "active:bg-card/95");
    expect(bubble).not.toHaveClass("supports-[backdrop-filter]:hover:bg-card/30", "supports-[backdrop-filter]:active:bg-card/40");
    fireEvent.click(bubble);
    expect(screen.getByTestId("panel-open")).toHaveTextContent("true");
    expect(screen.queryByTestId("corner-stack")).not.toBeInTheDocument();
    expect(screen.queryByTestId("corner-anchor")).not.toBeInTheDocument();
  });

  it("捲動時不淡出：任何捲動事件後容器沒有 opacity-0／pointer-events-none、沒有計時器", async () => {
    renderStack(true);
    const stack = await screen.findByTestId("corner-stack");
    const anchor = screen.getByTestId("corner-anchor");
    vi.useFakeTimers();
    try {
      fireEvent.scroll(document.body);
      fireEvent.scroll(window);
      expect(stack).not.toHaveClass("opacity-0");
      expect(stack.className).not.toMatch(/opacity-0|transition-opacity|pointer-events-none/);
      expect(anchor).not.toHaveClass("opacity-0");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

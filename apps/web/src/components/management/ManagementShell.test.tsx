import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, type Location } from "react-router";
import i18n from "@/i18n";
import { clickOutside, settle } from "@/test/outside-click";
import { ManagementShell, type ManagementNavItemSpec } from "./ManagementShell";
import { rememberPanelReturn, type PanelLocationState } from "@/lib/panel-return";
import { stubLayoutTier } from "@/test/layout-tier";

// #247。jsdom 不套 Tailwind：`hidden`／`flex` 只能以 class 斷言，真實顯示由 e2e 截圖驗。
// matchMedia：`src/test/setup.ts:28-40` 的全域 stub 恆回 matches:false（＝窄視窗）；寬視窗案自己 stubGlobal。

const ITEMS: ManagementNavItemSpec[] = [
  { to: "/settings/account", label: "Account info" },
  { to: "/settings/login", label: "Sign-in" },
  { to: "/settings/storage", label: "Storage", count: 7 },
];

const BG = { pathname: "/n/tester/my-note", search: "", hash: "", state: null, key: "bg" } as Location;

function LocationProbe() {
  const location = useLocation();
  const bg = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation;
  return (
    <div data-testid="location" data-bg={bg?.pathname ?? ""} data-state-keys={Object.keys((location.state as object | null) ?? {}).sort().join(",")}>
      {location.pathname}
    </div>
  );
}

function renderShell(opts: { path?: string; state?: unknown; items?: ManagementNavItemSpec[]; subtitle?: string } = {}) {
  const onOpenChange = vi.fn();
  render(
    <MemoryRouter initialEntries={[{ pathname: opts.path ?? "/settings/login", state: opts.state ?? null }]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <ManagementShell
                title="Settings"
                subtitle={opts.subtitle}
                description="Panel description"
                items={opts.items ?? ITEMS}
                onOpenChange={onOpenChange}
              >
                <p>slot content</p>
              </ManagementShell>
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return { onOpenChange };
}

const itemsCard = () => document.querySelector<HTMLElement>('[data-management-card="items"]')!;
const contentCard = () => document.querySelector<HTMLElement>('[data-management-card="content"]')!;
const contentBox = () => document.querySelector<HTMLElement>("[data-management-content]")!;

function stubWideViewport() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })),
  );
}

describe("ManagementShell（#247）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("slot：標題是唯一的 DialogTitle、副文字、描述、計數、children 落在 [data-management-content]", async () => {
    renderShell({ subtitle: "Admin" });
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    const headings = within(dialog).getAllByRole("heading");
    expect(headings).toHaveLength(1);
    expect(headings[0]!.id).toBe(dialog.getAttribute("aria-labelledby"));
    expect(dialog).toHaveAccessibleDescription("Panel description");
    expect(within(dialog).getByText("Admin")).toBeInTheDocument();
    expect(within(dialog).getByText("7")).toHaveAttribute("aria-hidden", "true");
    expect(within(dialog).getByRole("link", { name: "Storage" })).toBeInTheDocument(); // 計數不進可及名稱
    expect(within(dialog).getByRole("navigation", { name: "Settings" })).toBeInTheDocument();
    expect(contentBox()).toContainElement(screen.getByText("slot content"));
    expect(contentBox()).toHaveAttribute("tabindex", "-1");
  });

  it("項次轉傳 backgroundLocation（突變：拿掉 state 轉傳要紅）", async () => {
    renderShell({ state: { backgroundLocation: BG } });
    fireEvent.click(await screen.findByRole("link", { name: "Account info" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/settings/account"));
    expect(screen.getByTestId("location")).toHaveAttribute("data-bg", "/n/tester/my-note");
  });

  it("沒有 backgroundLocation 時不帶 state（深連結）", async () => {
    renderShell();
    fireEvent.click(await screen.findByRole("link", { name: "Account info" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/settings/account"));
    expect(screen.getByTestId("location")).toHaveAttribute("data-bg", "");
  });

  it("end 生效：/groups/g1/roles 時帶 end 的「Members」沒有 aria-current", async () => {
    renderShell({
      path: "/groups/g1/roles",
      items: [
        { to: "/groups/g1", label: "Members", end: true },
        { to: "/groups/g1/roles", label: "Roles" },
      ],
    });
    expect(await screen.findByRole("link", { name: "Roles" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Members" })).not.toHaveAttribute("aria-current");
  });

  it("✕ 呼叫 onOpenChange(false)", async () => {
    const { onOpenChange } = renderShell();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("窄寬度停在項次層：左卡也有一顆 Close（md:hidden），點了關；內容層只有右卡那一顆", async () => {
    const { onOpenChange } = renderShell();
    await settle();
    // 內容層：只有右卡的 ✕。
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Back to sections" }));
    const closes = screen.getAllByRole("button", { name: "Close" });
    expect(closes).toHaveLength(2);
    const itemsCard = document.querySelector<HTMLElement>('[data-management-card="items"]')!;
    const left = within(itemsCard).getByRole("button", { name: "Close" });
    expect(left).toHaveClass("md:hidden");
    fireEvent.click(left);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("兩顆 ✕ 與返回鈕在觸控裝置都撐出 44px 的點擊範圍", async () => {
    renderShell();
    await settle();
    const right = screen.getByRole("button", { name: "Close" });
    const back = screen.getByRole("button", { name: "Back to sections" });
    for (const button of [right, back]) expect(button).toHaveClass("pointer-coarse:after:-inset-2", "pointer-coarse:after:absolute");
    fireEvent.click(back);
    const itemsCard = document.querySelector<HTMLElement>('[data-management-card="items"]')!;
    // 與右卡的 ✕ 同一個位置（卡的右上角 right-2 top-2），兩層切換時不跳。
    expect(within(itemsCard).getByRole("button", { name: "Close" })).toHaveClass("pointer-coarse:after:-inset-2", "absolute", "right-2", "top-2");
  });

  it("Esc 呼叫 onOpenChange(false)", async () => {
    const { onOpenChange } = renderShell();
    await settle();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("面板內恰一顆 Close（突變：拿掉 dialog.tsx 的 size==='panel' 判斷要紅）", async () => {
    renderShell();
    await settle();
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
  });

  it("右卡 DOM 順序：返回鈕 → ✕ → 內容容器", async () => {
    renderShell();
    await screen.findByRole("dialog");
    const kids = Array.from(contentCard().children);
    expect(kids[0]).toBe(screen.getByRole("button", { name: "Back to sections" }));
    expect(kids[1]).toBe(screen.getByRole("button", { name: "Close" }));
    expect(kids[2]).toBe(contentBox());
  });

  it("開啟後焦點在返回鈕、不是任何項次（Radix removeLinks；突變：加 onOpenAutoFocus 聚焦項次要紅）", async () => {
    renderShell();
    const back = await screen.findByRole("button", { name: "Back to sections" });
    await waitFor(() => expect(document.activeElement).toBe(back));
    expect(back).toHaveClass("md:hidden", "bg-card");
    for (const link of screen.getAllByRole("link")) expect(document.activeElement).not.toBe(link);
  });

  it("雙層初始＝內容層：左卡 hidden＋md:flex（不含裸 flex）、右卡 flex", async () => {
    renderShell();
    await screen.findByRole("dialog");
    expect(itemsCard().classList).toContain("hidden");
    expect(itemsCard().classList).toContain("md:flex");
    expect(itemsCard().classList).not.toContain("flex");
    expect(contentCard().classList).toContain("flex");
    expect(contentCard().classList).not.toContain("hidden");
  });

  it("按返回：左卡顯示、右卡隱藏（不含裸 flex）、網址不變、焦點在 aria-current 的項次", async () => {
    renderShell();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Back to sections" }));
    await waitFor(() => expect(itemsCard().classList).toContain("flex"));
    expect(itemsCard().classList).not.toContain("hidden");
    expect(contentCard().classList).toContain("hidden");
    expect(contentCard().classList).toContain("md:flex");
    expect(contentCard().classList).not.toContain("flex");
    expect(screen.getByTestId("location")).toHaveTextContent("/settings/login");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("link", { name: "Sign-in" })));
  });

  it("返回後點「目前所在」的項次：pathname 不變也要回內容層，焦點在 [data-management-content]", async () => {
    renderShell();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Back to sections" }));
    await waitFor(() => expect(contentCard().classList).toContain("hidden"));
    fireEvent.click(screen.getByRole("link", { name: "Sign-in" }));
    await waitFor(() => expect(contentCard().classList).toContain("flex"));
    expect(itemsCard().classList).toContain("hidden");
    await waitFor(() => expect(document.activeElement).toBe(contentBox()));
    expect(screen.getByTestId("location")).toHaveTextContent("/settings/login");
  });

  it("連續兩次「返回→點同一項」都會把焦點送到內容容器（seq 遞增，不是只觸發一次）", async () => {
    renderShell();
    await settle();
    for (let i = 0; i < 2; i += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Back to sections" }));
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("link", { name: "Sign-in" })));
      fireEvent.click(screen.getByRole("link", { name: "Sign-in" }));
      await waitFor(() => expect(document.activeElement).toBe(contentBox()));
    }
  });

  it("寬視窗（matchMedia matches:true）：點項次不搬焦點", async () => {
    stubWideViewport();
    renderShell();
    await settle();
    fireEvent.click(screen.getByRole("link", { name: "Account info" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/settings/account"));
    await settle();
    expect(document.activeElement).not.toBe(contentBox());
    expect(window.matchMedia).toHaveBeenCalledWith("(min-width: 768px)");
  });
});

describe("ManagementShell 手機（< 640）：貼底 sheet 的返回堆疊", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("MS-P1 從選單開（panelStart＋panelReturn）：停在項次清單；左上角「Back to menu」、沒有 ✕；點它 → sheet 收完後 onOpenChange(false)，再重開選單", async () => {
    stubLayoutTier("phone");
    const reopen = vi.fn();
    const state: PanelLocationState = { backgroundLocation: BG, panelStart: "list", panelReturn: rememberPanelReturn(reopen) };
    const { onOpenChange } = renderShell({ state });
    await settle();
    expect(itemsCard().classList).toContain("flex");
    expect(contentCard().classList).toContain("hidden");
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    const back = within(itemsCard()).getByRole("button", { name: "Back to menu" });
    expect(back).toHaveClass("absolute", "left-2", "top-2", "max-sm:after:-inset-2", "max-sm:after:absolute");
    expect(document.activeElement).toBe(back);
    fireEvent.click(back);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    await waitFor(() => expect(reopen).toHaveBeenCalledTimes(1));
    expect(onOpenChange.mock.invocationCallOrder[0]!).toBeLessThan(reopen.mock.invocationCallOrder[0]!);
  });

  it("MS-P2 選項次 → 內容層：左上角同一個位置是「Back to sections」、仍沒有 ✕；按它回項次清單", async () => {
    stubLayoutTier("phone");
    renderShell({ state: { backgroundLocation: BG, panelStart: "list" } satisfies PanelLocationState });
    await settle();
    fireEvent.click(screen.getByRole("link", { name: "Sign-in" }));
    expect(contentCard().classList).toContain("flex");
    expect(itemsCard().classList).toContain("hidden");
    const back = within(contentCard()).getByRole("button", { name: "Back to sections" });
    expect(back).toHaveClass("absolute", "left-2", "top-2", "max-sm:after:-inset-2");
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    fireEvent.click(back);
    expect(itemsCard().classList).toContain("flex");
    expect(within(itemsCard()).getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("MS-P3 深連結（沒有 panelStart）：直接停在那一頁；退到項次清單後的「‹」名稱是 Close、只關不重開", async () => {
    stubLayoutTier("phone");
    const reopen = vi.fn();
    rememberPanelReturn(reopen);
    const { onOpenChange } = renderShell({ state: { backgroundLocation: BG } });
    await settle();
    expect(contentCard().classList).toContain("flex");
    fireEvent.click(screen.getByRole("button", { name: "Back to sections" }));
    fireEvent.click(within(itemsCard()).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    await settle();
    expect(reopen).not.toHaveBeenCalled();
  });

  it("MS-P4 內容層按 Esc：整個關掉、不重開選單", async () => {
    stubLayoutTier("phone");
    const reopen = vi.fn();
    const { onOpenChange } = renderShell({ state: { backgroundLocation: BG, panelStart: "list", panelReturn: rememberPanelReturn(reopen) } });
    await settle();
    fireEvent.click(screen.getByRole("link", { name: "Sign-in" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    await settle();
    expect(reopen).not.toHaveBeenCalled();
  });

  it("MS-P6 點 sheet 外（上方的縫）：手機整個關掉、不重開選單；640 以上點外面不關（有未存輸入的表單）", async () => {
    stubLayoutTier("phone");
    const reopen = vi.fn();
    const { onOpenChange } = renderShell({ state: { backgroundLocation: BG, panelStart: "list", panelReturn: rememberPanelReturn(reopen) } });
    await settle();
    await clickOutside();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    await settle();
    expect(reopen).not.toHaveBeenCalled();
    cleanup();
    vi.unstubAllGlobals();

    stubLayoutTier("overlay");
    const wide = renderShell({ state: { backgroundLocation: BG } });
    await settle();
    await clickOutside();
    expect(wide.onOpenChange).not.toHaveBeenCalled();
  });

  it("MS-P5 640 以上：panelStart 不作用（照舊停在內容層），有 ✕、沒有「Back to menu」", async () => {
    stubLayoutTier("overlay");
    renderShell({ state: { backgroundLocation: BG, panelStart: "list", panelReturn: rememberPanelReturn(() => {}) } });
    await settle();
    expect(contentCard().classList).toContain("flex");
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back to menu" })).toBeNull();
  });
});

describe("ManagementShell 手機：「返回選單」只給真的從選單打開的那一次", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("MS-P7 打開後 panelStart／panelReturn 從這一筆歷史拿掉（只留 backgroundLocation）；重新整理或上一頁／下一頁回到這一筆＝深連結：停在那一頁，清單的「‹」是 Close、不重開選單", async () => {
    stubLayoutTier("phone");
    const reopen = vi.fn();
    renderShell({ state: { backgroundLocation: BG, panelStart: "list", panelReturn: rememberPanelReturn(reopen) } satisfies PanelLocationState });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveAttribute("data-state-keys", "backgroundLocation"));
    // 這一筆仍是從選單開的那一次：清單上的「‹」照樣是 Back to menu
    expect(within(itemsCard()).getByRole("button", { name: "Back to menu" })).toBeInTheDocument();
    cleanup();

    // 同一筆歷史再掛一次（重新整理、上一頁／下一頁）：state 只剩 backgroundLocation
    const { onOpenChange } = renderShell({ state: { backgroundLocation: BG } });
    await settle();
    expect(contentCard().classList).toContain("flex");
    fireEvent.click(screen.getByRole("button", { name: "Back to sections" }));
    expect(within(itemsCard()).queryByRole("button", { name: "Back to menu" })).toBeNull();
    fireEvent.click(within(itemsCard()).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    await settle();
    expect(reopen).not.toHaveBeenCalled();
  });

  it("MS-P8 在 640 以上從選單打開、之後縮到手機寬度：清單的「‹」是 Close，按了只關、不重開選單", async () => {
    const tier = stubLayoutTier("overlay");
    const reopen = vi.fn();
    const { onOpenChange } = renderShell({ state: { backgroundLocation: BG, panelStart: "list", panelReturn: rememberPanelReturn(reopen) } });
    await settle();
    act(() => tier.setLayoutTier("phone"));
    fireEvent.click(screen.getByRole("button", { name: "Back to sections" }));
    expect(within(itemsCard()).queryByRole("button", { name: "Back to menu" })).toBeNull();
    fireEvent.click(within(itemsCard()).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    await settle();
    expect(reopen).not.toHaveBeenCalled();
  });

  it("MS-P9 手機上卡貼齊 sheet：托盤不留內距，卡只有上圓角、左右與底沒有邊框，safe area 是卡的內距", async () => {
    stubLayoutTier("phone");
    renderShell({ state: { backgroundLocation: BG, panelStart: "list" } });
    await settle();
    const tray = itemsCard().parentElement!;
    expect(tray).toHaveClass("max-sm:p-0", "max-sm:gap-0");
    expect(tray.className).not.toMatch(/max-sm:p[lrb]-\[/);
    for (const card of [itemsCard(), contentCard()]) expect(card).toHaveClass("max-sm:rounded-t-xl", "max-sm:rounded-b-none", "max-sm:border-x-0", "max-sm:border-b-0");
    expect(itemsCard()).toHaveClass("max-sm:pb-[max(1rem,env(safe-area-inset-bottom))]", "max-sm:pl-[max(1rem,env(safe-area-inset-left))]");
    expect(contentCard()).toHaveClass("max-sm:pb-[env(safe-area-inset-bottom)]", "max-sm:pl-[env(safe-area-inset-left)]");
    // 卡貼齊 sheet 左緣：兩層的「‹」自己退開左側 safe area
    expect(within(itemsCard()).getByRole("button", { name: "Close" })).toHaveClass("max-sm:left-[max(0.5rem,env(safe-area-inset-left))]");
    expect(within(contentCard()).getByRole("button", { name: "Back to sections", hidden: true })).toHaveClass("max-sm:left-[max(0.5rem,env(safe-area-inset-left))]");
  });

  it("MS-P10 手機上面板與選單 sheet 同一個表面：卡用 popover 底色、上圓角 12px，托盤不再有毛玻璃與品牌底", async () => {
    stubLayoutTier("phone");
    renderShell({ state: { backgroundLocation: BG, panelStart: "list" } });
    await settle();
    const tray = itemsCard().parentElement!;
    for (const card of [itemsCard(), contentCard()]) {
      expect(card).toHaveClass("max-sm:bg-popover", "max-sm:rounded-t-xl");
      expect(card.className).not.toMatch(/max-sm:rounded-t-2xl/);
    }
    expect(tray).toHaveClass("max-sm:rounded-t-xl", "max-sm:bg-transparent", "max-sm:backdrop-blur-none");
    expect(tray.className).not.toMatch(/max-sm:rounded-t-2xl/);
  });

  it("MS-P11 手機上項次清單的列像選單的列：48px 高、16px 一般字重、相貼、4px 圓角、灰色按壓／焦點底色，目前項次也沒有常駐品牌色；列尾有「›」", async () => {
    stubLayoutTier("phone");
    renderShell({ state: { backgroundLocation: BG, panelStart: "list" } });
    await settle();
    const rows = within(itemsCard()).getAllByRole("link");
    expect(rows).toHaveLength(ITEMS.length);
    for (const row of rows) {
      expect(row).toHaveClass(
        "max-sm:min-h-12",
        "max-sm:h-auto",
        "max-sm:text-base",
        "max-sm:font-normal",
        "max-sm:rounded-sm",
        "max-sm:hover:bg-accent",
        "max-sm:active:bg-accent",
        "max-sm:focus-visible:bg-accent",
      );
    }
    expect(within(itemsCard()).getByRole("navigation")).toHaveClass("max-sm:gap-0");
    // 目前所在的項次（/settings/login）：手機把品牌底與粗體都蓋掉
    const current = within(itemsCard()).getByRole("link", { name: "Sign-in" });
    expect(current).toHaveClass("max-sm:bg-transparent", "max-sm:font-normal", "max-sm:text-foreground");
    expect(rows.filter((row) => row !== current).some((row) => /max-sm:bg-transparent/.test(row.className))).toBe(false);
    // 「›」只在手機顯示、不進可及名稱；有計數的列（Storage）計數在「›」之前
    for (const row of rows) {
      const chevron = row.querySelector("svg");
      expect(chevron).not.toBeNull();
      expect(chevron).toHaveAttribute("aria-hidden", "true");
      expect(chevron).toHaveClass("h-4", "w-4", "shrink-0", "sm:hidden");
    }
    expect(within(itemsCard()).getByRole("link", { name: "Account info" }).querySelector("svg")).toHaveClass("ml-auto");
    expect(within(itemsCard()).getByRole("link", { name: "Storage" }).querySelector("svg")).not.toHaveClass("ml-auto");
  });

  it("MS-P12 手機上標題 18px、列頭有髮絲線，兩層的「‹」落在同一個位置且透明底", async () => {
    stubLayoutTier("phone");
    renderShell({ state: { backgroundLocation: BG, panelStart: "list" } });
    await settle();
    const title = within(itemsCard()).getByText("Settings");
    expect(title).toHaveClass("max-sm:text-lg", "font-semibold");
    const header = title.parentElement!.parentElement!;
    expect(header).toHaveClass("max-sm:h-12", "max-sm:border-b", "max-sm:border-border");
    const listBack = within(itemsCard()).getByRole("button", { name: "Close" });
    const contentBack = within(contentCard()).getByRole("button", { name: "Back to sections", hidden: true });
    for (const back of [listBack, contentBack]) expect(back).toHaveClass("max-sm:top-[26px]", "max-sm:bg-transparent");
    expect(contentBox()).toHaveClass("max-sm:pt-4");
  });

  it("MS-P13 640 以上的列、標題與卡維持原樣：36px 高、14px、品牌色的目前項次、沒有手機專屬的底色", async () => {
    stubWideViewport();
    renderShell();
    await settle();
    const current = within(itemsCard()).getByRole("link", { name: "Sign-in" });
    expect(current).toHaveClass("h-9", "text-sm", "rounded-lg", "bg-brand-soft", "text-brand-on-soft");
    expect(itemsCard().parentElement).toHaveClass("backdrop-blur-md", "bg-background/45");
    expect(itemsCard()).toHaveClass("bg-card");
  });
});

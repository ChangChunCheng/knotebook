import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PHONE_QUERY } from "@/lib/layout-tiers";
import { stubLayoutTier } from "@/test/layout-tier";
import { clickOutside } from "@/test/outside-click";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuMainLevel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu";

function renderOpenMenu() {
  render(
    <DropdownMenu open>
      <DropdownMenuTrigger>open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>plain item</DropdownMenuItem>
        <DropdownMenuCheckboxItem checked>checkbox item</DropdownMenuCheckboxItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>sub trigger</DropdownMenuSubTrigger>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
}

describe("選單項在粗指標下撐到 40px 以上", () => {
  it.each([
    ["menuitem", "plain item"],
    ["menuitemcheckbox", "checkbox item"],
    ["menuitem", "sub trigger"],
  ] as const)("%s「%s」：py-1.5 之外多一個 pointer-coarse:py-2.5", (role, name) => {
    renderOpenMenu();
    const item = screen.getByRole(role, { name });
    expect(item).toHaveClass("py-1.5");
    expect(item).toHaveClass("pointer-coarse:py-2.5");
  });
});

describe("phoneSheet：手機（< 640）是貼底的 sheet，其他寬度照舊", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function Harness({ phoneSheet = true, onSelect }: { phoneSheet?: boolean; onSelect?: () => void }) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent phoneSheet={phoneSheet} sheetTitle="Row title" className="max-w-72 min-w-56">
          <DropdownMenuItem onSelect={onSelect}>first</DropdownMenuItem>
          <DropdownMenuSeparator data-testid="sep" />
          <DropdownMenuItem>second</DropdownMenuItem>
          <DropdownMenuRadioGroup value="a">
            <DropdownMenuRadioItem value="a" sheetRow>
              row radio
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="b">dot radio</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  /** Radix 的觸發鈕只掛 pointerdown（純 click 開不了）。 */
  function open(): HTMLElement {
    fireEvent.pointerDown(screen.getByRole("button", { name: "open" }), { button: 0 });
    return screen.getByRole("menu");
  }

  const SHEET_CLASSES = [
    "kb-menu-sheet",
    "kb-sheet",
    "w-full",
    "max-w-none",
    "min-w-0",
    "rounded-t-xl",
    "rounded-b-none",
    "pb-[max(0.5rem,env(safe-area-inset-bottom))]",
    "mb-(--kb-inset,0px)",
    "max-h-[calc(var(--kb-visible-h,100dvh)*0.85)]",
    "overflow-y-auto",
  ];

  it("手機：內容是 sheet（滿寬、上圓角、底部 safe area、跟著鍵盤、kb-sheet 進出場），呼叫端的寬度限制被蓋掉；小標題在最上面、接一條分隔線", () => {
    stubLayoutTier("phone");
    render(<Harness />);
    const menu = open();
    expect(menu).toHaveAttribute("data-menu-sheet");
    expect(menu).toHaveClass(...SHEET_CLASSES);
    expect(menu).not.toHaveClass("max-w-72");
    expect(menu).not.toHaveClass("min-w-56");
    const title = within(menu).getByText("Row title");
    expect(title).toHaveClass("truncate");
    expect(menu.firstElementChild).toBe(title);
    expect(title.nextElementSibling).toHaveAttribute("role", "separator");
  });

  it("手機：列至少 48px 高、16px 字（粗指標的 py-2.5 換掉）；分隔線伸到兩側（-mx-2）；sheetRow 的 RadioItem 同樣是列，色點那種不是", () => {
    stubLayoutTier("phone");
    render(<Harness />);
    const menu = open();
    for (const name of ["first", "second"]) {
      const item = within(menu).getByRole("menuitem", { name });
      expect(item).toHaveClass("min-h-12", "text-base", "pointer-coarse:py-2");
      expect(item).not.toHaveClass("text-sm");
      expect(item).not.toHaveClass("pointer-coarse:py-2.5");
    }
    expect(screen.getByTestId("sep")).toHaveClass("-mx-2");
    expect(within(menu).getByRole("menuitemradio", { name: "row radio" })).toHaveClass("min-h-12", "text-base");
    expect(within(menu).getByRole("menuitemradio", { name: "dot radio" })).not.toHaveClass("min-h-12");
  });

  it.each([["浮動（640-1279）", "overlay"], ["固定（>= 1280）", "docked"]] as const)("%s：與沒帶 phoneSheet 一樣（沒有 sheet class、沒有小標題，列與分隔線照舊）", (_label, tier) => {
    stubLayoutTier(tier);
    render(<Harness />);
    const menu = open();
    expect(menu).not.toHaveAttribute("data-menu-sheet");
    expect(menu.className).not.toMatch(/kb-menu-sheet|kb-sheet|rounded-t-xl|--kb-inset/);
    expect(menu).toHaveClass("max-w-72", "min-w-56", "rounded-md", "p-1");
    expect(within(menu).queryByText("Row title")).toBeNull();
    const item = within(menu).getByRole("menuitem", { name: "first" });
    expect(item).toHaveClass("py-1.5", "pointer-coarse:py-2.5", "text-sm");
    expect(item).not.toHaveClass("min-h-12");
    expect(screen.getByTestId("sep")).toHaveClass("-mx-1");
    expect(screen.getByTestId("sep")).not.toHaveClass("-mx-2");
  });

  it("手機但沒帶 phoneSheet：照舊是小選單", () => {
    stubLayoutTier("phone");
    render(<Harness phoneSheet={false} />);
    const menu = open();
    expect(menu).not.toHaveAttribute("data-menu-sheet");
    expect(menu.className).not.toMatch(/kb-menu-sheet/);
    expect(within(menu).queryByText("Row title")).toBeNull();
  });

  it("手機：仍是 Radix 選單——role menu／menuitem、方向鍵移動焦點、選項目關閉、Esc 關閉且焦點回觸發鈕", async () => {
    stubLayoutTier("phone");
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    let menu = open();
    const first = within(menu).getByRole("menuitem", { name: "first" });
    act(() => first.focus());
    await waitFor(() => expect(document.activeElement).toBe(first));
    fireEvent.keyDown(first, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "second" })));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "open" }));
    menu = open();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "first" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("手機：點 sheet 外（背板）關閉", async () => {
    stubLayoutTier("phone");
    render(<Harness />);
    open();
    await clickOutside();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("手機判斷只在選單開著時訂閱（側欄每列的 ⋮ 平常不各掛一份）", async () => {
    const handle = stubLayoutTier("phone");
    render(<Harness />);
    expect(handle.listenerCount(PHONE_QUERY)).toBe(0);
    open();
    expect(handle.listenerCount(PHONE_QUERY)).toBe(1);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(handle.listenerCount(PHONE_QUERY)).toBe(0);
  });

  it("手機：開著時把鍵盤高度（--kb-inset）與看得見的高度（--kb-visible-h）寫到內容上；其他寬度不寫", () => {
    const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
    const viewport = Object.assign(new EventTarget(), { height: 500, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true, writable: true });
    vi.stubGlobal("innerHeight", 844);
    try {
      stubLayoutTier("phone");
      render(<Harness />);
      const style = open().style;
      expect(style.getPropertyValue("--kb-inset")).toBe("344px");
      expect(style.getPropertyValue("--kb-visible-h")).toBe("500px");
      cleanup();
      stubLayoutTier("docked");
      render(<Harness />);
      expect(open().style.getPropertyValue("--kb-inset")).toBe("");
    } finally {
      if (original) Object.defineProperty(window, "visualViewport", original);
      else delete (window as { visualViewport?: unknown }).visualViewport;
    }
  });
});

describe("DropdownMenuMainLevel：手機 sheet 裡子選單展開時主層不渲染", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function renderLevel(drilled: boolean) {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent phoneSheet>
          <DropdownMenuMainLevel drilled={drilled}>
            <DropdownMenuItem>main item</DropdownMenuItem>
          </DropdownMenuMainLevel>
          <DropdownMenuItem>submenu row</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
  }

  it("手機 sheet：drilled → 主層項目不在；沒 drilled → 在", () => {
    stubLayoutTier("phone");
    renderLevel(true);
    expect(screen.queryByRole("menuitem", { name: "main item" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "submenu row" })).toBeInTheDocument();
    cleanup();
    renderLevel(false);
    expect(screen.getByRole("menuitem", { name: "main item" })).toBeInTheDocument();
  });

  it("不是 sheet（640 以上）：drilled 也照常渲染（就地展開形不換掉內容）", () => {
    stubLayoutTier("overlay");
    renderLevel(true);
    expect(screen.getByRole("menuitem", { name: "main item" })).toBeInTheDocument();
  });
});

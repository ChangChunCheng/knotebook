import { expect } from "vitest";

/**
 * 卡片頁（ui/button.tsx 規範例外二）的控制項高度斷言：`root`（預設 `main`）內所有
 * `button`、非 checkbox 的 `input`、`a.inline-flex`（長得像按鈕的連結）都是 44px（`h-11`）、不是 32px（`h-8`）。
 * 每個分支畫面（錯誤、重試、已登入、無證明方式…）各呼叫一次，才擋得住只在某條件分支漏掉 `size="lg"`。
 * `ignore`：不放大的例外選擇器（如授權頁文字內的「Not you?」連結鈕）；勾選框一律不查。
 * 回傳檢查到的元素數，呼叫端可再斷言至少一個，避免空真。
 */
export function expectCardControls44(root: HTMLElement = document.querySelector("main") as HTMLElement, ignore?: string): number {
  expect(root).toBeTruthy();
  const controls = Array.from(
    root.querySelectorAll<HTMLElement>('button:not([role="checkbox"]), input:not([type="checkbox"]), a.inline-flex'),
  ).filter((el) => !ignore || !el.matches(ignore));
  for (const el of controls) {
    expect(el, `${el.tagName} "${el.textContent || el.getAttribute("name") || ""}"`).toHaveClass("h-11");
    expect(el).not.toHaveClass("h-8");
  }
  return controls.length;
}

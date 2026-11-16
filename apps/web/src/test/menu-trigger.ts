import { fireEvent } from "@testing-library/react";

/**
 * 在選單觸發鈕上「按一下」：pointerdown 再 click，與瀏覽器一樣。Radix 原本在 pointerdown 開；
 * 手機 sheet 形（`DropdownMenu` 的 `phoneSheet`）改在同一下的 click 開，只送 pointerdown 開不了。
 */
export function pressTrigger(trigger: HTMLElement): void {
  fireEvent.pointerDown(trigger, { button: 0 });
  fireEvent.click(trigger, { detail: 1 });
}

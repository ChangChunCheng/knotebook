import { fireEvent } from "@testing-library/react";

/**
 * "Press" a menu trigger button: pointerdown then click, like a browser. Radix opens on pointerdown;
 * the phone sheet shape (`DropdownMenu`'s `phoneSheet`) opens on the click of the same press, so sending only pointerdown doesn't open it.
 */
export function pressTrigger(trigger: HTMLElement): void {
  fireEvent.pointerDown(trigger, { button: 0 });
  fireEvent.click(trigger, { detail: 1 });
}

import { act, fireEvent } from "@testing-library/react";

export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

/**
 * Simulates "click outside the dialog" in jsdom. In this Radix version's DismissableLayer:
 * - the document pointerdown subscription happens one tick after mount (`setTimeout 0`);
 * - a pointerdown with button===0 is deferred until the document `click` before pointerDownOutside is dispatched.
 * So let the timer run out first, then send the full pointerdown -> mousedown -> pointerup -> mouseup -> click; sending only pointerdown does nothing
 * (a guard's "doesn't close" assertion would pass vacuously). The baseline behavior (a default dialog does close on an outside click) is covered by `components/ui/dialog.test.tsx`.
 */
export async function clickOutside(): Promise<void> {
  await settle();
  fireEvent.pointerDown(document.body);
  fireEvent.mouseDown(document.body);
  fireEvent.pointerUp(document.body);
  fireEvent.mouseUp(document.body);
  fireEvent.click(document.body);
  await settle();
}

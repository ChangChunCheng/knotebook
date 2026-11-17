import { expect } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";

/** 以鍵盤打開 Radix Select 的面板（jsdom 沒有完整的 pointer 事件，鍵盤路徑最穩）。 */
async function openSelect(trigger: HTMLElement): Promise<void> {
  if (trigger.getAttribute("aria-expanded") === "true") return;
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "Enter" });
  });
  await screen.findByRole("listbox");
}

async function closed(): Promise<void> {
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}

/** 開選單、點名稱相符的選項、等面板收起。 */
export async function chooseOption(trigger: HTMLElement, optionName: string | RegExp): Promise<void> {
  await openSelect(trigger);
  const option = await screen.findByRole("option", { name: optionName });
  await act(async () => {
    fireEvent.click(option);
  });
  await closed();
}

/** 觸發鈕目前（受控）的值；空字串也會輸出。 */
export function selectedValue(trigger: HTMLElement): string {
  const v = trigger.getAttribute("data-value");
  if (v === null) throw new Error("selectedValue: element has no data-value attribute (not a ui/select trigger)");
  return v;
}

/** 開選單讀出所有選項的名稱，再用 Esc 收起。 */
export async function optionLabels(trigger: HTMLElement): Promise<string[]> {
  await openSelect(trigger);
  const labels = screen.getAllByRole("option").map((o) => o.textContent ?? "");
  await act(async () => {
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
  });
  await closed();
  return labels;
}

import { expect } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";

/** Opens via keyboard: jsdom lacks full pointer events, so the keyboard path is the stable one. */
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

export async function chooseOption(trigger: HTMLElement, optionName: string | RegExp): Promise<void> {
  await openSelect(trigger);
  const option = await screen.findByRole("option", { name: optionName });
  await act(async () => {
    fireEvent.click(option);
  });
  await closed();
}

export function selectedValue(trigger: HTMLElement): string {
  const v = trigger.getAttribute("data-value");
  if (v === null) throw new Error("selectedValue: element has no data-value attribute (not a ui/select trigger)");
  return v;
}

export async function optionLabels(trigger: HTMLElement): Promise<string[]> {
  await openSelect(trigger);
  const labels = screen.queryAllByRole("option").map((o) => o.textContent ?? "");
  await act(async () => {
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
  });
  await closed();
  return labels;
}

/** Only the visible cell, not the hidden copy used for sizing. */
export function displayedLabel(trigger: HTMLElement): string {
  const el = trigger.querySelector("[data-select-text]");
  if (!el) throw new Error("displayedLabel: element has no [data-select-text] (not a ui/select trigger)");
  return el.textContent ?? "";
}

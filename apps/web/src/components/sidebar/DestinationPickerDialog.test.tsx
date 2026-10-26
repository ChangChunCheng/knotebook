import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import i18n from "@/i18n";
import { ApiFail } from "@/api/client";
import { adminRole, customRole, groupDto } from "@/test/fixtures";
import { DestinationPickerDialog } from "./DestinationPickerDialog";
import { buildDestinationTree } from "./select-model";

// 目的地選擇框（#181 PR-2c T5，DP1–DP5）。

const A = groupDto({ id: "ga", name: "A" }, adminRole());
const B = groupDto({ id: "gb", name: "B" }, customRole({ permissions: { ...customRole().permissions, create: true } }));

function renderPicker(props: Partial<Parameters<typeof DestinationPickerDialog>[0]> & { mode: "move" | "copy" }) {
  const onPick = vi.fn();
  const onOpenChange = vi.fn();
  const t = i18n.t.bind(i18n) as (key: string, options?: Record<string, unknown>) => string;
  render(
    <DestinationPickerDialog
      count={3}
      nodes={buildDestinationTree({ mode: props.mode, groups: [A, B], t })}
      error={null}
      open
      onPick={onPick}
      onOpenChange={onOpenChange}
      {...props}
    />,
  );
  return { onPick, onOpenChange };
}

describe("DestinationPickerDialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("DP1 copy：My notes、小標 Workspace、A（沒有只能建不能編的 B）；按 A → onPick 群組", () => {
    const { onPick } = renderPicker({ mode: "copy" });
    const dialog = screen.getByRole("dialog");
    const items = within(dialog).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["My notes", "A"]);
    expect(within(dialog).getByText("Workspace").closest("li")).toHaveAttribute("role", "presentation");
    expect(within(dialog).getByRole("button", { name: "My notes" }).querySelector('svg[data-icon="user"]')).not.toBeNull();
    expect(within(dialog).getByRole("button", { name: "A" }).querySelector('svg[data-icon="users"]')).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "A" }));
    expect(onPick).toHaveBeenCalledWith({ kind: "group", groupId: "ga", name: "A" });
  });

  it("DP1 copy：按 My notes → onPick personal", () => {
    const { onPick } = renderPicker({ mode: "copy" });
    fireEvent.click(screen.getByRole("button", { name: "My notes" }));
    expect(onPick).toHaveBeenCalledWith({ kind: "personal" });
  });

  it("DP2 move：沒有 My notes，只有 A", () => {
    renderPicker({ mode: "move" });
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "My notes" })).toBeNull();
    // 「工作坊」小標只分隔我的筆記與群組；只有群組時不放（T5 review r1 N1）。
    expect(within(dialog).queryByText("Workspace")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "A" })).toBeInTheDocument();
  });

  it("DP3 nodes null → Loading…；error → role=alert", () => {
    renderPicker({ mode: "copy", nodes: null });
    expect(within(screen.getByRole("dialog")).getByText("Loading…")).toBeInTheDocument();
  });

  it("DP3 error → role=alert（errors.<code>）", () => {
    renderPicker({ mode: "copy", nodes: null, error: new ApiFail(500, "internal", "x") });
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent("Something went wrong. Please try again.");
  });

  it("DP4 標題與描述：Move to／Copy to、Choose where the 3 notes go.", () => {
    renderPicker({ mode: "move" });
    expect(screen.getByRole("dialog", { name: "Move to" })).toHaveAccessibleDescription("Choose where the 3 notes go.");
  });

  it("DP4 copy 標題 Copy to；單數描述", () => {
    renderPicker({ mode: "copy", count: 1 });
    expect(screen.getByRole("dialog", { name: "Copy to" })).toHaveAccessibleDescription("Choose where the note goes.");
  });

  it("DP4 zh-TW：標題移動到／複製到、根我的筆記", async () => {
    await i18n.changeLanguage("zh-TW");
    renderPicker({ mode: "copy" });
    const dialog = screen.getByRole("dialog", { name: "複製到" });
    expect(within(dialog).getByRole("button", { name: "我的筆記" })).toBeInTheDocument();
    expect(within(dialog).getByText("工作坊")).toBeInTheDocument();
    await i18n.changeLanguage("en");
  });

  it("DP4 zh-TW：move 標題移動到", async () => {
    await i18n.changeLanguage("zh-TW");
    renderPicker({ mode: "move" });
    expect(screen.getByRole("dialog", { name: "移動到" })).toBeInTheDocument();
    await i18n.changeLanguage("en");
  });

  it("DP5 Cancel → onOpenChange(false)、沒有 onPick", () => {
    const { onPick, onOpenChange } = renderPicker({ mode: "copy" });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onPick).not.toHaveBeenCalled();
  });
});

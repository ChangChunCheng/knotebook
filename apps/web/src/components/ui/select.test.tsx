import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";
import { Select, type SelectOption } from "./select";
import { chooseOption, displayedLabel, optionLabels, selectedValue } from "@/test/ui-select";

const ROLES: SelectOption[] = [
  { value: "viewer", label: "Viewer" },
  { value: "editor", label: "Editor" },
];

const WITH_AUTO: SelectOption[] = [
  { value: "", label: "Auto" },
  { value: "gpt", label: "GPT" },
];

function renderSelect(props: Partial<React.ComponentProps<typeof Select>> = {}) {
  const onValueChange = vi.fn();
  const utils = render(
    <Select variant="field" aria-label="Role" value="viewer" onValueChange={onValueChange} options={ROLES} {...props} />,
  );
  return { onValueChange, ...utils, trigger: () => screen.getByRole("combobox", { name: "Role" }) };
}

async function closeWithEscape() {
  await act(async () => {
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
  });
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}

describe("ui/select", () => {
  it("兩種 variant 都渲染 combobox，帶可及名稱與 data-value", () => {
    for (const variant of ["field", "inline"] as const) {
      const { trigger, unmount } = renderSelect({ variant, value: "editor" });
      expect(selectedValue(trigger())).toBe("editor");
      expect(displayedLabel(trigger())).toBe("Editor");
      unmount();
    }
  });

  it("field 的外框 class 與 Input 同一組（h-8、border-input、pointer-coarse:text-base）；inline 沒有 border-input", () => {
    const field = renderSelect({ variant: "field" });
    for (const c of ["h-8", "border-input", "pointer-coarse:text-base"]) expect(field.trigger()).toHaveClass(c);
    field.unmount();
    const inline = renderSelect({ variant: "inline" });
    expect(inline.trigger()).not.toHaveClass("border-input");
    expect(inline.trigger()).toHaveClass("border-dashed");
  });

  it("開選單列出全部選項，目前值那一項 aria-selected=true", async () => {
    const { trigger } = renderSelect();
    expect(await optionLabels(trigger())).toEqual(["Viewer", "Editor"]);
    fireEvent.keyDown(trigger(), { key: "Enter" });
    expect(await screen.findByRole("option", { name: "Viewer" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: "Editor" })).toHaveAttribute("aria-selected", "false");
  });

  it("chooseOption 後 onValueChange 收到選項的 value，元件不自己改值", async () => {
    const { trigger, onValueChange } = renderSelect();
    await chooseOption(trigger(), "Editor");
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith("editor");
    expect(selectedValue(trigger())).toBe("viewer");
    expect(displayedLabel(trigger())).toBe("Viewer");
  });

  it("disabled 的選項點不到、disabled 的元件開不了", async () => {
    const options = [...ROLES, { value: "owner", label: "Owner", disabled: true }];
    const { trigger, onValueChange, unmount } = renderSelect({ options });
    fireEvent.keyDown(trigger(), { key: "Enter" });
    const owner = await screen.findByRole("option", { name: "Owner" });
    expect(owner).toHaveAttribute("aria-disabled", "true");
    await act(async () => {
      fireEvent.click(owner);
    });
    expect(onValueChange).not.toHaveBeenCalled();
    unmount();

    const off = renderSelect({ disabled: true });
    expect(off.trigger()).toBeDisabled();
    fireEvent.keyDown(off.trigger(), { key: "Enter" });
    fireEvent.pointerDown(off.trigger());
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("Esc 關選單、焦點回觸發鈕", async () => {
    const { trigger } = renderSelect();
    trigger().focus();
    fireEvent.keyDown(trigger(), { key: "Enter" });
    await screen.findByRole("listbox");
    await closeWithEscape();
    await waitFor(() => expect(trigger()).toHaveFocus());
  });

  it("鍵盤：ArrowDown 開、方向鍵移動、Enter 選取", async () => {
    const { trigger, onValueChange } = renderSelect();
    trigger().focus();
    await act(async () => {
      fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    });
    await screen.findByRole("listbox");
    await waitFor(() => expect(screen.getByRole("option", { name: "Viewer" })).toHaveFocus());
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    });
    await waitFor(() => expect(screen.getByRole("option", { name: "Editor" })).toHaveFocus());
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("option", { name: "Editor" }), { key: "Enter" });
    });
    expect(onValueChange).toHaveBeenCalledWith("editor");
  });

  it('value 為空字串且有 "" 選項：顯示該選項 label，選它回呼收到 ""', async () => {
    const { trigger, onValueChange } = renderSelect({ options: WITH_AUTO, value: "" });
    expect(displayedLabel(trigger())).toBe("Auto");
    expect(trigger()).toHaveAttribute("data-value", "");
    fireEvent.keyDown(trigger(), { key: "Enter" });
    expect(await screen.findByRole("option", { name: "Auto" })).toHaveAttribute("aria-selected", "true");
    await closeWithEscape();
    await chooseOption(trigger(), "GPT");
    expect(onValueChange).toHaveBeenLastCalledWith("gpt");
  });

  it('目前值不是 "" 時選 "" 選項，回呼收到 ""', async () => {
    const { trigger, onValueChange } = renderSelect({ options: WITH_AUTO, value: "gpt" });
    await chooseOption(trigger(), "Auto");
    expect(onValueChange).toHaveBeenCalledWith("");
  });

  it('value 為空字串且沒有 "" 選項：顯示 placeholder；value 不在 options：顯示 placeholder', () => {
    const a = renderSelect({ value: "", placeholder: "Pick one" });
    expect(displayedLabel(a.trigger())).toBe("Pick one");
    expect(selectedValue(a.trigger())).toBe("");
    a.unmount();
    const b = renderSelect({ value: "nope", placeholder: "Pick one" });
    expect(displayedLabel(b.trigger())).toBe("Pick one");
    expect(selectedValue(b.trigger())).toBe("nope");
  });

  it("<label htmlFor=id>：getByLabelText 找得到觸發鈕、點 label 會讓觸發鈕取得焦點", () => {
    render(
      <>
        <label htmlFor="role-id">Member role</label>
        <Select variant="field" id="role-id" value="viewer" onValueChange={() => {}} options={ROLES} />
      </>,
    );
    const trigger = screen.getByLabelText("Member role");
    expect(trigger).toBe(screen.getByRole("combobox"));
    expect(trigger.id).toBe("role-id");
    fireEvent.click(screen.getByText("Member role"));
    expect(trigger).toHaveFocus();
  });

  it("name 有給：form 送出的 FormData 取得到目前值；沒給 name 則沒有該欄位", () => {
    const named = render(
      <form>
        <Select variant="field" aria-label="Role" name="role" value="editor" onValueChange={() => {}} options={ROLES} />
      </form>,
    );
    expect(new FormData(named.container.querySelector("form")!).get("role")).toBe("editor");
    named.unmount();
    const bare = render(
      <form>
        <Select variant="field" aria-label="Role" value="editor" onValueChange={() => {}} options={ROLES} />
      </form>,
    );
    expect([...new FormData(bare.container.querySelector("form")!).keys()]).toEqual([]);
  });

  it("在 Dialog 內：開著選單按 Esc，選單關、Dialog 還在", async () => {
    const onOpenChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState("viewer");
      return (
        <Dialog open onOpenChange={onOpenChange}>
          <DialogContent>
            <DialogTitle>Share</DialogTitle>
            <DialogDescription>Pick a role</DialogDescription>
            <Select variant="field" aria-label="Role" value={value} onValueChange={setValue} options={ROLES} />
          </DialogContent>
        </Dialog>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole("combobox", { name: "Role" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    await screen.findByRole("listbox");
    await closeWithEscape();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    await chooseOption(trigger, "Editor");
    expect(selectedValue(trigger)).toBe("editor");
  });

  it("每個選項在觸發鈕內有隱藏的撐寬副本（aria-hidden），可及名稱與 data-value 不變", () => {
    const { trigger } = renderSelect({ value: "viewer" });
    const sizers = Array.from(trigger().querySelectorAll("[data-select-sizer]"));
    expect(sizers.map((s) => s.textContent)).toEqual(["Viewer", "Editor"]);
    for (const s of sizers) {
      expect(s).toHaveAttribute("aria-hidden", "true");
      expect(s).toHaveClass("invisible");
    }
    expect(displayedLabel(trigger())).toBe("Viewer");
    expect(trigger()).toHaveAccessibleName("Role");
    expect(selectedValue(trigger())).toBe("viewer");
  });

  it("長 label：觸發鈕文字所在元素有 truncate", () => {
    const options = [{ value: "a", label: "Alice Example Long Name (alice.example.long@example.com)" }];
    const { trigger } = renderSelect({ options, value: "a" });
    expect(trigger().querySelector("[data-select-text]")).toHaveClass("truncate");
    expect(trigger()).toHaveClass("min-w-0");
  });
});

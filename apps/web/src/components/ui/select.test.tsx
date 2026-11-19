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
  it("both variants render a combobox with an accessible name and data-value", () => {
    for (const variant of ["field", "inline"] as const) {
      const { trigger, unmount } = renderSelect({ variant, value: "editor" });
      expect(selectedValue(trigger())).toBe("editor");
      expect(displayedLabel(trigger())).toBe("Editor");
      unmount();
    }
  });

  it("the field variant's frame classes match Input's (h-8, border-input, pointer-coarse:text-base); inline has no border-input", () => {
    const field = renderSelect({ variant: "field" });
    for (const c of ["h-8", "border-input", "pointer-coarse:text-base"]) expect(field.trigger()).toHaveClass(c);
    field.unmount();
    const inline = renderSelect({ variant: "inline" });
    expect(inline.trigger()).not.toHaveClass("border-input");
    expect(inline.trigger()).toHaveClass("border-dashed");
  });

  it("opening the menu lists all options and the current value's option has aria-selected=true", async () => {
    const { trigger } = renderSelect();
    expect(await optionLabels(trigger())).toEqual(["Viewer", "Editor"]);
    fireEvent.keyDown(trigger(), { key: "Enter" });
    expect(await screen.findByRole("option", { name: "Viewer" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: "Editor" })).toHaveAttribute("aria-selected", "false");
  });

  it("after chooseOption onValueChange receives the option's value and the component does not change the value itself", async () => {
    const { trigger, onValueChange } = renderSelect();
    await chooseOption(trigger(), "Editor");
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith("editor");
    expect(selectedValue(trigger())).toBe("viewer");
    expect(displayedLabel(trigger())).toBe("Viewer");
  });

  it("a disabled option cannot be clicked and a disabled component cannot be opened", async () => {
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

  it("Esc closes the menu and focus returns to the trigger", async () => {
    const { trigger } = renderSelect();
    trigger().focus();
    fireEvent.keyDown(trigger(), { key: "Enter" });
    await screen.findByRole("listbox");
    await closeWithEscape();
    await waitFor(() => expect(trigger()).toHaveFocus());
  });

  it("keyboard: ArrowDown opens, arrow keys move, Enter selects", async () => {
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

  it('value is an empty string and an "" option exists: shows the label of that option, and choosing it calls back with ""', async () => {
    const { trigger, onValueChange } = renderSelect({ options: WITH_AUTO, value: "" });
    expect(displayedLabel(trigger())).toBe("Auto");
    expect(trigger()).toHaveAttribute("data-value", "");
    fireEvent.keyDown(trigger(), { key: "Enter" });
    expect(await screen.findByRole("option", { name: "Auto" })).toHaveAttribute("aria-selected", "true");
    await closeWithEscape();
    await chooseOption(trigger(), "GPT");
    expect(onValueChange).toHaveBeenLastCalledWith("gpt");
  });

  it('when the current value is not "", choosing the "" option calls back with ""', async () => {
    const { trigger, onValueChange } = renderSelect({ options: WITH_AUTO, value: "gpt" });
    await chooseOption(trigger(), "Auto");
    expect(onValueChange).toHaveBeenCalledWith("");
  });

  it('value is an empty string and there is no "" option: shows the placeholder; value not in options: shows the placeholder', () => {
    const a = renderSelect({ value: "", placeholder: "Pick one" });
    expect(displayedLabel(a.trigger())).toBe("Pick one");
    expect(selectedValue(a.trigger())).toBe("");
    a.unmount();
    const b = renderSelect({ value: "nope", placeholder: "Pick one" });
    expect(displayedLabel(b.trigger())).toBe("Pick one");
    expect(selectedValue(b.trigger())).toBe("nope");
  });

  it("<label htmlFor=id>: getByLabelText finds the trigger and clicking the label focuses the trigger", () => {
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

  it('inside a form with no "" option: when the value and options go from empty to real values, no "" callback happens', async () => {
    const onValueChange = vi.fn();
    function Harness() {
      const [loaded, setLoaded] = useState(false);
      return (
        <form>
          <Select
            variant="field"
            aria-label="Role"
            value={loaded ? "editor" : ""}
            onValueChange={onValueChange}
            options={loaded ? ROLES : []}
          />
          <button type="button" onClick={() => setLoaded(true)}>
            load
          </button>
        </form>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "load" }));
    await waitFor(() => expect(selectedValue(screen.getByRole("combobox", { name: "Role" }))).toBe("editor"));
    await act(async () => {});
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('inside a form with an "" option: when the value goes from one not yet in the list to one in the list, no callback happens', async () => {
    const onValueChange = vi.fn();
    function Harness() {
      const [loaded, setLoaded] = useState(false);
      return (
        <form>
          <Select
            variant="field"
            aria-label="Model"
            value={loaded ? "gpt" : "late"}
            onValueChange={onValueChange}
            options={loaded ? WITH_AUTO : [{ value: "", label: "Auto" }]}
          />
          <button type="button" onClick={() => setLoaded(true)}>
            load
          </button>
        </form>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "load" }));
    await waitFor(() => expect(selectedValue(screen.getByRole("combobox", { name: "Model" }))).toBe("gpt"));
    await act(async () => {});
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("with name: the submitted FormData has the current value; without name there is no such field", () => {
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

  it("inside a Dialog: Esc with the menu open closes the menu and the Dialog stays", async () => {
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

  it("each option has a hidden width-reserving copy inside the trigger (aria-hidden) and the accessible name and data-value are unchanged", () => {
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

  it("long label: the element holding the trigger text has truncate", () => {
    const options = [{ value: "a", label: "Alice Example Long Name (alice.example.long@example.com)" }];
    const { trigger } = renderSelect({ options, value: "a" });
    expect(trigger().querySelector("[data-select-text]")).toHaveClass("truncate");
    expect(trigger()).toHaveClass("min-w-0");
  });
});

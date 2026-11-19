import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { SelectAllCheckbox, SelectionCheckbox } from "./selection-checkbox";

const input = () => screen.getByRole("checkbox") as HTMLInputElement;

describe("SelectionCheckbox", () => {
  it("custom-drawn: appearance-none, 14px, small radius, brand background and focus ring; no accent-brand; both svgs aria-hidden", () => {
    const { container } = render(<SelectionCheckbox checked={false} onChange={() => {}} />);
    for (const cls of ["appearance-none", "h-3.5", "w-3.5", "rounded-sm", "border-muted-foreground", "bg-transparent", "checked:bg-brand", "indeterminate:bg-brand", "focus-visible:ring-2"]) {
      expect(input()).toHaveClass(cls);
    }
    for (const cls of ["accent-brand", "bg-background", "border-input"]) expect(input()).not.toHaveClass(cls);
    const svgs = container.querySelectorAll("svg");
    expect(svgs).toHaveLength(2);
    for (const svg of svgs) expect(svg).toHaveAttribute("aria-hidden", "true");
    const minus = container.querySelector('svg[data-icon="minus"]');
    const check = [...svgs].find((svg) => svg !== minus)!;
    expect(minus).not.toBeNull();
    // pointer-events-none is load-bearing: without it a click on the check lands on the svg and a real browser does not toggle.
    for (const cls of ["pointer-events-none", "hidden", "peer-checked:block", "peer-disabled:opacity-50"]) expect(check).toHaveClass(cls);
    for (const cls of ["pointer-events-none", "hidden", "peer-indeterminate:block", "peer-disabled:opacity-50"]) expect(minus).toHaveClass(cls);
    expect(minus).not.toHaveClass("peer-checked:block");
  });

  it("the indeterminate property follows the prop (true -> false -> true)", () => {
    const { rerender } = render(<SelectionCheckbox checked={false} indeterminate onChange={() => {}} />);
    expect(input().indeterminate).toBe(true);
    rerender(<SelectionCheckbox checked={false} indeterminate={false} onChange={() => {}} />);
    expect(input().indeterminate).toBe(false);
    rerender(<SelectionCheckbox checked={false} indeterminate onChange={() => {}} />);
    expect(input().indeterminate).toBe(true);
  });

  it("clicking an indeterminate box with unchanged parent state: onChange is called once and the box stays indeterminate", () => {
    const onChange = vi.fn();
    render(<SelectionCheckbox checked={false} indeterminate onChange={onChange} />);
    fireEvent.click(input());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(input().indeterminate).toBe(true);
  });

  it("checked and indeterminate both true: indeterminate wins and checked is false", () => {
    render(<SelectionCheckbox checked indeterminate onChange={() => {}} />);
    expect(input().checked).toBe(false);
    expect(input().indeterminate).toBe(true);
  });

  it("ref points at the input, data-selection-key reaches the input, and a Shift click's nativeEvent.shiftKey is readable", () => {
    const ref = createRef<HTMLInputElement>();
    const seen: boolean[] = [];
    render(
      <SelectionCheckbox
        ref={ref}
        checked={false}
        data-selection-key="note:1"
        onChange={(event) => seen.push((event.nativeEvent as MouseEvent).shiftKey)}
      />,
    );
    expect(ref.current).toBe(input());
    expect(input()).toHaveAttribute("data-selection-key", "note:1");
    fireEvent.click(input(), { shiftKey: true });
    expect(seen).toEqual([true]);
  });
});

describe("SelectAllCheckbox", () => {
  const renderAll = (state: "all" | "some" | "none", onToggle = () => {}) =>
    render(<SelectAllCheckbox state={state} onToggle={onToggle} label="Select all" title="Select all visible" />);
  const box = () => screen.getByRole("checkbox", { name: "Select all" }) as HTMLInputElement;

  it("three states map to checked / indeterminate; a click calls onToggle once; title is passed through", () => {
    const onToggle = vi.fn();
    const { unmount } = renderAll("some", onToggle);
    expect(box().indeterminate).toBe(true);
    expect(box().checked).toBe(false);
    expect(box()).toHaveAttribute("title", "Select all visible");
    fireEvent.click(box());
    expect(onToggle).toHaveBeenCalledTimes(1);
    unmount();
    renderAll("all");
    expect(box().checked).toBe(true);
    expect(box().indeterminate).toBe(false);
  });

  it("disabled: the box is disabled and a click does not call onToggle", () => {
    const onToggle = vi.fn();
    render(<SelectAllCheckbox state="none" disabled onToggle={onToggle} label="Select all" title="Select all visible" />);
    expect(box()).toBeDisabled();
    // Use element.click() (jsdom does no activation behavior for a disabled element, matching a real browser); fireEvent.click dispatches the event directly and would bypass disabled.
    box().click();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("none: neither checked nor indeterminate", () => {
    renderAll("none");
    expect(box().checked).toBe(false);
    expect(box().indeterminate).toBe(false);
  });
});

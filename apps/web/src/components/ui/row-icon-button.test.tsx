import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "./dialog";
import { Pencil, Trash } from "./icons";
import { RowIconButton } from "./row-icon-button";

describe("RowIconButton (row actions are icon buttons)", () => {
  it("ghost with size icon (h-8 w-8, ROW_ICON_BUTTON); aria-label and title are both the label; neutral color", () => {
    render(<RowIconButton label="Edit Basic" icon={<Pencil className="h-4 w-4" />} />);
    const button = screen.getByRole("button", { name: "Edit Basic" });
    expect(button).toHaveAttribute("title", "Edit Basic");
    expect(button).toHaveClass("h-8", "w-8", "text-muted-foreground");
    expect(button.className).not.toMatch(/(^|\s)bg-(primary|destructive|brand|brand-deep)(\s|$)/);
    expect(button.className).not.toMatch(/(^|\s)border-input(\s|$)/);
  });

  it("tone=destructive: ROW_ICON_DANGER (text-destructive + hover:bg-destructive/10), not the destructive variant (no bg-destructive)", () => {
    render(<RowIconButton label="Delete Basic" tone="destructive" icon={<Trash className="h-4 w-4" />} />);
    const button = screen.getByRole("button", { name: "Delete Basic" });
    expect(button).toHaveClass("text-destructive", "hover:bg-destructive/10");
    expect(button).not.toHaveClass("bg-destructive");
  });

  it("softDisabled: aria-disabled (so ROW_ICON_DANGER's aria-disabled:opacity-40 applies) with the title replaced by the reason; clicking does not call onClick; it is not a native disabled", () => {
    const onClick = vi.fn();
    render(
      <RowIconButton label="Remove a@x" tone="destructive" softDisabled softDisabledReason="Only admin" onClick={onClick} icon={<Trash className="h-4 w-4" />} />,
    );
    const button = screen.getByRole("button", { name: "Remove a@x" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAttribute("title", "Only admin");
    expect(button).toHaveClass("aria-disabled:opacity-40", "cursor-not-allowed");
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("as the child of DialogTrigger asChild: a normal button opens the dialog when clicked; a softDisabled one does not", () => {
    const { rerender } = render(
      <Dialog>
        <DialogTrigger asChild>
          <RowIconButton label="Delete Basic" tone="destructive" icon={<Trash className="h-4 w-4" />} />
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Delete?</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete Basic" }));
    expect(screen.getByRole("dialog", { name: "Delete?" })).toBeInTheDocument();
    rerender(
      <Dialog key="b">
        <DialogTrigger asChild>
          <RowIconButton label="Delete Basic" tone="destructive" softDisabled icon={<Trash className="h-4 w-4" />} />
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Delete?</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete Basic" }));
    expect(screen.queryByRole("dialog", { name: "Delete?" })).not.toBeInTheDocument();
  });
});

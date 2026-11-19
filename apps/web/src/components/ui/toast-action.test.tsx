import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { dismissAllToasts, toast, Toaster, useToasts } from "./toast";

afterEach(() => {
  act(() => dismissAllToasts());
});

describe("toast action", () => {
  it("action: renders the action button; a click calls onClick and closes that toast", async () => {
    const onClick = vi.fn();
    render(<Toaster />);
    const store = renderHook(() => useToasts());
    act(() => {
      toast({ title: "x", action: { label: "Open", onClick } });
    });
    expect(store.result.current).toHaveLength(1);

    fireEvent.click(await screen.findByRole("button", { name: "Open" }));

    expect(onClick).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(store.result.current).toEqual([]));
    expect(screen.queryByText("x")).toBeNull();
  });

  it("action.altText is used when given and label is the fallback", async () => {
    render(<Toaster />);
    act(() => {
      toast({ title: "a", action: { label: "Open", onClick: vi.fn(), altText: "Copy is in My notes" } });
    });
    await screen.findByRole("button", { name: "Open" });
    // Relies on the internal attribute data-radix-toast-announce-alt of @radix-ui/react-toast (not public API); a rename on upgrade turns this test red (no false green), and then the selector must be updated against Radix's source.
    expect(document.querySelector('[data-radix-toast-announce-alt="Copy is in My notes"]')).not.toBeNull();
    act(() => dismissAllToasts());
    act(() => {
      toast({ title: "b", action: { label: "Go", onClick: vi.fn() } });
    });
    await screen.findByRole("button", { name: "Go" });
    expect(document.querySelector('[data-radix-toast-announce-alt="Go"]')).not.toBeNull();
  });
});

describe("toast viewport safe area", () => {
  it("padding on all four sides is max(16px, safe area): not covered by the notch, the home indicator or the sides in landscape", () => {
    render(<Toaster />);
    const viewport = document.querySelector("ol");
    expect(viewport).not.toBeNull();
    for (const [prefix, side] of [["pt", "top"], ["pr", "right"], ["pb", "bottom"], ["pl", "left"]]) {
      expect(viewport).toHaveClass(`${prefix}-[max(1rem,env(safe-area-inset-${side}))]`);
    }
    expect(viewport).not.toHaveClass("p-4");
  });
});

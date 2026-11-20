import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Switch } from "./switch";

// #247: slim switch, track 26x14 px, thumb 10 px, checked offset 12 px
describe("Switch size and tone (#247)", () => {
  it("track is h-3.5 w-[26px] and no longer carries the old h-4 w-7", () => {
    render(<Switch aria-label="s" />);
    const track = screen.getByRole("switch", { name: "s" });
    expect(track).toHaveClass("h-3.5", "w-[26px]");
    expect(track).not.toHaveClass("h-4");
    expect(track).not.toHaveClass("w-7");
  });

  it("thumb is h-2.5 w-2.5 with translate-x-3 when checked and translate-x-0.5 when unchecked", () => {
    render(<Switch aria-label="s" />);
    const thumb = screen.getByRole("switch", { name: "s" }).firstElementChild!;
    expect(thumb).toHaveClass("h-2.5", "w-2.5", "data-[state=checked]:translate-x-3", "data-[state=unchecked]:translate-x-0.5");
    expect(thumb).not.toHaveClass("data-[state=checked]:translate-x-3.5");
  });

  it('tone="destructive": checked state has bg-destructive and twMerge overrides bg-brand', () => {
    render(<Switch aria-label="s" tone="destructive" />);
    const track = screen.getByRole("switch", { name: "s" });
    expect(track).toHaveClass("data-[state=checked]:bg-destructive");
    expect(track).not.toHaveClass("data-[state=checked]:bg-brand");
  });

  it("default tone: checked state has bg-brand and no bg-destructive", () => {
    render(<Switch aria-label="s" />);
    const track = screen.getByRole("switch", { name: "s" });
    expect(track).toHaveClass("data-[state=checked]:bg-brand");
    expect(track).not.toHaveClass("data-[state=checked]:bg-destructive");
  });
});

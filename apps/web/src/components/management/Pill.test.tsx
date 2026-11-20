import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Pill } from "./Pill";

describe("Pill (#247: permission pill, lists only those held)", () => {
  it("default tone: neutral outline, carries data-pill", () => {
    render(<Pill>Read</Pill>);
    const pill = screen.getByText("Read");
    expect(pill).toHaveAttribute("data-pill");
    expect(pill).toHaveClass("border-border");
    expect(pill).not.toHaveClass("text-destructive");
  });

  it('tone="destructive": pale red background and red text', () => {
    render(<Pill tone="destructive">Move</Pill>);
    expect(screen.getByText("Move")).toHaveClass("bg-destructive/10", "text-destructive");
  });
});

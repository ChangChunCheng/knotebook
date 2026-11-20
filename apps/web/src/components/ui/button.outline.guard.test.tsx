import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Button } from "./button";

/**
 * #247: outline hover/pressed states fill with color (site-wide). jsdom runs no CSS, so this guards that the class tokens are not removed
 * (same approach as switch.guard.test.tsx); the real colors need a browser.
 */
describe("Button outline variant (#247)", () => {
  it("hover fills with brand-deep and white text with no border; pressed is one step darker (color-mix 85% black)", () => {
    render(<Button variant="outline">x</Button>);
    const b = screen.getByRole("button", { name: "x" });
    expect(b).toHaveClass(
      "hover:bg-brand-deep",
      "hover:text-brand-fg",
      "hover:border-transparent",
      "active:[background:color-mix(in_oklch,var(--brand-deep)_85%,black)]",
    );
    expect(b).not.toHaveClass("hover:bg-accent");
  });

  it("ghost hover keeps the neutral bg-accent (the three buttons in a row do not flash)", () => {
    render(<Button variant="ghost">g</Button>);
    expect(screen.getByRole("button", { name: "g" })).toHaveClass("hover:bg-accent");
  });
});
